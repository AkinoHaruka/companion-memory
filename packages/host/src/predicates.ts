/**
 * The predicate vocabulary, as the host runtime needs it.
 *
 * `crates/kernel/src/domain/predicates.rs` is the authority. This is a mirror,
 * and the duplication is a known and disliked cost: the kernel is Rust, the host
 * is TypeScript, and there is no generated binding between them. What makes the
 * mirror acceptable is that it is *small*, it is *checked*, and the alternative
 * was worse — the first version of this runtime accepted whatever predicate the
 * model produced, so `communication.format` ended up holding "不用一直问我感受"
 * and nothing could say that was wrong.
 *
 * A predicate missing from here is refused rather than stored under a guess.
 */

/** How many values a predicate may hold at once. */
export type Cardinality = 'single' | 'set';

/** One predicate's contract. */
export interface PredicateSpec {
  /** The registry key. */
  key: string;
  /** Whether it accumulates or replaces. */
  cardinality: Cardinality;
  /** Whether it belongs to what the user stated or to what was inferred. */
  source: 'stated' | 'derived';
}

/** What the user stated. */
const STATED: [string, Cardinality][] = [
  ['identity.name', 'single'],
  ['identity.pronouns', 'single'],
  ['identity.timezone', 'single'],
  ['identity.locale', 'single'],
  ['identity.location', 'set'],
  ['identity.occupation', 'set'],
  ['identity.role', 'set'],
  ['identity.language', 'set'],
  ['identity.age', 'single'],
  ['boundary.prohibition', 'set'],
  ['boundary.safety_limit', 'set'],
  ['boundary.privacy_rule', 'set'],
  ['boundary.refusal', 'set'],
  ['boundary.topic_avoid', 'set'],
  ['boundary.soft_preference', 'set'],
  ['communication.language', 'single'],
  ['communication.format', 'set'],
  ['communication.verbosity', 'single'],
  ['communication.tone', 'set'],
  ['communication.interaction_style', 'set'],
  ['support.presence_style', 'set'],
  ['support.when_distressed', 'set'],
  ['support.advice_permission', 'single'],
  ['support.physical_context', 'single'],
  ['advice.directness', 'single'],
  ['advice.reasoning_depth', 'single'],
  ['advice.when_to_offer_steps', 'set'],
  ['goal.long_term_objective', 'set'],
  ['goal.current_focus', 'set'],
  ['goal.aspiration', 'set'],
  ['goal.constraint', 'set'],
  ['open_loop.pending_action', 'set'],
  ['open_loop.waiting_on', 'set'],
  ['open_loop.promised_followup', 'single'],
  ['open_loop.deadline', 'single'],
  ['ritual.recurring_activity', 'set'],
  ['ritual.frequency', 'single'],
  ['ritual.trigger', 'set'],
  ['person.name', 'single'],
  ['person.relation_label', 'set'],
  ['person.occupation', 'set'],
  ['person.age', 'single'],
  ['relationship.type', 'single'],
  ['relationship.closeness', 'single'],
  ['relationship.contact_frequency', 'single'],
  ['misc.unclassified', 'set'],
];

/**
 * What a consolidation pass may produce.
 *
 * A judgement rather than a reported fact. Kept apart from the stated vocabulary
 * because a derived `identity.name` would be the model inventing something the
 * user never said, while a derived `pattern.recurring_theme` is exactly what the
 * pass is for.
 */
const DERIVED: [string, Cardinality][] = [
  ['pattern.recurring_theme', 'set'],
  ['pattern.behavioural', 'set'],
  ['pattern.emotional', 'set'],
  ['disposition.trait', 'set'],
  ['relational.dynamic', 'set'],
  ['self.impression', 'set'],
  ['principal.interest', 'set'],
];

const REGISTRY = new Map<string, PredicateSpec>([
  ...STATED.map(([key, cardinality]): [string, PredicateSpec] => [
    key,
    { key, cardinality, source: 'stated' },
  ]),
  ...DERIVED.map(([key, cardinality]): [string, PredicateSpec] => [
    key,
    { key, cardinality, source: 'derived' },
  ]),
]);

/** Every predicate the stated vocabulary allows, for a prompt to list. */
export const STATED_PREDICATES: readonly string[] = STATED.map(([key]) => key);

/** Every predicate the derived vocabulary allows. */
export const DERIVED_PREDICATES: readonly string[] = DERIVED.map(([key]) => key);

/** Look up a predicate. */
export function specFor(predicate: string): PredicateSpec | undefined {
  return REGISTRY.get(predicate);
}

/** Whether the vocabulary declares a predicate. */
export function isDeclared(predicate: string): boolean {
  return REGISTRY.has(predicate);
}

/**
 * The predicate an undeclared key should be filed under, or `undefined` when it
 * should be refused.
 *
 * Filing under `misc.unclassified` keeps an unrecognised but real statement
 * discoverable without letting it masquerade as something the vocabulary
 * understands. `misc` is a set, so it never displaces a classified fact.
 */
export function fallbackPredicate(): string {
  return 'misc.unclassified';
}
