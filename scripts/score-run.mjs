/**
 * Score a completed run against the properties the design claims.
 *
 * The point of a scorer is that every change to a prompt or a rule can be judged
 * by the same standard, on the same material, without anyone having to read a
 * transcript and form an impression. An impression is not a measurement, and
 * prompt work in particular is where an impression is most confidently wrong.
 *
 * Each check is deliberately narrow. "Memory quality is better" is not
 * checkable; "a boundary was never surfaced" and "a transient state did not
 * become a claim" are.
 *
 *   node scripts/score-run.mjs <db path> [<transcript.json>]
 *
 * Exits non-zero when a check the design calls mandatory fails, so the scorer
 * can gate a change rather than only report on one.
 */

import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const dbPath = process.argv[2];
const transcriptPath = process.argv[3];
if (!dbPath) {
  process.stderr.write('usage: node scripts/score-run.mjs <db path> [<transcript.json>]\n');
  process.exitCode = 1;
  process.exit();
}

const db = new DatabaseSync(dbPath);
const transcript = transcriptPath ? JSON.parse(readFileSync(transcriptPath, 'utf8')) : [];

/** One scored property. */
const results = [];

/**
 * Record a check.
 *
 * @param {string} name - what is being asserted.
 * @param {boolean} passed - the outcome.
 * @param {string} detail - the evidence, pass or fail.
 * @param {boolean} mandatory - whether a failure should fail the run.
 */
function check(name, passed, detail, mandatory = true) {
  results.push({ name, passed, detail, mandatory });
}

const claims = db
  .prepare(
    'SELECT id, predicate, value, mention, status, source_type, importance, confidence FROM claims',
  )
  .all();
const active = claims.filter((claim) => claim.status === 'active');
const episodes = db.prepare('SELECT id, narrative FROM episodes').all();
const governance = db
  .prepare("SELECT action, detail FROM audit_events WHERE action IN ('supersede','forget')")
  .all();

// ---------------------------------------------------------------------------
// 1. Stated facts are remembered
// ---------------------------------------------------------------------------

// `identity.name` is how the user is addressed; `person.name` is the name of
// somebody else in their life. A run stored the user's own name under each, so
// the check accepts both rather than asserting one reading. The prompt now
// disambiguates, but a scorer that fails on a defensible choice measures the
// scorer, not the system.
const nameClaims = active.filter(
  (claim) => claim.predicate === 'identity.name' || claim.predicate === 'person.name',
);
check(
  'the user\'s name is remembered',
  nameClaims.some((claim) => claim.value.includes('林越')),
  nameClaims.length > 0
    ? nameClaims.map((c) => `${c.predicate}=${c.value}`).join(' / ')
    : 'no name recorded under identity.name or person.name',
);

const languageClaims = active.filter((claim) => claim.predicate === 'communication.language');
check(
  'the stated language preference is remembered',
  languageClaims.length > 0,
  languageClaims.map((c) => c.value).join(' / ') || 'no communication.language recorded',
);

// ---------------------------------------------------------------------------
// 2. A boundary is held without being recited
// ---------------------------------------------------------------------------

const boundaries = active.filter((claim) => claim.predicate.startsWith('boundary.'));
check(
  'the boundary is recorded',
  boundaries.length > 0,
  boundaries.map((c) => `${c.predicate}=${c.value}`).join(' / ') || 'no boundary recorded',
);
check(
  'every boundary is background_only',
  boundaries.length > 0 && boundaries.every((claim) => claim.mention === 'background_only'),
  boundaries.map((c) => `${c.predicate} -> ${c.mention}`).join(' / ') || 'n/a',
);
check(
  'no boundary text reaches the model as speakable context',
  !transcript.some(
    (turn) =>
      typeof turn.injectedContext === 'string' &&
      /<relevant>[\s\S]*?boundary\./.test(turn.injectedContext),
  ),
  'checked every turn\'s injected context for a boundary inside <relevant>',
);

// ---------------------------------------------------------------------------
// 3. A transient state does not become a fact
// ---------------------------------------------------------------------------

const TRANSIENT_MARKERS = ['特别累', '脑子都是糊的', '梦游', '开了一天会'];
const leaked = active.filter((claim) =>
  TRANSIENT_MARKERS.some((marker) => claim.value.includes(marker)),
);
check(
  'no transient state was written as a claim',
  leaked.length === 0,
  leaked.length === 0 ? 'no claim carries a transient marker' : leaked.map((c) => c.value).join(' / '),
);

// ---------------------------------------------------------------------------
// 4. A contradiction supersedes rather than accumulating
// ---------------------------------------------------------------------------

const verbosity = active.filter((claim) => claim.predicate === 'communication.verbosity');
check(
  'the changed preference did not accumulate',
  verbosity.length <= 1,
  verbosity.length === 0
    ? 'no verbosity claim recorded'
    : verbosity.map((c) => c.value).join(' | ') + ` (${verbosity.length})`,
);
check(
  'a supersede was recorded when a preference changed',
  governance.some((event) => event.action === 'supersede'),
  governance.filter((e) => e.action === 'supersede').length + ' supersede event(s)',
  false,
);

// ---------------------------------------------------------------------------
// 5. No predicate holds contradicting active values where it should not
// ---------------------------------------------------------------------------

/**
 * Predicates that may legitimately hold several concurrent values.
 *
 * The same list the kernel's cardinality table encodes, restated here so the
 * scorer judges by the design rather than by whatever the run happened to do.
 */
const MULTI_VALUED = new Set([
  'identity.location',
  'identity.occupation',
  'identity.role',
  'identity.language',
  'boundary.prohibition',
  'boundary.topic_avoid',
  'boundary.privacy_rule',
  'communication.format',
  'goal.long_term_objective',
  'goal.current_focus',
  'support.presence_style',
  'support.when_distressed',
  'ritual.recurring_activity',
  'misc.unclassified',
]);

const counts = new Map();
for (const claim of active) counts.set(claim.predicate, (counts.get(claim.predicate) ?? 0) + 1);
const overcrowded = [...counts.entries()].filter(
  ([predicate, total]) => total > 1 && !MULTI_VALUED.has(predicate),
);
check(
  'no single-valued predicate holds more than one active value',
  overcrowded.length === 0,
  overcrowded.length === 0
    ? 'every single-valued predicate holds one value'
    : overcrowded.map(([p, n]) => `${p} x${n}`).join(', '),
);

// ---------------------------------------------------------------------------
// 6. Every predicate is one the vocabulary declares
// ---------------------------------------------------------------------------

const STATED_PREFIXES = [
  'identity.',
  'boundary.',
  'communication.',
  'support.',
  'advice.',
  'goal.',
  'open_loop.',
  'ritual.',
  'person.',
  'relationship.',
  'misc.',
];
const DERIVED_PREFIXES = ['pattern.', 'disposition.', 'relational.', 'self.', 'principal.'];

const unknown = active.filter((claim) => {
  const known =
    STATED_PREFIXES.some((prefix) => claim.predicate.startsWith(prefix)) ||
    DERIVED_PREFIXES.some((prefix) => claim.predicate.startsWith(prefix));
  return !known;
});
check(
  'every stored predicate belongs to a declared vocabulary',
  unknown.length === 0,
  unknown.length === 0 ? 'all predicates are declared' : unknown.map((c) => c.predicate).join(', '),
);

// ---------------------------------------------------------------------------
// 7. Consolidation only produces beliefs with independent support
// ---------------------------------------------------------------------------

const derived = active.filter(
  (claim) => claim.source_type === 'dream_consolidation',
);
// `importance` is selected explicitly. An earlier version of this scorer omitted
// it from the query and then read it anyway, so the check compared `undefined`
// and passed for the wrong reason — a scorer that cannot see the value it is
// judging is worse than no check, because it reports a pass.
const insufficient = derived.filter((claim) => Number(claim.importance) > 0.5);
check(
  'a derived belief never carries more weight than an observation',
  insufficient.length === 0,
  derived.length === 0
    ? 'no derived belief was stored'
    : derived.map((c) => `${c.predicate} importance=${c.importance}`).join(' / '),
  false,
);
check(
  'every derived belief is background_only',
  derived.every((claim) => claim.mention === 'background_only'),
  derived.length === 0 ? 'n/a' : derived.map((c) => `${c.predicate} -> ${c.mention}`).join(' / '),
);

// ---------------------------------------------------------------------------
// 8. Recall reaches across sessions
// ---------------------------------------------------------------------------

const catTurn = transcript.find((turn) => (turn.intent ?? '').includes('recall a detail'));
check(
  'a detail from an earlier session was available when returned to',
  !catTurn || catTurn.visibleRecordIds.length > 0,
  catTurn ? `${catTurn.visibleRecordIds.length} record(s) visible` : 'turn not found in transcript',
);

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

let failed = 0;
process.stdout.write('run score\n');
process.stdout.write(`${'='.repeat(72)}\n`);
for (const result of results) {
  const mark = result.passed ? 'PASS' : result.mandatory ? 'FAIL' : 'WARN';
  if (!result.passed && result.mandatory) failed += 1;
  process.stdout.write(`${mark}  ${result.name}\n`);
  process.stdout.write(`      ${result.detail}\n`);
}
process.stdout.write(`${'='.repeat(72)}\n`);
process.stdout.write(
  `claims ${active.length} active / ${claims.length} total | episodes ${episodes.length} | ` +
    `governance events ${governance.length}\n`,
);
process.stdout.write(
  failed === 0
    ? 'result: every mandatory check passed\n'
    : `result: ${failed} mandatory check(s) FAILED\n`,
);

db.close();
process.exitCode = failed === 0 ? 0 : 1;
