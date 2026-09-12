/**
 * The smallest experiment that answers one question.
 *
 * Question: does the graded recall rule produce a lift, or do the zero-memory
 * replies carry the evidence too? It needs the ceiling and the control on the
 * recall turn, with the record admitted first -- three arms over two turns, two
 * repetitions. Twelve calls, not a hundred.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = 'C:/TRAE/Riko-dsh-TencentDB/companion-memory';
const { runOracleEvaluation } = await import(`file:///${root}/packages/host/dist/src/evaluator.js`);
const { createOpenAiCompatibleClient } = await import(`file:///${root}/packages/host/dist/src/openai-client.js`);
const { SESSIONS } = await import(`file:///${root}/packages/host/dist/src/script.js`);

const credentials = JSON.parse(process.env.COMPANION_MEMORY_EVAL_CREDENTIALS);
const calls = [];
const client = createOpenAiCompatibleClient({
  credentials,
  model: process.env.COMPANION_MEMORY_EVAL_MODEL,
  onCall: (report) => calls.push(report),
});

const directory = mkdtempSync(join(tmpdir(), 'companion-memory-lift-'));
const s3 = SESSIONS[2];
const s4 = SESSIONS[3];
if (s3 === undefined || s4 === undefined) throw new Error('fixture changed');

const summary = await runOracleEvaluation({
  client,
  databasePath: join(directory, 'oracle.db'),
  workerCommand: join(root, 'target', 'debug', 'companion-memory-worker.exe'),
  runCount: 2,
  outputDirectory: directory,
  sequentialArms: true,
  interCallDelayMs: 1_500,
  arms: ['gold_forced', 'gold_retrieved', 'no_memory'],
  sessions: [
    { ...s3, turns: [s3.turns[0]] },
    { ...s4, turns: [s4.turns[0]] },
  ],
});

const rows = JSON.parse(readFileSync(join(directory, 'oracle-run-1.json'), 'utf8'));
for (const row of rows) {
  console.log(`\n=== ${row.session}t${row.turn} [${row.effectType}] ${row.user}`);
  for (const arm of ['gold_forced', 'gold_retrieved', 'no_memory']) {
    const a = row.arms[arm];
    const hits = ['半夜', '三点', '折腾'].filter((token) => (a.reply ?? '').includes(token));
    console.log(`  ${arm.padEnd(16)} inj=${String(a.injectedRecordIds.length).padStart(2)} len=${String(a.reply.length).padStart(4)} hit=${hits.length === 0 ? 'NONE' : hits.join('+')}`);
    console.log(`      ${JSON.stringify((a.reply ?? '').slice(0, 120))}`);
  }
}

console.log('\n=== lift (this experiment) ===');
for (const [effect, value] of Object.entries(summary.lift)) {
  if (value === undefined) continue;
  const show = (rate) => (rate === null ? 'n/a' : rate.toFixed(2));
  console.log(`  ${effect.padEnd(18)} with=${show(value.withMemory)} without=${show(value.withoutMemory)} delta=${show(value.delta)}`);
}
console.log(`\ncalls=${calls.length} refusals=${calls.filter((report) => report.error).length}`);
