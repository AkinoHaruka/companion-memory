/* oxlint-disable @stylistic/max-len */
import { afterEach, describe, expect, it } from 'vitest'
import { memoryScopeForPreset } from '../src/contracts.ts'
import { MemoryProfileStore } from '../src/store.ts'
import type { WikiPage } from '../src/wiki.ts'

class Table<V> { private readonly values = new Map<string, V>(); get(key: string): V | undefined { return this.values.get(key) }; entries(): IterableIterator<[string, V]> { return ([...this.values.entries()] as [string, V][])[Symbol.iterator]() }; async put(key: string, value: V): Promise<void> { this.values.set(key, value) }; async delete(key: string): Promise<boolean> { return this.values.delete(key) } }
class Domain { private readonly tables = new Map<string, Table<unknown>>(); table(name: string): Table<unknown> { let table = this.tables.get(name); if (!table) { table = new Table(); this.tables.set(name, table) }; return table } }
const scope = memoryScopeForPreset('test-owner', 'alias-resolution'); const stores: MemoryProfileStore[] = []
afterEach(async () => { await Promise.all(stores.map(store => store.close())); stores.length = 0 })
function person(id = 'lisa', title = 'Lisa'): WikiPage { return { id, path: `wiki/entities/${id}.md`, type: 'entity', title, description: title, body: title, sources: ['alias-session'], tags: [], timestamp: '2026-09-19T00:00:00.000Z', confidence: 1, status: 'confirmed', consent: true, locked: true, version: 1, updatedAt: '2026-09-19T00:00:00.000Z', category: 'traits_roles', kind: 'fact' } }

describe('entity-alias-resolution', () => {
  it('activates explicit coreference, contests inference, and invalidates without rewriting canon', async () => {
    const store = new MemoryProfileStore(new Domain(), scope); stores.push(store); await store.upsertManualPage(person()); const entityId = store.listPages()[0]!.id
    const explicit = await store.upsertAlias({ entityId, alias: '我姐 Lisa', sourceRefs: ['session:alias-session/event:1'], resolutionKind: 'explicit_coreference' }); expect(explicit.status).toBe('active'); expect(store.resolveAlias('我姐 Lisa')).toHaveLength(1)
    const inferred = await store.upsertAlias({ entityId, alias: '姐姐', sourceRefs: ['session:alias-session/event:2'], resolutionKind: 'derived_inference' }); expect(inferred.status).toBe('contested'); expect(store.resolveAlias('姐姐')).toEqual([])
    const before = store.page(entityId); expect(await store.invalidateAlias(explicit.id, 'user corrected the relation')).toBe(true); expect(store.resolveAlias('我姐 Lisa')).toEqual([]); expect(store.page(entityId)).toEqual(before); expect(store.listAliases().find(alias => alias.id === explicit.id)).toMatchObject({ status: 'invalidated', invalidatedReason: 'user corrected the relation' })
  })

  it('invalidates aliases when the canonical entity is forgotten', async () => {
    const store = new MemoryProfileStore(new Domain(), scope); stores.push(store); await store.upsertManualPage(person()); const entityId = store.listPages()[0]!.id
    const alias = await store.upsertAlias({ entityId, alias: '我姐 Lisa', sourceRefs: ['session:alias-session/event:3'], resolutionKind: 'explicit_coreference' })
    expect(store.resolveAlias('我姐 Lisa')).toHaveLength(1)
    expect(await store.forget(entityId)).toBe(true)
    expect(store.resolveAlias('我姐 Lisa')).toEqual([])
    expect(store.listAliases().find(item => item.id === alias.id)).toMatchObject({ status: 'invalidated', invalidatedReason: 'canonical entity forgotten' })
  })

  it('retains a reassigned alias edge and resolves its closed interval historically', async () => {
    const domain = new Domain(); const store = new MemoryProfileStore(domain, scope); stores.push(store); await store.upsertManualPage(person('zhang', 'Zhang')); await store.upsertManualPage(person('li', 'Li')); const zhangId = store.listPages().find(page => page.title === 'Zhang')!.id; const liId = store.listPages().find(page => page.title === 'Li')!.id
    const oldAlias = await store.upsertAlias({ entityId: zhangId, alias: 'the boss', sourceRefs: ['session:alias-session/event:4'], validFrom: '2025-01-01T00:00:00.000Z' })
    const currentAlias = await store.upsertAlias({ entityId: liId, alias: 'the boss', sourceRefs: ['session:alias-session/event:5'] })
    const listed = store.listAliases().filter(alias => alias.normalizedAlias === 'the boss'); const superseded = listed.find(alias => alias.id === oldAlias.id); const current = listed.find(alias => alias.id === currentAlias.id)
    expect(listed).toHaveLength(2); expect(superseded).toMatchObject({ status: 'invalidated', invalidatedReason: 'alias reassigned', replacedBy: currentAlias.id, validTo: currentAlias.validFrom }); expect(current).toMatchObject({ status: 'active', validFrom: superseded?.validTo })
    expect(store.resolveAlias('the boss')).toEqual([{ entityId: liId, alias: 'the boss', confidence: 0.5 }]); expect(store.resolveAlias('the boss', { atTime: '2025-06-01T00:00:00.000Z' })).toEqual([{ entityId: zhangId, alias: 'the boss', confidence: 0.5 }]); expect(store.resolveAlias('the boss', { history: true }).map(alias => alias.entityId).sort()).toEqual([liId, zhangId].sort())
    expect(store.snapshot().aliases.find(alias => alias.id === oldAlias.id)).toMatchObject({ status: 'invalidated', invalidatedReason: 'alias reassigned', replacedBy: currentAlias.id })
    const persisted = [...domain.table('aliases').entries()].map(([, value]) => value as { id: string; replacedBy?: string }).find(value => value.id === oldAlias.id); expect(persisted).toMatchObject({ id: oldAlias.id, replacedBy: currentAlias.id })
    await store.close(); const restored = new MemoryProfileStore(domain, scope); stores.push(restored); await restored.waitReady(); expect(restored.listAliases().find(alias => alias.id === oldAlias.id)).toMatchObject({ status: 'invalidated', invalidatedReason: 'alias reassigned', replacedBy: currentAlias.id, validTo: superseded?.validTo }); expect(restored.resolveAlias('the boss')).toEqual([{ entityId: liId, alias: 'the boss', confidence: 0.5 }]); expect(restored.resolveAlias('the boss', { atTime: '2025-06-01T00:00:00.000Z' })).toEqual([{ entityId: zhangId, alias: 'the boss', confidence: 0.5 }])
  })
})
