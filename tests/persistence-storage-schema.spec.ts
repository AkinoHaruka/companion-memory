import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { memoryScopeForPreset } from '../src/contracts.ts'
import { storageScopeKey } from '../src/memory-domain.ts'
import { MemoryProfileStore } from '../src/store.ts'
import type { EmbeddingProvider } from '../src/recall.ts'
import type { WikiPage } from '../src/wiki.ts'
import { startLiveHarness, type LiveHarness } from './support/live-harness.ts'

const scope = memoryScopeForPreset('test-owner', 'standard')
const lifecycleKeys = [
  'active', 'builtAt', 'dimension', 'generationId', 'indexName', 'previousGenerationId',
  'providerModel', 'schemaVersion', 'scope', 'sourceRevision', 'validated', 'vectorCount',
]

interface DurableIndexMetadata {
  readonly generationId: string
  readonly previousGenerationId?: string
  readonly validated: boolean
  readonly indexName: string
}

interface DurableProfileMetadata {
  readonly residentMaxChars?: number
  readonly residentOmittedPageIds?: string[]
  readonly residentDiagnostics?: { readonly compilerVersion: number }
}

function provider(): EmbeddingProvider & { readonly model: string } {
  return {
    model: 'real-json-dense-v1',
    async embedDocuments(texts) { return texts.map(text => text.includes('old') ? [1, 0] : [0, 1]) },
    async embedQuery() { return [1, 0] },
  }
}

function page(id: string, text: string): WikiPage {
  return {
    id,
    path: `wiki/concepts/${id}.md`,
    type: 'concept',
    title: text,
    description: text,
    body: text,
    sources: [`${id}-session`],
    tags: ['interaction_rules'],
    timestamp: '2026-09-20T00:00:00.000Z',
    confidence: 1,
    status: 'confirmed',
    consent: true,
    locked: true,
    version: 1,
    updatedAt: '2026-09-20T00:00:00.000Z',
    category: 'interaction_rules',
    kind: 'preference',
  }
}

function denseMetadata(harness: LiveHarness): DurableIndexMetadata {
  const domain = harness.context.storageDomain.get('riko_memory')
  if (domain === undefined) throw new Error('riko_memory domain was not open')
  const record = [...domain.table('index_meta').entries()]
    .map(([, value]) => value as DurableIndexMetadata)
    .find(value => value.indexName === 'dense')
  if (record === undefined) throw new Error('dense index metadata was not written')
  return record
}

function profileMetadata(harness: LiveHarness): DurableProfileMetadata {
  const domain = harness.context.storageDomain.get('riko_memory')
  if (domain === undefined) throw new Error('riko_memory domain was not open')
  const record = domain.table('profiles').get(storageScopeKey(scope)) as DurableProfileMetadata | undefined
  if (record === undefined) throw new Error('profile metadata was not written')
  return record
}

let harnesses: LiveHarness[] = []

afterEach(async () => {
  await Promise.all(harnesses.map(harness => harness.dispose()))
  harnesses = []
})

describe('real storage dense lifecycle schema', () => {
  it('retains resident compiler metadata across close and reopen', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-riko-memory-profile-schema-'))
    let store: MemoryProfileStore | undefined
    try {
      const config = ['    embeddingProvider: deterministic', '    recallVectorEnabled: true']
      const first = await startLiveHarness(config, root)
      harnesses.push(first)
      const domain = first.context.storageDomain.get('riko_memory')
      if (domain === undefined) throw new Error('riko_memory domain was not open')
      store = new MemoryProfileStore(domain, scope, undefined, 12_000, { embeddingProvider: provider() })
      await store.upsertManualPage(page('profile-schema-page', 'profile schema fact'))
      const before = profileMetadata(first)
      expect(before.residentMaxChars).toBe(12_000)
      expect(before.residentOmittedPageIds).toEqual([])
      expect(before.residentDiagnostics?.compilerVersion).toBeTypeOf('number')

      await store.close()
      store = undefined
      await first.dispose()
      harnesses = harnesses.filter(harness => harness !== first)

      const reopened = await startLiveHarness(config, root)
      harnesses.push(reopened)
      const after = profileMetadata(reopened)
      expect(after.residentMaxChars).toBe(before.residentMaxChars)
      expect(after.residentOmittedPageIds).toEqual(before.residentOmittedPageIds)
      expect(after.residentDiagnostics).toEqual(before.residentDiagnostics)
    } finally {
      await store?.close()
      await Promise.all(harnesses.map(harness => harness.dispose()))
      harnesses = []
      await rm(root, { recursive: true, force: true })
    }
  })

  it('retains generation lineage and validation across close and reopen', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-riko-memory-storage-schema-'))
    let store: MemoryProfileStore | undefined
    try {
      const config = ['    embeddingProvider: deterministic', '    recallVectorEnabled: true']
      const first = await startLiveHarness(config, root)
      harnesses.push(first)
      const domain = first.context.storageDomain.get('riko_memory')
      if (domain === undefined) throw new Error('riko_memory domain was not open')
      store = new MemoryProfileStore(domain, scope, undefined, 12_000, { embeddingProvider: provider() })
      await store.upsertManualPage(page('old-generation', 'old generation fact'))
      await store.recall('你还记得之前那个事实吗？', { vectorEnabled: true })
      const firstGeneration = denseMetadata(first)

      await store.upsertManualPage(page('new-generation', 'new generation fact'))
      await store.recall('你还记得之前那个事实吗？', { vectorEnabled: true })
      const before = denseMetadata(first)
      expect(Object.keys(before).sort()).toEqual(lifecycleKeys)
      expect(before.generationId).not.toBe(firstGeneration.generationId)
      expect(before.previousGenerationId).toBe(firstGeneration.generationId)
      expect(before.validated).toBe(true)

      await store.close()
      store = undefined
      await first.dispose()
      harnesses = harnesses.filter(harness => harness !== first)

      const reopened = await startLiveHarness(config, root)
      harnesses.push(reopened)
      const after = denseMetadata(reopened)
      expect(Object.keys(after).sort()).toEqual(lifecycleKeys)
      expect(after.generationId).toBe(before.generationId)
      expect(after.previousGenerationId).toBe(before.previousGenerationId)
      expect(after.validated).toBe(before.validated)
    } finally {
      await store?.close()
      await Promise.all(harnesses.map(harness => harness.dispose()))
      harnesses = []
      await rm(root, { recursive: true, force: true })
    }
  })
})
