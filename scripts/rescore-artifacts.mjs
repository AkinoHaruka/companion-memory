#!/usr/bin/env node
/**
 * Re-read stored replies under the current rules, without calling a model.
 *
 * Scoring is a pure function of what the model was shown and what it answered,
 * and the artifacts keep both. So a rule change costs nothing to evaluate: the
 * same replies are read again under the new rules. This is also the only way to
 * compare two rules fairly, because the model's own variance is held fixed --
 * re-running the fixture and comparing two scores asks the model to decide which
 * judge was better.
 *
 * What this cannot do is change what the model saw. A changed renderer, gate,
 * fixture or arm is an intervention, and it needs fresh replies. The header of
 * the output states this, because the failure mode here is subtle in exactly the
 * way this project keeps meeting: re-reading old replies under a new rule
 * produces a complete, plausible table about a system that no longer exists.
 *
 *   node scripts/rescore-artifacts.mjs runs/oracle --label or-ling
 *   node scripts/rescore-artifacts.mjs runs/oracle --label or-ling --runs 2
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ALL_ARMS, SCORER_VERSION, rescoreArm, scorerCondition, summarizeOracle,
} from '../packages/host/dist/src/evaluator.js';
import { unmeasurableTurns } from '../packages/host/dist/src/fixture.js';
import { PROBES, SESSIONS } from '../packages/host/dist/src/script.js';

const repositoryRoot = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');

function flag(name) {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

const root = process.argv[2];
if (root === undefined) throw new Error('usage: rescore-artifacts.mjs <runs/oracle directory> [--label prefix] [--runs N]');
const runsFlag = flag('--runs');
const limit = runsFlag === undefined ? Infinity : Number(runsFlag);
const label = flag('--label');

const available = readdirSync(root)
  .map((name) => ({ name, path: join(root, name) }))
  .filter((entry) => statSync(entry.path).isDirectory())
  .filter((entry) => label === undefined || entry.name.startsWith(label))
  .sort((left, right) => statSync(left.path).mtimeMs - statSync(right.path).mtimeMs);
const invocations = available.slice(limit === Infinity ? 0 : Math.max(0, available.length - limit));

const files = invocations.flatMap((invocation) => readdirSync(invocation.path)
  .filter((name) => /^oracle-run-\d+\.json$/.test(name))
  .map((name) => ({ invocation: invocation.name, path: join(invocation.path, name) })));
if (files.length === 0) throw new Error(`no artifacts under ${root}${label === undefined ? '' : ` for label ${label}`}`);

/** The frozen turns, keyed as the artifacts key them. */
const turns = new Map();
for (const session of [...SESSIONS, ...PROBES]) {
  for (const [index, turn] of session.turns.entries()) turns.set(`${session.id}t${index}`, turn);
}
const unmeasurable = unmeasurableTurns([...SESSIONS, ...PROBES]);

const rows = files.flatMap((entry, index) => {
  const parsed = JSON.parse(readFileSync(entry.path, 'utf8'));
  return parsed.map((row, turn) => {
    const key = `${row.session}t${row.turn}`;
    const turn_ = turns.get(key);
    const reason = turn_ === undefined ? undefined : unmeasurable.get(key);
    const scores = {};
    const arms = {};
    for (const arm of ALL_ARMS) {
      const stored = row.arms[arm];
      if (stored === undefined) {
        // The batch predates this arm: a turn it did not run, not a failure. The
        // skipped observation the live evaluator would have written is put back so
        // the aggregate has every arm to read.
        const skipped = 'this batch predates this arm, so it never ran here';
        scores[arm] = rescoreArm(row.effectType, turn_, { skipped }, reason);
        arms[arm] = { plan: {}, injectedRecordIds: [], reply: '', replyFailed: false, identityRenderedElsewhere: false, skipped };
        continue;
      }
      scores[arm] = rescoreArm(row.effectType, turn_, stored, reason);
      arms[arm] = stored;
    }
    return { ...row, run: index, scorerVersion: SCORER_VERSION, arms, scores };
  });
});

const summary = summarizeOracle(rows, files.length);
const effects = [...new Set(rows.map((row) => row.effectType))];

process.stdout.write('RE-SCORED OFFLINE. No model call was made: these are the stored replies read under the\n');
process.stdout.write(`current rules (scorer v${SCORER_VERSION}). They say how today\'s judge reads yesterday\'s behaviour,\n`);
process.stdout.write('not how today\'s system behaves -- a changed renderer, gate or fixture needs fresh replies.\n\n');
process.stdout.write(`invocations: ${invocations.map((entry) => entry.name).join(', ')}\n`);
process.stdout.write(`repetitions: ${files.length}   turns: ${rows.length}\n\n`);

process.stdout.write('what each effect measures now:\n');
for (const effect of effects) process.stdout.write(`  ${effect.padEnd(18)}${scorerCondition(effect)}\n`);

process.stdout.write('\neffect rates, pass/total; inv = invalid, n/a = not applicable, none of them scored\n');
process.stdout.write(`  ${'arm'.padEnd(22)}${effects.map((effect) => effect.padStart(18)).join('')}\n`);
for (const arm of ALL_ARMS) {
  const cells = effects.map((effect) => {
    const rate = summary.effectRates[arm][effect];
    if (rate === undefined) return 'n/a'.padStart(18);
    const excluded = rate.invalid + rate.notApplicable === 0 ? '' : ` inv${rate.invalid} na${rate.notApplicable}`;
    const value = rate.rate === null ? 'n/a' : `${rate.passed}/${rate.total}`;
    return `${value}${excluded}`.padStart(18);
  });
  process.stdout.write(`  ${arm.padEnd(22)}${cells.join('')}\n`);
}

const withLift = effects.filter((effect) => summary.lift[effect] !== undefined);
process.stdout.write('\nlift: gold_forced (ceiling) minus no_memory (control)\n');
process.stdout.write(`  ${'effect'.padEnd(18)}${'with'.padStart(8)}${'without'.padStart(9)}${'delta'.padStart(8)}\n`);
for (const effect of withLift) {
  const value = summary.lift[effect];
  const show = (rate) => (rate === null ? 'n/a' : rate.toFixed(2));
  process.stdout.write(`  ${effect.padEnd(18)}${show(value.withMemory).padStart(8)}${show(value.withoutMemory).padStart(9)}${show(value.delta).padStart(8)}\n`);
}
if (summary.spontaneousNameMentions !== undefined) {
  process.stdout.write('\nspontaneous name mentions (reported, not gated):\n');
  for (const arm of ALL_ARMS) {
    const value = summary.spontaneousNameMentions[arm];
    if (value === undefined || value.observed === 0) continue;
    process.stdout.write(`  ${arm.padEnd(22)}${value.mentioned}/${value.observed}\n`);
  }
}

process.stdout.write('\n=== verdict ===\n');
if (!summary.measurement.batchAcceptable) {
  process.stdout.write('REFUSED -- the rules cannot read this batch as a result:\n');
  for (const refusal of summary.measurement.refusals) process.stdout.write(`  - ${refusal}\n`);
} else {
  process.stdout.write('measurement preconditions held for this re-reading.\n');
}
process.stdout.write(`\n${JSON.stringify(summary.acceptance, null, 2)}\n`);
