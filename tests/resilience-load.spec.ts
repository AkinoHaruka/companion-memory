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

class LoadDomain {
  private readonly tables = new Map<string, Table<unknown>>()

  table(name: string): Table<unknown> {
    let table = this.tables.get(name)
    if (table === undefined) {
      table = new Table<unknown>()
      this.tables.set(name, table)
    }
    return table
  }
}

const scope = memoryScopeForPreset('load-owner', 'load-preset')
let stores: MemoryProfileStore[] = []

afterEach(async () => {
  await Promise.all(stores.map(store => store.close()))
  stores = []
})

function page(index: number): WikiPage {
  const text = `load fact ${String(index)}`
  return {
    id: `load-${String(index)}`,
    path: `wiki/concepts/load-${String(index)}.md`,
    type: 'concept',
    title: text,
    description: text,
    body: `${text} remains a confirmed bounded-load fact.`,
    sources: ['load-session'],
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

function evidence(index: number): string {
  return JSON.stringify({
    seq: index + 1,
    type: 'user/message',
    data: { source: { kind: 'user' }, content: [{ type: 'text', text: `load evidence ${String(index)}` }] },
  })
}

describe('bounded resident and recall load', () => {
  it('keeps Resident and recall bounded after hundreds of pages and thousands of evidence records', { timeout: 120_000 }, async () => {
    const domain = new LoadDomain()
    const store = new MemoryProfileStore(domain, scope, undefined, 512)
    stores.push(store)
    await store.waitReady()

    for (let index = 0; index < 240; index += 1) await store.upsertManualPage(page(index))
    for (let index = 0; index < 2_000; index += 1) await store.appendSessionEvent('load-session', evidence(index))
    await store.flush()

    const resident = store.renderResident()
    const response = await store.recall('你还记得之前的 load fact 137 吗？', { maxCandidates: 7, maxContextChars: 300 })

    expect(resident.length).toBeGreaterThan(0)
    expect(resident.length).toBeLessThanOrEqual(512)
    expect(response.results.length).toBeGreaterThan(0)
    expect(response.results.length).toBeLessThanOrEqual(7)
    expect(response.trace.contextChars).toBeGreaterThan(0)
    expect(response.trace.contextChars).toBeLessThanOrEqual(300)
    expect(response.results.some(result => result.authorityTier === 'canonical')).toBe(true)
    expect(response.results.filter(result => result.authorityTier === 'evidence').every(result => result.role === 'supplement')).toBe(true)
    expect(response.results.some(result => result.text.includes('load fact 137'))).toBe(true)
  })
})
