import { describe, expect, it } from 'vitest'
import type { RecallResult } from '../src/recall.ts'
import { companionCorpus } from './support/companion-corpus.ts'
import { executeCompanion, type RawOutcome } from './support/companion-runner.ts'
import { aggregateMetrics } from './support/evaluation-metrics.ts'

function scenario(id: string) {
  const found = companionCorpus.find(value => value.id === id)
  if (found === undefined) throw new Error(`missing companion scenario ${id}`)
  return found
}

function result(
  id: string,
  text: string,
  options: Pick<RecallResult, 'projection' | 'mentionDecision'> = { mentionDecision: 'explicit' },
): RecallResult {
  return {
    id,
    sourceType: 'canonical',
    text,
    sourceRefs: [`session:${id}`],
    epistemicStatus: 'confirmed',
    temporalStatus: 'current',
    eligibility: 'eligible',
    channels: ['lexical'],
    fusedScore: 1,
    mentionDecision: options.mentionDecision,
    ...(options.projection === undefined ? {} : { projection: options.projection }),
  }
}

function outcome(id: string, answer?: string, results: readonly RecallResult[] = [], injected = ''): RawOutcome {
  return {
    scenario: scenario(id),
    status: 'executed',
    observedLabel: 'correct silence',
    injected,
    resident: '',
    results,
    checks: {},
    exchanges: [],
    toolResults: [],
    ...(answer === undefined ? {} : { answer }),
  }
}

describe('companion answer-side metrics', () => {
  it('passes the captured live injection context to an injected answer generator', async () => {
    let received: string | undefined
    const raw = await executeCompanion(scenario('F.27'), {
      answerGenerator: (request) => {
        received = request.injectedContext
        return 'synthetic final answer'
      },
    })
    expect(raw.status).toBe('executed')
    expect(raw.answer).toBe('synthetic final answer')
    expect(received).toBe(raw.injected)
  })

  it('computes exact answer numerators and denominators from synthetic answers', () => {
    const semanticMatch = result('F.04-memory', 'North Pier Cafe window seat after 16:00')
    const semanticDrift = result('F.05-memory', 'locker B-417')
    const metrics = aggregateMetrics([
      outcome('F.03', '用户可能喜欢跑步。'),
      outcome('F.09', '最近工作好累。'),
      outcome('F.10', '我可以继续讨论工作。'),
      outcome('F.11', 'private health marker'),
      outcome('F.12', '午餐可以讨论。'),
      outcome('F.27', 'personal TypeScript hobby'),
      outcome('F.04', 'North Pier Cafe is noted.', [semanticMatch], semanticMatch.text),
      outcome('F.05', 'The weather is clear.', [semanticDrift], semanticDrift.text),
    ])

    expect(metrics.falsePersonalizationRate).toMatchObject({ numerator: 1, denominator: 3, scenarios: ['F.03', 'F.09', 'F.10'] })
    expect(metrics.unwantedMentionRate).toMatchObject({ numerator: 1, denominator: 2, scenarios: ['F.11', 'F.12'] })
    expect(metrics.memoryOveruseRate).toMatchObject({ numerator: 1, denominator: 1, scenarios: ['F.27'] })
    expect(metrics.semanticDriftRate).toMatchObject({ numerator: 1, denominator: 2, scenarios: ['F.04', 'F.05'] })
  })

  it('keeps all four answer fields unsupported when no answer generator supplied an answer', () => {
    const metrics = aggregateMetrics([outcome('F.03')])
    expect(metrics.falsePersonalizationRate).toMatchObject({ status: 'unsupported', numerator: 0, denominator: 0, scenarios: [] })
    expect(metrics.unwantedMentionRate).toMatchObject({ status: 'unsupported', numerator: 0, denominator: 0, scenarios: [] })
    expect(metrics.memoryOveruseRate).toMatchObject({ status: 'unsupported', numerator: 0, denominator: 0, scenarios: [] })
    expect(metrics.semanticDriftRate).toMatchObject({ status: 'unsupported', numerator: 0, denominator: 0, scenarios: [] })
    expect(metrics.falsePersonalizationRate?.reason).toBe('No final assistant answers; injection proxy is reported separately.')
    expect(metrics.unwantedMentionRate?.reason).toBe('No final assistant answers; sensitive disclosure proxy is reported separately.')
    expect(metrics.memoryOveruseRate?.reason).toBe(
      'No final assistant answers; utility-turn dynamic injection proxy is reported separately.',
    )
    expect(metrics.semanticDriftRate?.reason).toBe(
      'No multi-round semantic consolidation provider or human equivalence judgments in the deterministic Loader fixture.',
    )
  })

  it('counts projection presence and disclosure-withheld text per recalled document', () => {
    const projection = {
      id: 'projection:one',
      memoryId: 'one',
      allowedEffects: [],
      topicTags: [],
      disclosure: 'normal' as const,
      generatedFromVersion: 'v1',
      generatedAt: 'now',
    }
    const withheld = { ...projection, id: 'projection:two', memoryId: 'two', disclosure: 'never_explicit' as const }
    const metrics = aggregateMetrics([
      outcome('F.01', undefined, [result('one', 'visible', { projection, mentionDecision: 'explicit' })]),
      outcome('F.02', undefined, [result('two', '', { projection: withheld, mentionDecision: 'silent_use' })]),
      outcome('F.04', undefined, [result('three', 'raw')]),
    ])
    expect(metrics.safeUsageProjectionRate).toMatchObject({ numerator: 2, denominator: 3, scenarios: ['F.01', 'F.02', 'F.04'] })
    expect(metrics.rawTextWithheldRate).toMatchObject({ numerator: 1, denominator: 3, scenarios: ['F.01', 'F.02', 'F.04'] })
  })
})
