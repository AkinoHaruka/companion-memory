import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { describe, expect, it } from 'vitest';

import { runOracleEvaluation, type EvaluationClient } from './evaluator.js';
import type { SessionScript } from './script.js';

const workerProgram = [
  "const readline=require('node:readline'); const memories=new Map();",
  "const input=readline.createInterface({input:process.stdin});",
  "input.on('line',(line)=>{const q=JSON.parse(line);const p=q.params||{};const profile=p.scope&&p.scope.companion_profile_id||'';let result={};",
  "if(q.op==='health')result={protocolVersion:1,schemaVersion:3,predicateKeys:['identity.name'],predicateSchemas:[{key:'identity.name',valueKind:'text',enumValues:[]}]};",
  "if(q.op==='admit'){const rows=memories.get(profile)||[];for(const c of p.candidates||[])rows.push({id:'claim-'+c.id,text:c.predicate+': '+(c.raw_value||c.value)});memories.set(profile,rows);result={accepted:(p.candidates||[]).map(c=>'claim-'+c.id),rejected:[],pending:(p.pending||[]).length};}",
  "if(q.op==='warm'){let rows=memories.get(profile)||[];if(Array.isArray(p.force_record_ids))rows=rows.filter(r=>p.force_record_ids.includes(r.id));result={revision:rows.length,plan:{constraints:[],responseStyle:rows.map(r=>({recordId:r.id,text:r.text,surface:'freely_mentionable',reason:'test'})),continuity:[],topicActivated:[],deepRecall:[],doNotSurface:[]}};}",
  "if(q.op==='query')result={records:[]};if(q.op==='forget')result={forgotten:false,recordIds:[]};if(q.op==='session_closed')result={expired:0};",
  "console.log(JSON.stringify({version:1,id:q.id,ok:true,result}));});",
].join('');

const script: readonly SessionScript[] = [{
  id: 'oracle-contract', dayOffset: 0, turns: [
    {
      intent: 'establish identity', text: '我叫林越。', memoryOpportunity: 'none', effectType: 'correct_silence',
      gold: [{ predicate: 'identity.name', value: '林越', rawValue: '林越', quote: '林越' }],
      counterfactual: [{ predicate: 'identity.name', value: '周然', rawValue: '周然', quote: '林越' }],
    },
    { intent: 'natural name probe', text: '我想继续聊聊。', memoryOpportunity: 'positive', effectType: 'name' },
  ],
}];

const fakeModel: EvaluationClient = {
  async chat(messages) {
    const snapshot = messages.map((message) => message.content).join('\n');
    if (snapshot.includes('identity.name: 周然')) return { text: '周然，我在。' };
    if (snapshot.includes('identity.name: 林越')) return { text: '林越，我在。' };
    return { text: '我在。' };
  },
  async chatJson(messages) {
    const source = messages.at(-1)?.content ?? '';
    return source.includes('林越')
      ? { items: [{ kind: 'claim', predicate: 'identity.name', value: '林越', rawValue: '林越', quote: '林越', confidence: 1 }] }
      : { items: [] };
  },
};

describe('Oracle evaluator causal artifacts', () => {
  it('keeps repetitions isolated and records normal, Gold, forced, and counterfactual effects', async () => {
    const outputDirectory = mkdtempSync(join(tmpdir(), 'companion-memory-oracle-'));
    try {
      const summary = await runOracleEvaluation({
        client: fakeModel,
        databasePath: join(outputDirectory, 'oracle.db'),
        workerCommand: process.execPath,
        workerArgs: ['-e', workerProgram, '--'],
        runCount: 2,
        outputDirectory,
        sessions: script,
      });
      const first = JSON.parse(readFileSync(join(outputDirectory, 'oracle-run-1.json'), 'utf8')) as Array<Record<string, unknown>>;
      const second = JSON.parse(readFileSync(join(outputDirectory, 'oracle-run-2.json'), 'utf8')) as Array<Record<string, unknown>>;
      expect(first).toHaveLength(2);
      expect(second).toHaveLength(2);
      const probe = first[1] as { arms: Record<string, { reply: string; injectedRecordIds: string[] }>; scores: Record<string, { passed: boolean }> };
      const normal = probe.arms.normal;
      const retrieved = probe.arms.gold_retrieved;
      const forced = probe.arms.gold_forced;
      const counterfactual = probe.arms.counterfactual_forced;
      const normalScore = probe.scores.normal;
      if (normal === undefined || retrieved === undefined || forced === undefined || counterfactual === undefined || normalScore === undefined) {
        throw new Error('Oracle artifact omitted a required arm');
      }
      expect(normal.reply).toContain('林越');
      expect(retrieved.injectedRecordIds).toHaveLength(1);
      expect(forced.reply).toContain('林越');
      expect(counterfactual.reply).toContain('周然');
      expect(normalScore.passed).toBe(true);
      expect(summary.effectRates.gold_forced.name).toMatchObject({ passed: 2, total: 2, rate: 1 });
      expect(readFileSync(join(outputDirectory, 'oracle-summary.json'), 'utf8')).toContain('goldForcedCoreAtLeastEightOfTen');
    } finally {
      rmSync(outputDirectory, { recursive: true, force: true });
    }
  });
});
