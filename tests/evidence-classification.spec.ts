/* oxlint-disable @stylistic/max-len */
/*
 * L0 capture classification: what it writes, what it lets through, who may change a value, and what
 * happens to a capture-rule value when the capability that produced it is switched back off.
 *
 * Every assertion here reads a durable record or a read-path result, never a wall-clock measurement, so
 * the file can also pin the exact byte shape of the session record the capability writes while it is off.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { memoryScopeForPreset } from '../src/contracts.ts'
import { scopedRecordKey, type MemorySessionRecord } from '../src/memory-domain.ts'
import { MemoryProfileStore, type EvidenceClassificationCounts } from '../src/store.ts'

class Table<V> {
  private readonly values = new Map<string, V>()
  get(key: string): V | undefined { return this.values.get(key) }
  entries(): IterableIterator<[string, V]> { return ([...this.values.entries()] as [string, V][])[Symbol.iterator]() }
  async put(key: string, value: V): Promise<void> { this.values.set(key, value) }
  async delete(key: string): Promise<boolean> { return this.values.delete(key) }
}

class Domain {
  private readonly tables = new Map<string, Table<unknown>>()
  table(name: string): Table<unknown> { let table = this.tables.get(name); if (!table) { table = new Table(); this.tables.set(name, table) }; return table }
  /** Every stored record of one table, so a test can assert the durable shape of what was written. */
  records(name: string): unknown[] { return [...this.table(name).entries()].map(([, value]) => value) }
}

const scope = memoryScopeForPreset('evidence-owner', 'evidence-preset')
const stores: MemoryProfileStore[] = []
afterEach(async () => { await Promise.all(stores.map(store => store.close())); stores.length = 0 })

/** Open one store over a shared domain; an omitted flag exercises the shipped default. */
function open(domain: Domain, evidenceClassification?: boolean): MemoryProfileStore {
  const store = new MemoryProfileStore(domain, scope, undefined, 12_000, evidenceClassification === undefined ? {} : { evidenceClassification })
  stores.push(store)
  return store
}

/** One persisted user turn, in the envelope the service appends. */
function userLine(seq: number, text: string): string {
  return JSON.stringify({ seq, time: '2026-09-19T00:00:00.000Z', type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text }] } })
}
/** One persisted assistant turn; it is not an evidence candidate, so capture never classifies it. */
function assistantLine(seq: number): string {
  return JSON.stringify({ seq, time: '2026-09-19T00:00:00.000Z', type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '好的。' }] } } })
}

/** The durable session record behind one session id. */
function persistedSession(domain: Domain, sessionId: string): MemorySessionRecord {
  const record = domain.records('sessions').find(value => (value as MemorySessionRecord).sessionId === sessionId)
  if (record === undefined) throw new Error(`no persisted session record for ${sessionId}`)
  return record as MemorySessionRecord
}

/** Seed a session record directly, standing in for events captured before the capability existed. */
async function seedUnclassifiedSession(domain: Domain, sessionId: string, lines: readonly string[]): Promise<void> {
  await domain.table('sessions').put(scopedRecordKey(scope, sessionId), { schemaVersion: 2, scope, sessionId, lines: [...lines] })
}

const countsOf = (store: MemoryProfileStore, sessionId: string): EvidenceClassificationCounts => store.evidenceClassificationCounts(sessionId)
/** Every result of one recall whose raw text is visible to the caller. */
const disclosed = (results: readonly { readonly text: string }[]): string => JSON.stringify(results.map(result => result.text))

describe('L0 evidence classification', () => {
  it('writes exactly the legacy session record while the capability is off, by omission and by explicit false', async () => {
    const line = userLine(1, '我的储物柜编号是 B-417')
    const implicitDomain = new Domain(); const implicit = open(implicitDomain)
    await implicit.appendSessionEvent('legacy-session', line)
    const explicitDomain = new Domain(); const explicit = open(explicitDomain, false)
    await explicit.appendSessionEvent('legacy-session', line)

    const omitted = persistedSession(implicitDomain, 'legacy-session')
    const disabled = persistedSession(explicitDomain, 'legacy-session')
    expect(Object.keys(omitted).sort()).toEqual(['lines', 'schemaVersion', 'scope', 'sessionId'])
    expect(JSON.stringify(omitted)).toBe(JSON.stringify(disabled))
    expect(JSON.stringify(omitted)).not.toContain('evidenceMarkers')
    expect(countsOf(implicit, 'legacy-session')).toEqual({ normal: 0, provisional_sensitive: 0, sensitive: 0, unclassified: 1 })

    const response = await implicit.recall('你还记得我的储物柜 B-417 吗？')
    const matched = response.results.find(result => result.sourceType === 'evidence')
    expect(matched?.mentionDecision).toBe('explicit')
    expect(matched?.text).toContain('B-417')
    expect(disclosed(response.results)).toContain('B-417')
  })

  it('returns ordinary evidence as an explicit L0 result carrying its source ref', async () => {
    const store = open(new Domain(), true)
    await store.appendSessionEvent('classified-session', userLine(4, '我的储物柜编号是 B-417'))
    const response = await store.recall('你还记得我的储物柜 B-417 吗？')
    const result = response.results.find(value => value.sourceType === 'evidence')
    expect(result).toBeDefined()
    expect(result?.mentionDecision).toBe('explicit')
    expect(result?.text).toContain('B-417')
    // The ref names the session event's own seq, not the line index, so a citation survives re-reads.
    expect(result?.sourceRefs).toEqual(['session:classified-session/event:4'])
    expect(result?.sensitivity).toBe('normal')
    expect(countsOf(store, 'classified-session')).toEqual({ normal: 1, provisional_sensitive: 0, sensitive: 0, unclassified: 0 })
  })

  it('counts every stored line, keeping the fail-closed remainder apart from an explicit value', async () => {
    const store = open(new Domain(), true)
    await store.appendSessionEvent('mixed-session', userLine(1, '我的储物柜编号是 B-417'))
    await store.appendSessionEvent('mixed-session', userLine(2, '我的私密病历编号是 S-200'))
    await store.appendSessionEvent('mixed-session', assistantLine(3))
    const counts = countsOf(store, 'mixed-session')
    expect(counts).toEqual({ normal: 1, provisional_sensitive: 0, sensitive: 1, unclassified: 1 })
    expect(Object.keys(counts).sort()).toEqual(['normal', 'provisional_sensitive', 'sensitive', 'unclassified'])
    expect(Object.values(counts).reduce((sum, value) => sum + value, 0)).toBe(3)
    expect(JSON.stringify(counts)).not.toContain('B-417')
    expect(JSON.stringify(counts)).not.toContain('S-200')
  })

  it('keeps a recognised private claim to a projection even with capture classification on', async () => {
    const store = open(new Domain(), true)
    await store.appendSessionEvent('private-session', userLine(1, '我的私密病历编号是 S-200'))
    const response = await store.recall('你还记得我的私密病历编号 S-200 吗？')
    expect(disclosed(response.results)).not.toContain('S-200')
    const result = response.results.find(value => value.sourceType === 'evidence')
    expect(result?.text).toBe('')
    expect(result?.mentionDecision).toBe('silent_use')
    expect(countsOf(store, 'private-session')).toEqual({ normal: 0, provisional_sensitive: 0, sensitive: 1, unclassified: 0 })
  })

  it('reloads a persisted marker into the same classification in force', async () => {
    const domain = new Domain(); const first = open(domain, true)
    await first.appendSessionEvent('restart-classified', userLine(1, '我的储物柜编号是 B-417'))
    const restored = open(domain, true); await restored.waitReady()
    expect(countsOf(restored, 'restart-classified')).toEqual({ normal: 1, provisional_sensitive: 0, sensitive: 0, unclassified: 0 })
    const response = await restored.recall('你还记得我的储物柜 B-417 吗？')
    expect(response.results.some(result => result.mentionDecision === 'explicit' && result.text.includes('B-417'))).toBe(true)
  })

  it('refuses a proposal that would publish an unclassified event, and one that would relax a stored value', async () => {
    const domain = new Domain()
    // Seeded before the store opens, so the record is part of the scope the store loads rather than a
    // write racing the load.
    await seedUnclassifiedSession(domain, 'unclassified-session', [userLine(1, '我的储物柜编号是 B-417')])
    const store = open(domain, true)
    await store.waitReady()
    expect(countsOf(store, 'unclassified-session')).toEqual({ normal: 0, provisional_sensitive: 0, sensitive: 0, unclassified: 1 })

    expect(await store.proposeEvidenceSensitivity('unclassified-session', 0, 'normal')).toBe(false)
    expect(countsOf(store, 'unclassified-session').unclassified).toBe(1)
    const refusal = store.listAudits().filter(audit => audit.event === 'evidence-sensitivity-rejected')
    expect(refusal).toHaveLength(1)
    expect(refusal[0]?.detail).toMatchObject({ from: 'unclassified', to: 'normal', authority: 'model_proposal', reason: 'unclassified-target' })

    expect(await store.proposeEvidenceSensitivity('unclassified-session', 0, 'provisional_sensitive')).toBe(true)
    expect(countsOf(store, 'unclassified-session')).toEqual({ normal: 0, provisional_sensitive: 1, sensitive: 0, unclassified: 0 })
    expect(await store.proposeEvidenceSensitivity('unclassified-session', 0, 'provisional_sensitive')).toBe(false)
    expect(await store.proposeEvidenceSensitivity('unclassified-session', 0, 'normal')).toBe(false)
    expect(countsOf(store, 'unclassified-session').provisional_sensitive).toBe(1)
    expect(store.listAudits().filter(audit => audit.event === 'evidence-sensitivity-rejected')).toHaveLength(2)
  })

  it('lets a proposal tighten an explicitly sensitive value but never loosen it', async () => {
    const store = open(new Domain(), true)
    await store.appendSessionEvent('explicit-sensitive', userLine(1, '我的私密病历编号是 S-200'))
    expect(countsOf(store, 'explicit-sensitive').sensitive).toBe(1)
    expect(await store.proposeEvidenceSensitivity('explicit-sensitive', 0, 'provisional_sensitive')).toBe(false)
    expect(countsOf(store, 'explicit-sensitive').sensitive).toBe(1)
    const refusal = store.listAudits().filter(audit => audit.event === 'evidence-sensitivity-rejected')
    expect(refusal).toHaveLength(1)
    expect(refusal[0]?.detail).toMatchObject({ from: 'sensitive', to: 'provisional_sensitive', authority: 'model_proposal', reason: 'proposal-loosens-explicit-value' })
  })

  it('suspends a capture-rule value while the capability is off and restores it without deleting the record', async () => {
    const domain = new Domain(); const query = '你还记得我的储物柜 B-417 吗？'
    const on = open(domain, true)
    await on.appendSessionEvent('rollback-session', userLine(1, '我的储物柜编号是 B-417'))
    expect((await on.recall(query)).results.some(result => result.text.includes('B-417'))).toBe(true)

    const off = open(domain, false); await off.waitReady()
    expect(countsOf(off, 'rollback-session')).toEqual({ normal: 0, provisional_sensitive: 0, sensitive: 1, unclassified: 0 })
    expect(disclosed((await off.recall(query)).results)).not.toContain('B-417')
    expect(persistedSession(domain, 'rollback-session').evidenceMarkers).toEqual([{ index: 0, sensitivity: 'normal', origin: 'deterministic_rule' }])

    const again = open(domain, true); await again.waitReady()
    expect(countsOf(again, 'rollback-session')).toEqual({ normal: 1, provisional_sensitive: 0, sensitive: 0, unclassified: 0 })
    expect((await again.recall(query)).results.some(result => result.text.includes('B-417'))).toBe(true)
  })
})
