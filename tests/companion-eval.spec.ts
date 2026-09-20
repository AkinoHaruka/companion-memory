/* oxlint-disable @stylistic/max-len */
/**
 * Appendix F corpus execution and Appendix G aggregation in one spec.
 *
 * The corpus is a real Loader/HTTP composition driven once per scenario, so it is executed
 * here exactly once per round: both assertion groups read the same in-memory observations,
 * and no group depends on an artifact a different fork may or may not have written yet.
 */
import { beforeAll, describe, expect, it } from 'vitest'
import { companionCorpus } from './support/companion-corpus.ts'
import { runCompanionCorpus, type RawOutcome } from './support/companion-runner.ts'
import { aggregateMetrics, type Metric } from './support/evaluation-metrics.ts'

/** Write-side Appendix G fields: proposal quality and the authority that gates it. */
const WRITE_SIDE = ['candidatePrecision', 'authorityViolationRate', 'semanticDriftRate', 'correctionPropagation'] as const
/** Read-side Appendix G fields: retrieval, temporal, multi-hop and deletion behaviour. */
const READ_SIDE = ['recallAtK', 'mrr', 'ndcg', 'exactDetailRecovery', 'temporalAccuracy', 'multiHopSuccess', 'negativeRecallPrecision', 'forgetLeakage', 'purgeLeakage'] as const
/** Product-side Appendix G fields plus the three named prompt-injection proxies. */
const PRODUCT_SIDE = ['falsePersonalizationRate', 'unwantedMentionRate', 'memoryOveruseRate', 'falsePersonalizationInjectionRate', 'unwantedMentionInjectionRate', 'memoryOveruseInjectionRate'] as const
/** Projection-side fields counted over returned RecallResult documents. */
const PROJECTION_SIDE = ['safeUsageProjectionRate', 'rawTextWithheldRate'] as const
const ALL_FIELDS = [...WRITE_SIDE, ...READ_SIDE, ...PRODUCT_SIDE, ...PROJECTION_SIDE]
const LEGACY_FIELD_COUNT = 19
/** Fields whose subject has no live surface in this Loader fixture, so they stay explicitly unsupported. */
const UNMEASURABLE = ['semanticDriftRate', 'falsePersonalizationRate', 'unwantedMentionRate', 'memoryOveruseRate'] as const
/** Supported scenarios carrying one binary relevant target each, in corpus order. */
const RANKING_SCENARIOS = ['F.04', 'F.05', 'F.06', 'F.07', 'F.08', 'F.18', 'F.19', 'F.20', 'F.26', 'F.29'] as const
/** The only fields that rank or recover F.05's exact number now that its L0 channel is observable. */
const F05_FIELDS: readonly string[] = ['recallAtK', 'mrr', 'ndcg', 'exactDetailRecovery', ...PROJECTION_SIDE]

let outcomes: RawOutcome[]
let metrics: Record<string, Metric>

beforeAll(async () => {
  const run = await runCompanionCorpus()
  outcomes = run.outcomes
  metrics = aggregateMetrics(outcomes)
  console.log(`Companion raw results: ${run.path}`)
  console.log(`Appendix G metrics: ${JSON.stringify(metrics, null, 2)}`)
}, 180_000)

describe('Appendix F companion corpus', () => {
  it.each(companionCorpus)('$id $category — $expected.label', (scenario) => {
    const raw = outcomes.find(value => value.scenario.id === scenario.id)!
    if (scenario.unsupported !== undefined) {
      expect(raw.status).toBe('unsupported')
      expect(raw.reason).toBe(scenario.unsupported)
      return
    }
    expect(raw.status, raw.reason).toBe('executed')
    expect(raw.observedLabel, JSON.stringify(raw.checks)).toBe(scenario.expected.label)
    expect(Object.values(raw.checks).every(Boolean), JSON.stringify(raw.checks)).toBe(true)
  })
})

/** Read one persisted observation by corpus identifier. */
function row(id: string): RawOutcome {
  const found = outcomes.find(outcome => outcome.scenario.id === id)
  if (found === undefined) throw new Error(`no persisted observation for ${id}`)
  return found
}

/** Copy the corpus results with one boolean check overridden on a single scenario. */
function withCheck(id: string, check: string, value: boolean): RawOutcome[] {
  return outcomes.map(outcome => outcome.scenario.id === id
    ? { ...outcome, checks: { ...outcome.checks, [check]: value } }
    : outcome)
}

/** Copy the corpus results with injected and resident text appended to a single scenario. */
function withDisclosure(id: string, text: string): RawOutcome[] {
  return outcomes.map(outcome => outcome.scenario.id === id
    ? { ...outcome, injected: outcome.injected + text, resident: outcome.resident + text }
    : outcome)
}

/** Copy the corpus results with one status overridden on a single scenario. */
function withStatus(id: string, status: RawOutcome['status']): RawOutcome[] {
  return outcomes.map(outcome => outcome.scenario.id === id ? { ...outcome, status } : outcome)
}

/** Assert the shared contract every measured field must satisfy. */
function expectMeasured(metric: Metric, label: string): void {
  expect(metric.status, label).toBe('measured')
  expect(metric.value, label).not.toBeNull()
  expect(metric.reason, label).toBeUndefined()
  expect(metric.denominator, label).toBeGreaterThan(0)
  expect(metric.numerator, label).toBeGreaterThanOrEqual(0)
  expect(metric.numerator, label).toBeLessThanOrEqual(metric.denominator)
  expect(metric.value, label).toBeCloseTo(metric.numerator / metric.denominator, 12)
  expect(metric.scenarios.length, label).toBe(metric.denominator)
  expect(metric.scope.trim().length, label).toBeGreaterThan(0)
  expect(metric.value, label).toBeGreaterThanOrEqual(0)
  expect(metric.value, label).toBeLessThanOrEqual(1)
}

/** Assert the shared contract every unmeasured field must satisfy. */
function expectUnmeasured(metric: Metric, label: string): void {
  expect(metric.status, label).toBe('unsupported')
  expect(metric.value, label).toBeNull()
  expect(metric.numerator, label).toBe(0)
  expect(metric.denominator, label).toBe(0)
  expect(metric.scenarios, label).toEqual([])
  expect(metric.scope, label).toBe('not measured')
  expect(metric.reason?.trim().length ?? 0, label).toBeGreaterThan(0)
}

/** Rank of the single relevant target inside one scenario's returned results, zero when absent. */
function liveRank(id: string): number {
  const outcome = row(id)
  const target = outcome.scenario.expected.contains
  if (target === undefined) throw new Error(`no relevance judgment for ${id}`)
  const index = outcome.results.findIndex(result => result.text.includes(target))
  return index < 0 ? 0 : index + 1
}

describe('Appendix G aggregate metrics', () => {
  it('produces every Appendix G write-side, read-side and product-side field', () => {
    for (const name of ALL_FIELDS) expect(Object.hasOwn(metrics, name), name).toBe(true)
    expect(Object.keys(metrics).sort()).toEqual([...ALL_FIELDS].sort())
    expect(WRITE_SIDE.length + READ_SIDE.length + PRODUCT_SIDE.length + PROJECTION_SIDE.length).toBe(ALL_FIELDS.length)
    expect(LEGACY_FIELD_COUNT).toBe(19)
    expect(ALL_FIELDS.length).toBe(21)
  })

  it('keeps each measurement arithmetically consistent with its own numerator and denominator', () => {
    const unmeasurable = new Set<string>(UNMEASURABLE)
    for (const name of ALL_FIELDS) {
      const metric = metrics[name]!
      if (unmeasurable.has(name)) expectUnmeasured(metric, name)
      else expectMeasured(metric, name)
    }
  })

  it('attributes every contributing scenario to a genuinely executed corpus case', () => {
    const known = new Set(companionCorpus.map(scenario => scenario.id))
    const executed = new Set(outcomes.filter(outcome => outcome.status === 'executed').map(outcome => outcome.scenario.id))
    const skipped = new Set(outcomes.filter(outcome => outcome.status !== 'executed').map(outcome => outcome.scenario.id))
    expect(skipped.size).toBeGreaterThan(0)
    for (const name of ALL_FIELDS) {
      for (const id of metrics[name]!.scenarios) {
        expect(known.has(id), `${name} cites unknown ${id}`).toBe(true)
        expect(executed.has(id), `${name} cites unexecuted ${id}`).toBe(true)
        expect(skipped.has(id), `${name} cites skipped ${id}`).toBe(false)
      }
    }
  })

  it('keeps unsupported cases out of every denominator and a newly supported case only in the fields that score it', () => {
    const unsupported = companionCorpus.filter(scenario => scenario.unsupported !== undefined).map(scenario => scenario.id)
    expect(unsupported).toEqual(['F.21', 'F.22', 'F.28', 'F.30'])
    for (const scenario of companionCorpus.filter(value => value.unsupported !== undefined)) expect(row(scenario.id).reason, scenario.id).toBe(scenario.unsupported)
    const exactNumber = row('F.05')
    expect(exactNumber.status).toBe('executed')
    expect(exactNumber.reason).toBeUndefined()
    expect(exactNumber.results.some(result => result.sourceType === 'evidence' && result.mentionDecision === 'explicit')).toBe(true)
    expect(metrics.recallAtK!.scenarios).toEqual(RANKING_SCENARIOS)
    expect(metrics.exactDetailRecovery!.scenarios).toEqual(['F.05', 'F.06'])
    for (const name of ALL_FIELDS) expect(metrics[name]!.scenarios.includes('F.05'), name).toBe(F05_FIELDS.includes(name))
  })

  it('scores recall, MRR and NDCG from the returned live results', () => {
    for (const id of RANKING_SCENARIOS) expect(liveRank(id), id).toBe(1)
    for (const name of ['recallAtK', 'mrr', 'ndcg'] as const) {
      const metric = metrics[name]!
      expectMeasured(metric, name)
      expect(metric.denominator, name).toBe(RANKING_SCENARIOS.length)
      expect(metric.value, name).toBeCloseTo(1, 12)
    }
    expect(metrics.recallAtK!.scope).toContain('Recall@8')
  })

  it('scores candidate, correction, temporal, exact-detail and multi-hop fields from live checks', () => {
    const candidates = row('F.03').snapshot!.candidates
    const worthy = candidates.filter(candidate => row('F.03').scenario.candidateJudgments
      ?.find(judgment => judgment.text === candidate.page.body)?.worthKeeping === true).length
    expect(candidates.length, 'F.03 must persist extracted candidates').toBeGreaterThan(0)
    expect(metrics.candidatePrecision!.scenarios).toEqual(['F.03'])
    expect(metrics.candidatePrecision!.denominator).toBe(candidates.length)
    expect(metrics.candidatePrecision!.numerator).toBe(worthy)

    for (const [name, ids, check] of [
      ['correctionPropagation', ['F.06', 'F.08'], 'correction'],
      ['temporalAccuracy', ['F.07', 'F.26'], 'inclusion'],
    ] as const) {
      const metric = metrics[name]!
      expect(metric.scenarios, name).toEqual([...ids])
      for (const id of ids) expect(row(id).checks[check], `${id}.${check}`).toBe(true)
      expect(metric.value, name).toBeCloseTo(1, 12)
    }
    expect(metrics.exactDetailRecovery!.scenarios).toEqual(['F.05', 'F.06'])
    expect(row('F.06').injected).toContain(row('F.06').scenario.expected.contains!)
    expect(metrics.multiHopSuccess!.scenarios).toEqual(['F.29'])
    expect(row('F.29').results.some(result => result.channels.includes('graph') && result.text.includes('Kyoto'))).toBe(true)
  })

  it('reports zero authority violations for the dream and rejected remember trials', () => {
    expect(metrics.authorityViolationRate!.scenarios).toEqual(['F.03', 'F.09', 'F.10'])
    expect(metrics.authorityViolationRate!.value).toBe(0)
    expect(row('F.03').checks.authority).toBe(true)
    expect(row('F.09').toolResults[0]!.isError).toBe(true)
    expect(row('F.10').toolResults[0]!.isError).toBe(true)
    expect(metrics.falsePersonalizationInjectionRate!.scenarios).toEqual(['F.03', 'F.09', 'F.10'])
    expect(metrics.falsePersonalizationInjectionRate!.value).toBe(0)
  })

  it('reports zero forget leakage for the derived-forget trial', () => {
    const forget = row('F.15')
    expect(metrics.forgetLeakage!.scenarios).toEqual(['F.15'])
    expect(metrics.forgetLeakage!.value).toBe(0)
    expect(forget.checks.derivedLeakage).toBe(true)
    const live = JSON.stringify([forget.snapshot?.pages, forget.snapshot?.candidates, forget.resident, forget.results, forget.injected])
    expect(live).not.toContain(forget.scenario.setup.text)
  })

  it('reports zero purge leakage across live state and storage-domain files', () => {
    const purge = row('F.16')
    expect(metrics.purgeLeakage!.scenarios).toEqual(['F.16'])
    expect(metrics.purgeLeakage!.value).toBe(0)
    expect(purge.checks.derivedLeakage).toBe(true)
    expect(purge.checks.diskLeakage).toBe(true)
    expect(purge.diskMatches).toEqual([])
  })

  it('reports zero sensitive disclosure for the unsolicited mention trials', () => {
    expect(metrics.unwantedMentionInjectionRate!.scenarios).toEqual(['F.11', 'F.12'])
    expect(metrics.unwantedMentionInjectionRate!.value).toBe(0)
    expect(metrics.negativeRecallPrecision!.scenarios).toEqual(['F.11', 'F.12', 'F.14', 'F.17', 'F.25', 'F.27'])
    expect(metrics.negativeRecallPrecision!.value).toBe(1)
    for (const id of ['F.11', 'F.12'] as const) {
      expect(row(id).checks.exclusion, id).toBe(true)
      expect(row(id).injected, id).not.toContain(row(id).scenario.expected.excludes!)
    }
  })

  it('reports zero memory-overuse injection on the utility trial', () => {
    expect(metrics.memoryOveruseInjectionRate!.scenarios).toEqual(['F.27'])
    expect(metrics.memoryOveruseInjectionRate!.value).toBe(0)
    expect(row('F.27').results.length).toBe(0)
    expect(row('F.27').injected).toBe('[]')
  })

  it('marks fields with no live surface as unsupported with their own reason', () => {
    for (const name of UNMEASURABLE) expectUnmeasured(metrics[name]!, name)
    const reasons = UNMEASURABLE.map(name => metrics[name]!.reason!)
    expect(new Set(reasons).size).toBe(UNMEASURABLE.length)
  })

  it('counts persisted projections and disclosure-withheld result text from recalled documents', () => {
    for (const name of PROJECTION_SIDE) expectMeasured(metrics[name]!, name)
    const documents = outcomes.filter(outcome => outcome.status === 'executed').flatMap(outcome => outcome.results)
    expect(metrics.safeUsageProjectionRate!.denominator).toBe(documents.length)
    expect(metrics.safeUsageProjectionRate!.numerator).toBe(documents.filter(result => result.projection !== undefined).length)
    expect(metrics.rawTextWithheldRate!.numerator).toBe(documents.filter(result => result.projection !== undefined
      && result.projection.disclosure !== 'normal' && result.text.length === 0).length)
  })

  it('reacts to a violation it is fed, so the reported zeros are computed rather than constant', () => {
    expect(aggregateMetrics(withCheck('F.15', 'derivedLeakage', false)).forgetLeakage!.value).toBe(1)
    expect(aggregateMetrics(withCheck('F.16', 'diskLeakage', false)).purgeLeakage!.value).toBe(1)
    expect(aggregateMetrics(withCheck('F.09', 'authority', false)).authorityViolationRate!.value).toBeCloseTo(1 / 3, 12)
    expect(aggregateMetrics(withDisclosure('F.11', 'private health marker')).unwantedMentionInjectionRate!.value).toBeCloseTo(1 / 2, 12)
    expect(aggregateMetrics(withDisclosure('F.27', 'recalled')).memoryOveruseInjectionRate!.value).toBe(1)
    expect(aggregateMetrics(withCheck('F.09', 'authority', false)).falsePersonalizationInjectionRate!.value).toBe(0)
  })

  it('rejects incomplete executions, duplicate identifiers and invalid cutoffs', () => {
    expect(() => aggregateMetrics(outcomes, 0)).toThrow(/k must be a positive integer/)
    expect(() => aggregateMetrics(outcomes, 1.5)).toThrow(/k must be a positive integer/)
    expect(() => aggregateMetrics([...outcomes, row('F.01')])).toThrow(/Duplicate scenario identifiers/)
    expect(() => aggregateMetrics(withStatus('F.01', 'error'))).toThrow(/Cannot score incomplete executions/)
  })
})
