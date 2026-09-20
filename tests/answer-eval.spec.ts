import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RecallResult } from '../src/recall.ts'
import { companionCorpus } from './support/companion-corpus.ts'
import { executeCompanion, type RawOutcome } from './support/companion-runner.ts'
import {
  answerGeneratorFromEnvironment,
  createProviderRequestGate,
  fetchWithProviderRetry,
} from './support/answer-evaluation.ts'
import { aggregateMetrics } from './support/evaluation-metrics.ts'

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

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

  it('maps the model-selected answer provider to OpenAI-compatible messages without requiring a key', async () => {
    vi.stubEnv('DSH_MEMORY_ANSWER_ENDPOINT', 'https://answer.example/v1/chat/completions')
    vi.stubEnv('DSH_MEMORY_ANSWER_MODEL', 'answer-model')
    vi.stubEnv('DSH_MEMORY_ANSWER_KEY', '')
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ choices: [{ message: { content: 'generated answer' } }] })),
    )
    const generator = answerGeneratorFromEnvironment()
    if (generator === undefined) throw new Error('expected answer generator')
    const request = {
      scenario: scenario('F.27'),
      userTurn: 'What should I do?', injectedContext: '<memory>safe context</memory>', resident: '', results: [],
    }
    await expect(generator(request)).resolves.toBe('generated answer')
    const [input, init] = fetchMock.mock.calls[0]!
    expect(input).toBe(
      'https://answer.example/v1/chat/completions',
    )
    expect(init?.headers).toEqual({ 'content-type': 'application/json' })
    expect(JSON.parse(String(init?.body))).toEqual({
      model: 'answer-model',
      messages: [
        { role: 'system', content: '<memory>safe context</memory>' },
        { role: 'user', content: 'What should I do?' },
      ],
    })
  })

  it('retries provider throttling and server failures with bounded, header-aware backoff', async () => {
    const successfulResponses = [new Response('{}', { status: 429 }), new Response('{}', { status: 200 })]
    const successfulFetch = vi.fn(async () => successfulResponses.shift()!)
    const success = await fetchWithProviderRetry('https://provider.example/chat', undefined, {
      gate: createProviderRequestGate({ minIntervalMs: 0, maxRetries: 1 }),
      fetchImpl: successfulFetch,
      sleep: async () => {},
    })
    expect(success.status).toBe(200)
    expect(successfulFetch).toHaveBeenCalledTimes(2)

    const badRequestFetch = vi.fn(async () => new Response('{}', { status: 400 }))
    const badRequest = await fetchWithProviderRetry('https://provider.example/chat', undefined, {
      gate: createProviderRequestGate({ minIntervalMs: 0, maxRetries: 3 }),
      fetchImpl: badRequestFetch,
      sleep: async () => {},
    })
    expect(badRequest.status).toBe(400)
    expect(badRequestFetch).toHaveBeenCalledTimes(1)

    const failureDelays: number[] = []
    const failingFetch = vi.fn(async () => new Response('{}', { status: 503 }))
    const finalFailure = await fetchWithProviderRetry('https://provider.example/chat', undefined, {
      gate: createProviderRequestGate({ minIntervalMs: 0, maxRetries: 2 }),
      fetchImpl: failingFetch,
      sleep: async (milliseconds) => { failureDelays.push(milliseconds) },
    })
    expect(finalFailure.status).toBe(503)
    expect(failingFetch).toHaveBeenCalledTimes(3)
    expect(failureDelays).toEqual([1_000, 2_000])

    const delays: number[] = []
    const retryAfterResponses = [new Response('{}', { status: 429, headers: { 'retry-after': '7' } }), new Response('{}', { status: 200 })]
    const retryAfterFetch = vi.fn(async () => retryAfterResponses.shift()!)
    await fetchWithProviderRetry('https://provider.example/chat', undefined, {
      gate: createProviderRequestGate({ minIntervalMs: 0, maxRetries: 1 }),
      fetchImpl: retryAfterFetch,
      sleep: async (milliseconds) => { delays.push(milliseconds) },
    })
    expect(delays).toEqual([7_000])
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
