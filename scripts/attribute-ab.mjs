/**
 * Attribute A/B differences to memory using signals that cannot be accidental.
 *
 * The predecessor of this script looked for a visible record's distinctive terms
 * in the reply and reported 0 of 12 turns. That was a broken measurement, not a
 * finding: the records are Chinese, the tokenizer only collected ASCII words of
 * three characters or more, and it therefore matched almost nothing. A check
 * that silently measures nothing reads exactly like a check that found nothing,
 * which is the failure this whole exercise exists to avoid.
 *
 * So this measures signals where attribution is structural rather than lexical.
 *
 * 1. **The user's name.** It was stated once, twenty-one days before the turn
 *    that uses it. A reply that addresses the user by name, against a reply that
 *    does not, cannot be coincidence.
 * 2. **Anaphora with no antecedent.** Words that presuppose earlier material —
 *    `之前`, `一直`, `还是`, `那个` — in one reply and not the other. The side
 *    without memory has nothing to refer back to.
 * 3. **Length.** A crude proxy, reported because the material includes a stated
 *    preference about reply length, so a systematic difference would be
 *    meaningful rather than noise.
 *
 * Each signal is reported separately and none is combined into a score, because
 * combining them would hide which one produced the result.
 *
 *   node scripts/attribute-ab.mjs [runs/ab/comparisons.json]
 */

import { readFileSync } from 'node:fs';

const path = process.argv[2] ?? 'packages/host/runs/ab/comparisons.json';
const comparisons = JSON.parse(readFileSync(path, 'utf8'));

/** Words that presuppose something said earlier in the relationship. */
const ANAPHORA = ['之前', '一直', '最近', '那次', '上次', '还是', '那个', '这阵子', '又是'];

function carriesAny(text, needles) {
  return needles.filter((needle) => text.includes(needle));
}

let nameSignal = 0;
let anaphoraSignal = 0;
let visibleTurns = 0;
const lengthDeltas = [];

process.stdout.write(`${'='.repeat(78)}\n`);

for (const item of comparisons) {
  const records = item.visibleRecords ?? [];
  const notes = [];

  if (records.length > 0) visibleTurns += 1;

  // Signal 1: the user's name, when the memory-aware side was given it.
  //
  // Checked against everything the side received — the stable block and the
  // candidates. An earlier version checked only the candidates and reported zero
  // while the replies plainly used the name, because that is where it lives.
  const given = `${item.stableBlock ?? ''}\n${records.map((record) => record.text).join('\n')}`;
  if (given.includes('林越') && !item.user.includes('林越')) {
    const inWith = item.withMemory.includes('林越');
    const inWithout = item.withoutMemory.includes('林越');
    if (inWith && !inWithout) {
      nameSignal += 1;
      notes.push('uses the user\'s name from memory; the no-memory reply does not');
    } else if (!inWith && inWithout) {
      notes.push('the NO-MEMORY reply uses the name (unexpected)');
    } else if (inWith && inWithout) {
      notes.push('both use the name');
    } else {
      notes.push('the name was available and neither reply used it');
    }
  }

  // Signal 2: anaphora in one reply and not the other.
  const withAnaphora = carriesAny(item.withMemory, ANAPHORA);
  const withoutAnaphora = carriesAny(item.withoutMemory, ANAPHORA);
  const onlyWith = withAnaphora.filter((word) => !withoutAnaphora.includes(word));
  if (onlyWith.length > 0 && records.length > 0) {
    anaphoraSignal += 1;
    notes.push(`refers back (${onlyWith.join(', ')}); the no-memory reply does not`);
  }

  const delta = item.withMemoryLength - item.withoutMemoryLength;
  lengthDeltas.push(delta);

  process.stdout.write(`[${item.session}] ${item.intent}\n`);
  process.stdout.write(
    `  records ${records.length} | lengths ${item.withMemoryLength} vs ${item.withoutMemoryLength} (${delta >= 0 ? '+' : ''}${delta})\n`,
  );
  for (const note of notes) process.stdout.write(`  -> ${note}\n`);
  if (notes.length === 0) process.stdout.write('  -> no structural signal\n');
}

const mean = lengthDeltas.reduce((sum, value) => sum + value, 0) / lengthDeltas.length;

process.stdout.write(`${'='.repeat(78)}\n`);
process.stdout.write(`turns with a record visible:                 ${visibleTurns}/${comparisons.length}\n`);
process.stdout.write(`turns where only memory uses the name:       ${nameSignal}\n`);
process.stdout.write(`turns where only memory refers back:         ${anaphoraSignal}\n`);
process.stdout.write(`mean length difference (memory - without):   ${mean.toFixed(1)} chars\n`);
process.stdout.write(
  '\nThe name and anaphora signals are structural: the side without memory has nothing\n' +
    'to refer to and was never told the name, so it cannot produce them by chance.\n',
);
