/**
 * Record identity and supersede decisions.
 *
 * This module exists because `kind + subject` is not a memory primary key.
 * "I design, and I also teach painting on weekends" cannot have its second
 * half supersede its first, and a misclassified location remark must never
 * silently destroy a precise location fact.
 *
 * Three guards, in order of application:
 *   1. `cardinality`  — a `set` predicate never supersedes, it only merges
 *   2. `misc`         — the unclassified escape hatch is inert (invariant I2)
 *   3. type compatibility — a vague value cannot overwrite a structured one
 *
 * A rejected write is always a *reportable* outcome, never a throw: extraction
 * runs on model output, and the caller's job is to keep the candidate rather
 * than crash.
 */

import {
  kindsCompatible,
  requireSpec,
  type Cardinality,
  type PredicateSpec,
  type ValueKind,
} from "../domain/predicates.js";
import { MISC_PREDICATE } from "../domain/predicate-keys.js";
import type { Claim } from "../domain/types.js";

/**
 * The identity of a slot: the triple that decides which records compete.
 *
 * Note what is *not* here — `importance`, timestamps, or the value itself. Two
 * claims share a slot when they make a statement about the same predicate, of
 * the same subject, under the same qualifiers, regardless of what they say.
 */
export interface SlotKey {
  predicate: string;
  entityRef?: string;
  qualifiers?: Record<string, string | number | boolean>;
}

/**
 * Stable serialisation of a slot.
 *
 * Qualifier keys are sorted so that `{a:1,b:2}` and `{b:2,a:1}` are one slot —
 * otherwise the same fact keyed in a different field order would accumulate
 * duplicates, which is the exact failure this module exists to prevent.
 *
 * A JSON tuple is used rather than a delimiter join because predicate keys,
 * entity ids and qualifier values are all free-form strings; any separator
 * chosen would eventually appear inside one of them.
 */
export function canonicalKeyParts(slot: SlotKey): string {
  const qualifiers = slot.qualifiers
    ? Object.keys(slot.qualifiers)
        .sort()
        .map((key) => [key, slot.qualifiers![key]] as const)
    : [];
  return JSON.stringify([slot.predicate, slot.entityRef ?? null, qualifiers]);
}

/**
 * Human-readable form of the same identity, for diagnostics and the UI that
 * lists what is remembered. Never use this as a map key.
 */
export function canonicalKey(slot: SlotKey): string {
  const parts = [slot.predicate];
  if (slot.entityRef) parts.push(`@${slot.entityRef}`);
  if (slot.qualifiers) {
    const rendered = Object.keys(slot.qualifiers)
      .sort()
      .map((key) => `${key}=${String(slot.qualifiers![key])}`)
      .join(",");
    if (rendered) parts.push(`{${rendered}}`);
  }
  return parts.join("");
}

/**
 * Whether this predicate ever replaces an existing value.
 *
 * `single` and `temporal_single` do; `set` does not — for a set, a new
 * differing value is additional information, not a correction.
 */
export function supersedesByCardinality(cardinality: Cardinality): boolean {
  return cardinality === "single" || cardinality === "temporal_single";
}

/** `misc` is the one predicate that is structurally inert (invariant I2). */
export function isInert(domain: string): boolean {
  return domain === "misc";
}

export type SupersedeRejection =
  | "unknown_predicate"
  | "cardinality_set"
  | "inert_domain"
  | "requires_entity_ref"
  | "type_incompatible"
  | "invalid_value";

export type SupersedeDecision =
  /** No active record occupies the slot; this is an insert. */
  | { action: "create"; spec: PredicateSpec }
  /** A new value replaces the active one; the old record is superseded. */
  | { action: "supersede"; spec: PredicateSpec; supersedesId: string }
  /** Same slot, equivalent value — reinforce the existing record, write nothing. */
  | { action: "merge"; spec: PredicateSpec; intoId: string }
  /** A `set` predicate gaining an additional distinct value. */
  | { action: "append"; spec: PredicateSpec }
  /** Refused. Caller keeps the candidate for review; nothing is destroyed. */
  | { action: "reject"; reason: SupersedeRejection; detail: string };

/**
 * Normalise a value for equivalence comparison.
 *
 * Only whitespace and case are flattened. Deliberately no stemming, no
 * synonymy, no fuzzy matching: "I design" and "I teach painting" are different
 * values, and guessing otherwise is how a system silently merges two facts
 * into one wrong one.
 */
export function normalizeForComparison(value: unknown): string {
  if (typeof value === "string") return value.trim().replace(/\s+/g, " ").toLowerCase();
  return JSON.stringify(value ?? null);
}

export function valuesEquivalent(left: unknown, right: unknown): boolean {
  return normalizeForComparison(left) === normalizeForComparison(right);
}

export type ValueClass =
  | { kind: "classifiable"; valueKind: ValueKind }
  | { kind: "unclassifiable"; reason: string };

/**
 * Classify an incoming value against a predicate's declared shape.
 *
 * The `unclassifiable` outcome is the important one: it is what turns "a model
 * said something we cannot type-check" from a silent overwrite into a held
 * candidate.
 */
export function classifyValue(spec: PredicateSpec, value: unknown): ValueClass {
  if (value === undefined || value === null) {
    return { kind: "unclassifiable", reason: "value is empty" };
  }
  if (spec.kind === "enum") {
    if (typeof value !== "string") return { kind: "unclassifiable", reason: "enum value must be a string" };
    if (spec.enumDomain && !spec.enumDomain.includes(value)) {
      return { kind: "unclassifiable", reason: "value is outside the declared enum domain" };
    }
    return { kind: "classifiable", valueKind: "enum" };
  }
  if (spec.kind === "number") {
    if (typeof value === "number" && Number.isFinite(value)) {
      return { kind: "classifiable", valueKind: "number" };
    }
    if (typeof value === "string" && /^-?\d+(\.\d+)?$/.test(value.trim())) {
      return { kind: "classifiable", valueKind: "number" };
    }
    return { kind: "unclassifiable", reason: "numeric value expected" };
  }
  if (spec.kind === "date") {
    return typeof value === "string" || value instanceof Date
      ? { kind: "classifiable", valueKind: "date" }
      : { kind: "unclassifiable", reason: "date value expected" };
  }
  if (spec.kind === "duration") {
    const ok =
      typeof value === "string" ||
      (typeof value === "object" && value !== null && (value as { kind?: unknown }).kind === "duration");
    return ok
      ? { kind: "classifiable", valueKind: "duration" }
      : { kind: "unclassifiable", reason: "duration value expected" };
  }
  if (spec.kind === "entity_ref") {
    return typeof value === "string" && value.trim().length > 0
      ? { kind: "classifiable", valueKind: "entity_ref" }
      : { kind: "unclassifiable", reason: "entity reference expected" };
  }
  if (typeof value === "string") {
    return value.trim().length > 0
      ? { kind: "classifiable", valueKind: "text" }
      : { kind: "unclassifiable", reason: "value is blank" };
  }
  return { kind: "unclassifiable", reason: "text value expected" };
}

export interface SupersedeInput {
  predicate: string;
  value: unknown;
  entityRef?: string;
  qualifiers?: Record<string, string | number | boolean>;
  /** `Claim.importance` of the incoming statement, used to rank a set append. */
  importance?: number;
}

/**
 * Decide what a new statement does to the records already in its slot.
 *
 * `sameSlotActive` must contain only records that are `active`, share the
 * caller's scope, and — for entity-bearing predicates — the same entity. The
 * caller owns scoping; this function owns the rules.
 *
 * Ordering matters: cardinality and inertness are checked before type
 * compatibility, because "a set never supersedes" is a stronger statement than
 * "this value would not have been compatible anyway".
 */
export function decideSupersede(
  input: SupersedeInput,
  sameSlotActive: readonly Claim[],
): SupersedeDecision {
  const spec = (() => {
    try {
      return requireSpec(input.predicate);
    } catch {
      return undefined;
    }
  })();
  if (!spec) {
    return { action: "reject", reason: "unknown_predicate", detail: input.predicate };
  }

  if (isInert(spec.domain) || spec.key === MISC_PREDICATE) {
    // Unclassified statements are stored for the user's benefit but must never
    // displace a classified fact.
    return { action: "reject", reason: "inert_domain", detail: spec.key };
  }

  if (spec.kind === "entity_ref" && !input.entityRef) {
    return {
      action: "reject",
      reason: "requires_entity_ref",
      detail: `${spec.key} needs an entity reference`,
    };
  }

  const classified = classifyValue(spec, input.value);
  if (classified.kind === "unclassifiable") {
    return { action: "reject", reason: "invalid_value", detail: classified.reason };
  }

  if (sameSlotActive.length === 0) return { action: "create", spec };

  const existing = pickMostAuthoritative(sameSlotActive);
  const equivalent = sameSlotActive.find((claim) => valuesEquivalent(claim.value, input.value));
  if (equivalent) {
    return { action: "merge", spec, intoId: equivalent.id };
  }

  if (!supersedesByCardinality(spec.cardinality)) {
    // A set accumulates. Still type-check the *existing* record so that adding
    // "I'm thinking about moving" into a set of places is refused rather than
    // quietly polluting the accumulation.
    const existingClass = classifyValue(spec, existing.value);
    if (existingClass.kind === "classifiable" && existingClass.valueKind !== classified.valueKind) {
      const compatible =
        (existingClass.valueKind === "text" && classified.valueKind === "text") ||
        existingClass.valueKind === classified.valueKind;
      if (!compatible) {
        return {
          action: "reject",
          reason: "type_incompatible",
          detail: `${classified.valueKind} cannot join a ${existingClass.valueKind} slot`,
        };
      }
    }
    return { action: "append", spec };
  }

  const existingClass = classifyValue(spec, existing.value);
  if (existingClass.kind === "unclassifiable") {
    // The incumbent cannot be type-checked, so it cannot be safely displaced.
    return {
      action: "reject",
      reason: "type_incompatible",
      detail: "incumbent value is unclassifiable; refusing to supersede it",
    };
  }

  const incomingKind = classified.valueKind;
  const incumbentKind = existingClass.valueKind;
  if (!kindsCompatible(incumbentKind, incomingKind)) {
    return {
      action: "reject",
      reason: "type_incompatible",
      detail: `${incomingKind} cannot supersede ${incumbentKind}`,
    };
  }

  return { action: "supersede", spec, supersedesId: existing.id };
}

/**
 * Choose which active record represents a slot when several somehow coexist.
 *
 * Multiple actives in one `single` slot means an earlier bug or a concurrent
 * write; picking deterministically by newest revision keeps the outcome stable
 * and reproducible rather than dependent on array order.
 */
function pickMostAuthoritative(claims: readonly Claim[]): Claim {
  return claims.reduce((best, candidate) =>
    candidate.updatedAt > best.updatedAt ||
    (candidate.updatedAt === best.updatedAt && candidate.id > best.id)
      ? candidate
      : best,
  );
}
