/**
 * Show A/B reply pairs side by side.
 *
 * The A/B counts differences; only a reader can say whether a difference is the
 * memory working or the model being non-deterministic. This prints the pairs so
 * the judgement is made on the words.
 *
 *   node scripts/show-ab.mjs [runs/ab/comparisons.json] [filter]
 */

import { readFileSync } from 'node:fs';

const path = process.argv[2] ?? 'packages/host/runs/ab/comparisons.json';
const filter = process.argv[3] ?? '';
const comparisons = JSON.parse(readFileSync(path, 'utf8'));

const selected = filter
  ? comparisons.filter(
      (item) =>
        (item.intent ?? '').includes(filter) ||
        (item.user ?? '').includes(filter) ||
        item.session === filter,
    )
  : comparisons;

for (const item of selected) {
  process.stdout.write(`${'='.repeat(78)}\n`);
  process.stdout.write(`[${item.session} day+${item.day}] ${item.intent}\n`);
  process.stdout.write(`USER: ${item.user}\n`);
  process.stdout.write(`\nRECORDS THE MEMORY-AWARE SIDE WAS GIVEN (${item.visibleRecords.length}):\n`);
  if (item.visibleRecords.length === 0) {
    process.stdout.write('  (none)\n');
  } else {
    for (const record of item.visibleRecords) {
      process.stdout.write(`  [${record.mention}] ${record.text}\n`);
    }
  }
  process.stdout.write(`\nWITH MEMORY    (${item.withMemoryLength}):\n  ${item.withMemory}\n`);
  process.stdout.write(`\nWITHOUT MEMORY (${item.withoutMemoryLength}):\n  ${item.withoutMemory}\n`);
}
