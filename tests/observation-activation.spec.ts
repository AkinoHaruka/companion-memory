/* oxlint-disable @stylistic/max-len */
import { afterEach, describe, expect, it } from 'vitest'
import { memoryScopeForPreset } from '../src/contracts.ts'
import { MemoryProfileStore } from '../src/store.ts'

class Table<V> { private readonly values = new Map<string, V>(); get(key: string): V | undefined { return this.values.get(key) }; entries(): IterableIterator<[string, V]> { return ([...this.values.entries()] as [string, V][])[Symbol.iterator]() }; async put(key: string, value: V): Promise<void> { this.values.set(key, value) }; async delete(key: string): Promise<boolean> { return this.values.delete(key) } }
class Domain { private readonly tables = new Map<string, Table<unknown>>(); table(name: string): Table<unknown> { let table = this.tables.get(name); if (!table) { table = new Table(); this.tables.set(name, table) }; return table } }
const scope = memoryScopeForPreset('test-owner', 'observation-activation'); const stores: MemoryProfileStore[] = []
afterEach(async () => { await Promise.all(stores.map(store => store.close())); stores.length = 0 })
async function anchors(store: MemoryProfileStore, count: number, sessions = 2): Promise<string[]> { const refs: string[] = []; for (let index = 1; index <= count; index += 1) { const session = `observation-session-${index % sessions}`; await store.appendSessionEvent(session, JSON.stringify({ seq: index, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: `anchor ${index}` }] } })); refs.push(`session:${session}/event:${index}`) }; return refs }

describe('observation-activation', () => {
  it('counts one event anchor once even when reference strings differ', async () => {
    const store = new MemoryProfileStore(new Domain(), scope); stores.push(store)
    await store.appendSessionEvent('duplicate-anchor-session', JSON.stringify({ seq: 1, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'one real anchor' }] } }))
    await expect(store.upsertObservationCandidate({ text: 'duplicate anchor pattern', sourceRefs: ['session:duplicate-anchor-session/event:1', 'session:duplicate-anchor-session/event:01'] })).rejects.toThrow(/at least 2/)
  })

  it('requires evidence, sessions, confidence, and no strong contradiction', async () => {
    const store = new MemoryProfileStore(new Domain(), scope); stores.push(store)
    const below = await store.upsertObservationCandidate({ text: 'below threshold pattern', sourceRefs: await anchors(store, 2), confidence: 0.99 }); expect(below.status).toBe('candidate'); expect(store.snapshot().pages).toEqual([])
    const active = await store.upsertObservationCandidate({ text: 'stable inferred tendency', sourceRefs: await anchors(store, 3), confidence: 0.9 }); expect(active.status).toBe('active'); expect(store.snapshot().pages).toEqual([])
    const recalled = await store.recall('你还记得之前的 stable tendency 吗？', { observationsEnabled: true }); expect(recalled.results.find(result => result.sourceType === 'observation' && result.text.includes('stable'))?.mentionDecision).toBe('silent_use')
    const sensitive = await store.upsertObservationCandidate({ text: 'sensitive inferred pattern', sourceRefs: await anchors(store, 3), confidence: 0.99, sensitivity: 'sensitive' }); expect(sensitive.status).toBe('candidate')
    const contradictoryRefs = await anchors(store, 3); const contradiction = await store.upsertObservationCandidate({ text: 'contradicted pattern', sourceRefs: contradictoryRefs.slice(0, 2), confidence: 0.9 }); const updated = await store.updateObservationEvidence(contradiction.id, { supportingRefs: [contradictoryRefs[2]!], contradictingRefs: contradictoryRefs }); expect(updated?.status).toBe('candidate')
  })

  it('classifies psychological observation text before normal auto-activation', async () => {
    const store = new MemoryProfileStore(new Domain(), scope); stores.push(store)
    const observation = await store.upsertObservationCandidate({ text: '用户有抑郁倾向', sourceRefs: await anchors(store, 3), confidence: 0.99, sensitivity: 'normal' })
    expect(observation.sensitivity).toBe('sensitive')
    expect(observation.status).toBe('candidate')
  })
})
