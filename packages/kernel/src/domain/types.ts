/**
 * Companion memory domain types.
 *
 * Three persistent layers plus a non-memory runtime layer and one evidence
 * primitive. See DESIGN.md §3 for why each field exists; the short version:
 *
 *   Claim      what the user stated            — fast, automatic, low risk
 *   Episode    what we went through together   — narrative, near-verbatim
 *   Inference  what the model came to believe  — slow, governed, revocable
 *
 * Every derived record cites `EvidenceRef`s rather than copying text, so
 * forgetting, contamination isolation and evidence collapse are all one
 * mechanism instead of three.
 *
 * Layer separation rule: this module imports nothing. No I/O, no LLM, no host
 * API, and no `Date.now()` — callers inject time. That is what makes the whole
 * layer exhaustively testable and portable to Rust (DESIGN.md §8).
 */

import type { MentionMode } from "./predicates.js";

/**
 * The durable identity of a relationship.
 *
 * Deliberately *not* keyed on the agent/model that happens to be talking. A
 * user who switches to a different model must not find that their companion
 * has forgotten them; the agent that produced a record is kept as provenance
 * metadata on the record, never as part of the ownership key.
 */
export interface RelationshipScope {
  serviceId: string;
  ownerUserId: string;
  companionProfileId: string;
}

export interface Provenance {
  /** The agent or model that produced this record. Metadata, not identity. */
  agentId?: string;
  promptFamily?: string;
  promptVersion?: string;
  model?: string;
  confidence: number;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Evidence
// ---------------------------------------------------------------------------

export type EvidenceSourceType = "message" | "claim" | "episode";

export type Speaker = "user" | "assistant";

/**
 * What a piece of evidence is *allowed to prove*.
 *
 * `assistant_action` can establish that the companion said something and can
 * support relationship history; it can never establish what the user is like.
 * That restriction is enforced in `rules/evidence.ts`, not by convention
 * (invariant I1).
 */
export type SemanticRole =
  | "user_assertion"
  | "user_reaction"
  | "assistant_action"
  | "observation";

export interface EvidenceRef {
  sourceType: EvidenceSourceType;
  sourceId: string;
  speaker: Speaker;
  semanticRole?: SemanticRole;
}

// ---------------------------------------------------------------------------
// Claim — what the user stated
// ---------------------------------------------------------------------------

export type ClaimStatus = "active" | "superseded" | "revoked" | "deleted";

/** Ranking projection, embedded rather than kept in a side table. */
export interface SalienceFields {
  importance: number;
  recallCount: number;
  lastRecalledAt?: string;
  /**
   * Negative-feedback landing spot. A record marked this way can never be
   * surfaced above `background_only` (invariant I7).
   */
  doNotSurface?: boolean;
}

export interface Claim extends SalienceFields {
  id: string;
  scope: RelationshipScope;

  /** Registry key, e.g. `identity.occupation`. */
  predicate: string;
  /** Person or place this claim is about, when the predicate is entity-bearing. */
  entityRef?: string;
  /** Distinguishes concurrent values of one predicate, e.g. `{ use: "work" }`. */
  qualifiers?: Record<string, string | number | boolean>;

  value: unknown;
  /** The user's own words, kept verbatim so nothing is lost in normalisation. */
  rawValue?: string;

  validFrom: string;
  validUntil?: string;

  status: ClaimStatus;
  supersedesId?: string;

  sourceRefs: EvidenceRef[];
  provenance: Provenance;

  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Episode — what we went through together
// ---------------------------------------------------------------------------

export interface EmotionalArcPoint {
  atTurn: number;
  labels: string[];
  intensity?: number;
  /**
   * `observed` is a weaker signal than `user_expressed` and must not be
   * promoted into an inference about the user on its own.
   */
  source: "user_expressed" | "observed";
}

export interface EpisodeParticipant {
  entityRef?: string;
  role: "user" | "companion";
}

export interface Episode extends SalienceFields {
  id: string;
  scope: RelationshipScope;

  occurredFrom: string;
  occurredTo?: string;

  /** Must be segmented by speaker; see DESIGN.md §2.2. */
  narrative: string;
  participants: EpisodeParticipant[];

  emotionalArc?: EmotionalArcPoint[];

  /**
   * What the user did or said next. Descriptive only — never a causal claim
   * that the companion's response "helped" (DESIGN.md §2.2).
   */
  userReaction?: string;
  /** The assistant turn this reaction responds to. */
  responseRef?: string;

  sourceRefs: EvidenceRef[];
  status: "active" | "deleted";

  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Inference — what the model came to believe
// ---------------------------------------------------------------------------

export type InferenceAxis =
  | "disposition"
  | "pattern"
  | "recurring_theme"
  | "relational"
  | "self_model"
  | "shared_world";

export type InferenceState = "accumulating" | "active" | "rejected" | "expired";

/**
 * Record of the checks that justified a promotion.
 *
 * Counts alone manufacture stereotypes: three consecutive Sundays spent on one
 * deadline are one underlying cause, not three independent confirmations.
 * Independence is what the promotion gate requires, and this is the evidence
 * that it was actually checked.
 */
export interface PromotionAudit {
  distinctSessions: number;
  temporalSpanDays: number;
  contextDiversity: number;
  counterExamplesChecked: number;
}

export interface Inference extends SalienceFields {
  id: string;
  scope: RelationshipScope;

  axis: InferenceAxis;
  predicate: string;
  value: string;

  state: InferenceState;
  /** Capped while `userAcknowledgedAt` is unset (invariant I11). */
  confidence: number;

  supportEvidence: EvidenceRef[];
  counterEvidence: EvidenceRef[];

  promotionAudit?: PromotionAudit;

  userAcknowledgedAt?: string;
  useMode: MentionMode;
  /** Set for `pattern`; drives mandatory review (invariant I12). */
  expiresAt?: string;

  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// RuntimeState — deliberately not memory
// ---------------------------------------------------------------------------

export interface SessionTrajectoryPoint {
  atTurn: number;
  affect: string[];
  topic: string;
}

/**
 * The conversation's present condition, with a TTL measured in turns or hours.
 *
 * "I'm so done with today" must change this and nothing else. Writing it into a
 * Claim or an Inference is how long-term memory gets poisoned by transient
 * state (DESIGN.md §3.5).
 */
export interface RuntimeState {
  scope: RelationshipScope;

  currentAffect?: string[];
  currentTopic?: string;
  apparentNeed?: string;
  conversationMode?: string;
  activeEntities?: string[];
  unresolvedTurnIntent?: string;

  sessionTrajectory?: SessionTrajectoryPoint[];

  expiresAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

/**
 * Highest confidence an inference may reach before the user has acknowledged
 * it. A model's own observation must never feel like a settled fact
 * (invariant I11).
 */
export const UNACKNOWLEDGED_CONFIDENCE_CAP = 0.65;

/** Days a `pattern` inference may go without fresh evidence before review. */
export const PATTERN_REVIEW_DAYS = 90;

/** Fraction of `misc` records above which the vocabulary is considered mismatched. */
export const MISC_RATIO_ALARM = 0.15;

/** Minimum independent sessions before an inference may be promoted. */
export const MIN_DISTINCT_SESSIONS = 3;

/** Minimum span, in days, over which those sessions must be spread. */
export const MIN_TEMPORAL_SPAN_DAYS = 14;
