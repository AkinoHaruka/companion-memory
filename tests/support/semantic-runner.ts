/** Live-harness executor for the semantic-gain corpus; one isolated harness per (scenario, provider). */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, vi } from 'vitest'
import type { RecallResult, RecallTrace } from '../../src/recall.ts'
import { semanticCorpus, type SemanticScenario } from './semantic-corpus.ts'
import { startLiveHarness } from './live-harness.ts'
import { fetchLive } from './live-http.ts'

/** Which recall configuration the trial runs under. */
export type SemanticProvider = 'lexical-only' | 'deterministic' | 'real-embedding'

/** Embedding endpoint settings required when {@link SemanticProvider} is `real-embedding`. */
export interface RealEmbeddingSettings {
  readonly endpoint: string
  readonly model: string
  readonly credentialRef: string
}

export interface SemanticOutcome {
  readonly scenario: SemanticScenario
  readonly provider: SemanticProvider
  readonly status: 'executed' | 'error'
  readonly reason?: string
  readonly targetId: string
  readonly results: readonly RecallResult[]
  readonly trace?: RecallTrace
}

function denseConfig(provider: SemanticProvider, embedding: RealEmbeddingSettings | undefined): string[] {
  if (provider === 'lexical-only') return ['    recallVectorEnabled: false']
  if (provider === 'deterministic') return ['    recallVectorEnabled: true', '    embeddingProvider: deterministic']
  if (embedding === undefined) throw new Error('real-embedding trials need endpoint settings')
  return [
    '    recallVectorEnabled: true',
    '    embeddingProvider: openai-compatible',
    `    embeddingEndpoint: ${embedding.endpoint}`,
    `    embeddingModel: ${embedding.model}`,
    `    embeddingCredentialRef: ${embedding.credentialRef}`,
  ]
}

/**
 * Seed one scenario's pages into a fresh harness, run the paraphrase query, and return the
 * retrieval evidence. No Dream, no session evidence: everything is canonical, so channel
 * attribution in the trace is unambiguous.
 */
export async function executeSemanticScenario(scenario: SemanticScenario, provider: SemanticProvider, embedding?: RealEmbeddingSettings): Promise<SemanticOutcome> {
  const root = await mkdtemp(join(tmpdir(), 'riko-semantic-'))
  let harness: Awaited<ReturnType<typeof startLiveHarness>> | undefined
  const config = [
    '    recallEnabled: true',
    '    purgeEnabled: true',
    '    temporalEnabled: true',
    '    dreamApiUrl: https://api.test/api/v1/chat/completions',
    ...denseConfig(provider, embedding),
  ]
  try {
    harness = await startLiveHarness(config, root)
    await vi.waitFor(() => { expect(harness?.context.webServer.port).toBeGreaterThan(0) }, { timeout: 15_000 })
    const port = harness.context.webServer.port
    const request = async <T>(path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST'): Promise<T> => {
      const response = await fetchLive(`http://127.0.0.1:${String(port)}/memory/v1${path}`, {
        method,
        headers: { 'content-type': 'application/json', 'x-dsh-memory-profile': 'standard' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
      expect(response.status, `${method} ${path}`).toBeLessThan(400)
      return await response.json() as T
    }
    const target = await request<{ id: string }>('/wiki/pages', { path: 'wiki/concepts/target.md', type: 'concept', title: scenario.target.title, content: scenario.target.content })
    const distractorIds: string[] = []
    for (const [index, distractor] of scenario.distractors.entries()) {
      const page = await request<{ id: string }>('/wiki/pages', { path: `wiki/concepts/distractor-${String(index)}.md`, type: 'concept', title: distractor.title, content: distractor.content })
      distractorIds.push(page.id)
    }
    const recalled = await request<{ results: readonly RecallResult[] }>('/recall', { query: scenario.query })
    const debug = await request<{ trace: RecallTrace }>('/recall/debug', { query: scenario.query })
    return {
      scenario,
      provider,
      status: 'executed',
      targetId: target.id,
      results: recalled.results,
      trace: debug.trace,
    }
  } catch (error) {
    const message = error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error)
    return { scenario, provider, status: 'error', reason: message, targetId: '', results: [] }
  } finally {
    try { await harness?.dispose() } finally { await rm(root, { recursive: true, force: true }) }
  }
}

/** Per-scenario, per-provider attribution distilled from raw results. */
export interface SemanticJudgment {
  readonly scenarioId: string
  readonly provider: SemanticProvider
  readonly targetInResults: boolean
  readonly targetViaDense: boolean
  readonly targetViaLexical: boolean
  readonly targetMention: string | undefined
  readonly denseSelected: number
  readonly denseNoise: number
}

export function judgeSemanticOutcome(outcome: SemanticOutcome): SemanticJudgment {
  // RecallResult.id carries the index-source prefix (`page:<id>`); the wiki API returns the bare id.
  const matchesTarget = (result: { readonly id: string }): boolean => result.id === outcome.targetId || result.id === `page:${outcome.targetId}`
  const target = outcome.results.find(matchesTarget)
  const denseSelected = outcome.results.filter(result => result.channels.includes('dense'))
  const targetMention = target?.mentionDecision
  return {
    scenarioId: outcome.scenario.id,
    provider: outcome.provider,
    targetInResults: target !== undefined,
    targetViaDense: target?.channels.includes('dense') === true,
    targetViaLexical: target?.channels.includes('lexical') === true,
    targetMention,
    denseSelected: denseSelected.length,
    // Noise: dense-channel results that are not the scenario's target page.
    denseNoise: denseSelected.filter(result => !matchesTarget(result)).length,
  }
}

/** Run the whole corpus under one provider. */
export async function runSemanticCorpus(provider: SemanticProvider, embedding?: RealEmbeddingSettings): Promise<SemanticOutcome[]> {
  const outcomes: SemanticOutcome[] = []
  for (const scenario of semanticCorpus) outcomes.push(await executeSemanticScenario(scenario, provider, embedding))
  return outcomes
}
