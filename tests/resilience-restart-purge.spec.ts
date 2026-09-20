import { afterEach, describe, expect, it } from 'vitest'
import { memoryScopeForPreset } from '../src/contracts.ts'
import type { EmbeddingProvider } from '../src/recall.ts'
import { MemoryProfileStore } from '../src/store.ts'
import type { WikiPage } from '../src/wiki.ts'

interface Table<V> {
  get(key: string): V | undefined
  entries(): IterableIterator<[string, V]>
  put(key: string, value: V): Promise<void>
  delete(key: string): Promise<boolean>
}

class StorageTable<V> implements Table<V> {
  private readonly values = new Map<string, V>()

  constructor(private readonly owner: TestStorageDomain, private readonly name: string) {}

  get(key: string): V | undefined { return this.values.get(key) }

  entries(): IterableIterator<[string, V]> { return ([...this.values.entries()] as [string, V][])[Symbol.iterator]() }

  async put(key: string, value: V): Promise<void> {
    this.values.set(key, value)
    this.owner.afterWrite(this.name)
  }

  async delete(key: string): Promise<boolean> {
    const removed = this.values.delete(key)
    this.owner.afterWrite(this.name)
    return removed
  }
}

class TestStorageDomain {
  private readonly tables = new Map<string, StorageTable<unknown>>()
  private failWrites = 0
  private purgeInterruptionArmed = false
  private journalCommitted = false
  private interruptionInjected = false

  table(name: string): StorageTable<unknown> {
    let table = this.tables.get(name)
    if (table === undefined) {
      table = new StorageTable(this, name)
      this.tables.set(name, table)
    }
    return table
  }

  failNextWrite(): void { this.failWrites = 1 }

  interruptAfterPurgeJournal(): void {
    this.purgeInterruptionArmed = true
    this.journalCommitted = false
    this.interruptionInjected = false
  }

  afterWrite(name: string): void {
    const purges = this.table('purges')
    const startedJournal = [...purges.entries()].some(([, value]) => (value as { purge?: { status?: string } }).purge?.status === 'started')
    if (!this.journalCommitted && name === 'profiles' && startedJournal) {
      this.journalCommitted = true
      return
    }
    if (this.purgeInterruptionArmed && this.journalCommitted && !this.interruptionInjected) {
      this.interruptionInjected = true
      throw new Error('injected purge interruption')
    }
    if (this.failWrites > 0) {
      this.failWrites -= 1
      throw new Error('injected write failure')
    }
  }
}

const scope = memoryScopeForPreset('resilience-owner', 'resilience-preset')
let stores: MemoryProfileStore[] = []

afterEach(async () => {
  await Promise.all(stores.map(store => store.close()))
  stores = []
})

function open(domain: TestStorageDomain, options: ConstructorParameters<typeof MemoryProfileStore>[4] = {}): MemoryProfileStore {
  const store = new MemoryProfileStore(domain, scope, undefined, 12_000, options)
  stores.push(store)
  return store
}

function page(pathPart: string, text: string, sources: readonly string[] = ['session-resilience']): WikiPage {
  return {
    id: pathPart,
    path: `wiki/concepts/${pathPart}.md`,
    type: 'concept',
    title: text,
    description: text,
    body: text,
    sources: [...sources],
    tags: ['interaction_rules'],
    timestamp: '2026-09-19T00:00:00.000Z',
    confidence: 1,
    status: 'confirmed',
    consent: true,
    locked: true,
    version: 1,
    updatedAt: '2026-09-19T00:00:00.000Z',
    category: 'interaction_rules',
    kind: 'preference',
  }
}

function denseProvider(options: { readonly failDocuments?: () => boolean } = {}): EmbeddingProvider & { readonly model: string } {
  const vectorFor = (text: string): readonly number[] => text.includes('old generation') ? [1, 0] : [0, 1]
  return {
    model: 'resilience-dense-v1',
    async embedDocuments(texts) {
      if (options.failDocuments?.()) throw new Error('document embedding failed')
      return texts.map(vectorFor)
    },
    async embedQuery() { return [1, 0] },
  }
}

interface DurableIndexMeta {
  readonly generationId?: string
  readonly sourceRevision: string
  readonly builtAt: string
  readonly active: boolean
  readonly validated?: boolean
  readonly degradedReason?: string
  readonly providerModel?: string
  readonly schemaVersion: number
}

interface MetadataChange {
  readonly name: string
  readonly patch: Record<string, unknown>
  readonly reason: string
}

function indexMeta(domain: TestStorageDomain): DurableIndexMeta {
  const value = [...domain.table('index_meta').entries()]
    .map(([, record]) => record as DurableIndexMeta & { indexName?: string })
    .find(record => record.indexName === 'dense')
  if (value === undefined) throw new Error('expected durable dense index metadata')
  return value
}

function closeStore(store: MemoryProfileStore): Promise<void> {
  stores = stores.filter(candidate => candidate !== store)
  return store.close()
}

describe('durable dense-index resilience', () => {
  it('keeps the prior generation and records degraded metadata after a failed rebuild', async () => {
    let failDocuments = false
    const domain = new TestStorageDomain()
    const provider = denseProvider({ failDocuments: () => failDocuments })
    const store = open(domain, { embeddingProvider: provider })
    await store.upsertManualPage(page('old', 'old generation fact'))
    const initial = await store.recall('你还记得之前那个事实吗？', { vectorEnabled: true })
    const oldId = store.listPages()[0]!.id
    const before = indexMeta(domain)
    const beforeVectors = [...domain.table('vectors').entries()].map(([, record]) => record as { sourceId: string; builtAt: string })

    await store.upsertManualPage(page('new', 'new generation fact'))
    failDocuments = true
    const failed = await store.recall('你还记得之前那个事实吗？', { vectorEnabled: true })
    const after = indexMeta(domain)
    const afterVectors = [...domain.table('vectors').entries()].map(([, record]) => record as { sourceId: string; builtAt: string })

    expect(initial.results.some(result => result.text.includes('old generation fact'))).toBe(true)
    expect(failed.trace.degradedModes).toContain('vector-degraded')
    expect(failed.results.filter(result => result.channels.includes('dense')).map(result => result.id)).toEqual([`page:${oldId}`])
    expect(after.active).toBe(true)
    expect(after.validated).toBe(false)
    expect(after.degradedReason).toBe('vector-degraded')
    expect(after.generationId).toBe(before.generationId)
    expect(afterVectors).toEqual(beforeVectors)
    expect(afterVectors.every(record => record.sourceId === `page:${oldId}` && record.builtAt === before.builtAt)).toBe(true)
  })

  it('restores a durable generation and marks changed source, model, or schema metadata degraded', async () => {
    const domain = new TestStorageDomain()
    const provider = denseProvider()
    const first = open(domain, { embeddingProvider: provider })
    await first.upsertManualPage(page('restart', 'old generation fact'))
    const firstResponse = await first.recall('你还记得之前那个事实吗？', { vectorEnabled: true })
    const original = indexMeta(domain)
    const generationId = original.generationId
    expect(firstResponse.results.some(result => result.text.includes('old generation fact'))).toBe(true)
    await closeStore(first)

    const restored = open(domain, { embeddingProvider: provider })
    await restored.waitReady()
    expect(indexMeta(domain).generationId).toBe(generationId)
    const restoredResponse = await restored.recall('你还记得之前那个事实吗？', { vectorEnabled: true })
    expect(restoredResponse.results.some(result => result.text.includes('old generation fact'))).toBe(true)
    const baseline = indexMeta(domain)
    await closeStore(restored)

    const changes: MetadataChange[] = [
      { name: 'sourceRevision', patch: { sourceRevision: 'persisted-stale-revision' }, reason: 'source-revision-changed' },
      { name: 'providerModel', patch: { providerModel: 'persisted-stale-model' }, reason: 'embedding-model-changed' },
      { name: 'schemaVersion', patch: { schemaVersion: 2 }, reason: 'index-schema-changed' },
    ]
    for (const change of changes) {
      const key = [...domain.table('index_meta').entries()]
        .find(([, value]) => (value as { indexName?: string }).indexName === 'dense')?.[0]
      if (key === undefined) throw new Error(`missing dense metadata for ${change.name}`)
      await domain.table('index_meta').put(key, { ...baseline, ...change.patch })
      const reopened = open(domain, { embeddingProvider: provider })
      await reopened.waitReady()
      const degraded = indexMeta(domain)
      expect(degraded.validated, change.name).toBe(false)
      expect(degraded.degradedReason, change.name).toBe(
        change.reason,
      )
      await closeStore(reopened)
    }
  })
})

describe('purge interruption recovery', () => {
  it('leaves a started durable journal on interruption and resumes with no cascade residue', async () => {
    const domain = new TestStorageDomain()
    const store = open(domain)
    const sessionId = 'session-purge-interruption'
    const phrase = 'purge interruption private phrase'
    await store.appendSessionEvent(sessionId, JSON.stringify({
      seq: 1,
      type: 'user/message',
      data: { source: { kind: 'user' }, content: [{ type: 'text', text: phrase }] },
    }))
    await store.appendSessionEvent(sessionId, JSON.stringify({
      seq: 2,
      type: 'user/message',
      data: { source: { kind: 'user' }, content: [{ type: 'text', text: `${phrase} repeated` }] },
    }))
    await store.upsertManualPage(page('purge-target', phrase, [sessionId]))
    await store.upsertObservationCandidate({
      text: `derived ${phrase}`,
      sourceRefs: [`session:${sessionId}/event:1`, `session:${sessionId}/event:2`],
    })
    await store.upsertJob({ id: 'purge-interruption-job', sessionId, status: 'pending' })
    const plan = store.purgePlan(sessionId)
    domain.interruptAfterPurgeJournal()

    await expect(store.purgeSession(sessionId, { confirmation: plan.confirmation })).rejects.toThrow('injected purge interruption')
    const journal = [...domain.table('purges').entries()]
      .map(([, record]) => record as { purge?: { operationId?: string; sessionId?: string; status?: string } })
      .find(record => record.purge?.operationId === `purge-${plan.confirmation}`)
    expect(journal?.purge).toEqual(expect.objectContaining({ sessionId, status: 'started' }))

    await closeStore(store)
    const resumed = open(domain)
    await resumed.waitReady()
    expect(resumed.listPurges().find(purge => purge.operationId === `purge-${plan.confirmation}`)?.status).toBe('completed')
    expect(await resumed.sessionEvidence(sessionId)).toBeUndefined()
    expect(resumed.listPages().some(item => item.body.includes(phrase))).toBe(false)
    expect(resumed.listObservations().some(item => item.text.includes(phrase))).toBe(false)
    expect(resumed.job('purge-interruption-job')).toBeUndefined()

    const cascadeTables = [
      'profiles', 'pages', 'candidates', 'sources', 'sessions', 'jobs', 'observations', 'audits',
      'suppressions', 'activation', 'index_meta', 'vectors', 'aliases', 'projections', 'conflicts',
    ]
    for (const tableName of cascadeTables) {
      const retained = [...domain.table(tableName).entries()].filter(([, value]) => {
        const text = JSON.stringify(value)
        return text.includes(sessionId) || text.includes(phrase)
      })
      expect(retained, tableName).toEqual([])
    }
  })
})

describe('concurrent recall and failed write', () => {
  it('returns one complete generation while a concurrent edit rolls back', async () => {
    const domain = new TestStorageDomain()
    let releaseQuery!: () => void
    let queryStarted!: () => void
    const queryReady = new Promise<void>((resolve) => { queryStarted = resolve })
    const queryRelease = new Promise<readonly number[]>((resolve) => { releaseQuery = () => { resolve([1, 0]) } })
    const provider: EmbeddingProvider & { readonly model: string } = {
      model: 'concurrency-v1',
      async embedDocuments() { return [[1, 0]] },
      async embedQuery() { queryStarted(); return queryRelease },
    }
    const store = open(domain, { embeddingProvider: provider })
    await store.upsertManualPage(page('concurrent', 'stable old generation value'))
    const id = store.listPages()[0]!.id
    const recallPromise = store.recall('你还记得之前那个事实吗？', { vectorEnabled: true })
    await queryReady

    domain.failNextWrite()
    const editPromise = store.editPage(id, { description: 'new half-written value', body: 'new half-written value' })
    releaseQuery()
    const [recalled, edited] = await Promise.allSettled([recallPromise, editPromise])

    expect(edited.status).toBe('rejected')
    expect(recalled.status).toBe('fulfilled')
    if (recalled.status === 'fulfilled') {
      expect(recalled.value.results.some(result => result.text.includes('stable old generation value'))).toBe(true)
      expect(recalled.value.results.some(result => result.text.includes('new half-written value'))).toBe(false)
    }
    expect(store.page(id)?.body).toBe('stable old generation value')
    const durablePage = [...domain.table('pages').entries()]
      .map(([, value]) => value as { page?: { id?: string; body?: string } })
      .find(value => value.page?.id === id)
    expect(durablePage?.page?.body).toBe('stable old generation value')
  })
})
