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
 *   node scripts/aggregate-acceptance.mjs <directory> --runs 7   # first seven only
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { summarizeOracle } from '../packages/host/dist/src/evaluator.js';

const root = process.argv[2];
if (root === undefined) throw new Error('usage: aggregate-acceptance.mjs <runs/oracle directory>');

const limitFlag = process.argv.indexOf('--runs');
const limit = limitFlag < 0 ? Infinity : Number(process.argv[limitFlag + 1]);

/** Repetition artifacts, oldest invocation first. */
function artifacts(directory) {
  const found = [];
  for (const name of readdirSync(directory)) {
    const invocation = join(directory, name);
    if (!statSync(invocation).isDirectory()) continue;
    for (const file of readdirSync(invocation)) {
      if (/^oracle-run-\d+\.json$/.test(file)) found.push({ invocation: name, file, path: join(invocation, file) });
    }
  }
  return found
    .sort((left, right) => (left.invocation === right.invocation
      ? left.file.localeCompare(right.file, undefined, { numeric: true })
      : left.invocation.localeCompare(right.invocation)))
    .slice(0, limit);
}

const files = artifacts(root);
if (files.length === 0) throw new Error(`no repetition artifacts under ${root}`);

/** Every row, with the run index rewritten so repetitions stay distinguishable. */
const rows = files.flatMap((entry, index) => {
  const parsed = JSON.parse(readFileSync(entry.path, 'utf8'));
  return parsed.map((row) => ({ ...row, run: index }));
});

const summary = summarizeOracle(rows, files.length);
const arms = ['normal', 'gold_retrieved', 'gold_forced', 'counterfactual_forced'];
const effects = ['name', 'language', 'preference', 'continuity', 'boundary', 'correct_silence'];

process.stdout.write(`repetitions aggregated: ${files.length} (of ${artifacts(root).length} present)\n\n`);
process.stdout.write('effect rates, unanswered turns excluded:\n');
process.stdout.write(`  ${'arm'.padEnd(22)}${effects.map((effect) => effect.padStart(16)).join('')}\n`);
for (const arm of arms) {
  const cells = effects.map((effect) => {
    const rate = summary.effectRates[arm][effect];
    if (rate === undefined || rate.rate === null) return 'n/a'.padStart(16);
    return `${rate.passed}/${rate.total}`.padStart(16);
  });
  process.stdout.write(`  ${arm.padEnd(22)}${cells.join('')}\n`);
}
process.stdout.write('\nunanswered turns per arm:\n');
for (const arm of arms) {
  process.stdout.write(`  ${arm.padEnd(22)}${summary.unreplied[arm]}  (answered ${(summary.acceptance.answeredShare[arm] * 100).toFixed(1)}%)\n`);
}
process.stdout.write(`\n${JSON.stringify(summary.acceptance, null, 2)}\n`);
