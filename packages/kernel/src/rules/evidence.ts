/**
 * Evidence admissibility — what a piece of support is allowed to prove.
 *
 * An `Inference` is a model's belief about the user; the only thing standing
 * between that belief and the model's own output is the support set it cites.
 * This module is the gate on that set, and it enforces three of the design's
 * numbered invariants (DESIGN.md §5):
 *
 *   I1 — evidence whose `speaker` is `assistant` can establish that the
 *        companion said something, and can support relationship history, but
 *        it can NEVER support an inference about the user. There is no
 *        exemption and no confidence level that unlocks it.
 *   I8 — a predicate with `inference_allowed: false` cannot contribute
 *        evidence to an inference; `misc.unclassified` is always disallowed.
 *   I5 — an inference whose support evidence has been entirely suppressed
 *        becomes invalid automatically; the caller never has to delete it.
 *
 * A fourth rule carries the same force without its own number: a `boundary.*`
 * claim is a constraint the companion must obey, never evidence about who the
 * user is (DESIGN.md §2.7 — a boundary is a gate, not a ranking input). Every
 * boundary row already sets `inference_allowed: false`, so what this rule
 * really buys is the *diagnosis*: "the model tried to reason from a boundary"
 * is a different failure from "the vocabulary forbids this predicate", and a
 * reviewer has to be told which one happened. That is why the boundary check
 * runs before the general disallow, and why it keys off the predicate's domain
 * rather than off a registry row — a `boundary.*` key is a constraint the
 * moment it is named, whether or not its row has landed in the registry yet.
 *
 * Both entry points share one rule list and differ only in how much of it they
 * report:
 *
 *   `maySupportUserInference`  — the write-path gate. First violation wins, so
 *                                a caller can refuse one ref cheaply.
 *   `verifyInferenceEvidence`  — the promotion audit. Every violation on every
 *                                ref, so the review sees the whole picture
 *                                instead of the first symptom. Counts alone
 *                                manufacture stereotypes; an audit that stops
 *                                at the first bad ref manufactures the same
 *                                thing one level up.
 *
 * Everything here is a value, never a throw: this runs on model output and
 * against records the user may have asked to forget underneath it.
 */

import { MISC_PREDICATE, splitPredicate } from "../domain/predicate-keys.js";
import { inferenceAllowedFor, specFor } from "../domain/predicates.js";
import type { Claim, Episode, EvidenceRef, EvidenceSourceType } from "../domain/types.js";

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

/**
 * Why one `EvidenceRef` may not support an inference about the user.
 *
 * Every code is a *reportable* outcome rather than an exception, because the
 * caller's job is to hold the candidate for review, not to crash on it. The
 * union is deliberately closed: a new rule gets a new code, so no caller can
 * accidentally treat a new failure as "fine".
 */
export type EvidenceViolation =
  /** I1 — assistant speech can never establish what the user is like. */
  | { code: "assistant_speaker"; ref: EvidenceRef }
  /** I8 — the predicate's registry row forbids inference, or the domain is `misc`. */
  | { code: "inference_disallowed"; ref: EvidenceRef; predicate: string }
  /** The predicate is a `boundary.*` constraint, not a fact about a person. */
  | { code: "boundary_is_constraint"; ref: EvidenceRef; predicate: string }
  /** The ref names a record the resolution has never heard of. */
  | { code: "unknown_source"; ref: EvidenceRef }
  /**
   * The id is known, but under a different layer than the ref declares — a
   * stale or corrupted reference. `expected` is the layer the ref claimed.
   */
  | { code: "source_type_mismatch"; ref: EvidenceRef; expected: EvidenceSourceType }
  /** The user asked to forget this record; I4 forbids it coming back. */
  | { code: "suppressed_source"; ref: EvidenceRef };

/**
 * Everything needed to decide whether a ref still points at something.
 *
 * Forgetting is a suppression set rather than a cascade delete (DESIGN.md
 * §3.4), which is exactly why this is three maps and one set instead of a
 * record store: a claim that is gone from `claims` may still be named by a
 * ref, and "suppressed" and "unresolvable" have to stay distinguishable so the
 * audit can say which one happened.
 *
 * `suppressed` is keyed by record id across all three layers — message, claim
 * and episode ids share one namespace here, because a `ForgetTarget` does not
 * know or care which layer the user was pointing at.
 */
export type EvidenceResolution = {
  claims: ReadonlyMap<string, Claim>;
  episodes: ReadonlyMap<string, Episode>;
  /** Ids of messages/claims/episodes the user asked to forget. */
  suppressed: ReadonlySet<string>;
};

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/**
 * What a ref actually points at, once resolution has run.
 *
 * Only the `claim` case carries a predicate: a claim is the one layer that was
 * classified against the registry, so it is the only layer I8 can speak about.
 * An episode is narrative and a message is host-owned raw text; neither has a
 * predicate, so neither can be judged by I8 or by the boundary rule.
 */
type SourceResolution =
  | { kind: "claim"; predicate: string }
  | { kind: "episode" }
  | { kind: "message" }
  | { kind: "unknown" }
  | { kind: "mismatch" };

/**
 * Resolve a ref against the resolution.
 *
 * The `mismatch` case exists so that a ref pointing at the wrong layer is not
 * silently filed as "unknown": a claim ref whose id is only known as an
 * episode is a corrupted reference, and collapsing it into `unknown_source`
 * would hide a real bookkeeping bug behind a missing record. Both are
 * non-resolving — the difference is what the report says.
 */
function resolveSource(ref: EvidenceRef, resolution: EvidenceResolution): SourceResolution {
  switch (ref.sourceType) {
    case "claim": {
      const claim = resolution.claims.get(ref.sourceId);
      if (claim) return { kind: "claim", predicate: claim.predicate };
      return resolution.episodes.has(ref.sourceId) ? { kind: "mismatch" } : { kind: "unknown" };
    }
    case "episode": {
      if (resolution.episodes.has(ref.sourceId)) return { kind: "episode" };
      return resolution.claims.has(ref.sourceId) ? { kind: "mismatch" } : { kind: "unknown" };
    }
    case "message":
      // The kernel holds no message log — the host does — so a message ref
      // resolves by construction. `suppressed` is the only thing that can drop
      // it; a host that can prove a message is gone must say so there.
      return { kind: "message" };
  }
}

// ---------------------------------------------------------------------------
// The rule list
// ---------------------------------------------------------------------------

/**
 * Every violation this ref has, in the order the rules are documented.
 *
 * Returning the full list rather than short-circuiting is what lets the two
 * public entry points share one implementation: the gate takes `[0]`, the
 * audit takes all of them.
 *
 * Rule order is load-bearing rather than cosmetic:
 *   - I1 is checked before anything can fail to resolve, because "assistant
 *     speech is not evidence about the user" holds even for a ref that points
 *     at nothing. There is no exemption for a missing record either.
 *   - Resolution precedes suppression so that a ref to a forgotten record that
 *     is also absent from the map is reported as `unknown_source`: the audit
 *     should not credit the suppression set with work it did not do.
 *   - Predicate rules are last, because they are the only ones that need a
 *     resolved claim to speak about.
 */
function violationsFor(ref: EvidenceRef, resolution: EvidenceResolution): EvidenceViolation[] {
  const violations: EvidenceViolation[] = [];

  // I1 — speaker, not semantic role, decides. A ref that labels itself
  // `assistant_action` and one that labels itself `observation` are refused
  // identically, and no provenance confidence is consulted.
  if (ref.speaker === "assistant") {
    violations.push({ code: "assistant_speaker", ref });
  }

  const source = resolveSource(ref, resolution);
  if (source.kind === "unknown") {
    violations.push({ code: "unknown_source", ref });
  } else if (source.kind === "mismatch") {
    violations.push({ code: "source_type_mismatch", ref, expected: ref.sourceType });
  }

  if (resolution.suppressed.has(ref.sourceId)) {
    violations.push({ code: "suppressed_source", ref });
  }

  if (source.kind === "claim") {
    const predicate = source.predicate;
    // The registry row is authoritative when it exists; `splitPredicate` is
    // the fallback so an unregistered `boundary.*` key is still recognised as
    // a constraint rather than falling through to the generic disallow.
    const domain = specFor(predicate)?.domain ?? splitPredicate(predicate)?.domain;

    if (domain === "boundary") {
      violations.push({ code: "boundary_is_constraint", ref, predicate });
    } else if (
      domain === "misc" ||
      predicate === MISC_PREDICATE ||
      !inferenceAllowedFor(predicate)
    ) {
      // `inferenceAllowedFor` answers `false` for a key the registry does not
      // know, which is the behaviour this rule wants: an unrecognised
      // predicate fails closed and cannot seed a belief about the user.
      violations.push({ code: "inference_disallowed", ref, predicate });
    }
  }

  return violations;
}

/**
 * Whether one ref may support an inference about the user.
 *
 * Returns the first violation in the documented order, or `null` when the ref
 * is admissible. This is the write-path gate: it is called per ref while an
 * inference is being assembled, so it stops at the first reason to refuse.
 * Use `verifyInferenceEvidence` when you need the whole picture instead.
 *
 * Note what "admissible" does *not* mean: it says nothing about whether the
 * ref is still live. A suppressed ref that has not been filtered can still be
 * checked here; `liveEvidence` is the filter for that.
 */
export function maySupportUserInference(
  ref: EvidenceRef,
  resolution: EvidenceResolution,
): EvidenceViolation | null {
  return violationsFor(ref, resolution)[0] ?? null;
}

/**
 * Full check of an inference's support set.
 *
 * Returns every violation found, not just the first: a ref can break more than
 * one rule at once (assistant speech *about* a boundary), and a promotion
 * review needs both facts. Violations are ordered by support position, and
 * within one ref by the rule order documented on `violationsFor`.
 *
 * `valid` is exactly `violations.length === 0`, and is offered separately
 * because the gate's question ("may I write this?") is asked far more often
 * than the audit's.
 */
export function verifyInferenceEvidence(
  support: readonly EvidenceRef[],
  resolution: EvidenceResolution,
): { valid: boolean; violations: EvidenceViolation[] } {
  const violations = support.flatMap((ref) => violationsFor(ref, resolution));
  return { valid: violations.length === 0, violations };
}

// ---------------------------------------------------------------------------
// Liveness
// ---------------------------------------------------------------------------

/**
 * Whether a ref still points at something that has not been forgotten.
 *
 * Deliberately *not* an admissibility check: a `boundary.*` claim or an
 * assistant-speaker ref can be perfectly live, because counter-evidence is
 * allowed to cite things support evidence may not. Liveness answers only "is
 * there still a record here?".
 */
function isLive(ref: EvidenceRef, resolution: EvidenceResolution): boolean {
  if (resolution.suppressed.has(ref.sourceId)) return false;
  const source = resolveSource(ref, resolution);
  return source.kind !== "unknown" && source.kind !== "mismatch";
}

/**
 * Filter a ref list down to the refs that still resolve and are not suppressed.
 *
 * This is the single filter every liveness question is built on, so that
 * "still live" means one thing everywhere: suppression first (I4 — a forgotten
 * record never comes back), then resolution.
 */
export function liveEvidence(
  refs: readonly EvidenceRef[],
  resolution: EvidenceResolution,
): EvidenceRef[] {
  return refs.filter((ref) => isLive(ref, resolution));
}

/**
 * Whether an inference should be considered collapsed because nothing supports
 * it any more.
 *
 * Per I5 this is true when there is no support ref at all, OR every support
 * ref is suppressed or unresolvable. The caller does not delete the inference —
 * an inference whose evidence has gone is a *record of a belief the model once
 * held*, and deleting it would erase the audit trail along with the belief.
 * What matters is that it stops being treated as supported.
 *
 * "Unresolvable" is included alongside "suppressed" on purpose: a support set
 * whose records cannot be found does not support anything either, and I5's
 * point is that an inference must never outlive its evidence.
 */
export function isCollapsed(
  support: readonly EvidenceRef[],
  resolution: EvidenceResolution,
): boolean {
  return liveEvidence(support, resolution).length === 0;
}

/**
 * Whether an inference has any counter-evidence left.
 *
 * Counter-evidence drives confidence down at promotion time, so callers need
 * it separated from support: a suppressed counter-example must stop counting
 * against an inference (the user asked to forget it), while a live one keeps
 * pulling confidence down even when it cites a predicate that could never be
 * *support*.
 */
export function liveCounterEvidence(
  counter: readonly EvidenceRef[],
  resolution: EvidenceResolution,
): EvidenceRef[] {
  return liveEvidence(counter, resolution);
}
