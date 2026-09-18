/* oxlint-disable @stylistic/max-len */

import { afterEach, describe, expect, it } from 'vitest'
import { memoryScopeForPreset, type MemoryScope } from '../src/contracts.ts'
import { MemoryProfileStore } from '../src/store.ts'
import type { WikiPage } from '../src/wiki.ts'

class Table<V> {
  private readonly values = new Map<string, V>()
  get(key: string): V | undefined { return this.values.get(key) }
  entries(): IterableIterator<[string, V]> { return ([...this.values.entries()] as [string, V][])[Symbol.iterator]() }
  async put(key: string, value: V): Promise<void> { this.values.set(key, value) }
  async delete(key: string): Promise<boolean> { return this.values.delete(key) }
}

class DomainFixture {
  private readonly tables = new Map<string, Table<unknown>>()
  table(name: string): Table<unknown> { let table = this.tables.get(name); if (!table) { table = new Table(); this.tables.set(name, table) } return table }
}

const scopeA = memoryScopeForPreset('owner-a', 'preset-a')
const scopeB = memoryScopeForPreset('owner-a', 'preset-b')
let stores: MemoryProfileStore[] = []

afterEach(async () => { await Promise.all(stores.map(store => store.close())); stores = [] })

function page(scope: MemoryScope, content: string, status: WikiPage['status'] = 'confirmed'): WikiPage {
  return { id: `${scope.stableAgentPresetId}-${content}`, path: `wiki/concepts/${scope.stableAgentPresetId}-${content}.md`, type: 'concept', title: content, description: content, body: content, sources: ['session-a'], tags: ['interaction_rules'], timestamp: '2026-09-17T00:00:00.000Z', confidence: 1, status, consent: status === 'confirmed', locked: status === 'confirmed', version: 1, updatedAt: '2026-09-17T00:00:00.000Z', category: 'interaction_rules', kind: 'preference' }
}

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

  it('persists Dream job status and cursor across a store restart', async () => {
    const domain = new DomainFixture(); const store = new MemoryProfileStore(domain, scopeA); stores.push(store)
    await store.upsertJob({ id: 'job-a', sessionId: 'session-a', scopeKey: scopeA.key, status: 'failed', attempts: 2, cursor: 7, error: 'rate_limited' })
    const restored = new MemoryProfileStore(domain, scopeA); stores.push(restored); await restored.waitReady()
    expect(restored.job('job-a')).toMatchObject({ status: 'failed', attempts: 2, cursor: 7, error: 'rate_limited' })
  })
})
