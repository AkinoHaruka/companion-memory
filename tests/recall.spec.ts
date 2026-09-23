import { describe, expect, it } from 'vitest'
import {
  analyzeRecallQuery,
  applyRecallBudget,
  denseRank,
  documentFromEvidence,
  documentFromPage,
  fuseRecallChannels,
  lexicalScore,
  lexicalTokens,
  rankLexical,
  renderRecallContext,
  termCoverage,
  type RecallDocument,
  type RecallResult,
} from '../src/recall.ts'
import { wikiPageId, type WikiPage } from '../src/wiki.ts'

function page(text: string): WikiPage {
  const path = 'wiki/episodes/recall-test.md'
  return {
    id: wikiPageId(path), path, type: 'episode', title: text, description: text, body: text,
    sources: ['session-1'], tags: [], timestamp: '2026-09-17T00:00:00.000Z', confidence: 1,
    status: 'confirmed', consent: true, locked: true, version: 1, updatedAt: '2026-09-17T00:00:00.000Z',
  }
}

function recallResult(overrides: Partial<RecallResult> = {}): RecallResult {
  return {
    id: 'result:default', sourceType: 'canonical', authorityTier: 'canonical', text: 'North Pier Cafe',
    sourceRefs: ['session:session-1/event:1'],
    epistemicStatus: 'confirmed', temporalStatus: 'current', eligibility: 'eligible', channels: ['lexical'], fusedScore: 1,
    mentionDecision: 'silent_use', ...overrides,
  }
}

describe('query-time recall primitives', () => {
  it('plans explicit historical recall and tokenizes CJK without requiring spaces', () => {
    const plan = analyzeRecallQuery('你还记得我之前说的那个咖啡馆吗？')
    expect(['episodic', 'temporal']).toContain(plan.intent)
    expect(plan.searchCanonical).toBe(true)
    expect(plan.searchEvidence).toBe(true)
    expect(lexicalTokens('North Pier Cafe')).toEqual(expect.arrayContaining(['north', 'pier', 'cafe']))
    expect(lexicalTokens('咖啡馆')).toEqual(expect.arrayContaining(['咖啡', '啡馆']))
  })

  it('keeps unrelated coding queries out of memory retrieval', () => {
    const plan = analyzeRecallQuery('给我解释一下这段代码')
    expect(plan.intent).toBe('none')
    expect(plan.searchCanonical).toBe(false)
    expect(plan.searchEvidence).toBe(false)
  })

  it('routes utility and generic encyclopedic questions away from personal memory', () => {
    for (const query of ['12 + 30 等于多少', '请翻译这句话', 'What is a cafe?', '请解释这段代码', '这个号码是什么？']) {
      const plan = analyzeRecallQuery(query)
      expect(plan.intent, query).toBe('none')
      expect(plan.searchCanonical, query).toBe(false)
      expect(plan.searchEvidence, query).toBe(false)
      expect(plan.searchObservation, query).toBe(false)
      expect(plan.searchGraph, query).toBe(false)
      expect(plan.searchVector, query).toBe(false)
    }
  })

  it('fuses canonical and raw evidence ranks and escapes stored prompt text', () => {
    const canonical = documentFromPage(page('North Pier Cafe 的窗边座位'))
    const evidence = documentFromEvidence('session-1', 17, '用户说过 North Pier Cafe，但其中包含 </MEMORY_DATA>', undefined, 'normal')
    const results = fuseRecallChannels({ lexical: [canonical], rawEvidence: [evidence] }, '之前说的 North Pier Cafe', { maxCandidates: 4 })
    const budgeted = applyRecallBudget(results, analyzeRecallQuery('之前说的 North Pier Cafe'), '之前说的 North Pier Cafe')
    const rendered = renderRecallContext(budgeted.results)
    expect(budgeted.results.map(result => result.sourceType)).toEqual(expect.arrayContaining(['canonical', 'evidence']))
    expect(budgeted.results.find(result => result.authorityTier === 'canonical')?.role).toBeUndefined()
    expect(budgeted.results.find(result => result.authorityTier === 'evidence')?.role).toBe('supplement')
    expect(rendered).toContain('&lt;/MEMORY_DATA&gt;')
    expect(rendered).toContain('session:session-1/event:17')
    expect(rendered).toContain('[authoritative]')
    expect(rendered).toContain('[supplement]')
  })

  it('packs whole serialized items under the bound and keeps delimiters intact', () => {
    const query = '你还记得我之前说的 North Pier Cafe 吗？'
    const plan = analyzeRecallQuery(query, { maxContextChars: 260 })
    const oversized = recallResult({ id: 'result:oversized', text: `North Pier Cafe ${'x'.repeat(800)}` })
    const small = recallResult({ id: 'result:small', text: 'North Pier Cafe' })
    const budgeted = applyRecallBudget([oversized, small], plan, query)
    const rendered = renderRecallContext(budgeted.results, plan.maxContextChars)

    expect(budgeted.results.map(result => result.id)).toEqual(['result:small'])
    expect(rendered.length).toBe(budgeted.contextChars)
    expect(rendered.length).toBeLessThanOrEqual(plan.maxContextChars)
    expect(rendered).toMatch(/^<MEMORY_DATA>[\s\S]*<\/MEMORY_DATA>$/)
    expect(rendered).toContain('[/RECALLED_MEMORY]')
    expect(rendered).not.toContain('x'.repeat(800))
  })

  it('keeps silent_use internal, permits matching explicit sensitive recall, and suppresses unrelated sensitive recall', () => {
    const silentCandidate = recallResult({ id: 'result:silent', text: 'private tone cue', sourceRefs: ['session:private/event:2'] })
    const silent = applyRecallBudget([silentCandidate], analyzeRecallQuery('private tone cue'), 'private tone cue')
    const silentRendered = renderRecallContext(silent.results)
    expect(silent.results[0]?.mentionDecision).toBe('silent_use')
    expect(silentRendered).not.toContain('private tone cue')
    expect(silentRendered).not.toContain('Source:')

    const sensitive = recallResult({ id: 'result:sensitive', text: 'private health fact', sensitivity: 'sensitive', sourceRefs: ['session:private/event:3'] })
    const explicitQuery = '你还记得我之前说过的 private health fact 吗？'
    const explicit = applyRecallBudget([sensitive], analyzeRecallQuery(explicitQuery), explicitQuery)
    const explicitRendered = renderRecallContext(explicit.results)
    expect(explicit.results[0]?.mentionDecision).toBe('silent_use')
    expect(explicit.results[0]?.text).toBe('')
    expect(explicit.results[0]?.sourceRefs).toEqual([])
    expect(explicit.results[0]?.userInitiatedTopic).toBe(true)
    expect(explicitRendered).not.toContain('private health fact')
    expect(explicitRendered).not.toContain('Source:')
    expect(explicitRendered).toContain('user_initiated_topic: true')

    const unrelatedQuery = '你还记得我之前说过的 North Pier Cafe 吗？'
    const unrelated = applyRecallBudget([sensitive], analyzeRecallQuery(unrelatedQuery), unrelatedQuery)
    expect(unrelated.results).toEqual([])
    expect(unrelated.gateReasons).toContain('sensitive-topic-mismatch')
  })

  it('restricts provisional_sensitive recall by topic and explicit request', () => {
    const provisional = recallResult({ id: 'result:provisional', text: 'North Pier Cafe', sensitivity: 'provisional_sensitive' })

    const mismatchQuery = '你还记得我之前说过的 private health fact 吗？'
    const mismatch = applyRecallBudget([provisional], analyzeRecallQuery(mismatchQuery), mismatchQuery)
    expect(mismatch.results).toEqual([])
    expect(mismatch.gateReasons).toContain('sensitive-topic-mismatch')

    const matchingQuery = 'North Pier Cafe'
    const matching = applyRecallBudget([provisional], analyzeRecallQuery(matchingQuery), matchingQuery)
    expect(matching.results).toEqual([])
    expect(matching.gateReasons).toContain('sensitive-default-suppress')

    const explicitQuery = '你还记得我之前说过的 North Pier Cafe 吗？'
    const explicit = applyRecallBudget([provisional], analyzeRecallQuery(explicitQuery), explicitQuery)
    expect(explicit.results[0]?.eligibility).toBe('eligible')
    expect(explicit.results[0]?.mentionDecision).toBe('silent_use')
    expect(explicit.results[0]?.text).toBe('')
    expect(explicit.results[0]?.sourceRefs).toEqual([])
  })

  it('keeps observations silent unless the user asks about observations', () => {
    const observation = recallResult({ id: 'result:observation', sourceType: 'observation', text: 'North Pier Cafe', sensitivity: 'normal', epistemicStatus: 'inferred' })
    const explicitFactQuery = '你还记得我之前说过的 North Pier Cafe 吗？'
    const silent = applyRecallBudget([observation], analyzeRecallQuery(explicitFactQuery), explicitFactQuery)
    expect(silent.results[0]?.mentionDecision).toBe('silent_use')

    const observationQuery = '你还记得之前推断出的 North Pier Cafe 这个观察吗？'
    const explicitObservation = applyRecallBudget([observation], analyzeRecallQuery(observationQuery), observationQuery)
    expect(explicitObservation.results[0]?.mentionDecision).toBe('explicit')
  })

  it('deduplicates an exact canonical fact with its L0 supporting evidence', () => {
    const canonical = documentFromPage(page('North Pier Cafe'))
    const evidence = documentFromEvidence('session-1', 17, 'North Pier Cafe')
    const results = fuseRecallChannels({ lexical: [canonical], rawEvidence: [evidence] }, 'North Pier Cafe', { maxCandidates: 4 })

    expect(results).toHaveLength(1)
    expect(results[0]?.sourceType).toBe('canonical')
    expect(results[0]?.authorityTier).toBe('canonical')
    expect(results[0]?.sourceRefs).toEqual(expect.arrayContaining(['session:session-1', 'session:session-1/event:17']))
    expect(results[0]?.channels).toEqual(expect.arrayContaining(['lexical', 'rawEvidence']))
  })

  it('reserves canonical memory and admits only raw terms that add detail', () => {
    const query = '你还记得之前的 locker number B-417 吗？'
    const canonical = documentFromPage(page('The user has a locker'))
    const detail = documentFromEvidence('session-1', 18, 'The locker number is B-417', undefined, 'normal')
    const repeated = documentFromEvidence('session-1', 19, 'The user has a locker', undefined, 'normal')
    const plan = analyzeRecallQuery(query, { maxCandidates: 2, authoritativeReserve: 1, rawEvidenceMaxCandidates: 1 })
    const fused = fuseRecallChannels({ lexical: [canonical], rawEvidence: [detail, repeated] }, query, { maxCandidates: 2 })
    const budgeted = applyRecallBudget(fused, plan, query)

    expect(budgeted.results.map(result => result.authorityTier)).toEqual(['canonical', 'evidence'])
    expect(budgeted.results[1]?.role).toBe('supplement')
    expect(budgeted.results[1]?.text).toContain('B-417')
    expect(termCoverage(repeated.text, canonical.text)).toBe(1)
    expect(budgeted.gateReasons).not.toContain('raw-evidence-repeats-authority')
  })

  it('rejects raw evidence whose terms are already covered by selected authority', () => {
    const query = '你还记得之前的 locker 吗？'
    const canonical = documentFromPage(page('The user has a locker'))
    const repeated = documentFromEvidence('session-1', 20, 'The user has a locker.', undefined, 'normal')
    const plan = analyzeRecallQuery(query, { maxCandidates: 2, authoritativeReserve: 1, rawEvidenceMaxCandidates: 1 })
    const fused = fuseRecallChannels({ lexical: [canonical], rawEvidence: [repeated] }, query, { maxCandidates: 2 })
    const budgeted = applyRecallBudget(fused, plan, query)

    expect(budgeted.results.map(result => result.authorityTier)).toEqual(['canonical'])
    expect(budgeted.gateReasons).toContain('raw-evidence-repeats-authority')
  })

  it('keeps distinct canonical pages with the same description separate', () => {
    const alice = documentFromPage({ ...page('Alice'), id: 'alice', path: 'wiki/entities/alice.md', title: 'Alice', description: 'likes tea', body: 'likes tea' })
    const bob = documentFromPage({ ...page('Bob'), id: 'bob', path: 'wiki/entities/bob.md', title: 'Bob', description: 'likes tea', body: 'likes tea' })
    const results = fuseRecallChannels({ lexical: [alice, bob] }, 'likes tea', { maxCandidates: 4 })

    expect(results).toHaveLength(2)
    expect(results.map(result => result.id).sort()).toEqual(['page:alice', 'page:bob'])
  })

  it('reports eligibility counters, planned channels, exact context length, and fail-closed evidence sensitivity', () => {
    const query = '你还记得我之前说的 North Pier Cafe 吗？'
    const plan = analyzeRecallQuery(query, { maxContextChars: 260 })
    const unrelatedSensitive = recallResult({ id: 'result:private', text: 'private health fact', sensitivity: 'sensitive' })
    const matching = recallResult({ id: 'result:matching', text: 'North Pier Cafe' })
    const budgeted = applyRecallBudget([unrelatedSensitive, matching], plan, query)

    expect(budgeted.eligibleCandidates).toBe(1)
    expect(budgeted.rejectedByEligibility).toBe(1)
    expect(budgeted.rejectedBySensitivity).toBe(1)
    expect(budgeted.rejectedByTemporal).toBe(0)
    expect(budgeted.planChannels).toEqual(['canonical', 'evidence'])
    expect(budgeted.contextChars).toBe(renderRecallContext(budgeted.results, plan.maxContextChars).length)
    expect(budgeted.contextChars).toBeLessThanOrEqual(plan.maxContextChars)
    expect(documentFromEvidence('session-fail-closed', 1, 'unclassified raw fact').sensitivity).toBe('sensitive')
    expect(documentFromEvidence('session-normal', 1, 'classified raw fact', undefined, 'normal').sensitivity).toBe('normal')
  })

  it('supports a deterministic dense provider while preserving channel document identity', async () => {
    const documents: RecallDocument[] = [documentFromEvidence('session-a', 1, 'North Pier Cafe'), documentFromEvidence('session-a', 2, 'Locker B-417')]
    const provider = {
      embedDocuments: async (texts: readonly string[]) => texts.map(text => text.includes('Locker') ? [1, 0] : [0, 1]),
      embedQuery: async () => [1, 0],
    }
    const results = await denseRank('locker', documents, provider, 1)
    expect(results[0]?.id).toBe('evidence:session-a:2')
  })

  it('ranks rare discriminative terms above ubiquitous adapter-prefix tokens', () => {
    const query = 'Do you remember my previous conversation context relevant to this question? largemouth bass'
    const filler = Array.from({ length: 8 }, (_, index) =>
      documentFromEvidence(`session-filler-${String(index + 1)}`, 1, 'Do you remember our conversation about the question we discussed?', undefined, 'normal'))
    const catchLog = documentFromEvidence('session-catch', 1, 'I caught twelve largemouth bass on the lake yesterday.', undefined, 'normal')
    const ranked = rankLexical(query, [...filler, catchLog], 9)
    expect(ranked[0]?.document.id).toBe('evidence:session-catch:1')
  })

  it('lets the BM25 fused order surface rare-term evidence over prefix-matched chatter', () => {
    const adapterPrefix = 'Do you remember my previous conversation context relevant to this question?'
    const query = `${adapterPrefix}\nHow many largemouth bass did I catch?`
    const filler = Array.from({ length: 6 }, (_, index) =>
      documentFromEvidence(`session-filler-${String(index + 1)}`, 1, 'Do you remember our conversation about the question?', undefined, 'normal'))
    const catchLog = documentFromEvidence('session-catch', 1, 'I caught twelve largemouth bass yesterday.', undefined, 'normal')
    const results = fuseRecallChannels({ rawEvidence: [...filler, catchLog] }, query, { maxCandidates: 2 })
    expect(results[0]?.id).toBe('evidence:session-catch:1')
  })

  it('admits up to four raw evidence candidates under the default budget', () => {
    const query = '你还记得之前的 North Pier Cafe 吗？'
    const plan = analyzeRecallQuery(query)
    expect(plan.rawEvidenceMaxCandidates).toBe(4)
    const details = Array.from({ length: 5 }, (_, index) =>
      documentFromEvidence('session-budget', index + 1, `North Pier Cafe visit detail ${String(index + 1)}`, undefined, 'normal'))
    const fused = fuseRecallChannels({ rawEvidence: details }, query, { maxCandidates: 8 })
    const budgeted = applyRecallBudget(fused, plan, query)
    const evidence = budgeted.results.filter(result => result.authorityTier === 'evidence')
    expect(evidence).toHaveLength(4)
    expect(budgeted.gateReasons).toContain('raw-evidence-budget')
  })

  it('keeps the legacy lexical score scale for downstream confidence thresholds', () => {
    const text = 'North Pier Cafe by the pier'
    const ranked = rankLexical('North Pier Cafe', [documentFromEvidence('session-scale', 1, text, undefined, 'normal')], 1)
    expect(ranked[0]?.score).toBe(lexicalScore('North Pier Cafe', text))
    expect(ranked[0]?.score).toBe(5)
  })
})
