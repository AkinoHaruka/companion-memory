/* oxlint-disable @stylistic/max-len */

/**
 * Write-set complexity of the L0 append path.
 *
 * These assertions deliberately count durable `table.put`/`table.delete`
 * calls and the serialized bytes handed to the storage layer instead of
 * measuring wall clock: the physical cost of one append is exactly the number
 * of durable record writes it performs, so the count IS the complexity, and a
 * count is stable on any machine.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { memoryScopeForPreset, type MemoryScope } from '../src/contracts.ts'
import { MEMORY_DOMAIN, scopedRecordKey, storageScopeKey } from '../src/memory-domain.ts'
import { MemoryProfileStore } from '../src/store.ts'

interface DurableWrite {
  readonly table: string
  readonly key: string
  readonly bytes: number
}

class CountingTable<V> {
  private readonly values = new Map<string, V>()
  constructor(private readonly domain: CountingDomain, private readonly name: string) {}
  get(key: string): V | undefined { return this.values.get(key) }
  entries(): IterableIterator<[string, V]> { return ([...this.values.entries()] as [string, V][])[Symbol.iterator]() }
  // The mutation lands BEFORE the ordinal check, so a failing write leaves the exact partial state a
  // real backend leaves behind: the store has to roll it back, not rely on the medium staying clean.
  async put(key: string, value: V): Promise<void> { this.values.set(key, value); this.domain.record(this.name, key, JSON.stringify(value).length) }
  async delete(key: string): Promise<boolean> { const removed = this.values.delete(key); this.domain.record(this.name, key, 0); return removed }
}

/** An in-memory domain that logs every durable write, and can fail the next k of them. */
class CountingDomain {
  private readonly tables = new Map<string, CountingTable<unknown>>()
  private readonly log: DurableWrite[] = []
  private ordinal = 0
  private failAt = 0
  private failuresRemaining = 0
  table(name: string): CountingTable<unknown> {
    let table = this.tables.get(name)
    if (table === undefined) { table = new CountingTable<unknown>(this, name); this.tables.set(name, table) }
    return table
  }
  /** Fail the next `count` durable writes, starting from the very next one. */
  failNext(count: number): void { this.failAt = this.ordinal + 1; this.failuresRemaining = count }
  /** Log one durable write, applying the ordinal fault injection first. */
  record(table: string, key: string, bytes: number): void {
    this.ordinal += 1
    if (this.failuresRemaining > 0 && this.ordinal >= this.failAt) { this.failuresRemaining -= 1; throw new Error('injected write failure') }
    this.log.push({ table, key, bytes })
  }
  /** Start a fresh measurement window; the fault ordinal keeps counting across windows. */
  reset(): void { this.log.length = 0 }
  writes(): readonly DurableWrite[] { return [...this.log] }
  countFor(table: string): number { return this.log.filter(write => write.table === table).length }
  total(): number { return this.log.length }
  bytesTotal(): number { return this.log.reduce((sum, write) => sum + write.bytes, 0) }
  bytesFor(table: string): number { return this.log.filter(write => write.table === table).reduce((sum, write) => sum + write.bytes, 0) }
}

const scopeA = memoryScopeForPreset('owner-a', 'preset-a')
const scopeB = memoryScopeForPreset('owner-a', 'preset-b')
let stores: MemoryProfileStore[] = []

afterEach(async () => { await Promise.all(stores.map(store => store.close())); stores = [] })

function open(domain: CountingDomain, scope: MemoryScope = scopeA): MemoryProfileStore {
  const store = new MemoryProfileStore(domain, scope); stores.push(store); return store
}

const evidence = (index: number): string => JSON.stringify({ schemaVersion: 1, sessionId: 'bench', seq: index + 1, time: '2026-09-19T00:00:00.000Z', type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: `turn ${index}` }] } })

/** Read one durable record out of the counting domain, by its scoped key or by a field predicate. */
function durableRecord(domain: CountingDomain, table: string, key: string): Record<string, unknown> | undefined {
  return domain.table(table).get(key) as Record<string, unknown> | undefined
}
/** The session's durable source record, whose key is the source id rather than the session id. */
function durableSessionSource(domain: CountingDomain, sessionId: string): Record<string, unknown> | undefined {
  for (const [, value] of domain.table('sources').entries()) {
    const record = value as { source?: { ref?: string } }
    if (record.source?.ref === sessionId) return value as Record<string, unknown>
  }
  return undefined
}

/** Append n lines to one session and report what the append path cost. */
async function appendBurst(store: MemoryProfileStore, domain: CountingDomain, n: number): Promise<{ readonly total: number; readonly sessionBytes: number }> {
  domain.reset()
  for (let index = 0; index < n; index += 1) await store.appendSessionEvent('bench', evidence(index))
  return { total: domain.total(), sessionBytes: domain.bytesFor('sessions') }
}

/** Fill a scope with records a whole-scope snapshot persist would rewrite on every append. */
async function seedFatScope(store: MemoryProfileStore): Promise<void> {
  for (let index = 0; index < 12; index += 1) {
    await store.upsertManualPage({ id: `fat-${String(index)}`, path: `wiki/concepts/fat-${String(index)}.md`, type: 'concept', title: `fat ${String(index)}`, description: `fat ${String(index)}`, body: `fat body ${String(index)}`, sources: ['session-fat'], tags: ['interaction_rules'], timestamp: '2026-09-17T00:00:00.000Z', confidence: 1, status: 'confirmed', consent: true, locked: true, version: 1, updatedAt: '2026-09-17T00:00:00.000Z', category: 'interaction_rules', kind: 'preference' } as never)
  }
  for (let session = 0; session < 6; session += 1) await store.appendSessionEvent(`fat-session-${String(session)}`, `fat line ${String(session)}`)
  await store.upsertAlias({ entityId: 'fat-0', alias: '胖事实', confidence: 0.9, sourceRefs: ['page:fat-0'] })
  await store.flush()
}

describe('L0 append write-set complexity', () => {
  it('uses the version-named domain while accepting every prior domain version', () => {
    expect(MEMORY_DOMAIN.version).toBe(6)
    expect(MEMORY_DOMAIN.compatibleVersions).toEqual([1, 2, 3, 4, 5])
  })

  it('writes exactly one record per appended line and never rewrites the scope snapshot', async () => {
    const domain = new CountingDomain(); const store = open(domain); await store.waitReady()
    const burst = await appendBurst(store, domain, 120)
    // One durable record per line: the session record that carries the line.
    expect(domain.countFor('sessions')).toBe(120)
    // Nothing else was rewritten per line — the derived records ride one write-behind window.
    expect(domain.countFor('pages')).toBe(0)
    expect(domain.countFor('audits')).toBe(0)
    expect(domain.countFor('aliases')).toBe(0)
    expect(domain.countFor('projections')).toBe(0)
    expect(domain.countFor('sources') + domain.countFor('profiles')).toBeLessThanOrEqual(4)
    expect(burst.total).toBeLessThanOrEqual(124)
  })

  it('grows the append write set linearly with the line count', async () => {
    const domain = new CountingDomain(); const store = open(domain); await store.waitReady()
    const small = await appendBurst(store, domain, 100)
    const large = await appendBurst(store, domain, 200)
    // Marginal cost per appended line is O(1) and independent of how many lines the session already holds.
    expect(large.total - small.total).toBeLessThanOrEqual(204)
    expect(large.total).toBeLessThanOrEqual(204)
    expect(domain.countFor('sessions')).toBe(200)
  })

  it('keeps one append\'s write set independent of how large the scope already is', async () => {
    const leanDomain = new CountingDomain(); const lean = open(leanDomain); await lean.waitReady()
    const leanBurst = await appendBurst(lean, leanDomain, 40)

    const fatDomain = new CountingDomain(); const fat = open(fatDomain); await fat.waitReady(); await seedFatScope(fat)
    const fatBurst = await appendBurst(fat, fatDomain, 40)

    // The scope now holds pages, sessions and audits, yet one append still writes one record.
    expect(fatDomain.countFor('pages')).toBe(0)
    expect(fatDomain.countFor('aliases')).toBe(0)
    expect(fatBurst.total).toBe(leanBurst.total)
    // ...and the bytes an append carries are the session's own, not the scope's.
    expect(fatBurst.sessionBytes).toBe(leanBurst.sessionBytes)
    expect(fatBurst.sessionBytes).toBeGreaterThan(0)
  })

  it('lands the session record before the append settles, so the append stays the evidence barrier', async () => {
    const domain = new CountingDomain(); const store = open(domain); await store.waitReady()
    const key = scopedRecordKey(scopeA, 'bench')
    const durableSession = (): { schemaVersion: number; scope: { key: string }; sessionId: string; lines: readonly string[] } | undefined => durableRecord(domain, 'sessions', key) as { schemaVersion: number; scope: { key: string }; sessionId: string; lines: readonly string[] } | undefined

    expect(durableSession()).toBeUndefined()
    await store.appendSessionEvent('bench', evidence(0))
    // Durable the moment the append resolves — Dream cannot read L0 that has not landed.
    expect(durableSession()?.lines).toEqual([evidence(0)])
    // Field set and schemaVersion of the persisted record are unchanged.
    expect(Object.keys(durableSession() ?? {}).sort()).toEqual(['lines', 'schemaVersion', 'scope', 'sessionId'])
    expect(durableSession()?.schemaVersion).toBe(2)
    expect(durableSession()?.scope.key).toBe(scopeA.key)
    expect(durableSession()?.sessionId).toBe('bench')

    await store.appendSessionEvent('bench', evidence(1))
    expect(durableSession()?.lines).toEqual([evidence(0), evidence(1)])
    // Every line of a burst, not just the last, is durable at its own append.
    for (let index = 2; index < 60; index += 1) await store.appendSessionEvent('bench', evidence(index))
    expect(durableSession()?.lines).toHaveLength(60)
  })

  it('coalesces the derived records into one write-behind flush and lands them on flush()', async () => {
    const domain = new CountingDomain(); const store = open(domain); await store.waitReady()
    await appendBurst(store, domain, 90)
    // The derived records were not rewritten per append.
    expect(domain.countFor('sources')).toBeLessThanOrEqual(2)
    expect(domain.countFor('profiles')).toBeLessThanOrEqual(2)

    domain.reset()
    await store.flush()
    // The explicit barrier lands them, exactly once.
    expect(domain.countFor('sources')).toBe(1)
    expect(domain.countFor('profiles')).toBe(1)
    expect(domain.countFor('sessions')).toBe(0)
    expect(durableSessionSource(domain, 'bench')?.schemaVersion).toBe(2)

    // A second flush has nothing left to do.
    domain.reset()
    await store.flush()
    expect(domain.total()).toBe(0)
  })

  it('lets any later mutation land the deferred records without an explicit flush', async () => {
    const domain = new CountingDomain(); const store = open(domain); await store.waitReady()
    await appendBurst(store, domain, 10)
    domain.reset()
    await store.upsertManualPage({ id: 'later', path: 'wiki/concepts/later.md', type: 'concept', title: 'later', description: 'later', body: 'later', sources: ['bench'], tags: ['interaction_rules'], timestamp: '2026-09-17T00:00:00.000Z', confidence: 1, status: 'confirmed', consent: true, locked: true, version: 1, updatedAt: '2026-09-17T00:00:00.000Z', category: 'interaction_rules', kind: 'preference' } as never)
    // The non-append path still persists the whole scope, so the write-behind buffer is empty afterwards.
    expect(domain.countFor('sources')).toBeGreaterThan(0)
    expect(domain.countFor('profiles')).toBeGreaterThan(0)
    domain.reset()
    await store.flush()
    expect(domain.total()).toBe(0)
  })

  it('rolls the coalesced write set back whole when one of its writes fails', async () => {
    const domain = new CountingDomain(); const store = open(domain); await store.waitReady()
    await store.upsertManualPage({ id: 'resident', path: 'wiki/concepts/resident.md', type: 'concept', title: 'resident', description: 'resident', body: 'resident', sources: ['bench'], tags: ['interaction_rules'], timestamp: '2026-09-17T00:00:00.000Z', confidence: 1, status: 'confirmed', consent: true, locked: true, version: 1, updatedAt: '2026-09-17T00:00:00.000Z', category: 'interaction_rules', kind: 'preference' } as never)
    await store.flush()
    await store.appendSessionEvent('bench', evidence(0))
    const residentBefore = store.renderResident()
    const durableBefore = JSON.stringify(['pages', 'sources', 'sessions', 'profiles'].map(name => [name, [...domain.table(name).entries()]]))

    // Exactly one write of the coalesced set fails: the injected cause has to reach the caller.
    domain.failNext(1)
    await expect(store.flush()).rejects.toThrow(/injected write failure/)
    // No partial state: every durable table is exactly what it was, and the served Resident is untouched.
    expect(JSON.stringify(['pages', 'sources', 'sessions', 'profiles'].map(name => [name, [...domain.table(name).entries()]]))).toBe(durableBefore)
    expect(store.renderResident()).toBe(residentBefore)

    // The buffer survived the failure, so the next barrier lands it.
    await store.flush()
    expect(durableSessionSource(domain, 'bench')?.schemaVersion).toBe(2)
  })

  it('writes no record outside the appending scope, whatever other scopes hold', async () => {
    const domain = new CountingDomain()
    const other = open(domain, scopeB); await other.waitReady(); await seedFatScope(other)
    const store = open(domain, scopeA); await store.waitReady()

    const burst = await appendBurst(store, domain, 30)
    const prefix = storageScopeKey(scopeA)
    const foreign = storageScopeKey(scopeB)
    expect(burst.total).toBeGreaterThan(0)
    for (const write of domain.writes()) {
      expect(write.key.startsWith(prefix)).toBe(true)
      expect(write.key.startsWith(foreign)).toBe(false)
    }
    // Every write went to a record this path owns: the session and its derived scope state.
    for (const write of domain.writes()) expect(['sessions', 'sources', 'profiles']).toContain(write.table)
  })
})
