/* oxlint-disable @stylistic/max-len */
/** Keyless companion comparison of deterministic dense recall against the lexical baseline. */
import { beforeAll, describe, expect, it } from 'vitest'
import { companionCorpus } from './support/companion-corpus.ts'
import { runDenseAblation, type DenseAblationRun, type RawOutcome } from './support/companion-runner.ts'
import { aggregateDenseAblationMetrics, type Metric } from './support/evaluation-metrics.ts'

let ablation: DenseAblationRun
let metrics: Record<string, Metric>

beforeAll(async () => {
  ablation = await runDenseAblation()
  metrics = aggregateDenseAblationMetrics(ablation)
  console.log(`Dense ablation raw results: off=${ablation.denseOff.path} on=${ablation.denseOn.path}`)
  console.log(`Dense ablation metrics: ${JSON.stringify(metrics, null, 2)}`)
}, 240_000)

function executed(outcomes: readonly RawOutcome[]): RawOutcome[] {
  return outcomes.filter(outcome => outcome.status === 'executed')
}

function expectMeasured(metric: Metric): void {
  expect(metric.status).toBe('measured')
  expect(metric.value).not.toBeNull()
  expect(metric.reason).toBeUndefined()
  expect(metric.denominator).toBeGreaterThan(0)
  expect(metric.numerator).toBeGreaterThanOrEqual(0)
  expect(metric.numerator).toBeLessThanOrEqual(metric.denominator)
  expect(metric.value).toBeCloseTo(metric.numerator / metric.denominator, 12)
}

describe('deterministic dense recall ablation', () => {
  it('runs the same corpus scenarios in both trials without execution errors', () => {
    expect(ablation.denseOff.outcomes).toHaveLength(companionCorpus.length)
    expect(ablation.denseOn.outcomes).toHaveLength(companionCorpus.length)
    expect(executed(ablation.denseOff.outcomes)).toHaveLength(27)
    expect(executed(ablation.denseOn.outcomes)).toHaveLength(27)
    expect(ablation.denseOff.outcomes.some(outcome => outcome.status === 'error')).toBe(false)
    expect(ablation.denseOn.outcomes.some(outcome => outcome.status === 'error')).toBe(false)
  })

  it('actually changes dense retrieval while keeping the provider keyless', () => {
    const offDenseCandidates = executed(ablation.denseOff.outcomes).reduce((sum, outcome) => sum + (outcome.trace?.candidatesByChannel.dense ?? 0), 0)
    const onDenseCandidates = executed(ablation.denseOn.outcomes).reduce((sum, outcome) => sum + (outcome.trace?.candidatesByChannel.dense ?? 0), 0)
    expect(offDenseCandidates).toBe(0)
    expect(onDenseCandidates).toBe(9)
  })

  it('reports the two supported rates from raw injected candidates', () => {
    expectMeasured(metrics.denseUniqueRecallGain!)
    expectMeasured(metrics.denseNoiseRate!)
    expect(metrics.denseUniqueRecallGain!.numerator).toBe(0)
    expect(metrics.denseUniqueRecallGain!.denominator).toBe(16)
    expect(metrics.denseUniqueRecallGain!.value).toBe(0)
    expect(metrics.denseNoiseRate!.numerator).toBe(2)
    expect(metrics.denseNoiseRate!.denominator).toBe(9)
    expect(metrics.denseNoiseRate!.value).toBeCloseTo(2 / 9, 12)
    expect(metrics.denseUniqueRecallGain!.scenarios).toHaveLength(metrics.denseUniqueRecallGain!.denominator)
    expect(metrics.denseNoiseRate!.scenarios).toHaveLength(metrics.denseNoiseRate!.denominator)
  })

  it('attributes dense gate rejection per candidate through RecallTrace gate decisions', () => {
    const metric = metrics.denseGateRejectionRate!
    expectMeasured(metric)
    expect(metric.numerator).toBe(0)
    expect(metric.denominator).toBe(9)
    expect(metric.value).toBe(0)
    expect(metric.scenarios).toHaveLength(metric.denominator)
  })
})
