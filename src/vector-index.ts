/* oxlint-disable @stylistic/max-len */
import { createHash } from 'node:crypto'
import type { MemoryScope } from './contracts.ts'
import type { MemoryIndexMetaRecord, MemoryVectorRecord } from './memory-domain.ts'
import { cosineSimilarity, type EmbeddingProvider, type RecallDocument } from './recall.ts'

/** Schema versions accepted by the memory domain's derived index records. */
export type DenseVectorIndexSchemaVersion = MemoryIndexMetaRecord['schemaVersion']

/** Configuration for one scoped, bounded dense vector index. */
export interface DenseVectorIndexOptions {
  readonly indexName: string
  readonly scope: MemoryScope
  readonly schemaVersion: DenseVectorIndexSchemaVersion
  readonly sourceRevision: string
  readonly providerModel?: string
  /** Expected embedding dimension; omitted to infer it from the provider. */
  readonly dimension?: number
  /** Maximum documents sent to the provider in one call. */
  readonly batchSize?: number
  /** Maximum active vectors retained by this index. */
  readonly maxVectors?: number
  /** Maximum dimension accepted from any provider. */
  readonly maxDimension?: number
  /** Clock used for metadata and persistence timestamps. */
  readonly now?: () => string
}

/** One in-memory vector and the document it was derived from. */
export interface DenseVectorIndexRecord {
  readonly id: string
  readonly document: RecallDocument
  readonly vector: readonly number[]
}

/** Metadata exposed by a vector index without the store-owned scope field. */
export type DenseVectorIndexMetadata = Omit<MemoryIndexMetaRecord, 'scope'>

/** One dense search result ordered by descending cosine similarity. */
export interface DenseVectorSearchResult {
  readonly id: string
  readonly document: RecallDocument
  readonly score: number
}

/** Base typed failure for dense index operations. */
export class DenseVectorIndexError extends Error {
  /** Operation that failed. */
  readonly operation: 'rebuild' | 'search'
  /** Original failure, retained for diagnostics without changing the public message. */
  readonly causeValue?: unknown

  /**
   * @param message Sanitized public message.
   * @param operation Operation that failed.
   * @param causeValue Original failure, if one exists.
   */
  constructor(message: string, operation: 'rebuild' | 'search', causeValue?: unknown) {
    super(message)
    this.name = 'DenseVectorIndexError'
    this.operation = operation
    this.causeValue = causeValue
  }
}

/** Typed failure raised when a provider cannot build a complete generation. */
export class DenseVectorIndexBuildError extends DenseVectorIndexError {
  /** Batch number that failed, when failure occurred during provider embedding. */
  readonly batchIndex?: number

  /**
   * @param batchIndex Failed zero-based batch number.
   * @param causeValue Original provider failure.
   */
  constructor(batchIndex?: number, causeValue?: unknown) {
    super('dense vector index rebuild failed', 'rebuild', causeValue)
    this.name = 'DenseVectorIndexBuildError'
    if (batchIndex !== undefined) this.batchIndex = batchIndex
  }
}

/** Typed failure raised when query embedding cannot complete. */
export class DenseVectorIndexQueryError extends DenseVectorIndexError {
  /**
   * @param causeValue Original provider failure.
   */
  constructor(causeValue?: unknown) {
    super('dense vector index query failed', 'search', causeValue)
    this.name = 'DenseVectorIndexQueryError'
  }
}

/** Invalid index input or persisted record. */
export class DenseVectorIndexValidationError extends DenseVectorIndexError {
  /**
   * @param message Validation failure description.
   */
  constructor(message: string) {
    super(message, 'rebuild')
    this.name = 'DenseVectorIndexValidationError'
  }
}

interface ProviderDescriptor {
  readonly model?: string
  readonly dimension?: number
}

interface StoredVector extends DenseVectorIndexRecord {
  readonly persisted: MemoryVectorRecord
}

interface Generation {
  readonly entries: readonly StoredVector[]
  readonly metadata: DenseVectorIndexMetadata
}

/**
 * Provider-neutral, scoped and rebuildable dense index.
 *
 * Rebuilds assemble a private candidate generation, validate every vector,
 * then promote it atomically. The active generation is never mutated while a
 * provider call is in flight, which gives blue/green behavior: a failed build
 * leaves the previous active generation searchable. `restore()` treats the
 * supplied records as one already-built generation and activates them after
 * validation.
 *
 * Stored vectors are bounded by `maxVectors` (default 10,000) and
 * `maxDimension` (default 4,096). These bounds cover both provider output and
 * persisted records; callers can lower them for a smaller scope.
 */
export class DenseVectorIndex {
  private readonly options: Required<Pick<DenseVectorIndexOptions, 'indexName' | 'scope' | 'schemaVersion' | 'sourceRevision' | 'maxVectors' | 'maxDimension'>> & Omit<DenseVectorIndexOptions, 'indexName' | 'scope' | 'schemaVersion' | 'sourceRevision' | 'maxVectors' | 'maxDimension'>
  private readonly createdAt: string
  private activeGeneration: Generation | undefined
  private stagedGeneration: Generation | undefined
  private invalidatedReason: string | undefined

  /**
   * @param options Scoped index name, version, bounds and source revision.
   */
  constructor(options: DenseVectorIndexOptions) {
    const maxVectors = validatePositiveBound(options.maxVectors ?? 10_000, 'maxVectors')
    const maxDimension = validatePositiveBound(options.maxDimension ?? 4_096, 'maxDimension')
    const indexName = nonEmpty(options.indexName, 'indexName')
    const sourceRevision = nonEmpty(options.sourceRevision, 'sourceRevision')
    if (!Number.isInteger(options.schemaVersion) || options.schemaVersion < 1) throw new DenseVectorIndexValidationError('schemaVersion must be a positive integer')
    if (options.dimension !== undefined) validateDimension(options.dimension, maxDimension)
    const now = options.now ?? (() => new Date().toISOString())
    const createdAt = now()
    if (createdAt.length === 0) throw new DenseVectorIndexValidationError('now must return a non-empty timestamp')
    this.options = {
      ...options,
      indexName,
      sourceRevision,
      maxVectors,
      maxDimension,
      scope: options.scope,
      schemaVersion: options.schemaVersion,
    }
    this.createdAt = createdAt
  }

  /**
   * Build and activate a complete generation in bounded provider batches.
   *
   * @param documents Scoped documents from canonical/evidence/observation recall.
   * @param provider Embedding provider used for document vectors.
   * @param signal Optional cancellation signal forwarded to the provider.
   * @returns Resolves after the validated generation is active.
   * @throws DenseVectorIndexBuildError when provider output or execution fails.
   */
  async rebuild(documents: readonly RecallDocument[], provider: EmbeddingProvider, signal?: AbortSignal): Promise<void> {
    const normalizedDocuments = normalizeDocuments(documents, this.options.maxVectors)
    const batchSize = validatePositiveBound(this.options.batchSize ?? 32, 'batchSize')
    const descriptor = describeProvider(provider)
    const providerModel = resolveProviderModel(this.options.providerModel, descriptor.model)
    if (this.options.dimension !== undefined && descriptor.dimension !== undefined && this.options.dimension !== descriptor.dimension) throw new DenseVectorIndexValidationError('provider dimension does not match index dimension')

    const entries: StoredVector[] = []
    let dimension: number | undefined = this.options.dimension ?? descriptor.dimension
    const builtAt = this.timestamp()
    for (let start = 0; start < normalizedDocuments.length; start += batchSize) {
      const batchIndex = Math.floor(start / batchSize)
      const batch = normalizedDocuments.slice(start, start + batchSize)
      let vectors: readonly (readonly number[])[]
      try {
        signal?.throwIfAborted()
        vectors = await provider.embedDocuments(batch.map(document => document.text), signal)
      } catch (error) {
        throw new DenseVectorIndexBuildError(batchIndex, error)
      }
      if (vectors.length !== batch.length) throw new DenseVectorIndexBuildError(batchIndex)
      for (let index = 0; index < vectors.length; index += 1) {
        const vector = vectors[index]
        if (vector === undefined) throw new DenseVectorIndexBuildError(batchIndex)
        dimension = validateVector(vector, dimension, this.options.maxDimension, batchIndex)
        const document = batch[index]
        if (document === undefined) throw new DenseVectorIndexBuildError(batchIndex)
        entries.push({
          id: document.id,
          document,
          vector: [...vector],
          persisted: {
            schemaVersion: this.options.schemaVersion,
            scope: this.options.scope,
            id: document.id,
            indexName: this.options.indexName,
            model: providerModel ?? 'unspecified',
            dimension,
            vector: [...vector],
            textHash: hashText(document.text),
            sourceKind: document.sourceType,
            sourceId: document.id,
            builtAt,
          },
        })
      }
    }

    const candidate = this.generation(entries, {
      indexName: this.options.indexName,
      schemaVersion: this.options.schemaVersion,
      sourceRevision: this.options.sourceRevision,
      builtAt,
      active: false,
      ...(providerModel === undefined ? {} : { providerModel }),
      ...(dimension === undefined ? {} : { dimension }),
      vectorCount: entries.length,
    })
    validateGeneration(candidate, this.options.scope, this.options.indexName, this.options.maxVectors, this.options.maxDimension)
    this.stagedGeneration = candidate
    this.activate()
    this.invalidatedReason = undefined
  }

  /**
   * Restore one persisted generation and activate it after validation.
   *
   * Restored records retain exact vectors and persistence fields. The record
   * schema does not store document text, so the returned document contains its
   * durable id/source identity and an empty text field until the owning store
   * joins it with canonical documents.
   *
   * @param records Vector records belonging to this scope and index.
   * @returns Nothing; the validated records become the active generation.
   */
  restore(records: readonly MemoryVectorRecord[]): void {
    if (records.length > this.options.maxVectors) throw new DenseVectorIndexValidationError('vector count exceeds maxVectors')
    const entries: StoredVector[] = []
    let dimension: number | undefined = this.options.dimension
    let providerModel: string | undefined = this.options.providerModel
    let restoredModel: string | undefined
    let builtAt = this.createdAt
    const ids = new Set<string>()
    for (const record of records) {
      if (record.schemaVersion !== this.options.schemaVersion) throw new DenseVectorIndexValidationError('vector schemaVersion does not match index')
      if (record.scope.key !== this.options.scope.key) throw new DenseVectorIndexValidationError('vector scope does not match index scope')
      if (record.indexName !== this.options.indexName) throw new DenseVectorIndexValidationError('vector indexName does not match index')
      if (ids.has(record.id)) throw new DenseVectorIndexValidationError('vector ids must be unique')
      ids.add(record.id)
      dimension = validateVector(record.vector, dimension ?? record.dimension, this.options.maxDimension)
      if (record.dimension !== dimension) throw new DenseVectorIndexValidationError('persisted vector dimension does not match vector length')
      if (restoredModel !== undefined && record.model !== restoredModel) throw new DenseVectorIndexValidationError('persisted vectors must use one provider model')
      restoredModel ??= record.model
      if (providerModel !== undefined && record.model !== providerModel) throw new DenseVectorIndexValidationError('persisted vector model does not match index providerModel')
      if (providerModel === undefined && record.model !== 'unspecified') providerModel = record.model
      builtAt = record.builtAt
      entries.push({
        id: record.id,
        document: documentFromRecord(record),
        vector: [...record.vector],
        persisted: { ...record, vector: [...record.vector] },
      })
    }
    const candidate = this.generation(entries, {
      indexName: this.options.indexName,
      schemaVersion: this.options.schemaVersion,
      sourceRevision: this.options.sourceRevision,
      builtAt,
      active: false,
      ...(providerModel === undefined ? {} : { providerModel }),
      ...(dimension === undefined ? {} : { dimension }),
      vectorCount: entries.length,
    })
    validateGeneration(candidate, this.options.scope, this.options.indexName, this.options.maxVectors, this.options.maxDimension)
    this.stagedGeneration = candidate
    this.activate()
    this.invalidatedReason = undefined
  }

  /**
   * Serialize the currently active generation for the store's vectors table.
   *
   * @returns Cloned vector records in deterministic id order.
   */
  serialize(): readonly MemoryVectorRecord[] {
    if (this.activeGeneration === undefined) return []
    return [...this.activeGeneration.entries]
      .sort((left, right) => compareIds(left.id, right.id))
      .map(entry => ({ ...entry.persisted, vector: [...entry.persisted.vector] }))
  }

  /**
   * Embed a query and rank the active generation without mutating it.
   *
   * @param query Query text sent to the provider.
   * @param provider Query embedding provider.
   * @param k Maximum number of positive-similarity results.
   * @param signal Optional cancellation signal forwarded to the provider.
   * @returns Ranked dense results with deterministic id tie-breaking.
   * @throws DenseVectorIndexQueryError when query embedding is unavailable or invalid.
   */
  async search(query: string, provider: EmbeddingProvider, k: number, signal?: AbortSignal): Promise<readonly DenseVectorSearchResult[]> {
    const generation = this.activeGeneration
    const limit = Math.max(0, Math.floor(k))
    if (generation === undefined || limit === 0) return []
    let queryVector: readonly number[]
    try {
      signal?.throwIfAborted()
      queryVector = await provider.embedQuery(query, signal)
    } catch (error) {
      throw new DenseVectorIndexQueryError(error)
    }
    try {
      validateVector(queryVector, generation.metadata.dimension, this.options.maxDimension)
    } catch (error) {
      if (error instanceof DenseVectorIndexValidationError) throw new DenseVectorIndexQueryError(error)
      throw error
    }
    return generation.entries
      .map(entry => ({ id: entry.id, document: entry.document, score: cosineSimilarity(queryVector, entry.vector) }))
      .filter(result => result.score > 0)
      .sort((left, right) => right.score - left.score || compareIds(left.id, right.id))
      .slice(0, limit)
  }

  /**
   * Return the current derived-index metadata.
   *
   * @returns Metadata suitable for the store's index_meta record after adding scope.
   */
  metadata(): DenseVectorIndexMetadata {
    const metadata = this.activeGeneration?.metadata ?? {
      indexName: this.options.indexName,
      schemaVersion: this.options.schemaVersion,
      sourceRevision: this.options.sourceRevision,
      builtAt: this.createdAt,
      active: false,
      ...(this.options.providerModel === undefined ? {} : { providerModel: this.options.providerModel }),
      ...(this.options.dimension === undefined ? {} : { dimension: this.options.dimension }),
      vectorCount: 0,
    }
    return this.invalidatedReason === undefined ? { ...metadata } : { ...metadata, degradedReason: this.invalidatedReason }
  }

  /**
   * Determine whether the active generation matches current source/provider/schema inputs.
   *
   * @param input Current source revision, provider model and index schema version.
   * @returns True when no active generation or any rebuild trigger differs.
   */
  needsRebuild(input: { readonly sourceRevision: string; readonly providerModel?: string; readonly schemaVersion: number }): boolean {
    const metadata = this.activeGeneration?.metadata
    if (metadata === undefined || !metadata.active || this.invalidatedReason !== undefined) return true
    return metadata.sourceRevision !== input.sourceRevision || metadata.providerModel !== input.providerModel || metadata.schemaVersion !== input.schemaVersion
  }

  /**
   * Record a rebuild trigger without discarding the searchable active generation.
   *
   * @param reason One of page create/edit/correct/supersede/forget, policy change, model change, or schema change.
   * @returns Nothing; the reason appears as degraded metadata until activation succeeds.
   */
  invalidate(reason: string): void {
    const normalized = reason.trim()
    if (normalized.length === 0) throw new DenseVectorIndexValidationError('invalidation reason must be non-empty')
    this.invalidatedReason = normalized
  }

  /**
   * Promote a fully staged generation. Rebuild and restore call this only after validation.
   *
   * @returns Nothing; an absent staged generation leaves the active generation unchanged.
   */
  activate(): void {
    const staged = this.stagedGeneration
    if (staged === undefined) return
    this.activeGeneration = { ...staged, metadata: { ...staged.metadata, active: true } }
    this.stagedGeneration = undefined
  }

  private generation(entries: readonly StoredVector[], metadata: DenseVectorIndexMetadata): Generation {
    return { entries, metadata }
  }

  private timestamp(): string {
    return (this.options.now ?? (() => new Date().toISOString()))()
  }
}

function normalizeDocuments(documents: readonly RecallDocument[], maxVectors: number): RecallDocument[] {
  if (documents.length > maxVectors) throw new DenseVectorIndexValidationError('document count exceeds maxVectors')
  const ids = new Set<string>()
  return documents.map((document) => {
    if (document.id.trim().length === 0 || document.text.length === 0) throw new DenseVectorIndexValidationError('documents require non-empty id and text')
    if (ids.has(document.id)) throw new DenseVectorIndexValidationError('document ids must be unique')
    ids.add(document.id)
    return { ...document, sourceRefs: [...document.sourceRefs] }
  })
}

function validateGeneration(generation: Generation, scope: MemoryScope, indexName: string, maxVectors: number, maxDimension: number): void {
  if (generation.entries.length > maxVectors) throw new DenseVectorIndexValidationError('generation exceeds maxVectors')
  for (const entry of generation.entries) {
    if (entry.persisted.scope.key !== scope.key || entry.persisted.indexName !== indexName) throw new DenseVectorIndexValidationError('generation scope or indexName mismatch')
    validateVector(entry.vector, generation.metadata.dimension, maxDimension)
  }
}

function validateVector(vector: readonly number[], expectedDimension: number | undefined, maxDimension: number, batchIndex?: number): number {
  if (vector.length === 0 || vector.length > maxDimension || (expectedDimension !== undefined && vector.length !== expectedDimension) || vector.some(value => !Number.isFinite(value))) {
    if (batchIndex === undefined) throw new DenseVectorIndexValidationError('vector must be finite and match the bounded dimension')
    throw new DenseVectorIndexBuildError(batchIndex)
  }
  return vector.length
}

function validateDimension(value: number, maxDimension: number): void {
  if (!Number.isInteger(value) || value < 1 || value > maxDimension) throw new DenseVectorIndexValidationError('dimension must be a positive integer within maxDimension')
}

function validatePositiveBound(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 1) throw new DenseVectorIndexValidationError(`${name} must be a positive integer`)
  return value
}

function nonEmpty(value: string, field: string): string {
  const normalized = value.trim()
  if (normalized.length === 0) throw new DenseVectorIndexValidationError(`${field} must be non-empty`)
  return normalized
}

function describeProvider(provider: EmbeddingProvider): ProviderDescriptor {
  return provider as EmbeddingProvider & ProviderDescriptor
}

function resolveProviderModel(expected: string | undefined, actual: string | undefined): string | undefined {
  if (expected !== undefined && actual !== undefined && expected !== actual) throw new DenseVectorIndexValidationError('provider model does not match index providerModel')
  return expected ?? actual
}

function documentFromRecord(record: MemoryVectorRecord): RecallDocument {
  return {
    id: record.id,
    sourceType: record.sourceKind,
    text: '',
    sourceRefs: [record.sourceId],
    epistemicStatus: record.sourceKind === 'canonical' ? 'confirmed' : 'inferred',
    temporalStatus: 'unknown',
  }
}

function hashText(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

function compareIds(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}
