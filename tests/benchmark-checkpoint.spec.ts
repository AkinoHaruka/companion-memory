import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  benchmarkCampaignKey,
  createBenchmarkCheckpoint,
  loadBenchmarkCheckpoint,
  recordBenchmarkFailure,
  recordBenchmarkStage,
  saveBenchmarkCheckpoint,
  stageCompleted,
  type BenchmarkCheckpointItem,
  type BenchmarkRunIdentity,
} from './support/benchmark-checkpoint.ts'
import { BenchmarkStageError, executeBenchmarkItem } from './support/external-benchmark-runner.ts'
import { adaptBenchmarkQuestion } from './support/benchmark-query-adapter.ts'

const identity: BenchmarkRunIdentity = {
  benchmark: 'locomo',
  datasetVersion: 'locomo10',
  datasetSha256: 'dataset-digest',
  adapterVersion: 'benchmark-query-v1',
  ingestionMappingVersion: 'locomo-role-map-v1',
  runtimeFingerprint: 'riko-memory-test-runtime',
  embeddingProvider: 'none',
  answerProvider: 'none',
  scorerVersion: 'official-compatible-v1',
  timeoutPolicy: 'bounded-v1',
  retryPolicy: 'retry-transient-v1',
}

function item(status: BenchmarkCheckpointItem['status'] = 'pending'): BenchmarkCheckpointItem {
  return { itemId: 'conv-1-qa-1', status, attempts: {} }
}

describe('external benchmark checkpoint', () => {
  it('has stable order-independent identity and changes when dataset identity changes', () => {
    const reordered: BenchmarkRunIdentity = {
      benchmark: identity.benchmark,
      datasetVersion: identity.datasetVersion,
      datasetSha256: identity.datasetSha256,
      adapterVersion: identity.adapterVersion,
      ingestionMappingVersion: identity.ingestionMappingVersion,
      runtimeFingerprint: identity.runtimeFingerprint,
      embeddingProvider: identity.embeddingProvider!,
      answerProvider: identity.answerProvider!,
      scorerVersion: identity.scorerVersion!,
      timeoutPolicy: identity.timeoutPolicy!,
      retryPolicy: identity.retryPolicy!,
    }
    expect(benchmarkCampaignKey(identity)).toBe(benchmarkCampaignKey(reordered))
    expect(benchmarkCampaignKey(identity)).not.toBe(benchmarkCampaignKey({ ...identity, datasetSha256: 'different-dataset' }))
  })

  it('writes atomically and rejects a mismatched campaign identity', async () => {
    const root = await mkdtemp(join(tmpdir(), 'riko-memory-benchmark-checkpoint-'))
    const path = join(root, 'run.json')
    const initial = createBenchmarkCheckpoint(identity, '2026-09-22T00:00:00.000Z')
    const recalled = recordBenchmarkStage(item('ingested'), 'recalled', { originalQuestion: 'What did I say?' })
    const document = { ...initial, items: { [recalled.itemId]: recalled } }
    await saveBenchmarkCheckpoint(path, document)
    expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({ schemaVersion: 1, campaignKey: document.campaignKey })
    await expect(loadBenchmarkCheckpoint(path, { ...identity, adapterVersion: 'different-adapter' })).rejects.toThrow('fingerprint mismatch')
    await expect(loadBenchmarkCheckpoint(path, identity)).resolves.toMatchObject({ items: { [recalled.itemId]: { status: 'recalled' } } })
  })

  it('reuses completed stages but keeps retryable failures eligible for another attempt', () => {
    const recalled = recordBenchmarkStage(item('ingested'), 'recalled', { recallContext: 'memory context' })
    expect(stageCompleted(recalled, 'ingested')).toBe(true)
    expect(stageCompleted(recalled, 'recalled')).toBe(true)
    expect(stageCompleted(recalled, 'answered')).toBe(false)
    const failed = recordBenchmarkFailure(recalled, { stage: 'answered', retryable: true, message: 'temporary timeout' })
    expect(failed.status).toBe('recalled')
    expect(failed.failure?.retryable).toBe(true)
    expect(failed.attempts.answered).toBe(1)
    expect(() => recordBenchmarkStage(recalled, 'ingested')).toThrow('cannot move backwards')
    expect(() => recordBenchmarkStage(recalled, 'pending')).toThrow('cannot move backwards')
  })

  it('persists each stage and does not implicitly retry a failed provider stage', async () => {
    const calls: string[] = []
    const checkpoints: string[] = []
    const result = await executeBenchmarkItem({
      item: { ...item(), originalQuestion: 'What did I say?', retrievalQuery: adaptBenchmarkQuestion({ question: 'What did I say?' }).retrievalQuery },
      query: adaptBenchmarkQuestion({ question: 'What did I say?' }),
      onCheckpoint: async checkpoint => { checkpoints.push(checkpoint.status) },
      handlers: {
        ingest: async () => { calls.push('ingest'); return {} },
        recall: async () => { calls.push('recall'); return { recallContext: 'context' } },
        answer: async () => { calls.push('answer'); throw new BenchmarkStageError('temporary answer timeout', true) },
        score: async () => { calls.push('score'); return { score: 1 } },
      },
    })
    expect(calls).toEqual(['ingest', 'recall', 'answer'])
    expect(checkpoints).toEqual(['ingested', 'recalled', 'recalled'])
    expect(result.failure).toMatchObject({ stage: 'answered', retryable: true })
    expect(result.status).toBe('recalled')
  })

  it('resumes from the last successful stage without repeating ingestion or recall', async () => {
    const calls: string[] = []
    const existing = recordBenchmarkStage(recordBenchmarkStage(item(), 'ingested'), 'recalled', { recallContext: 'saved context' })
    const result = await executeBenchmarkItem({
      item: existing,
      query: adaptBenchmarkQuestion({ question: 'What did I say?' }),
      handlers: {
        ingest: async () => { calls.push('ingest'); return {} },
        recall: async () => { calls.push('recall'); return { recallContext: 'new context' } },
        answer: async () => { calls.push('answer'); return { answer: 'answer' } },
        score: async () => { calls.push('score'); return { score: { exact: true } } },
      },
    })
    expect(calls).toEqual(['answer', 'score'])
    expect(result.status).toBe('completed')
    expect(result.recallContext).toBe('saved context')
  })
})
