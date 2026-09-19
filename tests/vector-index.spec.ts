import { describe, expect, it } from 'vitest'
import { createEmbeddingProvider, EmbeddingProviderError } from '../src/embedding-provider.ts'
import { DenseVectorIndex, DenseVectorIndexBuildError, DenseVectorIndexQueryError } from '../src/vector-index.ts'
import type { MemoryScope } from '../src/contracts.ts'
import type { EmbeddingProvider, RecallDocument } from '../src/recall.ts'

const scope: MemoryScope = { schemaVersion: 1, ownerNamespace: 'test', stableAgentPresetId: 'preset', key: 'test:preset' }

function document(id: string, text: string): RecallDocument {
  return { id, sourceType: 'canonical', text, sourceRefs: [`source:${id}`], epistemicStatus: 'confirmed', temporalStatus: 'current' }
}

function index(sourceRevision = 'revision-1', providerModel = 'deterministic-local-v1', schemaVersion: 1 | 2 | 3 = 1): DenseVectorIndex {
  return new DenseVectorIndex({ indexName: 'recall', scope, schemaVersion, sourceRevision, providerModel, now: () => '2026-09-19T00:00:00.000Z' })
}

function deterministicProvider(dimension = 32): EmbeddingProvider {
  const provider = createEmbeddingProvider({ kind: 'deterministic-local', dimension })
  if (provider === undefined) throw new Error('expected deterministic provider')
  return provider
}

describe('DenseVectorIndex', () => {
  it('builds, serializes, restores, and preserves deterministic search order', async () => {
    const provider = deterministicProvider()
    const documents = [document('page:a', 'North Pier Cafe has quiet window seats.'), document('page:b', 'Locker B-417 is near the station.'), document('page:c', 'The user prefers concise explanations.')]
    const first = index()
    await first.rebuild(documents, provider)
    const records = first.serialize()
    const restored = index()
    restored.restore(records)

    const originalResults = await first.search('quiet cafe window', provider, 3)
    const restoredResults = await restored.search('quiet cafe window', provider, 3)
    expect(restoredResults.map(result => result.id)).toEqual(originalResults.map(result => result.id))
    expect(restoredResults.map(result => result.score)).toEqual(originalResults.map(result => result.score))
    expect(restored.serialize()).toEqual(records)
  })

  it('is stable across two deterministic provider constructions', async () => {
    const first = createEmbeddingProvider({ kind: 'deterministic-local', dimension: 16 })
    const second = createEmbeddingProvider({ kind: 'deterministic-local', dimension: 16 })
    if (first === undefined || second === undefined) throw new Error('expected deterministic providers')
    await expect(first.embedQuery('same input')).resolves.toEqual(await second.embedQuery('same input'))
    await expect(first.embedDocuments(['one', 'two'])).resolves.toEqual(await second.embedDocuments(['one', 'two']))
  })

  it('keeps the active generation searchable after rebuild and query failures', async () => {
    const provider = deterministicProvider()
    const denseIndex = index()
    await denseIndex.rebuild([document('page:old', 'Old generation fact')], provider)
    const failingProvider: EmbeddingProvider = {
      async embedDocuments() { throw new Error('provider unavailable') },
      async embedQuery() { throw new Error('query unavailable') },
    }

    await expect(denseIndex.rebuild([document('page:new', 'New generation fact')], failingProvider)).rejects.toBeInstanceOf(DenseVectorIndexBuildError)
    await expect(denseIndex.search('old', provider, 5)).resolves.toEqual(expect.arrayContaining([expect.objectContaining({ id: 'page:old' })]))
    await expect(denseIndex.search('old', failingProvider, 5)).rejects.toBeInstanceOf(DenseVectorIndexQueryError)
    await expect(denseIndex.search('old', provider, 5)).resolves.toEqual(expect.arrayContaining([expect.objectContaining({ id: 'page:old' })]))
  })

  it('requires rebuild after revisions, model/schema changes, and invalidation', async () => {
    const denseIndex = index()
    await denseIndex.rebuild([document('page:a', 'Alpha')], deterministicProvider())
    expect(denseIndex.needsRebuild({ sourceRevision: 'revision-1', providerModel: 'deterministic-local-v1', schemaVersion: 1 })).toBe(false)
    expect(denseIndex.needsRebuild({ sourceRevision: 'revision-2', providerModel: 'deterministic-local-v1', schemaVersion: 1 })).toBe(true)
    expect(denseIndex.needsRebuild({ sourceRevision: 'revision-1', providerModel: 'other-model', schemaVersion: 1 })).toBe(true)
    expect(denseIndex.needsRebuild({ sourceRevision: 'revision-1', providerModel: 'deterministic-local-v1', schemaVersion: 2 })).toBe(true)
    denseIndex.invalidate('page-corrected')
    expect(denseIndex.metadata().degradedReason).toBe('page-corrected')
    expect(denseIndex.needsRebuild({ sourceRevision: 'revision-1', providerModel: 'deterministic-local-v1', schemaVersion: 1 })).toBe(true)
  })

  it('enforces bounded batches and dimensions', async () => {
    const denseIndex = new DenseVectorIndex({ indexName: 'recall', scope, schemaVersion: 1, sourceRevision: 'revision-1', maxVectors: 1, maxDimension: 4, batchSize: 1 })
    await expect(denseIndex.rebuild([document('a', 'a'), document('b', 'b')], deterministicProvider(4))).rejects.toThrow('maxVectors')
    const invalidProvider: EmbeddingProvider = {
      async embedDocuments() { return [[1, 2, 3, 4, 5]] },
      async embedQuery() { return [1, 2, 3, 4, 5] },
    }
    await expect(denseIndex.rebuild([document('a', 'a')], invalidProvider)).rejects.toBeInstanceOf(DenseVectorIndexBuildError)
  })
})

describe('embedding provider factory', () => {
  it('retries 429 once and resolves the credential for each call', async () => {
    const responses = [
      new Response('', { status: 429 }),
      new Response(JSON.stringify({ data: [{ embedding: [1, 0] }] }), { status: 200, headers: { 'content-type': 'application/json' } }),
    ]
    let calls = 0
    let resolved = 0
    const secret = 'test-secret-that-must-not-leak'
    const provider = createEmbeddingProvider({ kind: 'openai-compatible', endpoint: 'http://127.0.0.1:9999/v1/embeddings', model: 'test-model', credentialRef: 'embedding-key', timeoutMs: 100 }, {
      resolveCredential: (name) => { resolved += 1; return name === 'embedding-key' ? secret : undefined },
      fetch: async (_input, init) => {
        calls += 1
        expect(init?.headers).toEqual({ authorization: `Bearer ${secret}`, 'content-type': 'application/json' })
        return responses.shift() ?? new Response('', { status: 500 })
      },
    })
    if (provider === undefined) throw new Error('expected HTTP provider')
    await expect(provider.embedQuery('hello')).resolves.toEqual([1, 0])
    expect(calls).toBe(2)
    expect(resolved).toBe(1)
  })

  it('bounds timeout through the transport abort signal', async () => {
    let aborted = false
    const provider = createEmbeddingProvider({ kind: 'openai-compatible', endpoint: 'http://127.0.0.1:9999/v1/embeddings', model: 'test-model', credentialRef: 'embedding-key', timeoutMs: 10 }, {
      resolveCredential: () => 'secret',
      fetch: async (_input, init) => await new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener('abort', () => { aborted = true; reject(new Error('transport aborted')) }, { once: true })
      }),
    })
    if (provider === undefined) throw new Error('expected HTTP provider')
    await expect(provider.embedQuery('timeout')).rejects.toMatchObject({ reason: 'timeout' })
    expect(aborted).toBe(true)
  })

  it('sanitizes HTTP failures and never includes the credential in an error', async () => {
    const secret = 'secret-only-in-memory'
    const provider = createEmbeddingProvider({ kind: 'openai-compatible', endpoint: 'http://127.0.0.1:9999/v1/embeddings', model: 'test-model', credentialRef: 'embedding-key', timeoutMs: 100 }, {
      resolveCredential: () => secret,
      fetch: async () => new Response(JSON.stringify({ error: { message: secret } }), { status: 500 }),
    })
    if (provider === undefined) throw new Error('expected HTTP provider')
    const error = await provider.embedQuery('failure').catch(value => value)
    expect(error).toBeInstanceOf(EmbeddingProviderError)
    expect(String(error)).not.toContain(secret)
  })
})
