/**
 * Inspect a completed run: what the audit trail recorded, and whether any
 * predicate ended up holding contradicting values.
 *
 *   node scripts/inspect-run.mjs packages/host/runs/companion.db
 */

import { DatabaseSync } from 'node:sqlite';

const path = process.argv[2];
if (!path) {
  process.stderr.write('usage: node scripts/inspect-run.mjs <db path>\n');
  process.exitCode = 1;
  process.exit();
}

const db = new DatabaseSync(path);

const events = db
  .prepare(
    "SELECT action, record_kind, detail FROM audit_events " +
      "WHERE action IN ('supersede', 'forget', 'consolidate') ORDER BY created_at, id",
  )
  .all();
process.stdout.write(`governance events: ${events.length}\n`);
for (const event of events) {
  process.stdout.write(`  ${event.action}: ${event.detail}\n`);
}

const overlapping = db
  .prepare(
    'SELECT predicate, COUNT(*) AS total FROM claims WHERE status = ? ' +
      'GROUP BY predicate HAVING total > 1 ORDER BY total DESC',
  )
  .all('active');
process.stdout.write(
  `\npredicates holding more than one active value: ${overlapping.length}\n`,
);
for (const row of overlapping) {
  process.stdout.write(`  ${row.predicate} x${row.total}\n`);
  const values = db
    .prepare('SELECT value FROM claims WHERE status = ? AND predicate = ?')
    .all('active', row.predicate);
  for (const value of values) process.stdout.write(`      - ${value.value}\n`);
}

const byStatus = db.prepare('SELECT status, COUNT(*) AS total FROM claims GROUP BY status').all();
process.stdout.write('\nclaims by status:\n');
for (const row of byStatus) process.stdout.write(`  ${row.status}: ${row.total}\n`);

process.stdout.write('\nthe supersede chain for any predicate that has one:\n');
const chained = db
  .prepare(
    'SELECT predicate, value, status FROM claims ' +
      'WHERE predicate IN (SELECT predicate FROM claims WHERE status = ? GROUP BY predicate) ' +
      'ORDER BY predicate, status',
  )
  .all('superseded');
for (const row of chained) process.stdout.write(`  [${row.status}] ${row.predicate}: ${row.value}\n`);

const episodes = db.prepare('SELECT COUNT(*) AS total FROM episodes').get();
process.stdout.write(`\nepisodes: ${episodes.total}\n`);

db.close();
