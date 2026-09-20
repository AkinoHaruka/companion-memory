/* oxlint-disable @stylistic/max-len */
import { afterEach, describe, expect, it } from 'vitest'
import { memoryScopeForPreset } from '../src/contracts.ts'
import { renderRecallContext } from '../src/recall.ts'
import { MemoryProfileStore } from '../src/store.ts'
import type { WikiPage } from '../src/wiki.ts'

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
}

const scope = memoryScopeForPreset('evidence-precedence-owner', 'evidence-precedence-preset')
const stores: MemoryProfileStore[] = []
afterEach(async () => { await Promise.all(stores.map(store => store.close())); stores.length = 0 })

function open(domain: Domain, options: ConstructorParameters<typeof MemoryProfileStore>[4] = {}): MemoryProfileStore {
  const store = new MemoryProfileStore(domain, scope, undefined, 12_000, options); stores.push(store); return store
}

function userLine(seq: number, text: string): string {
  return JSON.stringify({ seq, time: '2026-09-19T00:00:00.000Z', type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text }] } })
}

function page(id: string, text: string, sourceSession: string): WikiPage {
  return { id, path: `wiki/concepts/${id}.md`, type: 'concept', title: text, description: text, body: text, sources: [`session:${sourceSession}`], tags: ['locker'], timestamp: '2026-09-19T00:00:00.000Z', confidence: 1, status: 'confirmed', consent: true, locked: true, version: 1, updatedAt: '2026-09-19T00:00:00.000Z' }
}

describe('L0 evidence disclosure precedence', () => {
  it('keeps suspended classifications fail-closed, loosens only genuinely unclassified evidence, and skips policy cues', async () => {
    const classifiedDomain = new Domain()
    const classified = open(classifiedDomain, { evidenceClassification: true, unclassifiedEvidenceDisclosure: 'user_explicit_only' })
    await classified.appendSessionEvent('classified-sensitive', userLine(1, '我的私密病历编号是 S-200'))
    await classified.appendSessionEvent('classified-provisional', userLine(1, '我的储物柜编号是 B-417'))

    const classifierOff = open(classifiedDomain, { evidenceClassification: false, unclassifiedEvidenceDisclosure: 'user_explicit_only' })
    await classifierOff.waitReady()
    expect(classifierOff.evidenceClassificationCounts('classified-sensitive')).toEqual({ normal: 0, provisional_sensitive: 0, sensitive: 1, unclassified: 0 })
    expect(classifierOff.evidenceClassificationCounts('classified-provisional')).toEqual({ normal: 0, provisional_sensitive: 0, sensitive: 1, unclassified: 0 })
    for (const query of ['你还记得我的私密病历编号 S-200 吗？', '你还记得我的储物柜编号 B-417 吗？']) {
      const response = await classifierOff.recall(query)
      const evidence = response.results.find(result => result.sourceType === 'evidence')
      expect(evidence).toMatchObject({ mentionDecision: 'silent_use', text: '' })
      expect(renderRecallContext(response.results)).not.toMatch(/S-200|B-417/)
    }

    const unclassified = open(new Domain(), { evidenceClassification: false, unclassifiedEvidenceDisclosure: 'user_explicit_only' })
    const unclassifiedText = 'unclassified locker U-404'
    await unclassified.appendSessionEvent('unclassified-session', userLine(1, unclassifiedText))
    const explicit = await unclassified.recall('你还记得 unclassified locker U-404 吗？')
    expect(explicit.results.find(result => result.sourceType === 'evidence')).toMatchObject({ mentionDecision: 'explicit', text: expect.stringContaining(unclassifiedText) })

    const policyDomain = new Domain()
    const policyStore = open(policyDomain, { evidenceClassification: false, unclassifiedEvidenceDisclosure: 'user_explicit_only' })
    const topic = 'orchid private hobby'
    await policyStore.appendSessionEvent('policy-session', userLine(1, topic))
    await policyStore.upsertManualPage(page('policy-page', topic, 'policy-session'))
    await policyStore.appendSessionEvent('policy-session', userLine(2, `不要再主动提 ${topic}`))
    const policyPage = policyStore.snapshot().pages?.find(value => value.title === topic)
    if (policyPage === undefined) throw new Error('policy page was not persisted')
    expect(await policyStore.suppressCanonical(policyPage.id, 'user-requested-suppression')).toBe(true)
    const suppressionAudit = policyStore.listAudits().find(audit => audit.event === 'canonical-suppressed')
    expect(suppressionAudit?.detail?.policyEvidenceRefs).toEqual(['session:policy-session/event:2'])

    const restarted = open(policyDomain, { evidenceClassification: false, unclassifiedEvidenceDisclosure: 'user_explicit_only' })
    await restarted.waitReady()
    const policyQuery = `你还记得 不要再主动提 ${topic} 吗？`
    const suppressed = await restarted.recall(policyQuery)
    expect(suppressed.results.some(result => result.sourceRefs.includes('session:policy-session/event:2'))).toBe(false)
    expect(renderRecallContext(suppressed.results)).not.toContain('不要再主动提')

    expect(await restarted.restoreCanonical(policyPage.id, 'user-requested-restore')).toBe(true)
    const restored = await restarted.recall(policyQuery)
    expect(restored.results.some(result => result.sourceRefs.includes('session:policy-session/event:2') && result.text.includes('不要再主动提'))).toBe(true)

    expect(await restarted.suppressCanonical(policyPage.id, 'user-requested-suppression')).toBe(true)
    const purgePlan = restarted.purgePlan('policy-session')
    expect(await restarted.purgeSession('policy-session', { confirmation: purgePlan.confirmation })).toBe(true)
    const afterPurge = open(policyDomain, { evidenceClassification: false, unclassifiedEvidenceDisclosure: 'user_explicit_only' })
    await afterPurge.waitReady()
    expect(await afterPurge.sessionEvidence('policy-session')).toBeUndefined()
    expect((await afterPurge.recall(policyQuery)).results).toEqual([])
  })
})
