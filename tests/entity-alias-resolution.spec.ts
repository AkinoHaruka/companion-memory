/* oxlint-disable @stylistic/max-len */
import { afterEach, describe, expect, it } from 'vitest'
import { memoryScopeForPreset } from '../src/contracts.ts'
import { MemoryProfileStore } from '../src/store.ts'
import type { WikiPage } from '../src/wiki.ts'

class Table<V> { private readonly values = new Map<string, V>(); get(key: string): V | undefined { return this.values.get(key) }; entries(): IterableIterator<[string, V]> { return ([...this.values.entries()] as [string, V][])[Symbol.iterator]() }; async put(key: string, value: V): Promise<void> { this.values.set(key, value) }; async delete(key: string): Promise<boolean> { return this.values.delete(key) } }
class Domain { private readonly tables = new Map<string, Table<unknown>>(); table(name: string): Table<unknown> { let table = this.tables.get(name); if (!table) { table = new Table(); this.tables.set(name, table) }; return table } }
const scope = memoryScopeForPreset('test-owner', 'alias-resolution'); const stores: MemoryProfileStore[] = []
afterEach(async () => { await Promise.all(stores.map(store => store.close())); stores.length = 0 })
function person(): WikiPage { return { id: 'lisa', path: 'wiki/entities/lisa.md', type: 'entity', title: 'Lisa', description: 'Lisa', body: 'Lisa', sources: ['alias-session'], tags: [], timestamp: '2026-09-19T00:00:00.000Z', confidence: 1, status: 'confirmed', consent: true, locked: true, version: 1, updatedAt: '2026-09-19T00:00:00.000Z', category: 'traits_roles', kind: 'fact' } }

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
})
