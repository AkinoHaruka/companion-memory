/* oxlint-disable @stylistic/max-len */
import { afterEach, describe, expect, it } from 'vitest'
import { memoryScopeForPreset } from '../src/contracts.ts'
import { renderRecallContext } from '../src/recall.ts'
import { MemoryProfileStore } from '../src/store.ts'
import type { MemorySensitivity } from '../src/types.ts'
import type { WikiPage } from '../src/wiki.ts'

class Table<V> { private readonly values = new Map<string, V>(); get(key: string): V | undefined { return this.values.get(key) }; entries(): IterableIterator<[string, V]> { return ([...this.values.entries()] as [string, V][])[Symbol.iterator]() }; async put(key: string, value: V): Promise<void> { this.values.set(key, value) }; async delete(key: string): Promise<boolean> { return this.values.delete(key) } }
class Domain { private readonly tables = new Map<string, Table<unknown>>(); table(name: string): Table<unknown> { let table = this.tables.get(name); if (!table) { table = new Table(); this.tables.set(name, table) }; return table } }

const scope = memoryScopeForPreset('disclosure-owner', 'disclosure-preset')
const stores: MemoryProfileStore[] = []
afterEach(async () => { await Promise.all(stores.map(store => store.close())); stores.length = 0 })

function page(id: string, text: string, sensitivity?: MemorySensitivity): WikiPage {
  return { id, path: `wiki/concepts/${id}.md`, type: 'concept', title: text, description: text, body: text, sources: [`session:${id}`], tags: ['locker'], timestamp: '2026-09-19T00:00:00.000Z', confidence: 1, status: 'confirmed', consent: true, locked: true, version: 1, updatedAt: '2026-09-19T00:00:00.000Z', ...(sensitivity === undefined ? {} : { sensitivity }) }
}

function open(domain: Domain, options: ConstructorParameters<typeof MemoryProfileStore>[4] = {}): MemoryProfileStore {
  const store = new MemoryProfileStore(domain, scope, undefined, 12_000, options); stores.push(store); return store
}

describe('memory disclosure policy', () => {
  it('enforces normal, user_explicit_only and never_explicit through real store recall', async () => {
    const normal = open(new Domain()); await normal.upsertManualPage(page('normal-memory', 'normal locker N-101'))
    const normalRecall = await normal.recall('my locker N-101 normal')
    const normalResult = normalRecall.results.find(result => result.sourceType === 'canonical')
    expect(normalResult).toMatchObject({ mentionDecision: 'explicit', text: expect.stringContaining('normal locker N-101'), sourceRefs: ['session:normal-memory'] })
    expect(renderRecallContext(normalRecall.results)).toContain('normal locker N-101')

    const explicitOnly = open(new Domain()); await explicitOnly.upsertManualPage(page('explicit-only-memory', 'explicit locker U-202', 'provisional_sensitive'))
    const ordinaryRecall = await explicitOnly.recall('my locker U-202 explicit')
    const ordinaryResult = ordinaryRecall.results.find(result => result.sourceType === 'canonical')
    expect(ordinaryResult).toMatchObject({ mentionDecision: 'silent_use', text: '', sourceRefs: [] })
    expect(renderRecallContext(ordinaryRecall.results)).not.toContain('explicit locker U-202')
    const explicitRecall = await explicitOnly.recall('Do you remember my locker U-202 explicit?')
    const explicitResult = explicitRecall.results.find(result => result.sourceType === 'canonical')
    expect(explicitResult).toMatchObject({ mentionDecision: 'explicit', text: expect.stringContaining('explicit locker U-202'), sourceRefs: ['session:explicit-only-memory'] })
    expect(renderRecallContext(explicitRecall.results)).toContain('Source: session:explicit-only-memory')

    const never = open(new Domain()); await never.upsertManualPage(page('never-memory', 'never locker S-303', 'sensitive'))
    const neverRecall = await never.recall('Do you remember my locker S-303 never?')
    const neverResult = neverRecall.results.find(result => result.sourceType === 'canonical')
    expect(neverResult).toMatchObject({ mentionDecision: 'silent_use', text: '', sourceRefs: [] })
    expect(renderRecallContext(neverRecall.results)).not.toContain('never locker S-303')
  })

  it('keeps guidance-class normal pages silent on an ordinary query', async () => {
    const preference = open(new Domain()); await preference.upsertManualPage({ ...page('preference-memory', 'concise locker guidance'), kind: 'preference' })
    const preferenceRecall = await preference.recall('my locker concise guidance')
    const preferenceResult = preferenceRecall.results.find(result => result.sourceType === 'canonical')
    expect(preferenceResult).toMatchObject({ mentionDecision: 'silent_use' })
    expect(renderRecallContext(preferenceRecall.results)).not.toContain('concise locker guidance')

    const interaction = open(new Domain()); await interaction.upsertManualPage({ ...page('interaction-memory', 'quiet locker courtesy'), category: 'interaction_rules' })
    const interactionRecall = await interaction.recall('my locker quiet courtesy')
    const interactionResult = interactionRecall.results.find(result => result.sourceType === 'canonical')
    expect(interactionResult).toMatchObject({ mentionDecision: 'silent_use' })
    expect(renderRecallContext(interactionRecall.results)).not.toContain('quiet locker courtesy')
  })

  it('applies the lowered unclassified-evidence policy only to explicit topic matches', async () => {
    const store = open(new Domain(), { unclassifiedEvidenceDisclosure: 'user_explicit_only' })
    await store.appendSessionEvent('unclassified-session', JSON.stringify({ seq: 1, time: '2026-09-19T00:00:00.000Z', type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'unclassified locker U-404' }] } }))
    const ordinary = await store.recall('my locker U-404 unclassified')
    expect(ordinary.results.find(result => result.sourceType === 'evidence')).toMatchObject({ mentionDecision: 'silent_use', text: '', sourceRefs: [] })
    const explicit = await store.recall('Do you remember my unclassified locker U-404?')
    expect(explicit.results.find(result => result.sourceType === 'evidence')).toMatchObject({ mentionDecision: 'explicit', text: expect.stringContaining('unclassified locker U-404'), sourceRefs: ['session:unclassified-session/event:1'] })
  })
})
