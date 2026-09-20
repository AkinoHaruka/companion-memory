import { afterEach, describe, expect, it } from 'vitest'
import { createEmbeddingProvider } from '../src/embedding-provider.ts'
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

class AblationDomain {
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

const SCENARIO_COUNT = 12
const PAGES_PER_SCENARIO = 20
let stores: MemoryProfileStore[] = []

afterEach(async () => {
  await Promise.all(stores.map(store => store.close()))
  stores = []
})

function page(index: number, kind: 'target' | 'distractor'): WikiPage {
  const label = `${String(index).padStart(2, '0')}-${kind}`
  const text = kind === 'target'
    ? `synthetic target ${label} records a private detail about restoring film negatives`
    : `synthetic distractor ${label} records an unrelated detail about cataloguing paper maps`
  return {
    id: label,
    path: `wiki/concepts/large-ablation-${label}.md`,
    type: 'concept',
    title: text,
    description: text,
    body: text,
    sources: ['large-ablation-session'],
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

interface Trial {
  readonly targetId: string
  readonly results: Awaited<ReturnType<MemoryProfileStore['recall']>>
}

async function runTrial(index: number, vectorEnabled: boolean): Promise<Trial> {
  const scope = memoryScopeForPreset('large-ablation-owner', `large-ablation-${String(index)}`)
  const provider = createEmbeddingProvider({ kind: 'deterministic-local', dimension: 32 })
  if (provider === undefined) throw new Error('expected deterministic provider')
  const options = vectorEnabled ? { embeddingProvider: provider } : {}
  const store = new MemoryProfileStore(new AblationDomain(), scope, undefined, 12_000, options)
  stores.push(store)
  for (let distractor = 1; distractor < PAGES_PER_SCENARIO; distractor += 1) {
    await store.upsertManualPage(page(index * 100 + distractor, 'distractor'))
  }
  await store.upsertManualPage(page(index * 100, 'target'))
  const targetId = store.listPages().find(item => item.title.includes('target'))?.id
  if (targetId === undefined) throw new Error(`missing target page for scenario ${String(index)}`)
  const results = await store.recall('你记得之前那件事吗？', { vectorEnabled, maxCandidates: 8, maxContextChars: 2_000 })
  await store.close()
  stores = stores.filter(candidate => candidate !== store)
  return { targetId, results }
}

describe('larger keyless dense ablation', () => {
  it(
    'measures unique recall gain, dense noise, and gate rejection on a larger hard-negative pool',
    { timeout: 120_000 },
    async () => {
      const rows: Array<{
        readonly scenario: string
        readonly off: Trial
        readonly on: Trial
        readonly denseResults: number
        readonly denseNoise: number
        readonly gateCandidates: number
        readonly gateRejected: number
      }> = []
      for (let index = 0; index < SCENARIO_COUNT; index += 1) {
        const off = await runTrial(index, false)
        const on = await runTrial(index, true)
        const target = `page:${on.targetId}`
        const denseResults = on.results.results.filter(result => result.channels.includes('dense'))
        const denseDecisions = on.results.trace.gateDecisions.filter(decision => decision.channels.includes('dense'))
        rows.push({
          scenario: `L. ${String(index + 1).padStart(2, '0')}`,
          off,
          on,
          denseResults: denseResults.length,
          denseNoise: denseResults.filter(result => result.id !== target).length,
          gateCandidates: denseDecisions.length,
          gateRejected: denseDecisions.filter(decision => decision.decision === 'suppress').length,
        })
      }

      const uniqueGain = rows.filter(row => row.on.results.results.some(result => result.id === `page:${row.on.targetId}`)
        && !row.off.results.results.some(result => result.id === `page:${row.off.targetId}`)).length
      const denseSelected = rows.reduce((sum, row) => sum + row.denseResults, 0)
      const noise = rows.reduce((sum, row) => sum + row.denseNoise, 0)
      const gateCandidates = rows.reduce((sum, row) => sum + row.gateCandidates, 0)
      const gateRejected = rows.reduce((sum, row) => sum + row.gateRejected, 0)
      const metrics = {
        corpus: { scenarios: rows.length, pagesPerScenario: PAGES_PER_SCENARIO },
        uniqueRecallGain: { status: 'measured', numerator: uniqueGain, denominator: rows.length, value: uniqueGain / rows.length },
        denseNoiseRate: {
          status: 'measured', numerator: noise, denominator: denseSelected,
          value: denseSelected === 0 ? 0 : noise / denseSelected,
        },
        gateRejectionRate: {
          status: 'measured', numerator: gateRejected, denominator: gateCandidates,
          value: gateCandidates === 0 ? 0 : gateRejected / gateCandidates,
        },
      }
      console.log(`larger keyless dense ablation: ${JSON.stringify(metrics)}`)

      expect(rows).toHaveLength(SCENARIO_COUNT)
      expect(PAGES_PER_SCENARIO).toBeGreaterThan(10)
      expect(denseSelected).toBeGreaterThan(0)
      expect(gateCandidates).toBeGreaterThan(0)
      expect(uniqueGain).toBeGreaterThanOrEqual(0)
      expect(uniqueGain).toBeLessThanOrEqual(rows.length)
      expect(noise).toBeGreaterThanOrEqual(0)
      expect(noise).toBeLessThanOrEqual(denseSelected)
      expect(gateRejected).toBeGreaterThanOrEqual(0)
      expect(gateRejected).toBeLessThanOrEqual(gateCandidates)
    },
  )
})
