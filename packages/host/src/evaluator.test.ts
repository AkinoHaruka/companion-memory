import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { describe, expect, it } from 'vitest';

import { runOracleEvaluation, type EvaluationClient } from './evaluator.js';
import { SESSIONS, type SessionScript } from './script.js';

/**
 * A stand-in worker that stores what it is told and renders it into one channel.
 *
 * The channel is a parameter because the renderer contract is a real defect this
 * evaluator has to notice: `identity.name` measuredly arrived in `responseStyle`,
 * under guidance about language and level of detail, and eight forced records
 * produced not one reply that used the name. That batch reported the name effect
 * as zero. It is a mutation case, not a hypothetical.
 */
function workerProgram(deepChannel: 'deepRecall' | 'responseStyle'): string {
  return [
    "const readline=require('node:readline'); const memories=new Map();",
    "const input=readline.createInterface({input:process.stdin});",
    `const DEEP_CHANNEL=${JSON.stringify(deepChannel)};`,
    "input.on('line',(line)=>{const q=JSON.parse(line);const p=q.params||{};const profile=p.scope&&p.scope.companion_profile_id||'';let result={};",
    "if(q.op==='health')result={protocolVersion:1,schemaVersion:3,predicateKeys:['identity.name'],predicateSchemas:[{key:'identity.name',valueKind:'text',enumValues:[]}]};",
    "if(q.op==='admit'){const rows=memories.get(profile)||[];for(const c of p.candidates||[])rows.push({id:'claim-'+c.id,text:c.predicate+': '+(c.raw_value||c.value)});memories.set(profile,rows);result={accepted:(p.candidates||[]).map(c=>'claim-'+c.id),rejected:[],pending:(p.pending||[]).length};}",
    "if(q.op==='warm'){let rows=memories.get(profile)||[];if(Array.isArray(p.force_record_ids))rows=rows.filter(r=>p.force_record_ids.includes(r.id));const plan={constraints:[],responseStyle:[],continuity:[],topicActivated:[],deepRecall:[],doNotSurface:[]};plan[DEEP_CHANNEL]=rows.map(r=>({recordId:r.id,text:r.text,surface:'freely_mentionable',reason:'test'}));result={revision:rows.length,plan};}",
    "if(q.op==='query')result={records:[]};if(q.op==='forget')result={forgotten:false,recordIds:[]};if(q.op==='session_closed')result={expired:0};",
    "console.log(JSON.stringify({version:1,id:q.id,ok:true,result}));});",
  ].join('');
}

const workerArgs = (deepChannel: 'deepRecall' | 'responseStyle'): string[] => ['-e', workerProgram(deepChannel), '--'];

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
        workerArgs: workerArgs('deepRecall'),
        runCount: 2,
        outputDirectory,
        sessions: script,
      });
      const first = JSON.parse(readFileSync(join(outputDirectory, 'oracle-run-1.json'), 'utf8')) as Array<Record<string, unknown>>;
      const second = JSON.parse(readFileSync(join(outputDirectory, 'oracle-run-2.json'), 'utf8')) as Array<Record<string, unknown>>;
      expect(first).toHaveLength(2);
      expect(second).toHaveLength(2);
      const probe = first[1] as { arms: Record<string, { reply: string; injectedRecordIds: string[] }>; scores: Record<string, { state: string }> };
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
      expect(normalScore.state).toBe('pass');
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
        workerArgs: workerArgs('deepRecall'),
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

  it('refuses to report a name effect that the renderer made unreadable', async () => {
    // The measured defect, replayed as a mutation. `identity.name` reached the
    // model inside `<response_style>`, whose guidance is about language, tone,
    // format and level of detail — so a reply that does not address the user by
    // name says nothing about memory. Scoring it produced a zero that was read as
    // "the name memory does not work", and eight forced records were present.
    //
    // The batch must refuse rather than report, and the effect must be
    // not_applicable rather than failed.
    const outputDirectory = mkdtempSync(join(tmpdir(), 'companion-memory-oracle-style-'));
    try {
      const summary = await runOracleEvaluation({
        client: fakeModel,
        databasePath: join(outputDirectory, 'oracle.db'),
        workerCommand: process.execPath,
        workerArgs: workerArgs('responseStyle'),
        runCount: 1,
        outputDirectory,
        sessions: script,
      });
      const rows = JSON.parse(readFileSync(join(outputDirectory, 'oracle-run-1.json'), 'utf8')) as Array<{ scores: Record<string, { state: string; evidence: string }> }>;
      const nameTurn = rows[1];
      expect(nameTurn?.scores.normal?.state).toBe('not_applicable');
      expect(nameTurn?.scores.normal?.evidence).toContain('response_style');
      expect(summary.effectRates.normal.name).toMatchObject({ total: 0, notApplicable: 1 });
      expect(summary.measurement.notApplicable).toBeGreaterThan(0);
      expect(summary.measurement.batchAcceptable).toBe(false);
      expect(summary.measurement.refusals.join(' ')).toContain('not_applicable');
      expect(summary.acceptance.passed).toBe(false);
    } finally {
      rmSync(outputDirectory, { recursive: true, force: true });
    }
  });

  it('does not score a reply the budget cut in half, or one a reasoning route never wrote', async () => {
    // The measured mechanism. With `max_tokens` 400 a reasoning route spent 397
    // tokens thinking, returned `content: ""` and `finish_reason: "length"` — an
    // empty reply that is neither a model choosing silence nor a route refusing.
    // The same mechanism cut other replies mid sentence, and a cut reply cannot
    // be read for length, for a name, or for the absence of a prohibited topic.
    const outputDirectory = mkdtempSync(join(tmpdir(), 'companion-memory-oracle-cut-'));
    const cutClient: EvaluationClient = {
      async chat(messages) {
        const snapshot = messages.map((message) => message.content).join('\n');
        const truncated = snapshot.includes('identity.name: 林越');
        return {
          text: truncated ? '林越，我在听你说' : '我在。',
          route: {
            model: 'reasoning-route', endpoint: 'test', credential: 0, httpStatus: 200,
            finishReason: truncated ? 'length' : 'stop', textLength: truncated ? 8 : 3,
            completionTokens: 400, reasoningTokens: truncated ? 397 : 0, attempts: 1, elapsedMs: 10,
          },
        };
      },
      chatJson: fakeModel.chatJson,
    };
    try {
      const summary = await runOracleEvaluation({
        client: cutClient,
        databasePath: join(outputDirectory, 'oracle.db'),
        workerCommand: process.execPath,
        workerArgs: workerArgs('deepRecall'),
        runCount: 1,
        outputDirectory,
        sessions: script,
      });
      const rows = JSON.parse(readFileSync(join(outputDirectory, 'oracle-run-1.json'), 'utf8')) as Array<{ scores: Record<string, { state: string; evidence: string }> }>;
      const nameTurn = rows[1];
      // The reply contains 林越 and would have passed the rule; it is invalid because
      // it was cut, and reporting it as a pass would credit memory for a fragment.
      expect(nameTurn?.scores.gold_forced?.state).toBe('invalid');
      expect(nameTurn?.scores.gold_forced?.evidence).toContain('cut by the token budget');
      expect(summary.measurement.invalidShare.gold_forced).toBeGreaterThan(0);
      expect(summary.measurement.batchAcceptable).toBe(false);
      expect(summary.measurement.refusals.join(' ')).toContain('invalid');
      expect(summary.acceptance.passed).toBe(false);
    } finally {
      rmSync(outputDirectory, { recursive: true, force: true });
    }
  });

  it('refuses a self-contradicting fixture before spending a single model call', async () => {
    // The fixture compiler exists to fail here rather than in a batch of replies.
    // A counterfactual that restates gold is the recorded defect: the arm was
    // gold under another name and its difference from the ceiling was read as a
    // causal effect.
    const outputDirectory = mkdtempSync(join(tmpdir(), 'companion-memory-oracle-compile-'));
    let modelCalls = 0;
    const countingClient: EvaluationClient = {
      async chat() { modelCalls += 1; return { text: 'x' }; },
      async chatJson() { modelCalls += 1; return { items: [] }; },
    };
    const contradictory: readonly SessionScript[] = [{
      id: 'bad', dayOffset: 0, turns: [
        {
          intent: 'contradiction', text: '关于简短我改主意了。', memoryOpportunity: 'positive', effectType: 'preference',
          gold: [{ predicate: 'communication.verbosity', value: 'long', rawValue: '多讲一点', quote: '关于简短' }],
          counterfactual: [{ predicate: 'communication.verbosity', value: 'long', rawValue: '多讲一点', quote: '关于简短' }],
        },
      ],
    }];
    try {
      await expect(runOracleEvaluation({
        client: countingClient,
        databasePath: join(outputDirectory, 'oracle.db'),
        workerCommand: process.execPath,
        workerArgs: workerArgs('deepRecall'),
        runCount: 1,
        outputDirectory,
        sessions: contradictory,
      })).rejects.toThrow(/counterfactual-equals-gold/);
      expect(modelCalls).toBe(0);
    } finally {
      rmSync(outputDirectory, { recursive: true, force: true });
    }
  });

  it('declares a recall turn unmeasurable when the fixture recorded nothing for it', async () => {
    // s5t0 is scored for continuity — "项目又延期了" wants the model to recognise a
    // theme from three weeks earlier — and the fixture records no gold for it
    // anywhere, so no reply can be a recall of anything. Ten of the eighteen
    // continuity turns in the fixture are this turn; the recorded batch reported
    // them as a failure, which was a property of the fixture.
    //
    // This is the answer that needs no invented ground truth: not a pass, not a
    // fail, and not scored at all.
    const outputDirectory = mkdtempSync(join(tmpdir(), 'companion-memory-oracle-unmeasurable-'));
    const s5 = SESSIONS[4];
    if (s5 === undefined) throw new Error('the fixture no longer has an s5');
    try {
      const summary = await runOracleEvaluation({
        client: fakeModel,
        databasePath: join(outputDirectory, 'oracle.db'),
        workerCommand: process.execPath,
        workerArgs: workerArgs('deepRecall'),
        runCount: 1,
        outputDirectory,
        sessions: [{ ...s5, turns: [s5.turns[0]!] }],
      });
      const rows = JSON.parse(readFileSync(join(outputDirectory, 'oracle-run-1.json'), 'utf8')) as Array<{ scores: Record<string, { state: string; evidence: string }> }>;
      expect(rows[0]?.scores.normal?.state).toBe('not_applicable');
      expect(rows[0]?.scores.normal?.evidence).toContain('effect-without-evidence');
      expect(summary.effectRates.normal.continuity).toMatchObject({ total: 0, notApplicable: 1 });
      expect(summary.measurement.batchAcceptable).toBe(false);
      expect(summary.acceptance.passed).toBe(false);
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
        workerArgs: workerArgs('deepRecall'),
        runCount: 1,
        outputDirectory,
        sessions: script,
      })).rejects.toThrow(/already holds records/);
    } finally {
      rmSync(outputDirectory, { recursive: true, force: true });
    }
  });
});
