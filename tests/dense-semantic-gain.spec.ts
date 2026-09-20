/**
 * Semantic-gain ablation: paraphrase queries over a 10-page hard-negative pool.
 *
 * The Appendix F ablation cannot measure embedding quality — its per-query eligible dense pool
 * is 1-2 documents, below the candidate cap, so top-K equals whole-pool injection and every
 * provider scores identically (see `semantic-corpus.ts` for the design constraints). This spec
 * runs the corpus that fixes that: the query shares zero lexical material with its target, so
 * only vector semantics can surface it, and 9 same-domain distractors force the rank to select.
 *
 * Opt-in via `DSH_MEMORY_BGE_ENDPOINT` (loopback OpenAI-protocol embeddings; the negative
 * control uses the keyless deterministic provider and runs in the same session). Measured
 * rates are the finding of each run — printed as JSON, not pinned as invariants.
 */
import { beforeAll, describe, expect, it } from 'vitest'
import { semanticCorpus } from './support/semantic-corpus.ts'
import { judgeSemanticOutcome, runSemanticCorpus, type SemanticJudgment, type SemanticOutcome } from './support/semantic-runner.ts'

const endpoint = process.env.DSH_MEMORY_BGE_ENDPOINT

let lexicalOnly: SemanticOutcome[] = []
let deterministic: SemanticOutcome[] = []
let real: SemanticOutcome[] = []
let judgments: SemanticJudgment[] = []

describe.skipIf(endpoint === undefined)('semantic dense recall gain (paraphrase corpus)', () => {
  beforeAll(async () => {
    lexicalOnly = await runSemanticCorpus('lexical-only')
    deterministic = await runSemanticCorpus('deterministic')
    real = await runSemanticCorpus('real-embedding', {
      endpoint: endpoint!,
      model: process.env.DSH_MEMORY_BGE_MODEL ?? 'BAAI/bge-small-zh-v1.5',
      credentialRef: 'DSH_MEMORY_BGE_KEY',
    })
    judgments = [...lexicalOnly, ...deterministic, ...real].map(judgeSemanticOutcome)
    console.log(`semantic gain judgments: ${JSON.stringify(judgments, null, 2)}`)
  }, 600_000)

  it('executes every scenario under every provider without errors', () => {
    for (const outcomes of [lexicalOnly, deterministic, real]) {
      const failures = outcomes.filter(outcome => outcome.status === 'error')
      expect(outcomes).toHaveLength(semanticCorpus.length)
      expect(failures, JSON.stringify(failures.map(outcome => outcome.reason))).toEqual([])
    }
  })

  it('confirms the corpus design: the lexical baseline reaches none of the targets', () => {
    const baseline = judgments.filter(judgment => judgment.provider === 'lexical-only')
    expect(baseline).toHaveLength(semanticCorpus.length)
    for (const judgment of baseline) expect(judgment.targetInResults, judgment.scenarioId).toBe(false)
  })

  it('keeps dense selection bounded by the candidate cap and consistent with noise accounting', () => {
    for (const judgment of judgments) {
      if (judgment.provider === 'lexical-only') continue
      expect(judgment.denseSelected, judgment.scenarioId).toBeLessThanOrEqual(8)
      expect(judgment.denseNoise + (judgment.targetViaDense ? 1 : 0), judgment.scenarioId).toBe(judgment.denseSelected)
    }
  })

  it('reports semantic gain per provider as the measured finding of this run', () => {
    const summarize = (provider: string): string => {
      const rows = judgments.filter(judgment => judgment.provider === provider)
      const reached = rows.filter(judgment => judgment.targetInResults).length
      const viaDense = rows.filter(judgment => judgment.targetViaDense).length
      const noise = rows.reduce((sum, judgment) => sum + judgment.denseNoise, 0)
      return `${provider}: unique semantic gain ${String(viaDense)}/${String(rows.length)}, target reached ${String(reached)}/${String(rows.length)}, dense noise ${String(noise)}`
    }
    const report = [summarize('lexical-only'), summarize('deterministic'), summarize('real-embedding')].join(' | ')
    console.log(`semantic gain summary: ${report}`)
    expect(report).toContain('real-embedding')
  })
})
