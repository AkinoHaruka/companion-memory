/* oxlint-disable @stylistic/max-len */
import { afterEach, describe, expect, it } from 'vitest'
import { memoryScopeForPreset } from '../src/contracts.ts'
import { renderRecallContext, type RecallResult } from '../src/recall.ts'
import { MemoryProfileStore } from '../src/store.ts'
import type { SafeUsageProjection } from '../src/types.ts'
import type { WikiPage } from '../src/wiki.ts'

class Table<V> { private readonly values = new Map<string, V>(); get(key: string): V | undefined { return this.values.get(key) }; entries(): IterableIterator<[string, V]> { return ([...this.values.entries()] as [string, V][])[Symbol.iterator]() }; async put(key: string, value: V): Promise<void> { this.values.set(key, value) }; async delete(key: string): Promise<boolean> { return this.values.delete(key) } }
class Domain { private readonly tables = new Map<string, Table<unknown>>(); table(name: string): Table<unknown> { let table = this.tables.get(name); if (!table) { table = new Table(); this.tables.set(name, table) }; return table } }
const scope = memoryScopeForPreset('test-owner', 'projection'); const stores: MemoryProfileStore[] = []
afterEach(async () => { await Promise.all(stores.map(store => store.close())); stores.length = 0 })

function page(body: string): WikiPage { return { id: 'projection-source', path: 'wiki/concepts/projection-source.md', type: 'concept', title: 'A private preference', description: 'A private preference', body, sources: ['projection-session'], tags: ['interaction_rules'], timestamp: '2026-09-19T00:00:00.000Z', confidence: 1, status: 'confirmed', consent: true, locked: true, version: 1, updatedAt: '2026-09-19T00:00:00.000Z', category: 'interaction_rules', kind: 'preference' } }

const projection: SafeUsageProjection = {
  id: 'projection:calm-tone',
  memoryId: 'memory:private-tone',
  allowedEffects: ['tone', 'avoid_topic'],
  topicTags: ['health'],
  summary: 'Use a calm and concise tone.',
  disclosure: 'never_explicit',
  generatedFromVersion: 'memory-v1',
  generatedAt: '2026-09-19T00:00:00.000Z',
}

function result(overrides: Partial<RecallResult> = {}): RecallResult {
  return {
    id: 'result:private-tone',
    sourceType: 'canonical',
    text: 'PRIVATE MEMORY BODY MUST NOT APPEAR',
    sourceRefs: ['session:secret-session/event:42'],
    epistemicStatus: 'confirmed',
    temporalStatus: 'current',
    sensitivity: 'provisional_sensitive',
    eligibility: 'silent_only',
    channels: ['lexical'],
    fusedScore: 1,
    mentionDecision: 'silent_use',
    ...overrides,
  }
}

describe('silent-use-projection', () => {
  it('generates, persists, populates, and rebuilds a projection without the body', async () => {
    const domain = new Domain(); const first = new MemoryProfileStore(domain, scope); stores.push(first); const body = 'IDENTIFYING BODY: private medical appointment at 09:17'
    await first.upsertManualPage(page(body)); const id = first.listPages()[0]!.id; const projection = first.projectionFor(id)
    expect(projection).toBeDefined(); expect(JSON.stringify(projection)).not.toContain(body); expect(projection?.topicTags).toEqual(expect.arrayContaining(['concept', 'interaction_rules']))
    const recalled = await first.recall('What is my preference?'); expect(recalled.results.find(result => result.id === `page:${id}`)?.projection).toEqual(projection)
    const restored = new MemoryProfileStore(domain, scope); stores.push(restored); await restored.waitReady(); expect(restored.projectionFor(id)?.generatedFromVersion).toBe(projection?.generatedFromVersion)
    expect(await restored.forget(id)).toBe(true); expect(await restored.rebuildProjections()).toEqual([]); expect([...domain.table('projections').entries()]).toHaveLength(0)
  })

  it('renders guidance fields without the body or source identifiers', () => {
    const rendered = renderRecallContext([result({ projection })])

    expect(rendered).toContain('<internal-memory-guidance>')
    expect(rendered).toContain('tone: adapt_with_care')
    expect(rendered).toContain('topic_sensitivity: elevated')
    expect(rendered).toContain('avoid_unsolicited_reference: true')
    expect(rendered).toContain('avoid_probing: true')
    expect(rendered).toContain('user_initiated_topic: false')
    expect(rendered).toContain('summary: Use a calm and concise tone.')
    expect(rendered).not.toContain('PRIVATE MEMORY BODY MUST NOT APPEAR')
    expect(rendered).not.toContain('session:secret-session')
    expect(rendered).not.toContain('event:42')
  })

  it('blocks explicit raw quotes, suppresses suppressed results, and falls back without the body', () => {
    const explicit = renderRecallContext([result({ mentionDecision: 'explicit', eligibility: 'eligible' })])
    expect(explicit).not.toContain('PRIVATE MEMORY BODY MUST NOT APPEAR')
    expect(explicit).not.toContain('Source: session:secret-session/event:42')
    expect(explicit).toContain('<internal-memory-guidance>')

    expect(renderRecallContext([result({ mentionDecision: 'suppress' })])).toBe('')

    const fallback = renderRecallContext([result({ sourceType: 'observation', epistemicStatus: 'inferred', sensitivity: 'sensitive' })])
    expect(fallback).toContain('topic_sensitivity: high')
    expect(fallback).toContain('tone: tentative')
    expect(fallback).not.toContain('PRIVATE MEMORY BODY MUST NOT APPEAR')
    expect(fallback).not.toContain('session:secret-session')
    expect(fallback).not.toContain('event:42')
  })

  it('selects whole values under the cap and preserves both delimiters', () => {
    const first = renderRecallContext([result({ projection })])
    const rendered = renderRecallContext([
      result({ projection }),
      result({ id: 'result:second', text: 'SECOND PRIVATE BODY', projection: { ...projection, id: 'projection:second', memoryId: 'memory:second', summary: 'A second safe cue.' } }),
    ], first.length)

    expect(rendered).toBe(first)
    expect(rendered.length).toBeLessThanOrEqual(first.length)
    expect(rendered).toMatch(/^<MEMORY_DATA>[\s\S]*<\/MEMORY_DATA>$/)
    expect(rendered).toContain('[/RECALLED_MEMORY]')
    expect(rendered).not.toContain('SECOND PRIVATE BODY')
  })
})
