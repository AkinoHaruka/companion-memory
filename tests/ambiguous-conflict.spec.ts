/* oxlint-disable @stylistic/max-len */
import { afterEach, describe, expect, it } from 'vitest'
import { memoryScopeForPreset } from '../src/contracts.ts'
import { MemoryProfileStore } from '../src/store.ts'
import type { WikiPage } from '../src/wiki.ts'

class Table<V> { private readonly values = new Map<string, V>(); get(key: string): V | undefined { return this.values.get(key) }; entries(): IterableIterator<[string, V]> { return ([...this.values.entries()] as [string, V][])[Symbol.iterator]() }; async put(key: string, value: V): Promise<void> { this.values.set(key, value) }; async delete(key: string): Promise<boolean> { return this.values.delete(key) } }
class Domain { private readonly tables = new Map<string, Table<unknown>>(); table(name: string): Table<unknown> { let table = this.tables.get(name); if (!table) { table = new Table(); this.tables.set(name, table) }; return table } }
const scope = memoryScopeForPreset('test-owner', 'conflict'); const stores: MemoryProfileStore[] = []
afterEach(async () => { await Promise.all(stores.map(store => store.close())); stores.length = 0 })
function location(value: string, status: WikiPage['status'] = 'confirmed'): WikiPage { return { id: 'location', path: 'wiki/concepts/current-location.md', type: 'concept', title: '当前居住地', description: `我现在住${value}`, body: `我现在住${value}`, sources: ['conflict-session'], tags: ['traits_roles'], timestamp: '2026-09-19T00:00:00.000Z', confidence: 1, status, consent: status === 'confirmed', locked: status === 'confirmed', version: 1, updatedAt: '2026-09-19T00:00:00.000Z', category: 'traits_roles', kind: 'fact' } }

describe('ambiguous-conflict', () => {
  it('keeps old canon, contests current reads, and resolves a correction', async () => {
    const store = new MemoryProfileStore(new Domain(), scope); stores.push(store); await store.appendSessionEvent('conflict-session', JSON.stringify({ seq: 1, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '我现在住上海' }] } })); await store.upsertManualPage(location('上海')); const oldId = store.listPages()[0]!.id
    await store.ingestPages([{ ...location('杭州', 'candidate'), sources: ['conflict-session-2'] }], new Date().toISOString(), 'conflict-session-2')
    expect(store.page(oldId)?.body).toContain('上海'); expect(store.snapshot().candidates[0]?.status).toBe('pending_conflict'); expect(store.listConflicts()[0]?.state).toBe('contested')
    expect(store.renderResident()).not.toContain('上海'); expect((await store.recall('我现在住哪里？')).results.some(result => result.text.includes('上海'))).toBe(false)
    expect((await store.recall('你还记得之前我现在住上海吗？', { history: true })).results.some(result => result.text.includes('上海'))).toBe(true)
    const conflict = store.listConflicts()[0]!; expect(await store.resolveConflict(conflict.id, 'correction')).toBe(true); expect(store.listConflicts()[0]?.state).toBe('resolved'); expect(store.renderResident()).toContain('杭州'); expect(store.renderResident()).not.toContain('上海'); expect(store.snapshot().candidates[0]?.status).toBe('accepted')
    const afterCorrection = await store.recall('你还记得我现在住上海吗？', { history: true }); expect(afterCorrection.results.some(result => result.sourceType === 'evidence')).toBe(false); expect(afterCorrection.results.some(result => result.text.includes('上海'))).toBe(false); expect(afterCorrection.trace.gateReasons).toContain('correction-invalidated')
  })
})
