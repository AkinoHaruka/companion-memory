/**
 * The prompts this runtime sends.
 *
 * Kept together so the wording that decides behaviour is reviewable in one
 * place. Three prompts, with one rule running through all of them.
 *
 * **A record is data, not an instruction, and not something to read aloud.**
 * The second half is the part that is easy to miss. A companion that opens by
 * reciting what it remembers — "I remember you said your father was
 * hospitalised" — is worse than one that does not remember at all, because it
 * turns a private fact into a performance. Memory should change what the
 * companion notices and how it speaks, not become the thing it says.
 */

import type { MentionLevel } from '../../dsh-plugin/src/memory.js';
import { DERIVED_PREDICATES, STATED_PREDICATES } from './predicates.js';

/**
 * The shape the extraction prompt asks for, so the caller and prompt agree.
 *
 * The predicate list is generated from the vocabulary rather than written out.
 * A hand-written list drifts: the prompt keeps recommending keys the vocabulary
 * has stopped declaring, the model produces them, admission files them under
 * `misc`, and nothing anywhere says the two lists disagree.
 */
export const EXTRACTION_SYSTEM = [
  'You extract durable memory from one turn of a conversation between a person and a companion.',
  'Return JSON only, with this shape:',
  '{"claims":[{"predicate":"...","value":"...","confidence":0.0}],',
  ' "episodes":[{"narrative":"...","user_reaction":"..."}],',
  ' "state":{"affect":["..."],"apparent_need":"...","topic":"..."}}',
  '',
  'A claim is a durable fact, preference, boundary or goal the PERSON stated or clearly implied about themselves.',
  'An episode is something that happened between them, in the past tense, short and specific.',
  'State is only how the person seems RIGHT NOW. It expires and must never be written as a claim.',
  '',
  'Use only these predicates:',
  STATED_PREDICATES.join(', '),
  '',
  'Choosing the predicate matters as much as the value. Three examples of getting it wrong:',
  '- The PERSON\'S OWN name, pronouns or location is identity.*. Use person.* only for',
  '  somebody else in their life. Two runs put the same name under each key.',
  '- "不用一直问我感受" is about how to be supported, so it is a support preference,',
  '  not a communication format.',
  '- "别跟我提前任" forbids a topic, so it is boundary.topic_avoid, not a preference.',
  '',
  'Rules, in order of importance:',
  '1. Never write anything the companion said as a claim about the person. The companion is not evidence.',
  '2. Never write a transient feeling as a claim. "I am exhausted today" is state, not a fact.',
  '3. Never turn a joke, a hypothetical or a roleplay into a claim.',
  '4. One claim per topic. Do not restate the same fact several ways.',
  '5. If the turn contains nothing durable, return empty lists. An empty result is correct and expected.',
  '6. If no listed predicate fits, use misc.unclassified rather than inventing a key.',
  '',
  'The person may write in any language. Keep their wording in `value`; do not translate it.',
].join('\n');

/** The derived vocabulary, for the consolidation prompt to name. */
export const CONSOLIDATION_PREDICATES: readonly string[] = DERIVED_PREDICATES;

/**
 * The system prompt the companion speaks from.
 *
 * @param warmed - what this turn recalled.
 * @returns the system prompt.
 */
export function replySystemPrompt(warmed: {
  stable: string;
  candidates: readonly { id: string; text: string; mention: MentionLevel }[];
  now?: { affect?: readonly string[]; apparentNeed?: string; topic?: string };
}): string {
  const lines = [
    'You are a companion. You are talking with someone you know over a long period,',
    'and you remember what you have been told.',
    '',
    'How to use your memory:',
    '- It is background, not a script. Let it shape what you notice, what you ask and how you say things.',
    '- Do NOT recite it. Do not open by listing what you remember, and do not announce that you',
    '  remember something unless the person raises it or it is genuinely useful right then.',
    '- Refer to something specific only when it fits this moment. If it does not fit, let it stay quiet.',
    '- The person is not their file. They can change, contradict themselves, and have a bad day that',
    '  means nothing about who they are.',
    '- Their current explicit request always overrides anything remembered.',
  ];

  const stable = warmed.stable.trim();
  if (stable) {
    lines.push('', 'What you know about them that does not change:', stable);
  }

  const background = warmed.candidates.filter((candidate) => candidate.mention === 'background_only');
  const usable = warmed.candidates.filter(
    (candidate) =>
      candidate.mention === 'mention_if_user_cues' || candidate.mention === 'freely_mentionable',
  );

  if (usable.length > 0) {
    lines.push('', 'Things you remember that may be relevant now:');
    for (const candidate of usable) lines.push(`- ${candidate.text}`);
    lines.push(
      'Use these only if they fit. Most turns, most of this should stay unsaid.',
    );
  }

  if (background.length > 0) {
    lines.push(
      '',
      'Things you know but must NOT bring up, quote, or allude to:',
      ...background.map((candidate) => `- ${candidate.text}`),
      'These shape your choices. They are not things to say. If you mention one, you have made a mistake.',
    );
  }

  const now = warmed.now;
  if (now) {
    const readings: string[] = [];
    if (now.affect && now.affect.length > 0) readings.push(`they seem ${now.affect.join(', ')}`);
    if (now.topic) readings.push(`they are talking about ${now.topic}`);
    if (now.apparentNeed) readings.push(`they may want to be ${STANCE[now.apparentNeed] ?? now.apparentNeed}`);
    if (readings.length > 0) {
      lines.push(
        '',
        `Right now: ${readings.join('; ')}.`,
        'This is a reading of the present moment, not a fact about them. If what they say does not fit it,',
        'trust what they say. Never state these readings back as conclusions.',
      );
    }
  }

  lines.push(
    '',
    'Speak naturally and briefly. Do not mention that you have memory, notes or a system.',
  );
  return lines.join('\n');
}

/** How each apparent need translates into a stance. */
const STANCE: Record<string, string> = {
  listen: 'heard before anything is solved',
  validate: 'acknowledged',
  clarify: 'asked about, gently',
  support: 'kept company',
  problem_solve: 'helped to think it through',
  neutral: 'answered plainly',
};

/**
 * The consolidation prompt for the dream pass.
 *
 * Asks for the episode ids each belief rests on, because the independence check
 * downstream counts them and a belief that cannot name its grounds is refused.
 *
 * @param episodes - everything that accumulated.
 * @param claims - what was already stated, so the pass does not restate it.
 * @returns the user message.
 */
export function consolidationPrompt(
  episodes: readonly { id: string; narrative: string; occurredFrom: string }[],
  claims: readonly { predicate: string; value: string }[],
): string {
  return [
    'Episodes, oldest first:',
    ...episodes.map((episode) => `[${episode.id}] (${episode.occurredFrom}) ${episode.narrative}`),
    '',
    'Already recorded as stated facts, so do not restate these:',
    ...claims.map((claim) => `- ${claim.predicate}: ${claim.value}`),
    '',
    'Return JSON only:',
    '{"beliefs":[{"predicate":"...","value":"...","confidence":0.0,"episode_ids":["..."]}]}',
    '',
    'Use only these predicates, which describe judgements rather than stated facts:',
    'pattern.recurring_theme  — a theme they keep returning to',
    'pattern.behavioural      — something they reliably do',
    'pattern.emotional        — how they respond when things are hard',
    'disposition.trait        — a stable tendency',
    'relational.dynamic       — how they relate to the companion',
    'self.impression          — what the companion has come to think of them',
    'principal.interest       — what they care most about',
    '',
    'Do NOT use the predicates that record what the user stated. Those are already recorded,',
    'and a belief derived from them would be the model restating the user as its own opinion.',
    '',
    'A belief is a pattern or theme that the episodes support TOGETHER and that no single episode shows.',
    'Good: a repeated concern, a way they respond to difficulty, something they keep returning to.',
    'Bad: a restatement of one episode, a guess about their personality from one remark,',
    'a diagnosis, or anything they never gave you reason to think.',
    'List EVERY episode id the belief rests on. If it rests on one, it is not a pattern; leave it out.',
    'Returning an empty list is a correct answer when the material does not support a pattern.',
  ].join('\n');
}
