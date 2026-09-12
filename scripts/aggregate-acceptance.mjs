/**
 * Recompute the Oracle acceptance over every repetition that completed.
 *
 * The criterion is written for ten repetitions of the frozen conversation, and
 * `runOracleEvaluation` writes one artifact per repetition. Running all ten inside
 * one launcher process is not reliable here: the launcher aborted twice partway
 * through the first repetition, and a crash there loses every repetition after it.
 * Ten single-repetition invocations, each in its own process, produce the same
 * rows and cannot take each other down.
 *
 * The rows are aggregated with the evaluator's own `summarizeOracle` rather than a
 * second implementation of the thresholds, so the reported criterion is the one
 * the harness defines and not a restatement of it that can drift.
 *
 *   node scripts/aggregate-acceptance.mjs <runs/oracle directory>
 *   node scripts/aggregate-acceptance.mjs <directory> --runs 7          # newest seven
 *   node scripts/aggregate-acceptance.mjs <directory> --label or-ling   # one batch only
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { summarizeOracle } from '../packages/host/dist/src/evaluator.js';

function flag(name) {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

const root = process.argv[2];
if (root === undefined) throw new Error('usage: aggregate-acceptance.mjs <runs/oracle directory> [--runs N] [--label prefix]');

const runsFlag = flag('--runs');
const limit = runsFlag === undefined ? Infinity : Number(runsFlag);
const label = flag('--label');

/**
 * The invocations this aggregate is over, newest last.
 *
 * Ordered by directory modification time, not by name. The names are not
 * comparable: an invocation is named either an ISO timestamp or a
 * caller-supplied label, and `or-ling-1` sorts after `2026-09-12T04-...` while
 * being hours newer. Ordering by name and taking the first `--runs` therefore
 * aggregated whichever batch sorted first and reported it as the run just made
 * -- measured with twelve older invocations present, `--runs 2` scored two of
 * those. `--label` selects a batch explicitly; the names that entered the
 * aggregate are printed either way.
 */
function invocations(directory) {
  return readdirSync(directory)
    .map((name) => ({ name, path: join(directory, name) }))
    .filter((entry) => {
      try {
        return statSync(entry.path).isDirectory();
      } catch {
        return false;
      }
    })
    .filter((entry) => label === undefined || entry.name.startsWith(label))
    .sort((left, right) => statSync(left.path).mtimeMs - statSync(right.path).mtimeMs);
}

const available = invocations(root);
const selected = available.slice(limit === Infinity ? 0 : Math.max(0, available.length - limit));

const files = selected.flatMap((invocation) => readdirSync(invocation.path)
  .filter((name) => /^oracle-run-\d+\.json$/.test(name))
  .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }))
  .map((name) => ({ invocation: invocation.name, path: join(invocation.path, name) })));
if (files.length === 0) {
  throw new Error(label === undefined
    ? `no repetition artifacts under ${root}`
    : `no repetition artifacts under ${root} for label ${label}`);
}

/** Every row, with the run index rewritten so repetitions stay distinguishable. */
const rows = files.flatMap((entry, index) => {
  const parsed = JSON.parse(readFileSync(entry.path, 'utf8'));
  return parsed.map((row) => ({ ...row, run: index }));
});

const summary = summarizeOracle(rows, files.length);
const arms = ['normal', 'gold_retrieved', 'gold_forced', 'counterfactual_forced'];
const effects = ['name', 'language', 'preference', 'continuity', 'boundary', 'correct_silence'];

/** The predicate each effect actually applied, taken from the observations themselves. */
const conditions = new Map();
for (const row of rows) {
  for (const arm of arms) {
    if (!conditions.has(row.effectType)) conditions.set(row.effectType, row.scores[arm].condition);
  }
}

process.stdout.write(`invocations aggregated: ${selected.map((entry) => entry.name).join(', ')}\n`);
process.stdout.write(`repetitions aggregated: ${files.length} (of ${available.length} invocations present${label === undefined ? '' : ` for label ${label}`})\n`);
process.stdout.write(`scorer version: ${summary.measurement.scorerVersion}\n\n`);
const versionIncompatible = summary.measurement.refusals.some((refusal) => refusal.includes('scorer version'));
if (versionIncompatible) {
  // The rows come from different rules, so their score fields do not even have the
  // same shape. Printing the table would show zeros that look like failures rather
  // than like incomparability.
  process.stdout.write('these artifacts predate the current scorer; re-run the batch instead of re-reading it.\n\n');
} else {
  process.stdout.write('what each effect actually measured:\n');
  for (const effect of effects) process.stdout.write(`  ${effect.padEnd(18)}${conditions.get(effect) ?? '(no observation)'}\n`);
  process.stdout.write('\neffect rates, pass/total. valid observations only; inv = invalid, n/a = not applicable\n');
  process.stdout.write(`  ${'arm'.padEnd(22)}${effects.map((effect) => effect.padStart(18)).join('')}\n`);
  for (const arm of arms) {
    const cells = effects.map((effect) => {
      const rate = summary.effectRates[arm][effect];
      if (rate === undefined) return 'n/a'.padStart(18);
      const excluded = rate.invalid + rate.notApplicable === 0 ? '' : ` inv${rate.invalid} na${rate.notApplicable}`;
      const value = rate.rate === null ? 'n/a' : `${rate.passed}/${rate.total}`;
      return `${value}${excluded}`.padStart(18);
    });
    process.stdout.write(`  ${arm.padEnd(22)}${cells.join('')}\n`);
  }
  process.stdout.write('\nobservations that did not count:\n');
  for (const arm of arms) {
    process.stdout.write(`  ${arm.padEnd(22)}unanswered ${summary.unreplied[arm]}  refused ${summary.routeRefusals[arm]}  starved ${summary.starvedReplies[arm]}  invalid ${(summary.measurement.invalidShare[arm] * 100).toFixed(1)}%\n`);
  }
  // Not a per-arm effect: the extractor runs once per turn, for the normal arm.
  // A refusal here leaves the normal arm with nothing to store, which reads as
  // "the normal arm had no memory" unless it is counted.
  process.stdout.write(`\nextractor refusals: ${summary.extractionFailures} of ${rows.length} turns\n`);
}

process.stdout.write('\n=== verdict ===\n');
if (!summary.measurement.batchAcceptable) {
  // Machine-generated, and the only place a reading is allowed to come from. What
  // survives for diagnosis is the arithmetic; what does not survive is a
  // conclusion drawn from it.
  process.stdout.write('REFUSED -- this batch may not be read as a result:\n');
  for (const refusal of summary.measurement.refusals) process.stdout.write(`  - ${refusal}\n`);
  process.stdout.write('  The counts above are shown for diagnosis. They are not a product finding.\n');
} else {
  process.stdout.write('measurement preconditions held.\n');
}
if (versionIncompatible) {
  process.stdout.write('\nthe acceptance gates are not evaluated: they compare rates that were never computed.\n');
} else {
  process.stdout.write(`\n${JSON.stringify(summary.acceptance, null, 2)}\n`);
}
process.exitCode = summary.acceptance.passed ? 0 : 1;
