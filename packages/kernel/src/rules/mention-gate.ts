/**
 * The mention gate — retrieval is not permission to speak.
 *
 * Ranking answers "what matters". It does not answer "should this be said right
 * now". Perfect ranking still puts "the night the dog was sick" in front of a
 * user who spent Friday evening trying to think about something lighter.
 *
 *   user: "It's raining today."
 *   ai:   "It was raining the day your ex left, too."
 *
 * Every token of that is correct and the product is dead. So disclosure is a
 * separate decision from relevance, it applies to **all three layers** — not
 * just inferences — and it is monotone: gates and record-level flags may only
 * ever make a record *quieter*, never louder. A record's own mode is a ceiling,
 * never a grant.
 *
 * Invariants enforced here: I7 (`doNotSurface`), I10 (boundary is a constraint,
 * not a scored item), I13 (nothing below `freely_mentionable` volunteers itself).
 */

import { mentionPolicyFor, type MentionMode } from "../domain/predicates.js";
import type { Claim, Inference } from "../domain/types.js";

/**
 * Surface ladder. Higher means more willing to speak.
 *
 * Ordering is what makes "may only get quieter" expressible: the effective
 * level is the minimum of the predicate policy, the record's own mode, and
 * every applicable flag.
 */
export const SURFACE_LEVEL = {
  never_surface: 0,
  background_only: 1,
  mention_if_user_cues: 2,
  freely_mentionable: 3,
} as const satisfies Record<MentionMode, number>;

export type SurfaceLevelName = keyof typeof SURFACE_LEVEL;

const LEVEL_NAME: Record<number, SurfaceLevelName> = {
  0: "never_surface",
  1: "background_only",
  2: "mention_if_user_cues",
  3: "freely_mentionable",
};

export function levelName(level: number): SurfaceLevelName {
  return LEVEL_NAME[level] ?? "never_surface";
}

/**
 * Signals that license a mention.
 *
 * `topicImplies` is deliberately weaker than `userReferenced`: the user naming
 * a thing licenses that thing, whereas the subject merely being adjacent does
 * not license volunteering something private about it.
 */
export interface MentionCues {
  /** The user referred to this record, its entity, or its subject matter. */
  userReferenced: boolean;
  /** The current turn's topic implies this record's subject. */
  topicImplies: boolean;
  /** The user previously authorised being reminded at this time. */
  timeTriggerAuthorised: boolean;
  /**
   * A surface form the user themself just used. Required before a
   * `shared_world` term may be spoken back — using someone's private word for
   * a thing before they have used it in this conversation reads as
   * surveillance, not intimacy.
   */
  sharedTermInUserTurn?: boolean;
}

export type GateDenial =
  | "boundary_is_a_constraint"
  | "do_not_surface"
  | "never_surface"
  | "inference_not_active"
  | "uses_unlicensed_shared_term"
  | "awaiting_user_cue"
  | "time_trigger_not_authorised"
  | "no_cue";

export type MentionDecision =
  | { allowed: true; level: SurfaceLevelName; backgroundOnly: boolean }
  | { allowed: false; reason: GateDenial; level: SurfaceLevelName };

export interface MentionInput {
  /** `undefined` for a record kind without a predicate policy (e.g. an episode). */
  predicate?: string;
  /** The record's own mode. Acts as a ceiling. */
  recordMode?: MentionMode;
  /** Invariant I7. */
  doNotSurface?: boolean;
  /** Set for `shared_world` inference values. */
  sharedWorldTerm?: boolean;
  cues: MentionCues;
}

/**
 * The quietest level this record is permitted to reach.
 *
 * Pure function of the record's own policy and flags — it does not look at the
 * conversation, so callers can compute it once per turn and reuse it.
 */
export function effectiveSurfaceLevel(input: MentionInput): number {
  let level: number = SURFACE_LEVEL.freely_mentionable;

  if (input.predicate !== undefined) {
    level = Math.min(level, SURFACE_LEVEL[mentionPolicyFor(input.predicate)]);
  }
  if (input.recordMode !== undefined) {
    level = Math.min(level, SURFACE_LEVEL[input.recordMode]);
  }
  if (input.doNotSurface) {
    // The negative-feedback landing spot: a hard floor at silence.
    level = SURFACE_LEVEL.never_surface;
  }
  return level;
}

/**
 * Decide whether a record may be spoken, and at what level.
 *
 * Callers pass the *result* to the renderer, which must respect
 * `backgroundOnly`: a background-only record may shape tone and word choice but
 * must not be recited. That is what keeps memory useful without producing the
 * uncanny "I remember you said…" effect.
 */
export function mentionGate(input: MentionInput): MentionDecision {
  const level = effectiveSurfaceLevel(input);
  const name = levelName(level);

  if (level === SURFACE_LEVEL.never_surface) {
    // Distinguish why, so diagnostics and the UI can explain the silence.
    if (input.doNotSurface) return { allowed: false, reason: "do_not_surface", level: name };
    return { allowed: false, reason: "never_surface", level: name };
  }

  // A time trigger is only a licence if the user granted it in advance. An
  // anniversary the model remembered on its own is a landmine, not a gift.
  if (input.cues.timeTriggerAuthorised && !input.cues.userReferenced && !input.cues.topicImplies) {
    if (level >= SURFACE_LEVEL.background_only) {
      return { allowed: true, level: name, backgroundOnly: false };
    }
    return { allowed: false, reason: "time_trigger_not_authorised", level: name };
  }

  const hasSubstantiveCue = input.cues.userReferenced || input.cues.topicImplies;

  if (level === SURFACE_LEVEL.freely_mentionable) {
    if (input.sharedWorldTerm === true && !input.cues.sharedTermInUserTurn) {
      return { allowed: false, reason: "uses_unlicensed_shared_term", level: name };
    }
    return { allowed: true, level: name, backgroundOnly: false };
  }

  if (level === SURFACE_LEVEL.mention_if_user_cues) {
    if (!hasSubstantiveCue) {
      // Still usable as background: it shapes the reply without being quoted.
      return { allowed: false, reason: "awaiting_user_cue", level: name };
    }
    return { allowed: true, level: name, backgroundOnly: false };
  }

  // background_only: usable, never citable (invariant I13).
  return { allowed: true, level: name, backgroundOnly: true };
}

/**
 * Convenience wrapper for a Claim.
 */
export function claimMention(claim: Claim, cues: MentionCues): MentionDecision {
  return mentionGate({
    predicate: claim.predicate,
    ...(claim.doNotSurface !== undefined ? { doNotSurface: claim.doNotSurface } : {}),
    cues,
  });
}

/**
 * Convenience wrapper for an Inference.
 *
 * An inference that is not `active` is never spoken — `accumulating`,
 * `rejected` and `expired` all stay silent, which is what keeps a half-formed
 * impression from being voiced as if it were settled.
 */
export function inferenceMention(inference: Inference, cues: MentionCues): MentionDecision {
  const shared = {
    predicate: inference.predicate,
    recordMode: inference.useMode,
    ...(inference.doNotSurface !== undefined ? { doNotSurface: inference.doNotSurface } : {}),
  };
  if (inference.state !== "active") {
    return {
      allowed: false,
      reason: "inference_not_active",
      level: levelName(effectiveSurfaceLevel({ ...shared, cues })),
    };
  }
  return mentionGate({
    ...shared,
    ...(inference.axis === "shared_world" ? { sharedWorldTerm: true } : {}),
    cues,
  });
}

/**
 * Whether a record belongs in the constraint set rather than the scored pool.
 *
 * Boundaries are obligations, not candidates (invariant I10): they are always
 * in force, so they never compete for prompt budget and never need a cue.
 */
export function isConstraint(predicate: string | undefined): boolean {
  return predicate?.startsWith("boundary.") ?? false;
}
