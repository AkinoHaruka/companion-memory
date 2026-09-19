/* oxlint-disable @stylistic/max-len */
import { afterEach, describe, expect, it } from 'vitest'
import { memoryScopeForPreset } from '../src/contracts.ts'
import { MemoryProfileStore } from '../src/store.ts'
import type { WikiPage } from '../src/wiki.ts'

class Table<V> {
  private readonly values = new Map<string, V>()
  get(key: string): V | undefined { return this.values.get(key) }
  entries(): IterableIterator<[string, V]> { return ([...this.values.entries()] as [string, V][])[Symbol.iterator]() }
  async put(key: string, value: V): Promise<void> { this.values.set(key, value) }
  async delete(key: string): Promise<boolean> { return this.values.delete(key) }
}

class Domain { private readonly tables = new Map<string, Table<unknown>>(); table(name: string): Table<unknown> { let table = this.tables.get(name); if (!table) { table = new Table(); this.tables.set(name, table) }; return table } }

const scope = memoryScopeForPreset('test-owner', 'sensitivity')
const stores: MemoryProfileStore[] = []
afterEach(async () => { await Promise.all(stores.map(store => store.close())); stores.length = 0 })

function page(body: string): WikiPage {
  return { id: body, path: `wiki/concepts/${body}.md`, type: 'concept', title: body, description: body, body, sources: ['manual-sensitivity'], tags: ['preference'], timestamp: '2026-09-19T00:00:00.000Z', confidence: 1, status: 'confirmed', consent: true, locked: true, version: 1, updatedAt: '2026-09-19T00:00:00.000Z', category: 'interaction_rules', kind: 'preference' }
}

describe('sensitivity-provisional', () => {
  it('applies model tightening, rejects model loosening, and permits user loosening', async () => {
    const store = new MemoryProfileStore(new Domain(), scope); stores.push(store)
    await store.upsertManualPage(page('private tone preference'))
    const id = store.listPages()[0]!.id
    expect(await store.setMemorySensitivity({ id, target: 'page', sensitivity: 'provisional_sensitive', authority: 'model_proposal', reason: 'uncertain privacy' })).toBe(true)
    expect(store.page(id)?.sensitivity).toBe('provisional_sensitive')
    expect(await store.setMemorySensitivity({ id, target: 'page', sensitivity: 'sensitive', authority: 'model_proposal' })).toBe(true)
    expect(await store.setMemorySensitivity({ id, target: 'page', sensitivity: 'normal', authority: 'model_proposal' })).toBe(false)
    expect(store.page(id)?.sensitivity).toBe('sensitive')
    expect(store.listAudits().some(audit => audit.event === 'memory-sensitivity-rejected')).toBe(true)
    expect(await store.setMemorySensitivity({ id, target: 'page', sensitivity: 'normal', authority: 'user', reason: 'user approved use' })).toBe(true)
    expect(store.page(id)?.sensitivityHistory).toHaveLength(3)
  })

  it('applies management tightening and loosening directly, while rejecting model loosening', async () => {
    const store = new MemoryProfileStore(new Domain(), scope); stores.push(store)
    await store.upsertManualPage(page('management sensitivity preference'))
    const id = store.listPages()[0]!.id

    expect(await store.setMemorySensitivity({ id, target: 'page', sensitivity: 'sensitive', authority: 'management', reason: 'operator review' })).toBe(true)
    expect(await store.setMemorySensitivity({ id, target: 'page', sensitivity: 'normal', authority: 'model_proposal', reason: 'model loosening' })).toBe(false)
    expect(await store.setMemorySensitivity({ id, target: 'page', sensitivity: 'normal', authority: 'management', reason: 'operator restoration' })).toBe(true)

    expect(store.page(id)?.sensitivity).toBe('normal')
    expect(store.page(id)?.sensitivityHistory?.map(change => change.authority)).toEqual(['management', 'management'])
    const sensitivityAudits = store.listAudits().filter(audit => audit.event === 'memory-sensitivity-changed' || audit.event === 'memory-sensitivity-rejected')
    expect(sensitivityAudits.some(audit => audit.event === 'memory-sensitivity-changed' && audit.detail?.authority === 'management')).toBe(true)
    expect(sensitivityAudits.some(audit => audit.event === 'memory-sensitivity-changed' && audit.detail?.authority === 'deterministic_rule')).toBe(false)
    expect(sensitivityAudits.some(audit => audit.event === 'memory-sensitivity-rejected' && audit.detail?.authority === 'model_proposal')).toBe(true)
  })

  it('excludes provisional sensitive pages from Resident and suppresses generic topic cues', async () => {
    const store = new MemoryProfileStore(new Domain(), scope); stores.push(store)
    await store.upsertManualPage(page('my private tone preference'))
    const id = store.listPages()[0]!.id
    await store.setMemorySensitivity({ id, target: 'page', sensitivity: 'provisional_sensitive', authority: 'model_proposal' })
    expect(store.renderResident()).not.toContain('my private tone preference')
    const response = await store.recall('What is my preference?')
    expect(response.results.find(result => result.id === `page:${id}`)).toBeUndefined()
    expect(response.trace.gateReasons).toContain('sensitive-default-suppress')
  })

  it('round-trips sensitivity history across restart', async () => {
    const domain = new Domain(); const first = new MemoryProfileStore(domain, scope); stores.push(first)
    await first.upsertManualPage(page('restart sensitivity fact'))
    const id = first.listPages()[0]!.id
    await first.setMemorySensitivity({ id, target: 'page', sensitivity: 'sensitive', authority: 'model_proposal' })
    const restored = new MemoryProfileStore(domain, scope); stores.push(restored); await restored.waitReady()
    expect(restored.page(id)?.sensitivityHistory?.[0]).toMatchObject({ from: 'normal', to: 'sensitive', authority: 'model_proposal' })
  })
})
