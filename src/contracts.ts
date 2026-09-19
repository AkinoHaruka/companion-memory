import type { MemorySensitivity, SensitivityChange } from './types.ts'

/** Versioned, scope-aware contracts shared by the native memory state machine. */

export const MEMORY_SCHEMA_VERSION = 1 as const

export interface MemoryScope {
  readonly schemaVersion: typeof MEMORY_SCHEMA_VERSION
  readonly ownerNamespace: string
  readonly stableAgentPresetId: string
  readonly key: string
}

export interface EvidenceRef {
  readonly schemaVersion: typeof MEMORY_SCHEMA_VERSION
  readonly sessionId: string
  readonly eventSeq: number
  readonly sourceSpan?: { readonly start: number; readonly end: number }
}

export type CandidateStatus = 'candidate' | 'confirmed' | 'superseded' | 'forgotten'
export type ConsentState = 'pending' | 'explicit' | 'managed'

export interface MemoryCandidate {
  readonly schemaVersion: typeof MEMORY_SCHEMA_VERSION
  readonly id: string
  readonly scope: MemoryScope
  readonly title: string
  readonly content: string
  readonly status: CandidateStatus
  readonly consent: ConsentState
  readonly sensitivity?: MemorySensitivity
  readonly evidence: readonly EvidenceRef[]
  readonly source: 'dream' | 'manual'
  readonly createdAt: string
  readonly validUntil?: string
  readonly supersedes?: string
}

export interface WikiPage {
  readonly schemaVersion: typeof MEMORY_SCHEMA_VERSION
  readonly id: string
  readonly scope: MemoryScope
  readonly version: number
  readonly title: string
  readonly body: string
  readonly status: Exclude<CandidateStatus, 'forgotten'>
  readonly consent: ConsentState
  readonly sensitivity?: MemorySensitivity
  readonly sensitivityHistory?: readonly SensitivityChange[]
  readonly sourceCandidates: readonly string[]
  readonly evidence: readonly EvidenceRef[]
  readonly updatedAt: string
  readonly validUntil?: string
  readonly usagePolicy?: 'normal' | 'suppressed'
  readonly suppressedAt?: string
  readonly suppressionReason?: string
}

export interface ResidentSnapshot {
  readonly schemaVersion: typeof MEMORY_SCHEMA_VERSION
  readonly scope: MemoryScope
  readonly version: string
  readonly content: string
  readonly sourcePageIds: readonly string[]
  readonly generatedAt: string
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

export type DreamJobStatus = 'queued' | 'running' | 'succeeded' | 'failed'

export interface DreamJob {
  readonly schemaVersion: typeof MEMORY_SCHEMA_VERSION
  readonly id: string
  readonly scope: MemoryScope
  readonly sessionId: string
  readonly cursor: number
  readonly status: DreamJobStatus
  readonly attempts: number
  readonly createdAt: string
  readonly updatedAt: string
  readonly lastError?: string
}

/**
 * Build the only durable-memory scope accepted by the plugin.
 * A missing preset is intentionally an error: no default or global fallback
 * may turn a session without stable identity into shared memory.
 */
export function memoryScopeForPreset(ownerNamespace: string, stableAgentPresetId: string | null | undefined): MemoryScope {
  const owner = ownerNamespace.trim()
  if (owner.length === 0) throw new Error('memory scope owner namespace must be non-empty')
  const preset = stableAgentPresetId?.trim() ?? ''
  if (preset.length === 0) throw new Error('memory scope requires a stable agent preset')
  return {
    schemaVersion: MEMORY_SCHEMA_VERSION,
    ownerNamespace: owner,
    stableAgentPresetId: preset,
    key: `${owner}:${preset}`,
  }
}

/**
 * Only original user evidence can authorize confirmation. The caller must
 * pass the raw user text extracted from the referenced session event; Dream's
 * own output is never accepted as evidence.
 */
export function canConfirmCandidate(candidate: MemoryCandidate, rawUserEvidence: string): boolean {
  if (candidate.source !== 'dream' || candidate.status !== 'candidate' || candidate.consent !== 'pending') return false
  const evidence = rawUserEvidence.trim().toLocaleLowerCase()
  if (evidence.length === 0) return false
  const content = candidate.content.trim().toLocaleLowerCase()
  return content.length > 0 && evidence.includes(content)
}
