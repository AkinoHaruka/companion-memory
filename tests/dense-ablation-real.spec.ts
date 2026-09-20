/* oxlint-disable @stylistic/max-len */
/**
 * Real-embedding dense ablation against a loopback OpenAI-compatible endpoint.
 *
 * Opt-in: only runs when `DSH_MEMORY_BGE_ENDPOINT` is set (for example
 * `http://127.0.0.1:17653/v1/embeddings`, served by a local BGE process). The regular CI
 * suite keeps using the keyless deterministic ablation in `dense-ablation.spec.ts`; this
 * spec exists to answer one question — does a real semantic embedding model produce
 * unique recall gain over the lexical baseline, and at what noise rate?
 *
 * Assertions here are structural on purpose. The measured rates are the *finding* of each
 * run (printed as JSON), not regression invariants: pinning a real model's recall numbers
 * would make every model or corpus tweak a test failure for the wrong reason.
 */
import { beforeAll, describe, expect, it } from 'vitest'
import { companionCorpus } from './support/companion-corpus.ts'
import { runDenseAblationWithProvider, type DenseAblationRun, type RawOutcome } from './support/companion-runner.ts'
import { aggregateDenseAblationMetrics, type Metric } from './support/evaluation-metrics.ts'

const endpoint = process.env.DSH_MEMORY_BGE_ENDPOINT

let ablation: DenseAblationRun
let metrics: Record<string, Metric>

describe.skipIf(endpoint === undefined)('real dense recall ablation (BGE-small-zh-v1.5 via openai-compatible provider)', () => {
  beforeAll(async () => {
    ablation = await runDenseAblationWithProvider({
      endpoint: endpoint!,
      model: process.env.DSH_MEMORY_BGE_MODEL ?? 'BAAI/bge-small-zh-v1.5',
      credentialRef: 'DSH_MEMORY_BGE_KEY',
    })
    metrics = aggregateDenseAblationMetrics(ablation)
    console.log(`BGE dense ablation raw results: off=${ablation.denseOff.path} on=${ablation.denseOn.path}`)
    console.log(`BGE dense ablation metrics: ${JSON.stringify(metrics, null, 2)}`)
  }, 600_000)

  function executed(outcomes: readonly RawOutcome[]): RawOutcome[] {
    return outcomes.filter(outcome => outcome.status === 'executed')
  }

  it('runs the same corpus scenarios in both trials without execution errors', () => {
    const executableCorpusLength = companionCorpus.filter(scenario => scenario.unsupported === undefined).length
    expect(ablation.denseOff.outcomes).toHaveLength(companionCorpus.length)
    expect(ablation.denseOn.outcomes).toHaveLength(companionCorpus.length)
    expect(executed(ablation.denseOff.outcomes)).toHaveLength(executableCorpusLength)
    expect(executed(ablation.denseOn.outcomes)).toHaveLength(executableCorpusLength)
    expect(ablation.denseOff.outcomes.some(outcome => outcome.status === 'error')).toBe(false)
    expect(ablation.denseOn.outcomes.some(outcome => outcome.status === 'error')).toBe(false)
  })

  it('routes dense candidates through the real endpoint while the baseline stays lexical', () => {
    const offDenseCandidates = executed(ablation.denseOff.outcomes).reduce((sum, outcome) => sum + (outcome.trace?.candidatesByChannel.dense ?? 0), 0)
    const onDenseCandidates = executed(ablation.denseOn.outcomes).reduce((sum, outcome) => sum + (outcome.trace?.candidatesByChannel.dense ?? 0), 0)
    expect(offDenseCandidates).toBe(0)
    expect(onDenseCandidates).toBeGreaterThan(0)
  })

  it('reports every dense metric measured from real candidate flow', () => {
    for (const [name, metric] of Object.entries(metrics)) {
      if (metric.status !== 'measured') continue
      expect(metric.value, name).not.toBeNull()
      expect(metric.numerator, name).toBeGreaterThanOrEqual(0)
      expect(metric.numerator, name).toBeLessThanOrEqual(metric.denominator)
      expect(metric.value, name).toBeCloseTo(metric.numerator / metric.denominator, 12)
    }
  })

  it('attributes dense gate rejections per candidate in the trace', () => {
    const metric = metrics.denseGateRejectionRate
    if (metric?.status !== 'measured') return
    expect(metric.value).toBeCloseTo(metric.numerator / metric.denominator, 12)
  })
})
