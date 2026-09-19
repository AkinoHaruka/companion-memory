/* oxlint-disable @stylistic/max-len */
/*
 * What capture persists when the classifier itself is unusable.
 *
 * The mock delegates to the real module for every input it does not recognise, so a case that is not
 * about a broken classifier still exercises the shipped rule set; only the two marked inputs are the
 * injected faults. This has to live in its own file because `vi.mock` is file-wide, and a file-wide
 * classifier mock cannot also prove that the real module is the one wired into the store.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { memoryScopeForPreset } from '../src/contracts.ts'
import { MemoryProfileStore } from '../src/store.ts'

vi.mock('../src/sensitivity.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/sensitivity.ts')>()
  const classify = (text: string): unknown => {
    if (text.includes('classifier throws')) throw new Error('classifier unavailable')
    if (text.includes('classifier returns nonsense')) return 'not-a-sensitivity'
    return actual.classifyEvidenceSensitivity(text)
  }
  return { ...actual, classifyEvidenceSensitivity: classify } as unknown as typeof actual
})

class Table<V> {
  private readonly values = new Map<string, V>()
  get(key: string): V | undefined { return this.values.get(key) }
  entries(): IterableIterator<[string, V]> { return ([...this.values.entries()] as [string, V][])[Symbol.iterator]() }
  async put(key: string, value: V): Promise<void> { this.values.set(key, value) }
  async delete(key: string): Promise<boolean> { return this.values.delete(key) }
}

class Domain { private readonly tables = new Map<string, Table<unknown>>(); table(name: string): Table<unknown> { let table = this.tables.get(name); if (!table) { table = new Table(); this.tables.set(name, table) }; return table } }

const scope = memoryScopeForPreset('evidence-owner', 'classifier-fixture')
const stores: MemoryProfileStore[] = []
afterEach(async () => { await Promise.all(stores.map(store => store.close())); stores.length = 0 })

function open(domain: Domain): MemoryProfileStore {
  const store = new MemoryProfileStore(domain, scope, undefined, 12_000, { evidenceClassification: true })
  stores.push(store)
  return store
}

function userLine(seq: number, text: string): string {
  return JSON.stringify({ seq, time: '2026-09-19T00:00:00.000Z', type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text }] } })
}

describe('L0 capture classification with an unusable classifier', () => {
  it('persists the fail-closed value when the classifier throws or answers outside the supported states', async () => {
    const domain = new Domain(); const store = open(domain)
    await store.appendSessionEvent('fault-session', userLine(1, 'classifier throws on this turn'))
    await store.appendSessionEvent('fault-session', userLine(2, 'classifier returns nonsense for this turn'))
    expect(store.evidenceClassificationCounts('fault-session')).toEqual({ normal: 0, provisional_sensitive: 0, sensitive: 2, unclassified: 0 })
    const marks = store.listAudits().filter(audit => audit.event === 'evidence-sensitivity-marked')
    expect(marks.map(audit => audit.detail?.sensitivity)).toEqual(['sensitive', 'sensitive'])
    expect(marks.map(audit => audit.detail?.origin)).toEqual(['deterministic_rule', 'deterministic_rule'])

    const restored = open(domain); await restored.waitReady()
    expect(restored.evidenceClassificationCounts('fault-session')).toEqual({ normal: 0, provisional_sensitive: 0, sensitive: 2, unclassified: 0 })
  })

  it('keeps a fault-classified turn out of every raw disclosure', async () => {
    const store = open(new Domain())
    await store.appendSessionEvent('fault-session', userLine(1, 'classifier throws on this turn'))
    const response = await store.recall('你还记得 classifier throws on this turn 吗？')
    const result = response.results.find(value => value.sourceType === 'evidence')
    expect(result?.mentionDecision).toBe('silent_use')
    expect(result?.text).toBe('')
    expect(JSON.stringify(response.results.map(value => value.text))).not.toContain('classifier throws')
  })
})
