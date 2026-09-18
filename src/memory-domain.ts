/** Native storage-domain declaration for all Riko memory records. */
/* oxlint-disable @stylistic/max-len */

import { defineDomain, domainTable, type Domain } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'
import type { MemoryScope } from './contracts.ts'
import type { DreamSettings } from './types.ts'
import type { WikiCandidate, WikiPage, WikiSource } from './wiki.ts'

const scopeSchema = z.object({
  schemaVersion: z.literal(1),
  ownerNamespace: z.string().min(1),
  stableAgentPresetId: z.string().min(1),
  key: z.string().min(3),
})

const stateSchema = z.object({
  schemaVersion: z.literal(1),
  scope: scopeSchema,
  updatedAt: z.string().optional(),
  lastDreamAt: z.string().optional(),
  lastError: z.string().optional(),
  residentGeneratedAt: z.string().optional(),
  residentVersion: z.string().optional(),
  resident: z.string().optional(),
  settings: z.object({
    apiUrl: z.string().min(1),
    credentialRef: z.string().min(1),
    model: z.string().min(1),
    maxTokens: z.number().int().positive(),
  }),
})

const pageSchema = z.object({
  schemaVersion: z.literal(1),
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
    confidence: z.number().min(0).max(1),
    sensitivity: z.enum(['normal', 'sensitive']).optional(),
    status: z.enum(['candidate', 'confirmed', 'superseded']),
    consent: z.boolean(),
    validUntil: z.string().optional(),
    locked: z.boolean(),
    version: z.number().int().positive(),
    updatedAt: z.string(),
    category: z.string().optional(),
    kind: z.string().optional(),
  }).passthrough(),
})

const candidateSchema = z.object({
  schemaVersion: z.literal(1),
  scope: scopeSchema,
  candidate: z.object({
    id: z.string().min(1),
    proposedPath: z.string().min(1),
    page: pageSchema.shape.page,
    sourceConversations: z.array(z.string()),
    createdAt: z.string(),
    status: z.enum(['candidate', 'rejected', 'accepted']),
    conflictPageId: z.string().optional(),
  }),
})

const sourceSchema = z.object({
  schemaVersion: z.literal(1),
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
  schemaVersion: z.literal(1),
  scope: scopeSchema,
  sessionId: z.string().min(1),
  lines: z.array(z.string()),
})

const jobSchema = z.object({
  schemaVersion: z.literal(1),
  scope: scopeSchema,
  job: z.record(z.string(), z.unknown()),
})

const auditSchema = z.object({
  schemaVersion: z.literal(1),
  scope: scopeSchema,
  at: z.string(),
  event: z.string(),
  detail: z.record(z.string(), z.unknown()).optional(),
})

/** One storage-domain record containing state for a profile scope. */
export interface MemoryStateRecord {
  readonly schemaVersion: 1
  readonly scope: MemoryScope
  readonly updatedAt?: string
  readonly lastDreamAt?: string
  readonly lastError?: string
  readonly residentGeneratedAt?: string
  readonly residentVersion?: string
  readonly resident?: string
  readonly settings: DreamSettings
}

export interface MemoryPageRecord { readonly schemaVersion: 1; readonly scope: MemoryScope; readonly page: WikiPage }
export interface MemoryCandidateRecord { readonly schemaVersion: 1; readonly scope: MemoryScope; readonly candidate: WikiCandidate }
export interface MemorySourceRecord { readonly schemaVersion: 1; readonly scope: MemoryScope; readonly source: WikiSource }
export interface MemorySessionRecord { readonly schemaVersion: 1; readonly scope: MemoryScope; readonly sessionId: string; readonly lines: readonly string[] }
export interface MemoryJobRecord { readonly schemaVersion: 1; readonly scope: MemoryScope; readonly job: Record<string, unknown> }
export interface MemoryAuditRecord { readonly schemaVersion: 1; readonly scope: MemoryScope; readonly at: string; readonly event: string; readonly detail?: Record<string, unknown> }

/** The one versioned durable domain owned by this plugin. */
export const MEMORY_DOMAIN = defineDomain({
  name: 'riko_memory',
  version: 1,
  layout: 'per-record',
  tables: {
    profiles: domainTable<string, MemoryStateRecord>(stateSchema as unknown as z.ZodType<MemoryStateRecord>),
    pages: domainTable<string, MemoryPageRecord>(pageSchema as unknown as z.ZodType<MemoryPageRecord>),
    candidates: domainTable<string, MemoryCandidateRecord>(candidateSchema as unknown as z.ZodType<MemoryCandidateRecord>),
    sources: domainTable<string, MemorySourceRecord>(sourceSchema as unknown as z.ZodType<MemorySourceRecord>),
    sessions: domainTable<string, MemorySessionRecord>(sessionSchema),
    jobs: domainTable<string, MemoryJobRecord>(jobSchema),
    audits: domainTable<string, MemoryAuditRecord>(auditSchema as unknown as z.ZodType<MemoryAuditRecord>),
  },
})

export type MemoryDomain = Domain<typeof MEMORY_DOMAIN>

/** Build a domain key that cannot collide across profile scopes. */
export function scopedRecordKey(scope: MemoryScope, id: string): string {
  const value = id.trim()
  if (value.length === 0 || value.includes(':')) throw new Error('memory domain record id must be non-empty and must not contain colon')
  return `${storageScopeKey(scope)}--${value}`
}

/** Encode a human-readable scope into the storage backend's path-safe key grammar. */
export function storageScopeKey(scope: MemoryScope): string {
  return scope.key.replace(/[^A-Za-z0-9_-]/g, '--')
}

/** Detect whether a stored record belongs to one scope. */
export function belongsToScope(value: { readonly scope: MemoryScope }, scope: MemoryScope): boolean {
  return value.scope.key === scope.key
}
