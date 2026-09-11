/**
 * Companion memory predicate registry — the behavioural half of the vocabulary.
 *
 * A predicate key decides four things at once (DESIGN.md §3.0):
 *   1. the write path          — may a new value supersede an old one?
 *   2. the dedup key           — which records are even candidates to merge?
 *   3. whether a model may build an inference on it
 *   4. how it may be mentioned
 *
 * `predicate-keys.ts` owns *which* keys exist; this file owns *what they mean*.
 * `predicates.test.ts` asserts the two describe exactly the same key set.
 *
 * The registry is intentionally a flat static table rather than a nested
 * literal: it is reviewable row by row, and this exact shape ("static spec
 * table + lookup by key") ports to a Rust `static` table without redesign
 * (DESIGN.md §8).
 */

import {
  ALL_PREDICATE_KEYS,
  splitPredicate,
  type PredicateDomain,
  type PredicateKey,
} from "./predicate-keys.js";

// ---------------------------------------------------------------------------
// Vocabulary of the registry's own axes
// ---------------------------------------------------------------------------

/**
 * How many values a predicate may hold for one (entity, qualifier) key.
 *
 * This is the fix for the design's most severe defect: `kind + subject` is not
 * a memory primary key. "I design, and I also teach painting on weekends"
 * cannot have its second half supersede its first — so `occupation` is a set,
 * while `name` is not.
 */
export type Cardinality =
  /** Exactly one value; a new value supersedes the previous one. */
  | "single"
  /** Many values coexist; only equivalent duplicates merge. */
  | "set"
  /** One value *at a time*, but changes over time are expected and meaningful. */
  | "temporal_single";

/**
 * Coarse value shape, used for the pre-supersede type-compatibility check.
 *
 * Without this check a misclassified input destroys data silently: "I'm
 * thinking about moving cities" filed into the location predicate would
 * supersede "lives in Beijing", and nothing anywhere would report an error.
 * With it, the write is rejected and the record survives.
 */
export type ValueKind =
  | "text"
  | "enum"
  | "date"
  | "duration"
  | "number"
  | "entity_ref";

/** How a record may be surfaced. See DESIGN.md §3.6. */
export type MentionMode =
  | "background_only"
  | "mention_if_user_cues"
  | "freely_mentionable"
  | "never_surface";

export type Sensitivity = "low" | "medium" | "high";

export type Lifetime = "permanent" | "session" | "until_superseded";

export interface PredicateSpec {
  readonly key: PredicateKey;
  readonly domain: PredicateDomain;
  readonly cardinality: Cardinality;
  readonly kind: ValueKind;
  readonly sensitivity: Sensitivity;
  /**
   * Whether the model may build an `Inference` whose evidence includes a Claim
   * under this predicate (invariant I8).
   *
   * False for facts the user stated *about the relationship itself* — a
   * boundary is a constraint to respect, not evidence about who someone is —
   * and false for `misc`, so unclassified sludge cannot feed the inference
   * engine.
   */
  readonly inference_allowed: boolean;
  readonly mention_policy: MentionMode;
  readonly default_lifetime: Lifetime;
  /** Closed value set; only meaningful when `kind` is `enum`. */
  readonly enumDomain?: readonly string[];
  /** One line, for reviewers and for the UI that lists what is remembered. */
  readonly description: string;
}

// ---------------------------------------------------------------------------
// Enum domains
// ---------------------------------------------------------------------------

/**
 * Enum domains, keyed by **full predicate key**.
 *
 * Keying by subject alone was a defect: `relationship.type` has the subject
 * `type` while this table called the domain `relationship_type`, so the lookup
 * missed, `enumDomain` was omitted from the spec, and `checkValue` fell through
 * its `spec.enumDomain && ...` guard — silently accepting *any* string for a
 * closed vocabulary. Keying by full key makes that class of collision
 * impossible as the vocabulary grows.
 */
const ENUM_DOMAIN_BY_KEY: Record<string, readonly string[]> = {
  "identity.pronouns": ["she/her", "he/him", "they/them", "ask", "other"],
  "communication.format": ["prose", "bullets", "markdown", "plain", "code_heavy", "mixed"],
  "communication.verbosity": ["very_short", "short", "medium", "long", "adaptive"],
  "communication.tone": ["warm", "neutral", "direct", "playful", "formal", "gentle"],
  "communication.interaction_style": [
    "initiative_taking",
    "reactive",
    "socratic",
    "collaborative",
    "structured",
    "freeform",
  ],
  "support.presence_style": [
    "listen_first",
    "validate_first",
    "companionship",
    "practical_help",
    "space",
    "distraction",
  ],
  "support.when_distressed": [
    "listen",
    "validate",
    "clarify",
    "support",
    "problem_solve",
    "be_present_silently",
  ],
  "support.advice_permission": ["ask_before_advice", "advice_welcome", "no_advice_unless_asked"],
  "support.physical_context": ["mobile", "driving", "at_work", "in_public", "at_home", "unknown"],
  "advice.directness": ["very_direct", "direct", "gentle", "indirect"],
  "advice.reasoning_depth": ["conclusion_only", "brief_reasoning", "detailed_reasoning", "show_work"],
  "advice.when_to_offer_steps": ["on_request", "when_stuck", "proactively", "never"],
  "person.relation_label": [
    "partner",
    "spouse",
    "parent",
    "child",
    "sibling",
    "friend",
    "best_friend",
    "colleague",
    "manager",
    "report",
    "ex_partner",
    "therapist",
    "pet",
    "other",
  ],
  "relationship.type": [
    "family",
    "friend",
    "romantic",
    "professional",
    "acquaintance",
    "adversarial",
    "other",
  ],
  "relationship.closeness": ["very_close", "close", "moderate", "distant", "strained", "unknown"],
};

/** Closed enum domains, exposed for tests and for UI value pickers. */
export const ENUM_DOMAINS: Readonly<Record<string, readonly string[]>> = ENUM_DOMAIN_BY_KEY;

// ---------------------------------------------------------------------------
// Static table
// ---------------------------------------------------------------------------

type Row = readonly [
  Key: PredicateKey,
  Cardinality: Cardinality,
  Kind: ValueKind,
  Sensitivity: Sensitivity,
  InferenceAllowed: boolean,
  Mention: MentionMode,
  Lifetime: Lifetime,
  Description: string,
];

/**
 * Column order matches `Row` above.
 *
 * `misc.unclassified` is deliberately the one predicate that never supersedes
 * (invariant I2) and never feeds inferences (invariant I8).
 */
const ROWS: readonly Row[] = [
  // -- identity ------------------------------------------------------------
  ["identity.name", "temporal_single", "text", "high", false, "freely_mentionable", "permanent", "How the user is addressed."],
  ["identity.pronouns", "single", "enum", "high", false, "freely_mentionable", "permanent", "Pronouns the user stated."],
  ["identity.timezone", "single", "text", "high", false, "freely_mentionable", "permanent", "IANA timezone or equivalent."],
  ["identity.locale", "single", "text", "medium", false, "freely_mentionable", "permanent", "Language and region formatting preference."],
  ["identity.location", "set", "entity_ref", "high", false, "mention_if_user_cues", "until_superseded", "A place tied to the user; the qualifier distinguishes current, home and work."],
  ["identity.occupation", "set", "text", "high", true, "mention_if_user_cues", "until_superseded", "What the user does; a set allows concurrent roles."],
  ["identity.role", "set", "text", "high", true, "mention_if_user_cues", "until_superseded", "Roles the user holds, including informal ones."],
  ["identity.language", "set", "text", "low", false, "freely_mentionable", "permanent", "Languages the user speaks or writes."],
  ["identity.age", "temporal_single", "number", "high", false, "never_surface", "until_superseded", "Birth year or age. Never raised unprompted."],

  // -- boundary ------------------------------------------------------------
  // A boundary is a constraint to obey, not a fact to recite, so nothing here
  // is freely mentionable and nothing here may seed an inference.
  ["boundary.prohibition", "set", "text", "high", false, "background_only", "permanent", "An explicit do-not-do instruction."],
  ["boundary.safety_limit", "set", "text", "high", false, "background_only", "permanent", "A safety limit the companion must not cross."],
  ["boundary.privacy_rule", "set", "text", "high", false, "background_only", "permanent", "What must not be stored, repeated or shared."],
  ["boundary.refusal", "set", "text", "high", false, "background_only", "permanent", "A topic or action the user refused."],
  ["boundary.topic_avoid", "set", "text", "high", false, "background_only", "permanent", "Topics to handle with care or not raise."],
  ["boundary.soft_preference", "set", "text", "medium", false, "background_only", "until_superseded", "A weak do-not-do; repeated statements may promote it."],

  // -- communication -------------------------------------------------------
  ["communication.language", "single", "text", "low", false, "freely_mentionable", "permanent", "Language the companion should reply in."],
  ["communication.format", "set", "enum", "low", false, "freely_mentionable", "until_superseded", "Preferred reply shape."],
  ["communication.verbosity", "single", "enum", "low", false, "freely_mentionable", "until_superseded", "Preferred reply length."],
  ["communication.tone", "set", "enum", "medium", false, "freely_mentionable", "until_superseded", "Preferred register."],
  ["communication.interaction_style", "set", "enum", "medium", false, "freely_mentionable", "until_superseded", "Preferred conversational stance."],

  // -- support -------------------------------------------------------------
  // Stated support preferences orient behaviour; phrasing them back at the
  // user would read as clinical, hence mention_if_user_cues.
  ["support.presence_style", "set", "enum", "medium", false, "mention_if_user_cues", "until_superseded", "What kind of presence the user wants."],
  ["support.when_distressed", "set", "enum", "medium", false, "mention_if_user_cues", "until_superseded", "What to do when the user is struggling."],
  ["support.advice_permission", "single", "enum", "medium", false, "mention_if_user_cues", "until_superseded", "Whether to ask before offering advice."],
  ["support.physical_context", "temporal_single", "enum", "high", false, "never_surface", "session", "Being on mobile or in public; session-scoped."],

  // -- advice --------------------------------------------------------------
  ["advice.directness", "single", "enum", "low", false, "mention_if_user_cues", "until_superseded", "How blunt to be."],
  ["advice.reasoning_depth", "single", "enum", "low", false, "mention_if_user_cues", "until_superseded", "How much reasoning to show."],
  ["advice.when_to_offer_steps", "set", "enum", "low", false, "mention_if_user_cues", "until_superseded", "When concrete steps are welcome."],

  // -- goal ----------------------------------------------------------------
  ["goal.long_term_objective", "set", "text", "medium", true, "mention_if_user_cues", "until_superseded", "A durable desired outcome."],
  ["goal.current_focus", "set", "text", "medium", true, "freely_mentionable", "until_superseded", "What the user is actively working on."],
  ["goal.aspiration", "set", "text", "high", true, "mention_if_user_cues", "until_superseded", "A hoped-for future, possibly not stated publicly."],
  ["goal.constraint", "set", "text", "medium", false, "background_only", "until_superseded", "A limit on how a goal may be pursued."],

  // -- open_loop -----------------------------------------------------------
  // Deadlines and promises are temporal_single: keeping every past deadline
  // active would make the surfacing pool grow without bound, and the trigger
  // only ever needs the live one.
  ["open_loop.pending_action", "set", "text", "medium", true, "freely_mentionable", "until_superseded", "Something the user still has to do."],
  ["open_loop.waiting_on", "set", "text", "medium", true, "mention_if_user_cues", "until_superseded", "Something the user is waiting for."],
  ["open_loop.promised_followup", "temporal_single", "text", "medium", false, "mention_if_user_cues", "until_superseded", "What the companion said it would follow up on. A user-facing commitment, never evidence about the user."],
  ["open_loop.deadline", "temporal_single", "date", "medium", true, "mention_if_user_cues", "until_superseded", "A dated commitment; drives authorised time triggers."],

  // -- ritual --------------------------------------------------------------
  // A habit the *user stated* is a Claim. Only a pattern the model *observed*
  // belongs to the Inference layer.
  ["ritual.recurring_activity", "set", "text", "low", true, "freely_mentionable", "until_superseded", "A recurrent activity the user described."],
  ["ritual.frequency", "single", "text", "low", false, "freely_mentionable", "until_superseded", "How often the ritual happens."],
  ["ritual.trigger", "set", "text", "low", false, "mention_if_user_cues", "until_superseded", "What precedes or prompts the ritual."],

  // -- person --------------------------------------------------------------
  ["person.name", "single", "text", "medium", true, "freely_mentionable", "permanent", "Name of a person in the user's life."],
  ["person.relation_label", "set", "enum", "medium", true, "freely_mentionable", "until_superseded", "How that person relates to the user."],
  ["person.occupation", "set", "text", "medium", true, "mention_if_user_cues", "until_superseded", "What that person does."],
  ["person.age", "temporal_single", "number", "high", true, "never_surface", "until_superseded", "That person's age or birth year."],

  // -- relationship --------------------------------------------------------
  // Facts about a dyad. The *dynamic* of a relationship is observed over time
  // and therefore belongs to the Inference layer, not here.
  ["relationship.type", "single", "enum", "medium", true, "mention_if_user_cues", "until_superseded", "Category of the relationship."],
  ["relationship.closeness", "single", "enum", "high", true, "mention_if_user_cues", "until_superseded", "How close the user considers it."],
  ["relationship.contact_frequency", "single", "text", "medium", true, "mention_if_user_cues", "until_superseded", "How often they are in touch."],

  // -- misc ----------------------------------------------------------------
  ["misc.unclassified", "set", "text", "high", false, "mention_if_user_cues", "until_superseded", "Unclassified user statements. Never supersedes, never seeds inference."],
];

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

function specFromRow(row: Row): PredicateSpec {
  const [key, cardinality, kind, sensitivity, inferenceAllowed, mention, lifetime, description] =
    row;
  const parsed = splitPredicate(key);
  if (!parsed) throw new Error(`predicate key is malformed: ${key}`);
  const enumDomain = kind === "enum" ? ENUM_DOMAIN_BY_KEY[key] : undefined;
  if (kind === "enum" && !enumDomain) {
    // Fail loudly at construction. The previous subject-keyed lookup missed
    // silently, which disabled enum validation for that predicate without any
    // signal anywhere.
    throw new Error(`enum predicate has no declared domain: ${key}`);
  }
  return {
    key,
    domain: parsed.domain,
    cardinality,
    kind,
    sensitivity,
    inference_allowed: inferenceAllowed,
    mention_policy: mention,
    default_lifetime: lifetime,
    ...(enumDomain ? { enumDomain } : {}),
    description,
  };
}

const REGISTRY: ReadonlyMap<string, PredicateSpec> = new Map(
  ROWS.map((row) => [row[0] as string, specFromRow(row)]),
);

/** Predicate keys the registry has no behaviour for. */
export function missingSpecs(): PredicateKey[] {
  return ALL_PREDICATE_KEYS.filter((key) => !REGISTRY.has(key));
}

/** Registry rows whose key the vocabulary does not declare. */
export function orphanSpecs(): string[] {
  const declared = new Set<string>(ALL_PREDICATE_KEYS);
  return [...REGISTRY.keys()].filter((key) => !declared.has(key));
}

export function allSpecs(): readonly PredicateSpec[] {
  return [...REGISTRY.values()];
}

export function specFor(key: string): PredicateSpec | undefined {
  return REGISTRY.get(key);
}

/** Throwing accessor for internal call sites that have already validated. */
export function requireSpec(key: string): PredicateSpec {
  const spec = REGISTRY.get(key);
  if (!spec) throw new Error(`unknown predicate: ${key}`);
  return spec;
}

export function cardinalityOf(key: string): Cardinality | undefined {
  return specFor(key)?.cardinality;
}

/** Whether a model may build an inference whose evidence includes this predicate. */
export function inferenceAllowedFor(key: string): boolean {
  return specFor(key)?.inference_allowed ?? false;
}

export function mentionPolicyFor(key: string): MentionMode {
  return specFor(key)?.mention_policy ?? "background_only";
}

// ---------------------------------------------------------------------------
// Type compatibility — the guard that makes a misclassification survivable
// ---------------------------------------------------------------------------

/**
 * Which value shapes may legitimately replace which.
 *
 * Asymmetric on purpose, and the asymmetry is load-bearing: a `text` value may
 * never overwrite a structured one. "Next Wednesday, sometime" arriving as
 * prose must not replace a resolved date, because that silently trades a
 * precise fact for a vague one and nothing anywhere reports it.
 *
 * Refinement in the other direction is fine — a resolved date replacing an
 * earlier prose description is an improvement.
 */
const COMPATIBLE_KINDS: Record<ValueKind, readonly ValueKind[]> = {
  text: ["text", "enum", "date", "duration", "number", "entity_ref"],
  enum: ["enum"],
  date: ["date", "duration"],
  duration: ["duration", "date"],
  number: ["number"],
  entity_ref: ["entity_ref"],
};

export function kindsCompatible(previous: ValueKind, next: ValueKind): boolean {
  return COMPATIBLE_KINDS[previous].includes(next);
}

/** Infer a coarse shape from a JS value, for callers without an explicit kind. */
export function inferValueKind(value: unknown): ValueKind | undefined {
  if (typeof value === "string") return "text";
  if (typeof value === "number") return "number";
  if (value instanceof Date) return "date";
  if (value && typeof value === "object") {
    const candidate = value as { kind?: unknown };
    if (candidate.kind === "entity_ref") return "entity_ref";
    if (candidate.kind === "date") return "date";
    if (candidate.kind === "duration") return "duration";
  }
  return undefined;
}

export type ValueCheck = { ok: true } | { ok: false; reason: string };

/**
 * Validate a candidate value against a predicate's declared shape.
 *
 * Deliberately permissive: this is a guard against silent data destruction,
 * not a form validator. Anything it cannot classify is rejected rather than
 * coerced, so an unparseable value stays in the candidate queue instead of
 * overwriting a good record.
 */
export function checkValue(spec: PredicateSpec, value: unknown): ValueCheck {
  if (value === undefined || value === null) {
    return { ok: false, reason: "value is empty" };
  }
  if (spec.kind === "enum") {
    if (typeof value !== "string") return { ok: false, reason: "enum value must be a string" };
    if (spec.enumDomain && !spec.enumDomain.includes(value)) {
      return { ok: false, reason: `value is not in the enum domain for ${spec.key}` };
    }
    return { ok: true };
  }
  if (spec.kind === "number") {
    if (typeof value === "number" && Number.isFinite(value)) return { ok: true };
    // A birth year stated as text is common; accept a numeric string.
    if (typeof value === "string" && /^-?\d+(\.\d+)?$/.test(value.trim())) return { ok: true };
    return { ok: false, reason: "numeric value expected" };
  }
  if (spec.kind === "date" || spec.kind === "duration") {
    const kind = inferValueKind(value);
    if (kind === "date" || kind === "duration" || kind === "text") return { ok: true };
    return { ok: false, reason: `${spec.kind} value expected` };
  }
  if (spec.kind === "entity_ref") {
    if (typeof value === "string" && value.trim().length > 0) return { ok: true };
    return { ok: false, reason: "entity reference expected" };
  }
  if (typeof value === "string") {
    return value.trim().length > 0 ? { ok: true } : { ok: false, reason: "value is blank" };
  }
  return { ok: false, reason: "text value expected" };
}
