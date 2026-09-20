/**
 * Opt-in Appendix F campaign against the operator's Dream and final-answer providers.
 *
 * The campaign is skipped before corpus setup when a required environment variable is absent. Its metric
 * object is the measured output of the run, so the spec checks execution structure and answer coverage
 * without pinning provider-dependent rates.
 */
import { beforeAll, describe, expect, it } from 'vitest'
import { companionCorpus } from './support/companion-corpus.ts'
import { ANSWER_ENDPOINT_ENV, ANSWER_MODEL_ENV } from './support/answer-evaluation.ts'
import { DREAM_ENDPOINT_ENV, DREAM_KEY_ENV, runCompanionCorpus, type RawOutcome } from './support/companion-runner.ts'
import { aggregateMetrics, type Metric } from './support/evaluation-metrics.ts'

const dreamEndpoint = process.env[DREAM_ENDPOINT_ENV]?.trim()
const dreamKey = process.env[DREAM_KEY_ENV]?.trim()
const answerEndpoint = process.env[ANSWER_ENDPOINT_ENV]?.trim()
const answerModel = process.env[ANSWER_MODEL_ENV]?.trim()
const missing = [
  dreamEndpoint === undefined || dreamEndpoint.length === 0 ? DREAM_ENDPOINT_ENV : undefined,
  dreamKey === undefined || dreamKey.length === 0 ? DREAM_KEY_ENV : undefined,
  answerEndpoint === undefined || answerEndpoint.length === 0 ? ANSWER_ENDPOINT_ENV : undefined,
  answerModel === undefined || answerModel.length === 0 ? ANSWER_MODEL_ENV : undefined,
].filter((name): name is string => name !== undefined)

if (missing.length > 0) console.log(`Appendix G real-provider campaign skipped: missing ${missing.join(', ')}`)

let outcomes: RawOutcome[] = []
let metrics: Record<string, Metric> = {}

describe.skipIf(missing.length > 0)('Appendix G real-provider companion campaign', () => {
  beforeAll(async () => {
    if (dreamEndpoint === undefined || dreamKey === undefined) throw new Error('campaign requires a Dream endpoint and key')
    const dreamModel = process.env.DSH_MEMORY_DREAM_MODEL?.trim()
    const run = await runCompanionCorpus({
      dreamApiUrl: dreamEndpoint,
      dreamApiKey: dreamKey,
      ...(dreamModel === undefined ? {} : { dreamModel }),
    })
    outcomes = run.outcomes
    console.log(`Appendix G campaign raw results: ${run.path}`)
    const failures = outcomes.filter(outcome => outcome.status === 'error')
    for (const failure of failures) {
      console.error(`Campaign scenario ${failure.scenario.id} failed: ${failure.reason ?? 'unknown error'}`)
    }
    if (failures.length > 0) {
      const summary = failures.map(failure => `${failure.scenario.id}: ${failure.reason ?? 'unknown error'}`).join('\n')
      throw new Error(`Campaign scenario failures:\n${summary}`)
    }
    metrics = aggregateMetrics(outcomes)
    console.log(JSON.stringify(metrics, null, 2))
  }, 600_000)

  it('executes every supported case and preserves declared unsupported cases', () => {
    expect(outcomes).toHaveLength(companionCorpus.length)
    const failures = outcomes.filter(outcome => outcome.status === 'error')
    expect(failures, JSON.stringify(failures.map(outcome => outcome.reason))).toEqual([])
    for (const scenario of companionCorpus) {
      const outcome = outcomes.find(value => value.scenario.id === scenario.id)
      if (outcome === undefined) throw new Error(`missing campaign observation for ${scenario.id}`)
      if (scenario.unsupported !== undefined) {
        expect(outcome.status).toBe('unsupported')
        expect(outcome.reason).toBe(scenario.unsupported)
      } else expect(outcome.status).toBe('executed')
    }
  })

  it('measures all four answer-side fields from generated answers', () => {
    for (const name of ['semanticDriftRate', 'falsePersonalizationRate', 'unwantedMentionRate', 'memoryOveruseRate']) {
      const metric = metrics[name]
      expect(metric?.status, name).toBe('measured')
      expect(metric?.denominator, name).toBeGreaterThan(0)
    }
  })

  it('prints the complete Appendix G metric object for recording', () => {
    expect(Object.keys(metrics)).toHaveLength(21)
    for (const metric of Object.values(metrics)) {
      expect(metric.status).toBe('measured')
      expect(metric.value).not.toBeNull()
    }
  })
})
