import type { WikiCandidate, WikiRelationType } from './wiki.ts'
import type { MemoryAliasRecord } from './memory-domain.ts'

/** Durable records owned by one Riko memory profile. */

/** Permission state controlling whether a memory may be used. */
export type MemorySensitivity = 'normal' | 'provisional_sensitive' | 'sensitive'

/** Authority allowed to record a sensitivity change. */
export type SensitivityAuthority = 'deterministic_rule' | 'model_proposal' | 'user' | 'management'

/** Auditable transition between sensitivity permission states. */
export interface SensitivityChange {
  readonly at: string
  readonly from: MemorySensitivity
  readonly to: MemorySensitivity
  readonly authority: SensitivityAuthority
  readonly reason?: string
}

/** Effect a safe-use projection may communicate to the main model. */
export type SafeUsageEffect = 'tone' | 'avoid_topic' | 'avoid_repetition' | 'preference_alignment'

/** Raw-text disclosure policy carried by every memory projection. */
export type MemoryDisclosure = 'normal' | 'user_explicit_only' | 'never_explicit'

/** Deployment-selectable policy for unclassified fail-closed L0 evidence. */
export type UnclassifiedEvidenceDisclosure = Exclude<MemoryDisclosure, 'normal'>

/** Recall layer used to preserve canonical and derived authority during bounded selection. */
export type RecallAuthorityTier = 'canonical' | 'observation' | 'graph' | 'evidence'

/** Rebuildable projection that carries safe-use effects and raw-text disclosure policy. */
export interface SafeUsageProjection {
  readonly id: string
  readonly memoryId: string
  readonly allowedEffects: readonly SafeUsageEffect[]
  readonly topicTags: readonly string[]
  readonly summary?: string
  readonly disclosure: MemoryDisclosure
  /** Whether an ordinary, non-explicit turn may receive the stored raw text. */
  /** Absent means no, so a projection that never opted in stays guidance-only. */
  readonly ordinaryRawText?: boolean
  readonly generatedFromVersion: string
  readonly generatedAt: string
}

/** Read-time state of an ambiguous conflict overlay. */
export type ConflictState = 'contested' | 'resolved'

/** Read-time overlay that marks an ambiguous predicate without rewriting canon. */
export interface ConflictOverlay {
  readonly id: string
  readonly subject: string
  readonly predicate: string
  readonly oldCanonicalId: string
  readonly newCandidateId: string
  readonly state: ConflictState
  readonly createdAt: string
  readonly resolvedAt?: string
  readonly resolution?: 'correction' | 'temporal_transition' | 'management'
}

/** Coarse thematic bucket classifying one memory record. */
export type MemoryCategory =
  | 'traits_roles'
  | 'interaction_rules'
  | 'key_experiences'
  | 'promises_goals'
  | 'emotions'

/** Semantic kind used to classify one memory record. */
export type MemoryKind = 'fact' | 'preference' | 'event' | 'boundary' | 'emotion'
/** Lifecycle state used by the candidate and confirmed Wiki collections. */
export type MemoryStatus = 'candidate' | 'confirmed' | 'superseded'

/** Independent provider endpoint used only by the memory Dream worker. The wire protocol is inferred from the URL. */
export interface DreamSettings {
  readonly apiUrl: string
  /** Credential reference only; the secret is resolved per Dream operation. */
  readonly credentialRef: string
  readonly model: string
  readonly maxTokens: number
}

/** One durable Wiki record and its source lineage/retention metadata. */
export interface MemoryItem {
  readonly id: string
  readonly kind: MemoryKind
  readonly category: MemoryCategory
  readonly content: string
  readonly confidence: number
  readonly status: MemoryStatus
  readonly sourceConversations: readonly string[]
  readonly observedAt: string
  /** When the source record was written; optional for legacy records. */
  readonly recordedAt?: string
  /** Explicit temporal validity; null/absent means unknown, never guessed. */
  readonly validFrom?: string | null
  readonly validTo?: string | null
  readonly validUntil?: string
  readonly sensitivity: MemorySensitivity
  readonly sensitivityHistory?: readonly SensitivityChange[]
  readonly consent: boolean
}

/** Summary of one canonical Wiki page exposed by the management API. */
export interface WikiPageSummary {
  readonly id: string
  readonly path: string
  readonly type: string
  readonly title: string
  readonly description: string
  readonly status: 'candidate' | 'confirmed' | 'superseded'
  readonly consent: boolean
  readonly observedAt?: string
  readonly recordedAt?: string
  readonly validFrom?: string | null
  readonly validTo?: string | null
  readonly validUntil?: string
  readonly locked: boolean
  readonly confidence: number
  readonly version: number
  readonly updatedAt: string
}

/** Determinism-defined unit of the compiled resident. */
export type ResidentBlockKind = 'identity' | 'preferences' | 'relationships' | 'currentState' | 'communicationStyle' | 'activePeople' | 'openThreads'

/** Deterministic internal Resident unit. The public compatibility surface remains `ResidentSnapshot.content`. */
export interface ResidentBlock {
  readonly kind: ResidentBlockKind
  readonly entries: readonly string[]
  readonly sourcePageIds: readonly string[]
  /** The guaranteed minimum character share for this block; budget redistribution may push it beyond this. */
  readonly charBudget: number
}

/** Lifecycle status of one inferred observation. */
export type ObservationStatus = 'candidate' | 'active' | 'invalidated' | 'suppressed' | 'weakened'

/** Derived pattern; it is never interchangeable with a user-confirmed fact. */
export interface MemoryObservation {
  readonly id: string
  readonly text: string
  readonly sourceRefs: readonly string[]
  readonly supportingRefs?: readonly string[]
  readonly contradictingRefs?: readonly string[]
  readonly lastEvidenceAt?: string
  readonly minEvidence?: number
  readonly evidenceCount: number
  readonly confidence: number
  readonly status: ObservationStatus
  readonly epistemicStatus: 'inferred_observation'
  readonly sensitivity: MemorySensitivity
  readonly sensitivityHistory?: readonly SensitivityChange[]
  readonly observedAt: string
  readonly recordedAt: string
  readonly validFrom?: string | null
  readonly validTo?: string | null
  readonly derivedFromObservationIds?: readonly string[]
  readonly invalidatedAt?: string
}

/** Durable purge lifecycle record for one session. */
export interface MemoryPurgeRecord {
  readonly operationId: string
  readonly sessionId: string
  readonly status: 'started' | 'completed' | 'failed'
  readonly startedAt: string
  readonly completedAt?: string
  readonly error?: string
}

/** Resident prompt projection metadata. */
export interface ResidentSnapshot {
  readonly content: string
  readonly generatedAt?: string
  readonly sourcePageIds: readonly string[]
  readonly version: string
  readonly blocks?: readonly ResidentBlock[]
  readonly compilerVersion?: number
  readonly maxChars?: number
  readonly omittedPageIds?: readonly string[]
  readonly diagnostics?: {
    readonly eligibleCount: number
    readonly includedCount: number
    readonly omittedCount: number
    readonly charBudget: number
    readonly actualChars: number
    readonly compilerVersion: number
  } | undefined
}

/** Client-facing projection of one profile's durable memory state. */
export interface MemorySnapshot {
  readonly profileId: string
  /** Confirmed records, including expired records retained for Wiki visibility. */
  readonly records: readonly MemoryItem[]
  /** Unconfirmed Wiki page proposals waiting for client confirmation or rejection. */
  readonly candidates: readonly WikiCandidate[]
  /** Scope-local alias records exposed to management views and current recall's entity channel. */
  readonly aliases: readonly MemoryAliasRecord[]
  readonly observations?: readonly MemoryObservation[]
  /** Canonical Wiki page summaries used by the graph UI. */
  readonly pages?: readonly WikiPageSummary[]
  /** Current graph nodes and wikilink edges. */
  readonly graph?: {
    readonly nodes: readonly { readonly id: string; readonly title: string; readonly type: string; readonly layer?: 'L0' | 'L2' }[]
    readonly edges: readonly { readonly sourcePageId: string; readonly targetTitle: string; readonly targetPageId?: string; readonly relationType?: WikiRelationType; readonly targetKind?: 'page' | 'session' }[]
  }
  /** Raw source records indexed by the Wiki. */
  readonly sources?: readonly {
    readonly id: string
    readonly ref: string
    readonly kind: 'session' | 'manual'
    readonly sha256: string
    readonly status: 'uploaded' | 'ingested' | 'failed'
    readonly error?: string
    readonly observedAt: string
    readonly ingestedAt?: string
  }[]
  /** Current resident prompt metadata. */
  readonly residentSnapshot?: ResidentSnapshot
  readonly sessions: readonly string[]
  readonly resident: string
  readonly updatedAt?: string
  readonly lastDreamAt?: string
  readonly lastError?: string
}
