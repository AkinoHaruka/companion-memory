/** Native storage-domain declaration for all Riko memory records. */
/* oxlint-disable @stylistic/max-len */

import { defineDomain, domainTable, type Domain } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'
import type { MemoryScope } from './contracts.ts'
import type { ConflictOverlay, DreamSettings, MemoryObservation, MemorySensitivity, MemoryPurgeRecord as PurgeState, ResidentBlock, ResidentSnapshot, SafeUsageProjection, SensitivityAuthority } from './types.ts'
import type { WikiCandidate, WikiPage, WikiSource } from './wiki.ts'

const scopeSchema = z.object({
  schemaVersion: z.literal(1),
  ownerNamespace: z.string().min(1),
  stableAgentPresetId: z.string().min(1),
  key: z.string().min(3),
})

const recordSchemaVersion = z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5), z.literal(6)])
const sensitivitySchema = z.enum(['normal', 'provisional_sensitive', 'sensitive'])
const sensitivityAuthoritySchema = z.enum(['deterministic_rule', 'model_proposal', 'user', 'management'])
const sensitivityChangeSchema = z.object({
  at: z.string(),
  from: sensitivitySchema,
  to: sensitivitySchema,
  authority: sensitivityAuthoritySchema,
  reason: z.string().optional(),
})
const residentBlockSchema = z.object({
  kind: z.enum(['identity', 'preferences', 'relationships', 'currentState', 'communicationStyle', 'activePeople', 'openThreads']),
  entries: z.array(z.string()),
  sourcePageIds: z.array(z.string()),
  charBudget: z.number().int().nonnegative(),
})
const residentDiagnosticsSchema = z.object({
  eligibleCount: z.number().int().nonnegative(),
  includedCount: z.number().int().nonnegative(),
  omittedCount: z.number().int().nonnegative(),
  charBudget: z.number().int().nonnegative(),
  actualChars: z.number().int().nonnegative(),
  compilerVersion: z.number().int().nonnegative(),
})
const observationSchema = z.object({
  id: z.string().min(1),
  text: z.string().min(1),
  sourceRefs: z.array(z.string().min(1)).min(1),
  supportingRefs: z.array(z.string().min(1)).optional(),
  contradictingRefs: z.array(z.string().min(1)).optional(),
  lastEvidenceAt: z.string().optional(),
  minEvidence: z.number().int().positive().optional(),
  evidenceCount: z.number().int().min(1),
  confidence: z.number().min(0).max(1),
  status: z.enum(['candidate', 'active', 'invalidated', 'suppressed', 'weakened']),
  epistemicStatus: z.literal('inferred_observation'),
  sensitivity: sensitivitySchema,
  sensitivityHistory: z.array(sensitivityChangeSchema).optional(),
  observedAt: z.string(),
  recordedAt: z.string(),
  validFrom: z.string().nullable().optional(),
  validTo: z.string().nullable().optional(),
  derivedFromObservationIds: z.array(z.string()).optional(),
  invalidatedAt: z.string().optional(),
})

const stateSchema = z.object({
  schemaVersion: recordSchemaVersion,
  scope: scopeSchema,
  updatedAt: z.string().optional(),
  lastDreamAt: z.string().optional(),
  lastError: z.string().optional(),
  residentGeneratedAt: z.string().optional(),
  residentVersion: z.string().optional(),
  resident: z.string().optional(),
  residentBlocks: z.array(residentBlockSchema).optional(),
  residentMaxChars: z.number().int().nonnegative().optional(),
  residentOmittedPageIds: z.array(z.string()).optional(),
  residentDiagnostics: residentDiagnosticsSchema.optional(),
  settings: z.object({
    apiUrl: z.string().min(1),
    credentialRef: z.string().min(1),
    model: z.string().min(1),
    maxTokens: z.number().int().positive(),
  }),
})

const pageSchema = z.object({
  schemaVersion: recordSchemaVersion,
  scope: scopeSchema,
  page: z.object({
    id: z.string().min(1),
    path: z.string().min(1),
    type: z.string().min(1),
    title: z.string().min(1),
    description: z.string(),
    body: z.string().min(1),
    sources: z.array(z.string()),
    tags: z.array(z.string()),
    timestamp: z.string(),
    observedAt: z.string().optional(),
    recordedAt: z.string().optional(),
    confidence: z.number().min(0).max(1),
    sensitivity: sensitivitySchema.optional(),
    sensitivityHistory: z.array(sensitivityChangeSchema).optional(),
    validFromPrecision: z.enum(['exact', 'month', 'season', 'approximate']).optional(),
    temporalNote: z.string().optional(),
    status: z.enum(['candidate', 'confirmed', 'superseded']),
    consent: z.boolean(),
    validUntil: z.string().optional(),
    validFrom: z.string().nullable().optional(),
    validTo: z.string().nullable().optional(),
    supersededBy: z.string().optional(),
    supersedes: z.array(z.string()).optional(),
    supersessionReason: z.enum(['correction', 'temporal_transition', 'manual_supersede', 'forget']).optional(),
    epistemicStatus: z.enum(['explicit_user', 'confirmed_user', 'management_edit', 'inferred', 'system_normalized']).optional(),
    authority: z.array(z.string()).optional(),
    usagePolicy: z.enum(['normal', 'suppressed']).optional(),
    suppressedAt: z.string().optional(),
    suppressionReason: z.string().optional(),
    locked: z.boolean(),
    version: z.number().int().positive(),
    updatedAt: z.string(),
    category: z.string().optional(),
    kind: z.string().optional(),
  }).passthrough(),
})

const candidateSchema = z.object({
  schemaVersion: recordSchemaVersion,
  scope: scopeSchema,
  candidate: z.object({
    id: z.string().min(1),
    proposedPath: z.string().min(1),
    page: pageSchema.shape.page,
    sourceConversations: z.array(z.string()),
    createdAt: z.string(),
    status: z.enum(['candidate', 'rejected', 'accepted', 'pending_conflict']),
    conflictPageId: z.string().optional(),
  }),
})

const sourceSchema = z.object({
  schemaVersion: recordSchemaVersion,
  scope: scopeSchema,
  source: z.object({
    id: z.string().min(1),
    ref: z.string().min(1),
    kind: z.enum(['session', 'manual']),
    sha256: z.string().min(1),
    status: z.enum(['uploaded', 'ingested', 'failed']),
    error: z.string().optional(),
    observedAt: z.string(),
    ingestedAt: z.string().optional(),
  }),
})

const sessionSchema = z.object({
  schemaVersion: recordSchemaVersion,
  scope: scopeSchema,
  sessionId: z.string().min(1),
  lines: z.array(z.string()),
  evidenceMarkers: z.array(z.object({
    index: z.number().int().nonnegative(),
    sensitivity: sensitivitySchema,
    origin: sensitivityAuthoritySchema.optional(),
  })).optional(),
})

const jobSchema = z.object({
  schemaVersion: recordSchemaVersion,
  scope: scopeSchema,
  job: z.record(z.string(), z.unknown()),
})

const auditSchema = z.object({
  schemaVersion: recordSchemaVersion,
  scope: scopeSchema,
  at: z.string(),
  event: z.string(),
  detail: z.record(z.string(), z.unknown()).optional(),
})

const observationRecordSchema = z.object({
  schemaVersion: recordSchemaVersion,
  scope: scopeSchema,
  observation: observationSchema,
})
const purgeRecordSchema = z.object({
  operationId: z.string().min(1),
  sessionId: z.string().min(1),
  status: z.enum(['started', 'completed', 'failed']),
  startedAt: z.string(),
  completedAt: z.string().optional(),
  error: z.string().optional(),
})
const suppressionSchema = z.object({
  schemaVersion: recordSchemaVersion,
  scope: scopeSchema,
  id: z.string().min(1),
  targetKind: z.enum(['page', 'observation']),
  targetId: z.string().min(1),
  reason: z.string(),
  createdAt: z.string(),
  active: z.boolean(),
  restoredAt: z.string().optional(),
  restoreReason: z.string().optional(),
})
const activationSchema = z.object({
  schemaVersion: recordSchemaVersion,
  scope: scopeSchema,
  recordId: z.string().min(1),
  lastRecalledAt: z.string().optional(),
  recallCount: z.number().int().nonnegative(),
  residentPriority: z.number(),
  activationScore: z.number(),
  updatedAt: z.string(),
})
const indexMetaSchema = z.object({
  schemaVersion: recordSchemaVersion,
  scope: scopeSchema,
  indexName: z.string().min(1),
  sourceRevision: z.string().min(1),
  builtAt: z.string(),
  active: z.boolean(),
  providerModel: z.string().optional(),
  dimension: z.number().int().nonnegative().optional(),
  vectorCount: z.number().int().nonnegative().optional(),
  degradedReason: z.string().optional(),
  generationId: z.string().min(1).optional(),
  previousGenerationId: z.string().min(1).optional(),
  validated: z.boolean().optional(),
})
const vectorSchema = z.object({
  schemaVersion: recordSchemaVersion,
  scope: scopeSchema,
  id: z.string().min(1),
  indexName: z.string().min(1),
  model: z.string().min(1),
  dimension: z.number().int().nonnegative(),
  vector: z.array(z.number()),
  textHash: z.string().min(1),
  sourceKind: z.enum(['canonical', 'evidence', 'observation']),
  sourceId: z.string().min(1),
  builtAt: z.string(),
})
const aliasSchema = z.object({
  schemaVersion: recordSchemaVersion,
  scope: scopeSchema,
  id: z.string().min(1),
  entityId: z.string().min(1),
  alias: z.string().min(1),
  normalizedAlias: z.string().min(1),
  confidence: z.number().min(0).max(1),
  sourceRefs: z.array(z.string()),
  createdAt: z.string(),
  updatedAt: z.string(),
  status: z.enum(['active', 'contested', 'invalidated']).optional(),
  resolutionKind: z.enum(['explicit_coreference', 'derived_inference', 'management']).optional(),
  validFrom: z.string().optional(),
  validTo: z.string().optional(),
  invalidatedAt: z.string().optional(),
  invalidatedReason: z.string().optional(),
  replacedBy: z.string().optional(),
})

const projectionSchema = z.object({
  schemaVersion: recordSchemaVersion,
  scope: scopeSchema,
  projection: z.object({
    id: z.string().min(1),
    memoryId: z.string().min(1),
    allowedEffects: z.array(z.enum(['tone', 'avoid_topic', 'avoid_repetition', 'preference_alignment'])),
    topicTags: z.array(z.string()),
    summary: z.string().optional(),
    disclosure: z.preprocess(value => value === 'user_initiated_only' ? 'never_explicit' : value, z.enum(['normal', 'user_explicit_only', 'never_explicit'])),
    ordinaryRawText: z.boolean().optional(),
    generatedFromVersion: z.string().min(1),
    generatedAt: z.string(),
  }),
})
const conflictSchema = z.object({
  schemaVersion: recordSchemaVersion,
  scope: scopeSchema,
  conflict: z.object({
    id: z.string().min(1),
    subject: z.string().min(1),
    predicate: z.string().min(1),
    oldCanonicalId: z.string().min(1),
    newCandidateId: z.string().min(1),
    state: z.enum(['contested', 'resolved']),
    createdAt: z.string(),
    resolvedAt: z.string().optional(),
    resolution: z.enum(['correction', 'temporal_transition', 'management']).optional(),
  }),
})

/** One storage-domain record containing state for a profile scope. */
export interface MemoryStateRecord {
  readonly schemaVersion: 1 | 2 | 3 | 4 | 5 | 6
  readonly scope: MemoryScope
  readonly updatedAt?: string
  readonly lastDreamAt?: string
  readonly lastError?: string
  readonly residentGeneratedAt?: string
  readonly residentVersion?: string
  readonly resident?: string
  readonly residentBlocks?: readonly ResidentBlock[]
  readonly residentMaxChars?: number
  readonly residentOmittedPageIds?: readonly string[]
  readonly residentDiagnostics?: ResidentSnapshot['diagnostics']
  readonly settings: DreamSettings
}

/** Durable Wiki page record bound to one profile scope. */
export interface MemoryPageRecord { readonly schemaVersion: 1 | 2 | 3 | 4 | 5 | 6; readonly scope: MemoryScope; readonly page: WikiPage }
/** Durable Wiki candidate record bound to one profile scope. */
export interface MemoryCandidateRecord { readonly schemaVersion: 1 | 2 | 3 | 4 | 5 | 6; readonly scope: MemoryScope; readonly candidate: WikiCandidate }
/** Durable Wiki source record bound to one profile scope. */
export interface MemorySourceRecord { readonly schemaVersion: 1 | 2 | 3 | 4 | 5 | 6; readonly scope: MemoryScope; readonly source: WikiSource }
/** Durable session transcript record bound to one profile scope. */
export interface MemorySessionRecord { readonly schemaVersion: 1 | 2 | 3 | 4 | 5 | 6; readonly scope: MemoryScope; readonly sessionId: string; readonly lines: readonly string[]; readonly evidenceMarkers?: readonly { readonly index: number; readonly sensitivity: MemorySensitivity; readonly origin?: SensitivityAuthority }[] }
/** Durable Dream job record bound to one profile scope. */
export interface MemoryJobRecord { readonly schemaVersion: 1 | 2 | 3 | 4 | 5 | 6; readonly scope: MemoryScope; readonly job: Record<string, unknown> }
/** Durable audit event record bound to one profile scope. */
export interface MemoryAuditRecord { readonly schemaVersion: 1 | 2 | 3 | 4 | 5 | 6; readonly scope: MemoryScope; readonly at: string; readonly event: string; readonly detail?: Record<string, unknown> }
/** Durable observation record bound to one profile scope. */
export interface MemoryObservationRecord { readonly schemaVersion: 1 | 2 | 3 | 4 | 5 | 6; readonly scope: MemoryScope; readonly observation: MemoryObservation }
/** Durable purge lifecycle record bound to one profile scope. */
export interface MemoryPurgeRecord { readonly schemaVersion: 1 | 2 | 3 | 4 | 5 | 6; readonly scope: MemoryScope; readonly purge: PurgeState }

/** Durable reversible suppression of a canonical page or observation. */
export interface MemorySuppressionRecord {
  readonly schemaVersion: 1 | 2 | 3 | 4 | 5 | 6
  readonly scope: MemoryScope
  readonly id: string
  readonly targetKind: 'page' | 'observation'
  readonly targetId: string
  readonly reason: string
  readonly createdAt: string
  readonly active: boolean
  readonly restoredAt?: string
  readonly restoreReason?: string
}

/** Durable recall and resident-priority state; it never changes truth. */
export interface MemoryActivationRecord {
  readonly schemaVersion: 1 | 2 | 3 | 4 | 5 | 6
  readonly scope: MemoryScope
  readonly recordId: string
  readonly lastRecalledAt?: string
  readonly recallCount: number
  readonly residentPriority: number
  readonly activationScore: number
  readonly updatedAt: string
}

/** Durable lifecycle metadata for one rebuildable derived index. */
export interface MemoryIndexMetaRecord {
  readonly schemaVersion: 1 | 2 | 3 | 4 | 5 | 6
  readonly scope: MemoryScope
  readonly indexName: string
  readonly sourceRevision: string
  readonly builtAt: string
  readonly active: boolean
  readonly providerModel?: string
  readonly dimension?: number
  readonly vectorCount?: number
  readonly degradedReason?: string
  readonly generationId?: string
  readonly previousGenerationId?: string
  readonly validated?: boolean
}

/** Durable provider-neutral vector associated with one source record. */
export interface MemoryVectorRecord {
  readonly schemaVersion: 1 | 2 | 3 | 4 | 5 | 6
  readonly scope: MemoryScope
  readonly id: string
  readonly indexName: string
  readonly model: string
  readonly dimension: number
  readonly vector: number[]
  readonly textHash: string
  readonly sourceKind: 'canonical' | 'evidence' | 'observation'
  readonly sourceId: string
  readonly builtAt: string
}

/** Durable alias record for entity resolution without graph ranking. */
export interface MemoryAliasRecord {
  readonly schemaVersion: 1 | 2 | 3 | 4 | 5 | 6
  readonly scope: MemoryScope
  readonly id: string
  readonly entityId: string
  readonly alias: string
  readonly normalizedAlias: string
  readonly confidence: number
  readonly sourceRefs: string[]
  readonly createdAt: string
  readonly updatedAt: string
  readonly status?: 'active' | 'contested' | 'invalidated'
  readonly resolutionKind?: 'explicit_coreference' | 'derived_inference' | 'management'
  readonly validFrom?: string
  readonly validTo?: string
  readonly invalidatedAt?: string
  readonly invalidatedReason?: string
  readonly replacedBy?: string
}

/** Durable record containing one safe-use projection. */
export interface MemoryProjectionRecord { readonly schemaVersion: 1 | 2 | 3 | 4 | 5 | 6; readonly scope: MemoryScope; readonly projection: SafeUsageProjection }

/** Durable record containing one read-time conflict overlay. */
export interface MemoryConflictRecord { readonly schemaVersion: 1 | 2 | 3 | 4 | 5 | 6; readonly scope: MemoryScope; readonly conflict: ConflictOverlay }

/** The one versioned durable domain owned by this plugin. */
export const MEMORY_DOMAIN = defineDomain({
  name: 'riko_memory',
  version: 6,
  compatibleVersions: [1, 2, 3, 4, 5],
  layout: 'per-record',
  tables: {
    profiles: domainTable<string, MemoryStateRecord>(stateSchema as unknown as z.ZodType<MemoryStateRecord>),
    pages: domainTable<string, MemoryPageRecord>(pageSchema as unknown as z.ZodType<MemoryPageRecord>),
    candidates: domainTable<string, MemoryCandidateRecord>(candidateSchema as unknown as z.ZodType<MemoryCandidateRecord>),
    sources: domainTable<string, MemorySourceRecord>(sourceSchema as unknown as z.ZodType<MemorySourceRecord>),
    sessions: domainTable<string, MemorySessionRecord>(sessionSchema as unknown as z.ZodType<MemorySessionRecord>),
    jobs: domainTable<string, MemoryJobRecord>(jobSchema),
    observations: domainTable<string, MemoryObservationRecord>(observationRecordSchema as unknown as z.ZodType<MemoryObservationRecord>),
    purges: domainTable<string, MemoryPurgeRecord>(z.object({ schemaVersion: recordSchemaVersion, scope: scopeSchema, purge: purgeRecordSchema }) as unknown as z.ZodType<MemoryPurgeRecord>),
    audits: domainTable<string, MemoryAuditRecord>(auditSchema as unknown as z.ZodType<MemoryAuditRecord>),
    suppressions: domainTable<string, MemorySuppressionRecord>(suppressionSchema as unknown as z.ZodType<MemorySuppressionRecord>),
    activation: domainTable<string, MemoryActivationRecord>(activationSchema as unknown as z.ZodType<MemoryActivationRecord>),
    index_meta: domainTable<string, MemoryIndexMetaRecord>(indexMetaSchema as unknown as z.ZodType<MemoryIndexMetaRecord>),
    vectors: domainTable<string, MemoryVectorRecord>(vectorSchema as unknown as z.ZodType<MemoryVectorRecord>),
    aliases: domainTable<string, MemoryAliasRecord>(aliasSchema as unknown as z.ZodType<MemoryAliasRecord>),
    projections: domainTable<string, MemoryProjectionRecord>(projectionSchema as unknown as z.ZodType<MemoryProjectionRecord>),
    conflicts: domainTable<string, MemoryConflictRecord>(conflictSchema as unknown as z.ZodType<MemoryConflictRecord>),
  },
})

/** Strongly-typed handle for the versioned memory domain. */
export type MemoryDomain = Domain<typeof MEMORY_DOMAIN>

/**
 * Build a domain key that cannot collide across profile scopes.
 * @param scope - the profile scope owning the record.
 * @param id - the local record identifier.
 * @returns the composite storage key.
 */
export function scopedRecordKey(scope: MemoryScope, id: string): string {
  const value = id.trim()
  if (value.length === 0 || value.includes(':')) throw new Error('memory domain record id must be non-empty and must not contain colon')
  return `${storageScopeKey(scope)}--${value}`
}

/**
 * Encode a human-readable scope into the storage backend's path-safe key grammar.
 * @param scope - the profile scope to encode.
 * @returns the path-safe storage key for the scope.
 */
export function storageScopeKey(scope: MemoryScope): string {
  return scope.key.replace(/[^A-Za-z0-9_-]/g, '--')
}

/**
 * Detect whether a stored record belongs to one scope.
 * @param value - the record carrying a scope reference.
 * @param scope - the profile scope to test against.
 * @returns whether the record belongs to the scope.
 */
export function belongsToScope(value: { readonly scope: MemoryScope }, scope: MemoryScope): boolean {
  return value.scope.key === scope.key
}
