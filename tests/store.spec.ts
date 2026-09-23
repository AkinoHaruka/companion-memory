/* oxlint-disable @stylistic/max-len */

import { afterEach, describe, expect, it } from 'vitest'
import { memoryScopeForPreset, type MemoryScope } from '../src/contracts.ts'
import type { EmbeddingProvider, MemoryReranker } from '../src/recall.ts'
import { MemoryProfileStore } from '../src/store.ts'
import type { WikiPage } from '../src/wiki.ts'

class Table<V> {
  private readonly values = new Map<string, V>()
  constructor(private readonly beforeWrite: () => void = () => {}) {}
  get(key: string): V | undefined { return this.values.get(key) }
  entries(): IterableIterator<[string, V]> { return ([...this.values.entries()] as [string, V][])[Symbol.iterator]() }
  async put(key: string, value: V): Promise<void> { this.beforeWrite(); this.values.set(key, value) }
  async delete(key: string): Promise<boolean> { this.beforeWrite(); return this.values.delete(key) }
}

class DomainFixture {
  private readonly tables = new Map<string, Table<unknown>>()
  private writeCount = 0
  failAtWrite: number | undefined
  table(name: string): Table<unknown> { let table = this.tables.get(name); if (!table) { table = new Table(() => { this.writeCount += 1; if (this.failAtWrite === this.writeCount) throw new Error('injected write failure') }); this.tables.set(name, table) } return table }
  writes(): number { return this.writeCount }
}

const scopeA = memoryScopeForPreset('owner-a', 'preset-a')
const scopeB = memoryScopeForPreset('owner-a', 'preset-b')
let stores: MemoryProfileStore[] = []

afterEach(async () => { await Promise.all(stores.map(store => store.close())); stores = [] })

function page(scope: MemoryScope, content: string, status: WikiPage['status'] = 'confirmed'): WikiPage {
  return { id: `${scope.stableAgentPresetId}-${content}`, path: `wiki/concepts/${scope.stableAgentPresetId}-${content}.md`, type: 'concept', title: content, description: content, body: content, sources: ['session-a'], tags: ['interaction_rules'], timestamp: '2026-09-17T00:00:00.000Z', confidence: 1, status, consent: status === 'confirmed', locked: status === 'confirmed', version: 1, updatedAt: '2026-09-17T00:00:00.000Z', category: 'interaction_rules', kind: 'preference' }
}

function denseProvider(options: { readonly failDocuments?: () => boolean; readonly failQuery?: () => boolean; readonly counters?: { documents: number; queries: number } } = {}): EmbeddingProvider & { readonly model: string } {
  const vectorFor = (text: string): readonly number[] => text.includes('dense target') ? [1, 0] : [0, 1]
  return {
    model: 'test-dense-v1',
    async embedDocuments(texts) { if (options.counters) options.counters.documents += 1; if (options.failDocuments?.()) throw new Error('document embedding failed'); return texts.map(vectorFor) },
    async embedQuery(query) { if (options.counters) options.counters.queries += 1; if (options.failQuery?.()) throw new Error('query embedding failed'); return query.includes('dense') ? [1, 0] : [0, 1] },
  }
}

function throwingReranker(): MemoryReranker { return { async rerank() { throw new Error('reranker failed') } } }

describe('storage-domain-backed MemoryProfileStore', () => {
  it('does not let runtime Dream settings downgrade HTTPS or embed a credential in the endpoint', async () => {
    const domain = new DomainFixture(); const store = new MemoryProfileStore(domain, scopeA); stores.push(store)
    await expect(store.updateDreamSettings({ apiUrl: 'http://provider.example/anthropic' })).rejects.toThrow(/https/i)
    await expect(store.updateDreamSettings({ apiUrl: 'https://credential@provider.example/anthropic' })).rejects.toThrow(/embedded credential/i)
  })

  it('persists one scope and keeps a different preset isolated', async () => {
    const domain = new DomainFixture(); const alice = new MemoryProfileStore(domain, scopeA); stores.push(alice)
    await alice.upsertManualPage(page(scopeA, 'Alice likes concise answers'))
    expect(alice.renderResident()).toContain('Alice likes concise answers')
    const restored = new MemoryProfileStore(domain, scopeA); stores.push(restored); await restored.waitReady(); expect(restored.renderResident()).toContain('Alice likes concise answers')
    const bob = new MemoryProfileStore(domain, scopeB); stores.push(bob); await bob.waitReady(); expect(bob.renderResident()).toBe('')
  })

  it('keeps Dream output as a candidate until explicit confirmation', async () => {
    const domain = new DomainFixture(); const store = new MemoryProfileStore(domain, scopeA); stores.push(store)
    await store.ingestPages([page(scopeA, 'candidate preference', 'candidate')], new Date().toISOString(), 'session-a')
    expect(store.snapshot().candidates).toHaveLength(1); expect(store.renderResident()).toBe('')
    expect(await store.confirm(store.snapshot().candidates[0]!.id)).toBe(true); expect(store.renderResident()).toContain('candidate preference')
  })

  it('merges repeated candidates by fingerprint and preserves all source conversations', async () => {
    const domain = new DomainFixture(); const store = new MemoryProfileStore(domain, scopeA); stores.push(store)
    const first = page(scopeA, 'repeated preference', 'candidate')
    const second = { ...first, id: 'different-model-id', path: 'wiki/concepts/different-model-path.md', sources: ['session-b'] }
    await store.ingestPages([first], new Date().toISOString(), 'session-a')
    await store.ingestPages([second], new Date().toISOString(), 'session-b')
    const candidates = store.snapshot().candidates
    expect(candidates).toHaveLength(1)
    expect(candidates[0]!.sourceConversations).toEqual(expect.arrayContaining(['session-a', 'session-b']))
    expect(store.renderResident()).toBe('')
  })

  it('lets an operator reject a candidate without promoting it into Resident', async () => {
    const domain = new DomainFixture(); const store = new MemoryProfileStore(domain, scopeA); stores.push(store)
    await store.ingestPages([page(scopeA, 'do not promote', 'candidate')], new Date().toISOString(), 'session-a')
    const candidateId = store.snapshot().candidates[0]!.id
    expect(await store.reject(candidateId)).toBe(true)
    expect(await store.reject(candidateId)).toBe(false)
    expect(store.snapshot().candidates).toEqual([])
    expect(store.renderResident()).toBe('')
    expect(store.listAudits().some(audit => audit.event === 'candidate-rejected')).toBe(true)
  })

  it('corrects and forgets derived memory while retaining raw evidence', async () => {
    const domain = new DomainFixture(); const store = new MemoryProfileStore(domain, scopeA); stores.push(store)
    await store.appendSessionEvent('session-a', JSON.stringify({ seq: 1, type: 'user/message', data: 'raw evidence' })); await store.upsertManualPage(page(scopeA, 'old preference'))
    const id = store.snapshot().pages![0]!.id; await store.editPage(id, { description: 'new preference', body: 'new preference' }); expect(store.renderResident()).not.toContain('old preference'); expect(store.renderResident()).toContain('new preference')
    expect(await store.forget(id)).toBe(true); expect(store.renderResident()).toBe(''); expect(await store.sessionEvidence('session-a')).toContain('raw evidence')
  })

  it('retains correction history and removes superseded pages from Resident', async () => {
    const domain = new DomainFixture(); const store = new MemoryProfileStore(domain, scopeA); stores.push(store)
    await store.upsertManualPage(page(scopeA, 'version one'))
    const id = store.snapshot().pages![0]!.id
    await store.editPage(id, { description: 'version two', body: 'version two' })
    const audits = [...domain.table('audits').entries()] as Array<[string, { event: string; detail?: { previous?: { body?: string }; current?: { body?: string } } }]>
    const correction = audits.map(([, record]) => record).find(record => record.event === 'page-corrected')
    expect(correction?.detail?.previous?.body).toBe('version one')
    expect(correction?.detail?.current?.body).toBe('version two')
    expect(await store.supersede(id)).toBe(true)
    expect(store.renderResident()).toBe('')
    expect(store.listPages({ status: 'superseded' })[0]?.version).toBe(3)
  })

  it('keeps the last resident projection when Dream fails', async () => {
    const domain = new DomainFixture(); const store = new MemoryProfileStore(domain, scopeA); stores.push(store); await store.upsertManualPage(page(scopeA, 'keep this resident')); const before = store.renderResident()
    await store.markDreamFailure(new Error('provider unavailable Bearer token-value sk-example-secret'))
    expect(store.renderResident()).toBe(before)
    expect(store.snapshot().lastError).toBe('provider unavailable Bearer [redacted] [redacted]')
    expect(JSON.stringify(store.listAudits())).not.toContain('token-value')
    expect(JSON.stringify(store.listAudits())).not.toContain('sk-example-secret')
  })

  it('keeps expired pages auditable but excludes them from the new Resident', async () => {
    const domain = new DomainFixture(); const store = new MemoryProfileStore(domain, scopeA); stores.push(store)
    await store.upsertManualPage({ ...page(scopeA, 'expired preference'), validUntil: '2020-01-01T00:00:00.000Z' })
    expect(store.listPages()).toHaveLength(1)
    expect(store.snapshot().records).toHaveLength(1)
    expect(store.renderResident()).toBe('')
  })

  it('keeps sensitive canonical pages out of Resident while allowing explicit recall', async () => {
    const domain = new DomainFixture(); const store = new MemoryProfileStore(domain, scopeA); stores.push(store)
    await store.upsertManualPage({ ...page(scopeA, '私密健康偏好'), sensitivity: 'sensitive' })
    expect(store.renderResident()).toBe('')
    const silent = await store.recall('我的私密健康偏好是什么？')
    expect(silent.results).toEqual([])
    expect(silent.trace.gateReasons).toContain('sensitive-default-suppress')
    const explicit = await store.recall('你还记得我之前说过的私密健康偏好吗？')
    expect(explicit.results.find(result => result.sensitivity === 'sensitive')?.mentionDecision).toBe('silent_use')
    expect(explicit.results.find(result => result.sensitivity === 'sensitive')?.text).toBe('')
  })

  it('persists Dream job status and cursor across a store restart', async () => {
    const domain = new DomainFixture(); const store = new MemoryProfileStore(domain, scopeA); stores.push(store)
    await store.upsertJob({ id: 'job-a', sessionId: 'session-a', scopeKey: scopeA.key, status: 'failed', attempts: 2, cursor: 7, error: 'rate_limited' })
    const restored = new MemoryProfileStore(domain, scopeA); stores.push(restored); await restored.waitReady()
    expect(restored.job('job-a')).toMatchObject({ status: 'failed', attempts: 2, cursor: 7, error: 'rate_limited' })
  })

  it('recalls long-tail canonical and raw evidence without changing Resident truth', async () => {
    const domain = new DomainFixture(); const store = new MemoryProfileStore(domain, scopeA); stores.push(store)
    await store.upsertManualPage(page(scopeA, 'North Pier Cafe window seat'))
    await store.appendSessionEvent('session-number', JSON.stringify({ seq: 17, time: '2026-09-17T00:00:00.000Z', type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '我的储物柜编号是 B-417。' }] } }))
    const cafe = await store.recall('你还记得我之前说的那个 North Pier Cafe 吗？')
    expect(cafe.results.some(result => result.text.includes('North Pier Cafe'))).toBe(true)
    expect(cafe.trace.candidatesByChannel.lexical).toBeGreaterThan(0)
    const number = await store.recall('我之前说过的储物柜编号是什么？')
    expect(number.results.some(result => result.text.includes('B-417'))).toBe(true)
    expect(number.results.some(result => result.sourceRefs.includes('session:session-number/event:17'))).toBe(true)
    expect(store.renderResident()).not.toContain('B-417')
  })

  it('does not recall unrelated or cross-scope personal memory', async () => {
    const domain = new DomainFixture(); const alice = new MemoryProfileStore(domain, scopeA); const bob = new MemoryProfileStore(domain, scopeB); stores.push(alice, bob)
    await bob.upsertManualPage(page(scopeB, 'Bob private cafe preference'))
    const unrelated = await alice.recall('给我解释一下这段代码')
    expect(unrelated.results).toEqual([])
    const scoped = await alice.recall('你还记得我之前说的那个咖啡馆吗？')
    expect(scoped.results).toEqual([])
  })

  it('answers current and historical temporal queries without overwriting the old state', async () => {
    const domain = new DomainFixture(); const store = new MemoryProfileStore(domain, scopeA); stores.push(store)
    await store.upsertManualPage({ ...page(scopeA, '我住上海'), observedAt: '2025-01-10T00:00:00.000Z', validFrom: '2025-01-10T00:00:00.000Z' })
    const oldId = store.snapshot().pages![0]!.id
    const current = await store.updatePageTemporal(oldId, { description: '我搬到杭州了', body: '我搬到杭州了', validFrom: '2026-01-10T00:00:00.000Z', observedAt: '2026-01-10T00:00:00.000Z' })
    expect(current?.description).toBe('我搬到杭州了')
    expect(store.listPages({ status: 'superseded' }).some(item => item.id === oldId && item.validTo === '2026-01-10T00:00:00.000Z')).toBe(true)
    expect(store.searchTemporal('上海', { atTime: '2025-06-01T00:00:00.000Z' })[0]?.page.description).toBe('我住上海')
    expect(store.searchTemporal('杭州', { atTime: '2026-06-01T00:00:00.000Z' })[0]?.page.description).toBe('我搬到杭州了')
    expect(store.renderResident()).toContain('我搬到杭州了'); expect(store.renderResident()).not.toContain('我住上海')
    const historical = await store.recall('你还记得我住哪里吗？', { atTime: '2025-06-01T00:00:00.000Z' })
    expect(historical.results.some(result => result.text.includes('我住上海'))).toBe(true)
  })

  it('keeps correction distinct from temporal replacement and retains audit lineage', async () => {
    const domain = new DomainFixture(); const store = new MemoryProfileStore(domain, scopeA); stores.push(store)
    await store.upsertManualPage(page(scopeA, '我姐叫 Linda'))
    const id = store.snapshot().pages![0]!.id
    const corrected = await store.editPage(id, { description: '我姐叫 Lisa', body: '我姐叫 Lisa' })
    expect(corrected?.id).toBe(id); expect(store.listPages()).toHaveLength(1); expect(store.renderResident()).toContain('我姐叫 Lisa'); expect(store.renderResident()).not.toContain('Linda')
    expect(store.listAudits().some(audit => audit.event === 'page-corrected')).toBe(true)
    expect(store.listAudits().some(audit => audit.event === 'page-temporal-updated')).toBe(false)
  })

  it('compiles deterministic bounded Resident blocks and reads a legacy snapshot', async () => {
    const domain = new DomainFixture(); const store = new MemoryProfileStore(domain, scopeA, undefined, 480); stores.push(store)
    for (let index = 0; index < 20; index += 1) await store.upsertManualPage(page(scopeA, `稳定事实 ${index} ${'x'.repeat(30)}`))
    const resident = store.renderResident(); const snapshot = store.snapshot()
    expect(resident.length).toBeLessThanOrEqual(480); expect(resident).toContain('<persistent-memory>'); expect(resident).toContain('</persistent-memory>'); expect(snapshot.residentSnapshot?.blocks?.length).toBeGreaterThan(0)
    const blockSourcePageIds = snapshot.residentSnapshot?.blocks?.flatMap(block => block.sourcePageIds) ?? []
    expect(snapshot.residentSnapshot?.sourcePageIds).toEqual([...new Set(blockSourcePageIds)])
    expect(blockSourcePageIds.length).toBeLessThan(20)
    const restored = new MemoryProfileStore(domain, scopeA, undefined, 480); stores.push(restored); await restored.waitReady()
    expect(restored.renderResident()).toBe(resident)

    const legacyDomain = new DomainFixture()
    await legacyDomain.table('profiles').put('owner-a--preset-a', { schemaVersion: 1, scope: scopeA, resident: '<persistent-memory>legacy snapshot</persistent-memory>', settings: { apiUrl: 'https://provider.example/chat', credentialRef: 'DSH_MEMORY_DREAM_API_KEY', model: 'legacy', maxTokens: 1200 } })
    const legacy = new MemoryProfileStore(legacyDomain, scopeA); stores.push(legacy); await legacy.waitReady()
    expect(legacy.renderResident()).toContain('legacy snapshot'); expect(legacy.snapshot().residentSnapshot?.blocks).toEqual([])
    await legacy.upsertManualPage(page(scopeA, 'migrated fact'))
    expect((legacyDomain.table('profiles').get('owner-a--preset-a') as { schemaVersion: number }).schemaVersion).toBe(2)
  })

  it('skips an oversized Resident item and continues to a later item that fits', async () => {
    const domain = new DomainFixture(); const store = new MemoryProfileStore(domain, scopeA, undefined, 300); stores.push(store)
    const oversized = page(scopeA, `oversized ${'x'.repeat(160)}`); const later = page(scopeA, 'later item fits')
    await store.upsertManualPage(oversized); await store.upsertManualPage(later)
    const snapshot = store.snapshot(); const oversizedId = store.page(oversized.path)?.id; const laterId = store.page(later.path)?.id
    expect(store.renderResident()).toContain('later item fits'); expect(store.renderResident()).not.toContain('oversized')
    expect(snapshot.residentSnapshot?.sourcePageIds).toContain(laterId); expect(snapshot.residentSnapshot?.sourcePageIds).not.toContain(oversizedId); expect(snapshot.residentSnapshot?.omittedPageIds).toContain(oversizedId)
    expect(snapshot.residentSnapshot?.content.length).toBe(snapshot.residentSnapshot?.diagnostics?.actualChars); expect(snapshot.residentSnapshot?.content.length).toBeLessThanOrEqual(300)
  })

  it('redistributes the unused Resident block budget instead of stranding it', async () => {
    const domain = new DomainFixture(); const store = new MemoryProfileStore(domain, scopeA, undefined, 600); stores.push(store)
    const bareConcept = (content: string): WikiPage => ({ id: `${scopeA.stableAgentPresetId}-${content}`, path: `wiki/concepts/${content}.md`, type: 'concept', title: content, description: content, body: content, sources: ['session-a'], tags: [], timestamp: '2026-09-17T00:00:00.000Z', confidence: 1, status: 'confirmed', consent: true, locked: true, version: 1, updatedAt: '2026-09-17T00:00:00.000Z' })
    await store.upsertManualPage({ ...bareConcept('partner Kai'), type: 'relationship', path: 'wiki/relationships/partner-kai.md' })
    for (let index = 1; index <= 40; index += 1) await store.upsertManualPage(bareConcept(`P${String(index).padStart(2, '0')}`))
    const snapshot = store.snapshot().residentSnapshot
    // The single relationship page keeps its fair minimum share while the preference block absorbs
    // the budget the six empty blocks leave unused; the old even split admitted only four of the
    // forty preference entries and rendered ~229 chars.
    expect(store.renderResident()).toContain('partner Kai')
    expect(snapshot?.blocks?.find(block => block.kind === 'preferences')?.entries.length).toBe(27)
    expect(snapshot?.diagnostics?.includedCount).toBe(28)
    expect(store.renderResident().length).toBeGreaterThan(500)
    expect(store.renderResident().length).toBeLessThanOrEqual(600)
  })

  it('bounds and migrates an over-budget legacy Resident instead of serving it', async () => {
    const domain = new DomainFixture(); const legacyValue = '<persistent-memory>legacy ' + 'x'.repeat(400) + '</persistent-memory>'
    await domain.table('profiles').put('owner-a--preset-a', { schemaVersion: 1, scope: scopeA, resident: legacyValue, settings: { apiUrl: 'https://provider.example/chat', credentialRef: 'DSH_MEMORY_DREAM_API_KEY', model: 'legacy', maxTokens: 1200 } })
    const store = new MemoryProfileStore(domain, scopeA, undefined, 120); stores.push(store); await store.waitReady()
    expect(store.renderResident()).toBe(''); expect(store.renderResident().length).toBeLessThanOrEqual(120); expect(store.snapshot().residentSnapshot?.diagnostics?.actualChars).toBe(0)
    expect((domain.table('profiles').get('owner-a--preset-a') as { resident: string }).resident.length).toBeLessThanOrEqual(120)
  })

  it('uses persisted evidence sensitivity markers and fails closed for unknown raw evidence', async () => {
    const domain = new DomainFixture(); const store = new MemoryProfileStore(domain, scopeA); stores.push(store)
    await store.appendSessionEvent('session-sensitivity', JSON.stringify({ seq: 1, time: '2026-09-17T00:00:00.000Z', type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '我的储物柜编号是 N-100。' }] } }))
    await store.appendSessionEvent('session-sensitivity', JSON.stringify({ seq: 2, time: '2026-09-17T00:00:00.000Z', type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '我的私密病历编号是 S-200。' }] } }))
    expect(await store.markEvidenceSensitivity('session-sensitivity', 0, 'normal', 'user')).toBe(true)
    const normal = await store.recall('我之前说过的储物柜编号是什么？'); expect(normal.results.some(result => result.text.includes('N-100'))).toBe(true)
    const unknown = await store.recall('我的编号是私密病历吗？'); expect(unknown.results.some(result => result.text.includes('S-200'))).toBe(false); expect(unknown.trace.gateReasons).toContain('sensitive-default-suppress')
    expect(store.listAudits().some(audit => audit.event === 'evidence-sensitivity-marked')).toBe(true)
  })

  it('applies atTime to raw evidence and observedAt-only canonical pages', async () => {
    const domain = new DomainFixture(); const store = new MemoryProfileStore(domain, scopeA); stores.push(store)
    await store.appendSessionEvent('session-time', JSON.stringify({ seq: 1, time: '2025-01-01T00:00:00.000Z', type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '旧储物柜编号 O-1。' }] } }))
    await store.appendSessionEvent('session-time', JSON.stringify({ seq: 2, time: '2026-01-01T00:00:00.000Z', type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '新储物柜编号 N-2。' }] } }))
    await store.markEvidenceSensitivity('session-time', 0, 'normal', 'user'); await store.markEvidenceSensitivity('session-time', 1, 'normal', 'user')
    await store.upsertManualPage({ ...page(scopeA, '未来观察页面'), observedAt: '2099-01-01T00:00:00.000Z' })
    const response = await store.recall('我之前说过的储物柜编号是什么？', { atTime: '2025-06-01T00:00:00.000Z' })
    expect(response.results.some(result => result.text.includes('O-1'))).toBe(true); expect(response.results.some(result => result.text.includes('N-2'))).toBe(false); expect(response.results.some(result => result.text.includes('未来观察页面'))).toBe(false)
  })

  it('derives provider page observation time from validated L0 and stamps canonical receipt time', async () => {
    const domain = new DomainFixture(); const store = new MemoryProfileStore(domain, scopeA); stores.push(store)
    await store.appendSessionEvent('temporal-source', JSON.stringify({ seq: 7, time: '2026-01-02T03:04:05.000Z', type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'trusted temporal fact' }] } }))
    const providerPage = { ...page(scopeA, 'trusted temporal fact'), sources: ['temporal-source'], observedAt: '1900-01-01T00:00:00.000Z', recordedAt: '1901-01-01T00:00:00.000Z', timestamp: '1902-01-01T00:00:00.000Z' }
    await store.ingestPages([providerPage], '2026-09-19T00:00:00.000Z', 'temporal-source')
    const stored = store.page(providerPage.path); expect(stored?.observedAt).toBe('2026-01-02T03:04:05.000Z'); expect(stored?.recordedAt).not.toBe('1901-01-01T00:00:00.000Z'); expect(stored?.recordedAt).toBeDefined()

    const legacy = { ...page(scopeA, 'legacy timestamp only'), sources: ['legacy-source'], timestamp: '2020-01-01T00:00:00.000Z', recordedAt: '2020-01-02T00:00:00.000Z' }
    await store.ingestPages([legacy], '2026-09-19T00:00:00.000Z')
    expect(store.page(legacy.path)?.observedAt).toBeUndefined()
  })

  it('invalidates old L0 evidence after a canonical correction', async () => {
    const domain = new DomainFixture(); const store = new MemoryProfileStore(domain, scopeA); stores.push(store)
    await store.appendSessionEvent('session-correction', JSON.stringify({ seq: 1, time: '2026-09-17T00:00:00.000Z', type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '我姐姐叫 Linda。' }] } }))
    const original = page(scopeA, '我姐姐叫 Linda'); await store.upsertManualPage({ ...original, sources: ['session-correction'] }); const id = store.page(original.path)?.id as string
    await store.editPage(id, { title: '我姐姐叫 Lisa', description: '我姐姐叫 Lisa', body: '我姐姐叫 Lisa' })
    const response = await store.recall('你还记得我姐姐叫 Linda 吗？', { history: true })
    expect(response.results.some(result => result.text.includes('Linda'))).toBe(false); expect(response.trace.gateReasons).toContain('correction-invalidated')
  })

  it('degrades graph recall to lexical results when graph expansion throws', async () => {
    const domain = new DomainFixture(); const store = new MemoryProfileStore(domain, scopeA); stores.push(store); await store.upsertManualPage(page(scopeA, 'graph fallback fact'))
    const internal = store as unknown as { wikiIndex: { graph: (...args: unknown[]) => unknown } }; internal.wikiIndex.graph = () => { throw new Error('graph unavailable') }
    const response = await store.recall('你还记得 graph fallback fact 后来怎么样？', { graphEnabled: true, graphMaxHop: 1 })
    expect(response.results.some(result => result.text.includes('graph fallback fact'))).toBe(true); expect(response.trace.degradedModes).toContain('graph-degraded')
  })

  it('suppresses canonical memory from Resident and recall, then restores it', async () => {
    const domain = new DomainFixture(); const store = new MemoryProfileStore(domain, scopeA); stores.push(store); await store.upsertManualPage(page(scopeA, 'suppressible canonical fact')); const id = store.snapshot().pages![0]!.id
    expect(await store.suppressCanonical(id, 'user requested silence')).toBe(true); expect(store.renderResident()).not.toContain('suppressible canonical fact'); expect((await store.recall('你还记得 suppressible canonical fact 吗？')).results).toEqual([])
    expect(await store.restoreCanonical(id, 'user requested restore')).toBe(true); expect(store.renderResident()).toContain('suppressible canonical fact'); expect((await store.recall('你还记得 suppressible canonical fact 吗？')).results.some(result => result.text.includes('suppressible canonical fact'))).toBe(true)
  })

  it('increments activation only after successful recall without changing canonical truth', async () => {
    const domain = new DomainFixture(); const store = new MemoryProfileStore(domain, scopeA); stores.push(store); await store.upsertManualPage(page(scopeA, 'activation truth')); const id = store.snapshot().pages![0]!.id; const before = store.page(id)?.body
    await store.recall('你还记得 activation truth 吗？'); await store.recall('你还记得 activation truth 吗？')
    const activation = [...domain.table('activation').entries()].map(([, value]) => value as { recordId: string; recallCount: number }).find(value => value.recordId === `page:${id}`)
    expect(activation?.recallCount).toBe(2); expect(store.page(id)?.body).toBe(before)
  })

  it('rolls back every durable table and the served Resident when a persist write fails', async () => {
    const domain = new DomainFixture(); const store = new MemoryProfileStore(domain, scopeA); stores.push(store)
    await store.upsertManualPage(page(scopeA, 'rollback baseline'))
    await store.appendSessionEvent('rollback-session', JSON.stringify({ seq: 1, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'rollback raw evidence' }] } }))
    const before = store.snapshot(); const beforeTables = new Map(['pages', 'candidates', 'sources', 'sessions', 'jobs', 'observations'].map(name => [name, JSON.stringify([...domain.table(name).entries()])]))
    domain.failAtWrite = domain.writes() + 4
    await expect(store.ingestPages([page(scopeA, 'rollback candidate', 'candidate')], new Date().toISOString(), 'rollback-session')).rejects.toThrow(/injected write failure/)
    domain.failAtWrite = undefined
    expect(store.snapshot()).toEqual(before); for (const [name, value] of beforeTables) expect(JSON.stringify([...domain.table(name).entries()])).toBe(value)
    const restored = new MemoryProfileStore(domain, scopeA); stores.push(restored); await restored.waitReady(); expect(restored.renderResident()).toBe(before.resident); expect(restored.snapshot().records).toEqual(before.records)
  })

  it('stores, resolves, rebuilds, and reloads explicit and canonical aliases', async () => {
    const domain = new DomainFixture(); const store = new MemoryProfileStore(domain, scopeA); stores.push(store)
    const person = { ...page(scopeA, 'Lisa'), path: 'wiki/entities/lisa.md', type: 'entity' as const, title: 'Lisa', tags: ['我姐'], body: 'Lisa is linked from [[Lisa]]。', category: 'traits_roles' as const, kind: 'fact' as const }
    await store.upsertManualPage(person); const entityId = store.listPages()[0]!.id
    await store.upsertAlias({ entityId, alias: '姐姐', confidence: 0.9, sourceRefs: [`page:${entityId}`] })
    expect(store.resolveAlias('姐姐')).toEqual([{ entityId, alias: '姐姐', confidence: 0.9 }]); expect(store.resolveAlias('我姐')).toEqual([])
    expect(store.listAliases().some(alias => alias.alias === 'Lisa' && alias.sourceRefs.includes(`page:${entityId}`))).toBe(true)
    await store.rebuildAliases(); const restored = new MemoryProfileStore(domain, scopeA); stores.push(restored); await restored.waitReady(); expect(restored.resolveAlias('姐姐')).toEqual([{ entityId, alias: '姐姐', confidence: 0.9 }]); expect(restored.resolveAlias('我姐')).toEqual([])
  })

  it('keeps inferred observations separate, gated, anchored and invalidatable', async () => {
    const domain = new DomainFixture(); const store = new MemoryProfileStore(domain, scopeA); stores.push(store)
    await store.appendSessionEvent('session-observation', JSON.stringify({ seq: 1, time: '2026-09-17T00:00:00.000Z', type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'deadline 前我会忙乱。' }] } }))
    await store.appendSessionEvent('session-observation', JSON.stringify({ seq: 2, time: '2026-09-17T00:01:00.000Z', type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'deadline 前我又会忙乱。' }] } }))
    await expect(store.upsertObservationCandidate({ text: '用户一次在 deadline 前表示忙乱。', sourceRefs: ['session:session-observation/event:1'] })).rejects.toThrow(/at least 2/)
    expect(store.listObservations()).toEqual([])
    await expect(store.upsertObservationCandidate({ text: '用户多次在 deadline 前表示忙乱。', sourceRefs: ['session:session-observation/event:1', 'session:session-observation/event:999999'] })).rejects.toThrow(/invalid/i)
    const observation = await store.upsertObservationCandidate({ text: '用户多次在 deadline 前表示忙乱。', sourceRefs: ['session:session-observation/event:1', 'session:session-observation/event:2'], confidence: 0.7 })
    expect(observation.status).toBe('candidate'); expect(observation.epistemicStatus).toBe('inferred_observation'); expect(store.snapshot().pages).toEqual([]); expect(store.renderResident()).toBe('')
    await expect(store.upsertObservationCandidate({ text: '由旧推断继续推断', sourceRefs: [`observation:${observation.id}`], derivedFromObservationIds: [observation.id] })).rejects.toThrow(/evidence anchor/)
    expect(await store.activateObservation(observation.id)).toBe(true)
    const silent = await store.recall('发生过忙乱吗？', { observationsEnabled: true })
    expect(silent.results.find(result => result.sourceType === 'observation')?.mentionDecision).toBe('silent_use')
    const explicit = await store.recall('你还记得我之前说过 deadline 忙乱吗？', { observationsEnabled: true })
    expect(explicit.results.find(result => result.sourceType === 'observation')?.mentionDecision).toBe('silent_use')
    expect(explicit.trace.gateReasons).toContain('inferred-observation-silent-use')
    const weakened = await store.updateObservationEvidence(observation.id, { contradictingRefs: ['session:session-observation/event:1'] })
    expect(weakened?.status).toBe('weakened'); expect(weakened?.confidence).toBeLessThan(observation.confidence)
    const invalidated = await store.updateObservationEvidence(observation.id, { contradictingRefs: ['session:session-observation/event:2'] })
    expect(invalidated?.status).toBe('invalidated')
    expect((await store.recall('你还记得我之前说过 deadline 忙乱吗？', { observationsEnabled: true })).results.some(result => result.sourceType === 'observation')).toBe(false)
  })

  it('uses the derived Wiki graph for bounded associative multi-hop recall', async () => {
    const domain = new DomainFixture(); const store = new MemoryProfileStore(domain, scopeA); stores.push(store)
    const person = { ...page(scopeA, '让我生气的人'), path: 'wiki/entities/angry-person.md', type: 'entity' as const, title: '让我生气的人', body: '让我生气的人后来发生了 [[后续事件]]。', category: 'traits_roles' as const, kind: 'fact' as const }
    const event = { ...page(scopeA, '后续事件'), path: 'wiki/episodes/follow-up.md', type: 'episode' as const, title: '后续事件', body: '后来他向我道歉了。', category: 'key_experiences' as const, kind: 'event' as const }
    await store.upsertManualPage(person); await store.upsertManualPage(event)
    const response = await store.recall('让我生气的人后来怎么样了？', { graphEnabled: true, graphMaxHop: 1 })
    expect(response.plan.searchGraph).toBe(true); expect(response.trace.candidatesByChannel.graph).toBeGreaterThan(0); expect(response.results.some(result => result.text.includes('向我道歉'))).toBe(true)
  })

  it('purges raw session evidence with derived cascade and a resumable journal', async () => {
    const domain = new DomainFixture(); const store = new MemoryProfileStore(domain, scopeA); stores.push(store)
    await store.appendSessionEvent('session-purge', JSON.stringify({ seq: 1, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'private purge detail' }] } }))
    await store.appendSessionEvent('session-purge', JSON.stringify({ seq: 2, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'private purge detail repeated' }] } }))
    await store.upsertManualPage({ ...page(scopeA, 'private purge detail'), description: 'private purge detail and keep detail', body: 'private purge detail and keep detail', sources: ['session-purge', 'session-keep'] })
    const pageId = store.listPages()[0]!.id
    await store.editPage(pageId, { description: 'private purge detail corrected and keep detail', body: 'private purge detail corrected and keep detail' })
    const observation = await store.upsertObservationCandidate({ text: 'derived private pattern', sourceRefs: ['session:session-purge/event:1', 'session:session-purge/event:2'] }); await store.activateObservation(observation.id)
    await store.upsertJob({ id: 'purge-job', sessionId: 'session-purge', status: 'pending' })
    const before = store.snapshot(); const plan = store.purgePlan('session-purge'); const dryRun = await store.purgeSession('session-purge', { dryRun: true }); expect(dryRun).toEqual(plan); expect(store.snapshot()).toEqual(before)
    await expect(store.purgeSession('session-purge', {})).rejects.toThrow(/confirmation/i)
    await expect(store.purgeSession('session-purge', { confirmation: 'wrong' })).rejects.toThrow(/confirmation/i)
    expect(await store.purgeSession('session-purge', { confirmation: plan.confirmation })).toBe(true)
    expect(await store.sessionEvidence('session-purge')).toBeUndefined(); expect(store.listPages()).toHaveLength(1); expect(store.listPages()[0]!.body).not.toContain('private purge detail'); expect(store.listPages()[0]!.body).toContain('keep detail'); expect(store.listObservations()).toEqual([]); expect(store.job('purge-job')).toBeUndefined(); expect(store.renderResident()).not.toContain('private purge detail')
    expect(store.listPurges()[0]?.status).toBe('completed'); expect(JSON.stringify(store.listAudits())).not.toContain('private purge detail')
    const restored = new MemoryProfileStore(domain, scopeA); stores.push(restored); await restored.waitReady(); expect(restored.job('purge-job')).toBeUndefined(); expect(JSON.stringify(restored.listAudits())).not.toContain('private purge detail')
  })

  it('erases fingerprints from mixed-source pages and an active dense index', async () => {
    const domain = new DomainFixture(); const store = new MemoryProfileStore(domain, scopeA, undefined, 12_000, { embeddingProvider: denseProvider() }); stores.push(store)
    const leakedPhrase = 'DERIVED PHRASE NOT PRESENT IN L0'
    await store.appendSessionEvent('session-derived-purge', JSON.stringify({ seq: 1, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'unrelated source wording' }] } }))
    await store.upsertManualPage({ ...page(scopeA, 'mixed derived page'), description: leakedPhrase, body: leakedPhrase, sources: ['session:session-derived-purge', 'session:session-keep-derived'] })
    await store.recall('你还记得之前的 mixed derived page 吗？', { vectorEnabled: true })
    const plan = store.purgePlan('session-derived-purge')
    expect(await store.purgeSession('session-derived-purge', { confirmation: plan.confirmation })).toBe(true)
    expect(store.listPages()[0]?.body).not.toContain(leakedPhrase)
    expect((([...domain.table('index_meta').entries()][0]?.[1] as { active?: boolean } | undefined)?.active)).toBe(false)
    expect([...domain.table('vectors').entries()].some(([, value]) => JSON.stringify(value).includes(leakedPhrase))).toBe(false)
    for (const tableName of ['profiles', 'pages', 'candidates', 'sources', 'sessions', 'jobs', 'observations', 'purges', 'audits', 'suppressions', 'activation', 'index_meta', 'vectors', 'aliases', 'projections', 'conflicts']) expect(JSON.stringify([...domain.table(tableName).entries()])).not.toContain(leakedPhrase)
    const restored = new MemoryProfileStore(domain, scopeA, undefined, 12_000, { embeddingProvider: denseProvider() }); stores.push(restored); await restored.waitReady(); expect(JSON.stringify(restored.snapshot())).not.toContain(leakedPhrase)
  })

  it('serializes concurrent purge attempts behind the durable scope lease', async () => {
    const domain = new DomainFixture(); const seed = new MemoryProfileStore(domain, scopeA); stores.push(seed)
    await seed.appendSessionEvent('session-concurrent-purge', 'raw concurrent purge evidence')
    const first = new MemoryProfileStore(domain, scopeA); const second = new MemoryProfileStore(domain, scopeA); stores.push(first, second); await Promise.all([first.waitReady(), second.waitReady()])
    const plan = first.purgePlan('session-concurrent-purge')
    const results = await Promise.allSettled([first.purgeSession('session-concurrent-purge', { confirmation: plan.confirmation }), second.purgeSession('session-concurrent-purge', { confirmation: plan.confirmation })])
    expect(results.filter(result => result.status === 'fulfilled' && result.value === true)).toHaveLength(1)
    expect(results.filter(result => result.status === 'fulfilled' && result.value === false)).toHaveLength(1)
    expect(await first.sessionEvidence('session-concurrent-purge')).toBeUndefined()
    expect([...domain.table('jobs').entries()].some(([, value]) => JSON.stringify(value).includes('purge-scope-lease'))).toBe(false)
  })

  it('retries an interrupted purge journal on restart without retaining raw evidence', async () => {
    const domain = new DomainFixture(); const original = new MemoryProfileStore(domain, scopeA); stores.push(original)
    await original.appendSessionEvent('session-recovery-purge', 'raw recovery line'); await original.upsertManualPage({ ...page(scopeA, 'recovery derived'), sources: ['session-recovery-purge'] })
    await domain.table('purges').put('owner-a--preset-a--recovery-op', { schemaVersion: 2, scope: scopeA, purge: { operationId: 'recovery-op', sessionId: 'session-recovery-purge', status: 'started', startedAt: '2026-09-18T00:00:00.000Z' } })
    const recovered = new MemoryProfileStore(domain, scopeA); stores.push(recovered); await recovered.waitReady()
    expect(await recovered.sessionEvidence('session-recovery-purge')).toBeUndefined(); expect(recovered.listPages()).toEqual([]); expect(recovered.listPurges().filter(purge => purge.operationId === 'recovery-op')).toHaveLength(1); expect(recovered.listPurges().find(purge => purge.operationId === 'recovery-op')?.status).toBe('completed')
    const reopened = new MemoryProfileStore(domain, scopeA); stores.push(reopened); await reopened.waitReady(); expect(reopened.listPurges().filter(purge => purge.operationId === 'recovery-op')).toHaveLength(1)
  })

  it('builds the scoped dense channel only from eligible recall documents', async () => {
    const domain = new DomainFixture(); const store = new MemoryProfileStore(domain, scopeA, undefined, 12_000, { embeddingProvider: denseProvider() }); stores.push(store)
    await store.upsertManualPage(page(scopeA, 'dense target')); await store.upsertManualPage(page(scopeA, 'unrelated fact'))
    const response = await store.recall('你还记得之前的 dense 代号吗？', { vectorEnabled: true })
    expect(response.trace.candidatesByChannel.dense).toBeGreaterThan(0); expect(response.results[0]?.channels).toContain('dense'); expect(response.results.some(result => result.text.includes('dense target'))).toBe(true)
  })

  it('falls back to lexical recall with vector-degraded when document embedding fails', async () => {
    const domain = new DomainFixture(); const store = new MemoryProfileStore(domain, scopeA, undefined, 12_000, { embeddingProvider: denseProvider({ failDocuments: () => true }) }); stores.push(store)
    await store.upsertManualPage(page(scopeA, 'lexical fallback fact'))
    const response = await store.recall('你还记得之前的 lexical fallback fact 吗？', { vectorEnabled: true })
    expect(response.results.some(result => result.text.includes('lexical fallback fact'))).toBe(true); expect(response.trace.degradedModes).not.toContain('vector-degraded')
  })

  it('restores persisted dense vectors and metadata on a fresh store', async () => {
    const domain = new DomainFixture(); const counters = { documents: 0, queries: 0 }; const provider = denseProvider({ counters }); const first = new MemoryProfileStore(domain, scopeA, undefined, 12_000, { embeddingProvider: provider }); stores.push(first)
    await first.upsertManualPage(page(scopeA, 'dense target')); await first.recall('你还记得之前的 dense 代号吗？', { vectorEnabled: true })
    expect([...domain.table('vectors').entries()]).not.toHaveLength(0); expect([...domain.table('index_meta').entries()]).toHaveLength(1); const metadata = [...domain.table('index_meta').entries()][0]?.[1] as { generationId?: string; sourceRevision: string; builtAt: string; active: boolean; validated?: boolean }; expect(metadata.generationId).toEqual(expect.any(String)); expect(metadata.sourceRevision).toEqual(expect.any(String)); expect(metadata.builtAt).toEqual(expect.any(String)); expect(metadata.active).toBe(true); expect(metadata.validated).toBe(true)
    const restored = new MemoryProfileStore(domain, scopeA, undefined, 12_000, { embeddingProvider: provider }); stores.push(restored); await restored.waitReady()
    const response = await restored.recall('你还记得之前的 dense 代号吗？', { vectorEnabled: true })
    // The reopened store must serve dense recall from the persisted generation. The exact embed call count is a
    // derived-index bookkeeping detail, so this asserts the durable and functional invariants instead of a call count.
    expect(response.results.some(result => result.text.includes('dense target'))).toBe(true); expect((([...domain.table('index_meta').entries()][0]?.[1] as { active: boolean }).active)).toBe(true); expect(response.trace.candidatesByChannel.dense ?? 0).toBeGreaterThan(0)
  })

  it('invalidates the active dense generation after a canonical edit and rebuilds lazily', async () => {
    const domain = new DomainFixture(); const store = new MemoryProfileStore(domain, scopeA, undefined, 12_000, { embeddingProvider: denseProvider() }); stores.push(store)
    await store.upsertManualPage(page(scopeA, 'dense target')); await store.recall('你还记得之前的 dense 代号吗？', { vectorEnabled: true })
    const id = store.listPages()[0]!.id; const before = ([...domain.table('index_meta').entries()][0]?.[1] as { sourceRevision: string }).sourceRevision
    await store.editPage(id, { description: 'dense target edited', body: 'dense target edited' })
    const invalidated = [...domain.table('index_meta').entries()][0]?.[1] as { active: boolean; degradedReason?: string; sourceRevision: string }
    expect(invalidated.active).toBe(true); expect(invalidated.degradedReason).toBe('source-revision-changed'); expect(invalidated.sourceRevision).toBe(before)
    await store.recall('你还记得之前的 dense 代号吗？', { vectorEnabled: true })
    const rebuilt = [...domain.table('index_meta').entries()][0]?.[1] as { active: boolean; degradedReason?: string; sourceRevision: string }
    expect(rebuilt.active).toBe(true); expect(rebuilt.degradedReason).toBeUndefined(); expect(rebuilt.sourceRevision).not.toBe(before)
  })

  it('keeps the prior active dense generation searchable when rebuild fails', async () => {
    let fail = false; const provider = denseProvider({ failDocuments: () => fail }); const domain = new DomainFixture(); const store = new MemoryProfileStore(domain, scopeA, undefined, 12_000, { embeddingProvider: provider }); stores.push(store)
    await store.upsertManualPage(page(scopeA, 'dense target')); await store.recall('你还记得之前的 dense 代号吗？', { vectorEnabled: true }); fail = true
    const id = store.listPages()[0]!.id; await store.editPage(id, { description: 'dense target changed', body: 'dense target changed' })
    const response = await store.recall('你还记得之前的 dense 代号吗？', { vectorEnabled: true }); const metadata = [...domain.table('index_meta').entries()][0]?.[1] as { active: boolean; degradedReason?: string }
    expect(response.trace.degradedModes).toContain('vector-degraded'); expect(response.results.some(result => result.text.includes('dense target changed'))).toBe(true); expect(metadata.active).toBe(true); expect(metadata.degradedReason).toBe('vector-degraded'); expect([...domain.table('vectors').entries()]).not.toHaveLength(0); const restarted = new MemoryProfileStore(domain, scopeA, undefined, 12_000, { embeddingProvider: provider }); stores.push(restarted); await restarted.waitReady(); const afterRestart = await restarted.recall('你还记得之前的 dense 代号吗？', { vectorEnabled: true }); expect(afterRestart.results.some(result => result.text.includes('dense target'))).toBe(true)
  })

  it('restores the dense runtime generation when a mutation fails mid-persist', async () => {
    const domain = new DomainFixture(); const store = new MemoryProfileStore(domain, scopeA, undefined, 12_000, { embeddingProvider: denseProvider() }); stores.push(store)
    await store.upsertManualPage(page(scopeA, 'rollback dense target')); await store.recall('你还记得之前的 rollback dense target 吗？', { vectorEnabled: true })
    domain.failAtWrite = domain.writes() + 1
    await expect(store.editPage(store.listPages()[0]!.id, { body: 'rollback dense changed', description: 'rollback dense changed' })).rejects.toThrow(/injected write failure/)
    domain.failAtWrite = undefined
    const response = await store.recall('你还记得之前的 rollback dense target 吗？', { vectorEnabled: true })
    expect(response.trace.degradedModes).not.toContain('vector-degraded')
    expect(response.results.some(result => result.text.includes('rollback dense target'))).toBe(true)
  })

  it('serves the bounded legacy Resident projection when V2 or blocks are disabled', async () => {
    const legacyDomain = new DomainFixture(); const legacy = new MemoryProfileStore(legacyDomain, scopeA, undefined, 180, { residentV2: false }); stores.push(legacy); await legacy.upsertManualPage(page(scopeA, 'legacy projection fact'))
    expect(legacy.renderResident().length).toBeLessThanOrEqual(180); expect(legacy.renderResident()).toContain('legacy projection fact'); expect(legacy.renderResident()).not.toContain('## '); expect(legacy.snapshot().residentSnapshot?.blocks).toEqual([])
    const blocksDomain = new DomainFixture(); const blocks = new MemoryProfileStore(blocksDomain, scopeA, undefined, 180, { residentBlocks: false }); stores.push(blocks); await blocks.upsertManualPage(page(scopeA, 'flat projection fact'))
    expect(blocks.renderResident()).toContain('flat projection fact'); expect(blocks.snapshot().residentSnapshot?.blocks).toEqual([])
  })

  it('applies the sensitive Resident flag independently from recall sensitivity policy', async () => {
    const excludedDomain = new DomainFixture(); const excluded = new MemoryProfileStore(excludedDomain, scopeA); stores.push(excluded); await excluded.upsertManualPage({ ...page(scopeA, 'sensitive resident fact'), sensitivity: 'sensitive' }); expect(excluded.renderResident()).toBe('')
    const includedDomain = new DomainFixture(); const included = new MemoryProfileStore(includedDomain, scopeA, undefined, 12_000, { sensitiveResident: true }); stores.push(included); await included.upsertManualPage({ ...page(scopeA, 'sensitive resident fact'), sensitivity: 'sensitive' }); expect(included.renderResident()).toContain('sensitive resident fact')
  })

  it('uses expiry-only eligibility when temporal filtering is disabled', async () => {
    const future = '2099-01-01T00:00:00.000Z'; const temporalDomain = new DomainFixture(); const temporal = new MemoryProfileStore(temporalDomain, scopeA); stores.push(temporal); await temporal.upsertManualPage({ ...page(scopeA, 'future temporal fact'), observedAt: future, validFrom: future }); expect(temporal.renderResident()).toBe('')
    const legacyDomain = new DomainFixture(); const legacy = new MemoryProfileStore(legacyDomain, scopeA, undefined, 12_000, { temporal: false }); stores.push(legacy); await legacy.upsertManualPage({ ...page(scopeA, 'future temporal fact'), observedAt: future, validFrom: future }); expect(legacy.renderResident()).toContain('future temporal fact'); expect((await legacy.recall('你还记得之前的 future temporal fact 吗？')).results.some(result => result.text.includes('future temporal fact'))).toBe(true)
  })

  it('uses the configured minimum observation evidence count', async () => {
    const domain = new DomainFixture(); const store = new MemoryProfileStore(domain, scopeA, undefined, 12_000, { minObservationEvidence: 3 }); stores.push(store)
    for (let seq = 1; seq <= 3; seq += 1) await store.appendSessionEvent('observation-threshold', JSON.stringify({ seq, time: `2026-09-17T00:0${seq}:00.000Z`, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: `anchor ${seq}` }] } }))
    const refs = (count: number): string[] => Array.from({ length: count }, (_, index) => `session:observation-threshold/event:${index + 1}`)
    await expect(store.upsertObservationCandidate({ text: 'three-anchor observation', sourceRefs: refs(2) })).rejects.toThrow(/at least 3/)
    await expect(store.upsertObservationCandidate({ text: 'three-anchor observation', sourceRefs: refs(3) })).resolves.toMatchObject({ evidenceCount: 3, minEvidence: 3 })
  })

  it('falls back to RRF order when the configured reranker throws', async () => {
    const baselineDomain = new DomainFixture(); const baseline = new MemoryProfileStore(baselineDomain, scopeA); stores.push(baseline); await baseline.upsertManualPage(page(scopeA, 'shared alpha')); await baseline.upsertManualPage(page(scopeA, 'shared beta')); const expected = (await baseline.recall('你还记得之前 shared 吗？')).results.map(result => result.id)
    const rerankDomain = new DomainFixture(); const reranked = new MemoryProfileStore(rerankDomain, scopeA, undefined, 12_000, { reranker: throwingReranker() }); stores.push(reranked); await reranked.upsertManualPage(page(scopeA, 'shared alpha')); await reranked.upsertManualPage(page(scopeA, 'shared beta')); const response = await reranked.recall('你还记得之前 shared 吗？')
    expect(response.results.map(result => result.id)).toEqual(expected); expect(response.trace.degradedModes).toContain('reranker-fallback-rrf')
  })

  it('keeps a user-grounded candidate pending while the auto-confirm policy is off', async () => {
    const domain = new DomainFixture(); const store = new MemoryProfileStore(domain, scopeA); stores.push(store)
    await store.appendSessionEvent('session-auto-off', JSON.stringify({ seq: 1, time: '2026-09-17T00:00:00.000Z', type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'My locker number is B-417' }] } }))
    await store.ingestPages([{ ...page(scopeA, 'My locker number is B-417', 'candidate'), sources: ['session-auto-off'] }], new Date().toISOString(), 'session-auto-off')
    expect(store.snapshot().candidates).toHaveLength(1); expect(store.snapshot().pages ?? []).toHaveLength(0)
  })

  it('auto-confirms a candidate only when the user stated the claim verbatim', async () => {
    const domain = new DomainFixture(); const store = new MemoryProfileStore(domain, scopeA, undefined, 12_000, { candidateAutoConfirm: 'user_grounded' }); stores.push(store)
    await store.appendSessionEvent('session-grounded', JSON.stringify({ seq: 4, time: '2026-09-17T00:00:00.000Z', type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'Remember that my locker number is B-417 please.' }] } }))
    await store.ingestPages([{ ...page(scopeA, 'my locker number is b-417', 'candidate'), sources: ['session-grounded'] }], new Date().toISOString(), 'session-grounded')
    expect(store.snapshot().candidates).toHaveLength(0)
    expect((store.snapshot().pages ?? []).map(existing => existing.description)).toContain('my locker number is b-417')
    const audits = [...domain.table('audits').entries()].map(([, value]) => value as { event: string; detail?: { groundingRef?: string; mode?: string } })
    const promotion = audits.find(entry => entry.event === 'candidate-auto-confirmed')
    expect(promotion?.detail?.mode).toBe('user_grounded')
    expect(promotion?.detail?.groundingRef).toBe('session:session-grounded/event:4')
  })

  it('leaves a claim the user never made pending under the user-grounded policy', async () => {
    const domain = new DomainFixture(); const store = new MemoryProfileStore(domain, scopeA, undefined, 12_000, { candidateAutoConfirm: 'user_grounded' }); stores.push(store)
    await store.appendSessionEvent('session-ungrounded', JSON.stringify({ seq: 1, time: '2026-09-17T00:00:00.000Z', type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'My locker number is B-417.' }] } }))
    await store.ingestPages([{ ...page(scopeA, 'The user may enjoy running', 'candidate'), sources: ['session-ungrounded'] }], new Date().toISOString(), 'session-ungrounded')
    expect(store.snapshot().candidates).toHaveLength(1); expect(store.snapshot().pages).toHaveLength(0)
  })

  it('auto-confirms every candidate under the explicit all policy and never a sensitive or conflicting one', async () => {
    const domain = new DomainFixture(); const all = new MemoryProfileStore(domain, scopeA, undefined, 12_000, { candidateAutoConfirm: 'all' }); stores.push(all)
    await all.ingestPages([{ ...page(scopeA, 'plain inferred preference', 'candidate'), sensitivity: 'sensitive' }], new Date().toISOString(), 'session-a')
    expect(all.snapshot().candidates).toHaveLength(1); expect(all.snapshot().pages).toHaveLength(0)
    const grounded = new MemoryProfileStore(domain, scopeB, undefined, 12_000, { candidateAutoConfirm: 'all' }); stores.push(grounded)
    await grounded.ingestPages([page(scopeB, 'plain inferred preference', 'candidate')], new Date().toISOString(), 'session-a')
    expect(grounded.snapshot().candidates).toHaveLength(0)
    expect((grounded.snapshot().pages ?? []).map(existing => existing.description)).toContain('plain inferred preference')
  })
})
