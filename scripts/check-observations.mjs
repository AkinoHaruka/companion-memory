/**
 * Check two things a run surfaced and I did not want to assume about.
 *
 *   1. Whether `SELECT importance` is being read correctly, or whether the
 *      scorer printed `undefined` because of how this driver names columns.
 *   2. What the extractor did with the cat, which appeared under `person.name`.
 *
 *   node scripts/check-observations.mjs <db path>
 */

import { DatabaseSync } from 'node:sqlite';

const db = new DatabaseSync(process.argv[2]);

const rows = db.prepare('SELECT id, predicate, value, importance FROM claims').all();
process.stdout.write('direct read of importance:\n');
for (const row of rows.slice(0, 3)) {
  process.stdout.write(
    `  ${row.predicate} | importance=${JSON.stringify(row.importance)} | keys=${Object.keys(row).join(',')}\n`,
  );
}

process.stdout.write('\nevery claim the extractor produced, by predicate:\n');
const byPredicate = new Map();
for (const row of rows) {
  const list = byPredicate.get(row.predicate) ?? [];
  list.push(row.value);
  byPredicate.set(row.predicate, list);
}
for (const [predicate, values] of [...byPredicate].sort()) {
  process.stdout.write(`  ${predicate}\n`);
  for (const value of values) process.stdout.write(`      ${value}\n`);
}

db.close();
