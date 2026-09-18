import type { WikiCandidate, WikiRelationType } from './wiki.ts'

/** Durable records owned by one Riko memory profile. */

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

/** One durable Wiki record and its provenance/retention metadata. */
export interface MemoryItem {
  readonly id: string
  readonly kind: MemoryKind
  readonly category: MemoryCategory
  readonly content: string
  readonly confidence: number
  readonly status: MemoryStatus
  readonly sourceConversations: readonly string[]
  readonly observedAt: string
  readonly validUntil?: string
  readonly sensitivity: 'normal' | 'sensitive'
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
  readonly validUntil?: string
  readonly locked: boolean
  readonly confidence: number
  readonly version: number
  readonly updatedAt: string
}

/** Resident prompt projection metadata. */
export interface ResidentSnapshot {
  readonly content: string
  readonly generatedAt?: string
  readonly sourcePageIds: readonly string[]
  readonly version: string
}

/** Client-facing projection of one profile's durable memory state. */
export interface MemorySnapshot {
  readonly profileId: string
  /** Confirmed records, including expired records retained for Wiki visibility. */
  readonly records: readonly MemoryItem[]
  /** Unconfirmed Wiki page proposals waiting for client confirmation or rejection. */
  readonly candidates: readonly WikiCandidate[]
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
