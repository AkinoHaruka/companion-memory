/**
 * Companion memory predicate vocabulary.
 *
 * This file declares *which* predicate keys exist, grouped by domain. The
 * behavioural half of every predicate (cardinality, sensitivity, whether a
 * model may build an inference on it, and how it may be mentioned) lives in
 * `predicates.ts`.
 *
 * Why the vocabulary is data instead of a type-only union: the registry must
 * be verifiable at runtime. `predicates.test.ts` asserts that the vocabulary
 * and the registry describe exactly the same key set, so a key added to one
 * and forgotten in the other fails the build instead of silently becoming
 * unreachable.
 *
 * Design note (DESIGN.md §3.0): a controlled vocabulary solves the
 * *classification* problem. It does not solve the *record identity* problem —
 * that is what `cardinality` is for.
 */

/** Relationship-native domains. `misc` is the single global escape hatch. */
export const PREDICATE_DOMAINS = [
  "identity",
  "boundary",
  "communication",
  "support",
  "advice",
  "goal",
  "open_loop",
  "ritual",
  "person",
  "relationship",
  "misc",
] as const;

export type PredicateDomain = (typeof PREDICATE_DOMAINS)[number];

/**
 * The one global escape hatch.
 *
 * Every domain's unclassifiable cases collapse here instead of growing a
 * per-domain `other` subject. A per-domain `other` would silently rebuild the
 * free-text fragmentation this design exists to remove; one shared `misc`
 * makes the failure rate measurable (a `misc` ratio above 15% is a hard signal
 * that the vocabulary is mismatched), and records filed under it never
 * supersede anything (invariant I2) so a misclassification degrades to "one
 * more misc row" rather than "a destroyed fact".
 */
export const MISC_PREDICATE = "misc.unclassified" as const;

export const PREDICATE_KEYS = {
  identity: [
    "identity.name",
    "identity.pronouns",
    "identity.timezone",
    "identity.locale",
    "identity.location",
    "identity.occupation",
    "identity.role",
    "identity.language",
    "identity.age",
  ],
  boundary: [
    "boundary.prohibition",
    "boundary.safety_limit",
    "boundary.privacy_rule",
    "boundary.refusal",
    "boundary.topic_avoid",
    "boundary.soft_preference",
  ],
  communication: [
    "communication.language",
    "communication.format",
    "communication.verbosity",
    "communication.tone",
    "communication.interaction_style",
  ],
  support: [
    "support.presence_style",
    "support.when_distressed",
    "support.advice_permission",
    "support.physical_context",
  ],
  advice: [
    "advice.directness",
    "advice.reasoning_depth",
    "advice.when_to_offer_steps",
  ],
  goal: [
    "goal.long_term_objective",
    "goal.current_focus",
    "goal.aspiration",
    "goal.constraint",
  ],
  open_loop: [
    "open_loop.pending_action",
    "open_loop.waiting_on",
    "open_loop.promised_followup",
    "open_loop.deadline",
  ],
  ritual: [
    "ritual.recurring_activity",
    "ritual.frequency",
    "ritual.trigger",
  ],
  person: [
    "person.name",
    "person.relation_label",
    "person.occupation",
    "person.age",
  ],
  relationship: [
    "relationship.type",
    "relationship.closeness",
    "relationship.contact_frequency",
  ],
  misc: [MISC_PREDICATE],
} as const satisfies Record<PredicateDomain, readonly string[]>;

/**
 * Every predicate key in the vocabulary, as a union of string literals.
 *
 * `satisfies` above keeps the literal types while still checking that every
 * domain is present and that each entry is a string.
 */
export type PredicateKey = (typeof PREDICATE_KEYS)[PredicateDomain][number];

export const ALL_PREDICATE_KEYS: readonly PredicateKey[] = PREDICATE_DOMAINS.flatMap(
  (domain) => PREDICATE_KEYS[domain] as readonly PredicateKey[],
);

/** Domains whose records describe an entity other than the user. */
export const ENTITY_BEARING_DOMAINS: readonly PredicateDomain[] = ["person", "relationship"];

/**
 * Split a predicate key into its domain and subject.
 *
 * Returns `null` for a malformed key rather than throwing: callers at a trust
 * boundary (extractor output, migration input) need to *report* a bad key, not
 * crash on it.
 */
export function splitPredicate(
  key: string,
): { domain: PredicateDomain; subject: string } | null {
  const separator = key.indexOf(".");
  if (separator <= 0 || separator === key.length - 1) return null;
  const domain = key.slice(0, separator);
  if (!isPredicateDomain(domain)) return null;
  return { domain, subject: key.slice(separator + 1) };
}

export function isPredicateDomain(value: unknown): value is PredicateDomain {
  return typeof value === "string" && (PREDICATE_DOMAINS as readonly string[]).includes(value);
}

export function isPredicateKey(value: unknown): value is PredicateKey {
  return typeof value === "string" && (ALL_PREDICATE_KEYS as readonly string[]).includes(value);
}
