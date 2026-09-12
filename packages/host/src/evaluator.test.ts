import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

  it('cannot pass when the route stops answering', async () => {
    // The dangerous direction. An empty reply cannot contain a prohibited topic,
    // so a turn where the route failed used to count as the boundary holding --
    // the protection score rising on exactly the turns that broke. Measured on a
    // live run: 12 of 80 replies came back empty, and the protections were the
    // only effects that looked healthy.
    //
    // Unanswered turns are dropped from the denominators rather than counted as
    // failures, so what is asserted here is that the sample is refused, not that
    // it is scored badly.
    const outputDirectory = mkdtempSync(join(tmpdir(), 'companion-memory-oracle-silent-'));
    try {
      const summary = await runOracleEvaluation({
        client: { async chat() { return { text: '' }; }, chatJson: fakeModel.chatJson },
        databasePath: join(outputDirectory, 'oracle.db'),
        workerCommand: process.execPath,
        workerArgs: ['-e', workerProgram, '--'],
        runCount: 1,
        outputDirectory,
        sessions: script,
      });
      expect(summary.acceptance.answeredShare.normal).toBe(0);
      expect(summary.acceptance.enoughTurnsWereAnswered).toBe(false);
      expect(summary.acceptance.passed).toBe(false);
      expect(summary.unreplied.normal).toBeGreaterThan(0);
      // Nothing may be credited to a turn nobody answered, in either direction.
      expect(summary.effectRates.normal.correct_silence).toMatchObject({ passed: 0, total: 0, rate: null });
      expect(summary.effectRates.normal.boundary).toMatchObject({ passed: 0, total: 0, rate: null });
    } finally {
      rmSync(outputDirectory, { recursive: true, force: true });
    }
  });

  it('refuses a database that already holds records', async () => {
    // runs of an invocation. It is not safe across invocations: profile ids are
    // `normal-0`, `gold-retrieved-0` and so on, so a second invocation against
    // the same file begins each repetition with the previous run's memories in
    // place. Measured against the real worker, a second warm on an untouched
    // scope returned one record the first invocation had left there — which is
    // the longer-and-longer relationship the per-run suffixes exist to prevent,
    // arriving through the one door they do not cover.
    //
    // The check is on the file rather than on its contents because that is what
    // the runner can see before paying for a model call.
    const outputDirectory = mkdtempSync(join(tmpdir(), 'companion-memory-oracle-stale-'));
    const databasePath = join(outputDirectory, 'oracle.db');
    try {
      writeFileSync(databasePath, 'previous invocation', 'utf8');
      await expect(runOracleEvaluation({
        client: fakeModel,
        databasePath,
        workerCommand: process.execPath,
        workerArgs: ['-e', workerProgram, '--'],
        runCount: 1,
        outputDirectory,
        sessions: script,
      })).rejects.toThrow(/already holds records/);
    } finally {
      rmSync(outputDirectory, { recursive: true, force: true });
    }
  });
});
