/**
 * Predicate vocabulary ↔ registry contract tests.
 *
 * `predicate-keys.ts` declares *which* keys exist; `predicates.ts` declares
 * *what each key means*. Almost every test here exists to make a silent
 * divergence between those two files impossible: a key that gains no behaviour
 * row, a row whose key was never declared, a boundary that becomes freely
 * mentionable, or an unclassified record that starts seeding inference.
 *
 * Three assertions deviate from the originally requested wording because the
 * source genuinely behaves differently. Each is marked `DEVIATION` below with
 * the real behaviour pinned instead of the requested one. The source was NOT
 * changed.
 */

import { describe, expect, it } from "vitest";
import {
  ALL_PREDICATE_KEYS,
  MISC_PREDICATE,
  PREDICATE_DOMAINS,
  PREDICATE_KEYS,
  isPredicateDomain,
  isPredicateKey,
  splitPredicate,
} from "./predicate-keys.js";
import {
  ENUM_DOMAINS,
  allSpecs,
  cardinalityOf,
  checkValue,
  inferenceAllowedFor,
  kindsCompatible,
  mentionPolicyFor,
  missingSpecs,
  orphanSpecs,
  requireSpec,
  specFor,
} from "./predicates.js";
import type { MentionMode, ValueKind } from "./predicates.js";

const KEY_SHAPE = /^[a-z_]+\.[a-z_]+$/;
const SNAKE_VALUE = /^[a-z0-9_]+$/;

const MENTION_MODES: readonly MentionMode[] = [
  "background_only",
  "mention_if_user_cues",
  "freely_mentionable",
  "never_surface",
];

const ALL_VALUE_KINDS: readonly ValueKind[] = [
  "text",
  "enum",
  "date",
  "duration",
  "number",
  "entity_ref",
];

/**
 * `identity.pronouns` is the one enum whose values are the fixed pronoun
 * spellings rather than snake_case (see the `ENUM_DOMAINS` doc comment in
 * `predicates.ts`: "Values are snake_case or the fixed pronoun spellings").
 * DEVIATION (minor, assertion 8): those three slash forms cannot satisfy the
 * requested `/^[a-z0-9_]+$/`, so the set is pinned explicitly here and the
 * regex is still enforced for every other enum value in the codebase.
 */
const PRONOUN_SPELLINGS = ["she/her", "he/him", "they/them", "ask", "other"];
const PRONOUN_SPELLING_SET = new Set(PRONOUN_SPELLINGS);

/**
 * FIXED DEFECT (was assertion 8): `relationship.type` was declared
 * `kind: "enum"` but resolved to no enum domain, because the row's subject is
 * `type` while the domain table named its entry `relationship_type`. The
 * lookup missed, the field was omitted, and `checkValue` fell through its
 * `spec.enumDomain && ...` guard — silently accepting any string for a closed
 * vocabulary.
 *
 * Two changes close it: domains are now keyed by full predicate key, and
 * `specFromRow` throws at construction when an enum row has no domain. This
 * stays as an explicit expectation so the class of bug cannot come back.
 */
const ENUM_SPECS_WITHOUT_DOMAIN: readonly string[] = [];

// The requested key `communication.topic_avoid` does not exist in the
// vocabulary, so the real topic-avoid predicate is used instead. Written as a
// lookup rather than a hardcoded key so this keeps working if the key moves.
const TOPIC_AVOID_KEY = isPredicateKey("communication.topic_avoid")
  ? "communication.topic_avoid"
  : "boundary.topic_avoid";

describe("vocabulary ↔ registry agreement", () => {
  it("declares no key without a spec row and no spec row without a key", () => {
    expect(missingSpecs()).toEqual([]);
    expect(orphanSpecs()).toEqual([]);
  });

  it("has exactly one spec per declared key (no duplicate rows)", () => {
    const specs = allSpecs();
    const keys = specs.map((spec) => spec.key);
    expect(specs.length).toBe(ALL_PREDICATE_KEYS.length);
    expect(new Set(keys).size).toBe(keys.length);
    // Guards the two assertions above against passing vacuously.
    expect(specs.length).toBeGreaterThan(0);
  });

  it("files every declared key under its own domain prefix", () => {
    for (const domain of PREDICATE_DOMAINS) {
      for (const key of PREDICATE_KEYS[domain]) {
        expect(isPredicateKey(key), `${key} must be a declared predicate key`).toBe(true);
        const parsed = splitPredicate(key);
        expect(parsed, `${key} must split`).not.toBeNull();
        expect(parsed?.domain, `${key} filed under ${domain}`).toBe(domain);
        expect(specFor(key)?.domain, `spec domain for ${key}`).toBe(domain);
      }
    }
  });

  it("flattens the vocabulary to ALL_PREDICATE_KEYS without loss or duplication", () => {
    const grouped = PREDICATE_DOMAINS.flatMap((domain) => [...PREDICATE_KEYS[domain]]);
    expect(grouped.slice().sort()).toEqual([...ALL_PREDICATE_KEYS].slice().sort());
    expect(new Set(ALL_PREDICATE_KEYS).size).toBe(ALL_PREDICATE_KEYS.length);
  });
});

describe("key shape", () => {
  it("uses `domain.subject` with lowercase-and-underscore segments", () => {
    for (const key of ALL_PREDICATE_KEYS) {
      expect(key, `${key} must match ${KEY_SHAPE}`).toMatch(KEY_SHAPE);
    }
  });

  it("round-trips every key through splitPredicate", () => {
    for (const key of ALL_PREDICATE_KEYS) {
      const parsed = splitPredicate(key);
      expect(parsed, `splitPredicate(${key}) must not be null`).not.toBeNull();
      if (!parsed) continue;
      expect(`${parsed.domain}.${parsed.subject}`, `round-trip of ${key}`).toBe(key);
      expect(isPredicateDomain(parsed.domain), `${parsed.domain} must be a domain`).toBe(true);
      // No key may carry a second separator into the subject.
      expect(parsed.subject).not.toContain(".");
    }
  });

  it("rejects malformed keys instead of guessing a domain", () => {
    expect(splitPredicate("identity")).toBeNull();
    expect(splitPredicate(".name")).toBeNull();
    expect(splitPredicate("identity.")).toBeNull();
    expect(splitPredicate("unknown.subject")).toBeNull();
    expect(splitPredicate("")).toBeNull();
  });

  it("recognises declared keys and domains only", () => {
    expect(isPredicateKey("identity.occupation")).toBe(true);
    expect(isPredicateKey(MISC_PREDICATE)).toBe(true);
    expect(isPredicateKey("nope.nope")).toBe(false);
    expect(isPredicateKey(null)).toBe(false);
    expect(isPredicateKey(7)).toBe(false);

    expect(isPredicateDomain("identity")).toBe(true);
    expect(isPredicateDomain("misc")).toBe(true);
    expect(isPredicateDomain("nope")).toBe(false);
    expect(isPredicateDomain(undefined)).toBe(false);
  });
});

describe("lookup", () => {
  it("returns the spec for a known key and undefined for an unknown one", () => {
    const occupation = specFor("identity.occupation");
    expect(occupation).toBeDefined();
    expect(occupation?.key).toBe("identity.occupation");
    expect(occupation?.domain).toBe("identity");
    expect(typeof occupation?.description).toBe("string");
    expect(occupation?.description.length).toBeGreaterThan(0);

    expect(specFor("nope.nope")).toBeUndefined();
    expect(specFor("identity")).toBeUndefined();
    expect(cardinalityOf("nope.nope")).toBeUndefined();
  });

  it("requireSpec throws on an unknown key and returns the spec for a known one", () => {
    expect(() => requireSpec("nope.nope")).toThrow(/unknown predicate/);
    expect(requireSpec("identity.occupation")).toBe(specFor("identity.occupation"));
  });

  it("mentionPolicyFor closes over an unknown key instead of opening up", () => {
    expect(mentionPolicyFor("identity.name")).toBe("freely_mentionable");
    expect(mentionPolicyFor("nope.nope")).toBe("background_only");
  });
});

describe("cardinality", () => {
  // A predicate must not supersede when it can legitimately hold several
  // values: "I design, and I also teach painting on weekends" is two rows.
  it("identity.occupation is a set, so concurrent roles coexist", () => {
    expect(cardinalityOf("identity.occupation")).toBe("set");
    expect(requireSpec("identity.occupation").cardinality).toBe("set");
  });

  it("topic avoidance is a set, so several avoided topics coexist", () => {
    expect(TOPIC_AVOID_KEY, "topic-avoid predicate must exist").toBe("boundary.topic_avoid");
    expect(cardinalityOf(TOPIC_AVOID_KEY)).toBe("set");
  });

  it("identity.name is temporal_single, so a rename does not erase history", () => {
    expect(cardinalityOf("identity.name")).toBe("temporal_single");
  });

  it("communication.verbosity is single, so a new preference supersedes", () => {
    expect(cardinalityOf("communication.verbosity")).toBe("single");
  });
});

describe("misc is inert", () => {
  it("exists, never supersedes beyond set semantics, and cannot seed inference", () => {
    const spec = specFor(MISC_PREDICATE);
    expect(spec).toBeDefined();
    expect(spec?.cardinality).toBe("set");
    expect(spec?.inference_allowed).toBe(false);
    expect(spec?.domain).toBe("misc");
    expect(inferenceAllowedFor(MISC_PREDICATE)).toBe(false);
    expect(specFor(MISC_PREDICATE)?.key).toBe("misc.unclassified");
  });
});

describe("boundary is not freely mentionable and cannot seed inference", () => {
  const boundarySpecs = allSpecs().filter((spec) => spec.domain === "boundary");

  it("covers every boundary predicate", () => {
    expect(boundarySpecs.length).toBe(PREDICATE_KEYS.boundary.length);
    expect(boundarySpecs.length).toBeGreaterThan(0);
  });

  it("makes every boundary predicate background_only and inference-free", () => {
    for (const spec of boundarySpecs) {
      expect(spec.mention_policy, `${spec.key} mention policy`).toBe("background_only");
      expect(spec.inference_allowed, `${spec.key} inference`).toBe(false);
      // The accessors must agree with the raw spec.
      expect(mentionPolicyFor(spec.key), `${spec.key} via mentionPolicyFor`).toBe("background_only");
      expect(inferenceAllowedFor(spec.key), `${spec.key} via inferenceAllowedFor`).toBe(false);
    }
  });
});

describe("mention-mode vocabulary is closed", () => {
  it("uses only the four declared mention modes", () => {
    const specs = allSpecs();
    expect(specs.length).toBeGreaterThan(0);
    for (const spec of specs) {
      expect(MENTION_MODES, `${spec.key} has mention_policy=${spec.mention_policy}`).toContain(
        spec.mention_policy,
      );
    }
  });
});

describe("enum specs carry a closed value domain", () => {
  const enumSpecs = allSpecs().filter((spec) => spec.kind === "enum");

  it("finds the enum specs", () => {
    expect(enumSpecs.length).toBeGreaterThan(0);
  });

  it("gives every enum spec a non-empty value domain", () => {
    const withoutDomain = enumSpecs
      .filter((spec) => !spec.enumDomain || spec.enumDomain.length === 0)
      .map((spec) => spec.key);
    // Closed vocabulary with no domain means checkValue accepts anything.
    expect(withoutDomain).toEqual(ENUM_SPECS_WITHOUT_DOMAIN);
  });

  it("rejects an out-of-domain value for the predicate that used to escape validation", () => {
    // Regression pin for the subject-keyed lookup bug: relationship.type
    // silently accepted every string.
    const relationshipType = requireSpec("relationship.type");
    expect(relationshipType.enumDomain).toBeDefined();
    expect(checkValue(relationshipType, "romantic").ok).toBe(true);
    const rejected = checkValue(relationshipType, "complicated");
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) expect(rejected.reason).toMatch(/enum domain/);
  });

  it("keeps each declared enum domain non-empty and snake_case", () => {
    for (const [name, values] of Object.entries(ENUM_DOMAINS)) {
      expect(values.length, `ENUM_DOMAINS.${name} must not be empty`).toBeGreaterThan(0);
      for (const value of values) {
        if (name === "identity.pronouns") {
          // The one deliberate exception: pronouns are conventional spellings
          // ("she/her"), not vocabulary values, and are pinned by their own test.
          expect(PRONOUN_SPELLING_SET.has(value), `pronoun spelling ${value}`).toBe(true);
          continue;
        }
        expect(value, `ENUM_DOMAINS.${name} value ${value}`).toMatch(SNAKE_VALUE);
      }
    }
  });

  it("keeps every spec enum value snake_case (pronoun spellings aside)", () => {
    for (const spec of enumSpecs) {
      const values = spec.enumDomain;
      if (!values) continue;
      for (const value of values) {
        if (spec.key === "identity.pronouns") {
          // DEVIATION (minor, assertion 8): fixed pronoun spellings contain "/".
          expect(PRONOUN_SPELLING_SET.has(value), `pronoun spelling ${value}`).toBe(true);
        } else {
          expect(value, `${spec.key} enum value ${value}`).toMatch(SNAKE_VALUE);
        }
      }
    }
  });
});

describe("kindsCompatible", () => {
  it("lets text stand in for any kind", () => {
    expect(kindsCompatible("text", "number")).toBe(true);
    expect(kindsCompatible("text", "entity_ref")).toBe(true);
    expect(kindsCompatible("text", "enum")).toBe(true);
  });

  it("is reflexive for every kind", () => {
    for (const kind of ALL_VALUE_KINDS) {
      expect(kindsCompatible(kind, kind), `${kind} -> ${kind}`).toBe(true);
    }
  });

  it("treats date and duration as interchangeable spellings of one slot", () => {
    expect(kindsCompatible("date", "duration")).toBe(true);
    expect(kindsCompatible("duration", "date")).toBe(true);
  });

  it("still rejects genuinely unrelated kind changes", () => {
    expect(kindsCompatible("number", "date")).toBe(false);
    expect(kindsCompatible("enum", "number")).toBe(false);
    expect(kindsCompatible("enum", "entity_ref")).toBe(false);
    expect(kindsCompatible("entity_ref", "enum")).toBe(false);
  });

  it("refuses to let prose overwrite a structured value", () => {
    // FIXED DEFECT (was a DEVIATION): every structured kind used to list
    // "text" as accepted, which made the relation fully symmetric and
    // contradicted the table's own doc comment. The consequence was that
    // "next Wednesday, sometime" arriving as prose would supersede a resolved
    // date. The asymmetry is the whole point of the table.
    expect(kindsCompatible("number", "text")).toBe(false);
    expect(kindsCompatible("enum", "text")).toBe(false);
    expect(kindsCompatible("date", "text")).toBe(false);
    expect(kindsCompatible("duration", "text")).toBe(false);
    expect(kindsCompatible("entity_ref", "text")).toBe(false);
  });

  it("is asymmetric for every structured kind", () => {
    for (const kind of ALL_VALUE_KINDS) {
      if (kind === "text") continue;
      expect(kindsCompatible("text", kind), `text -> ${kind}`).toBe(true);
      expect(kindsCompatible(kind, "text"), `${kind} -> text`).toBe(false);
    }
  });
});

describe("checkValue", () => {
  const verbosity = requireSpec("communication.verbosity");
  const age = requireSpec("identity.age");

  it("accepts an enum value inside the closed domain", () => {
    expect(verbosity.kind).toBe("enum");
    expect(verbosity.enumDomain).toContain("short");
    expect(checkValue(verbosity, "short").ok).toBe(true);
  });

  it("rejects an enum value outside the closed domain", () => {
    const result = checkValue(verbosity, "banana");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/enum domain/);
  });

  it("rejects empty and non-string enum values", () => {
    expect(checkValue(verbosity, null).ok).toBe(false);
    expect(checkValue(verbosity, undefined).ok).toBe(false);
    expect(checkValue(verbosity, "").ok).toBe(false);
    expect(checkValue(verbosity, 42).ok).toBe(false);
  });

  it("accepts a numeric value and a numeric string for a number predicate", () => {
    expect(age.kind).toBe("number");
    expect(checkValue(age, 1990).ok).toBe(true);
    // A birth year stated as text is common.
    expect(checkValue(age, "1990").ok).toBe(true);
  });

  it("rejects a non-numeric value for a number predicate", () => {
    const result = checkValue(age, "old");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/numeric/);
    expect(checkValue(age, null).ok).toBe(false);
  });
});

describe("inferenceAllowedFor defaults closed", () => {
  it("refuses inference on a name", () => {
    expect(inferenceAllowedFor("identity.name")).toBe(false);
    expect(requireSpec("identity.name").inference_allowed).toBe(false);
  });

  it("refuses inference on an unknown predicate", () => {
    expect(inferenceAllowedFor("does.not.exist")).toBe(false);
  });

  it("still allows inference where the registry grants it", () => {
    // Guards against a `return false` stub passing the two tests above.
    expect(inferenceAllowedFor("identity.occupation")).toBe(true);
  });
});
