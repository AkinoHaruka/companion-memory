import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export const EXTERNAL_BENCHMARK_CHECKPOINT_SCHEMA_VERSION = 1 as const
export const BENCHMARK_ANSWER_NORMALIZATION_VERSION = 'answer-normalization-v1' as const

export type BenchmarkName = 'locomo' | 'longmemeval'
export type BenchmarkStage = 'pending' | 'ingested' | 'recalled' | 'answered' | 'scored' | 'completed'

export interface BenchmarkRunIdentity {
  readonly benchmark: BenchmarkName
  readonly datasetVersion: string
  readonly datasetSha256: string
  readonly adapterVersion: string
  readonly ingestionMappingVersion: string
  readonly runtimeFingerprint: string
  readonly embeddingProvider?: string
  readonly embeddingModel?: string
  readonly answerProvider?: string
  readonly answerModel?: string
  readonly scorerVersion?: string
  readonly timeoutPolicy?: string
  readonly retryPolicy?: string
}

export interface BenchmarkFailure {
  readonly stage: BenchmarkStage
  readonly retryable: boolean
  readonly message: string
}

export interface BenchmarkStageTiming {
  readonly startedAt: string
  readonly completedAt: string
  readonly durationMs: number
}

export interface BenchmarkIngestionSummary {
  readonly scope: string
  readonly sessionCount: number
  readonly turnCount: number
  readonly mappingVersion: string
  readonly fingerprint: string
  readonly firstEventAt?: string
  readonly lastEventAt?: string
}

export interface BenchmarkCheckpointItem {
  readonly itemId: string
  readonly status: BenchmarkStage
  readonly attempts: Readonly<Partial<Record<BenchmarkStage, number>>>
  readonly originalQuestion?: string
  readonly retrievalQuery?: string
  readonly recallContext?: string
  readonly recallTrace?: unknown
  readonly answer?: string
  readonly rawAnswer?: string
  readonly scoredAnswer?: string
  readonly answerNormalizationVersion?: typeof BENCHMARK_ANSWER_NORMALIZATION_VERSION
  readonly answerModelUsed?: string
  readonly scorerModelUsed?: string
  readonly score?: unknown
  readonly failure?: BenchmarkFailure
  readonly ingestion?: BenchmarkIngestionSummary
  readonly stageTimings?: Readonly<Partial<Record<BenchmarkStage, BenchmarkStageTiming>>>
}

export interface BenchmarkCheckpointDocument {
  readonly schemaVersion: typeof EXTERNAL_BENCHMARK_CHECKPOINT_SCHEMA_VERSION
  readonly campaignKey: string
  readonly identity: BenchmarkRunIdentity
  readonly updatedAt: string
  readonly items: Readonly<Record<string, BenchmarkCheckpointItem>>
}

const STAGE_ORDER: readonly BenchmarkStage[] = ['pending', 'ingested', 'recalled', 'answered', 'scored', 'completed']

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue)
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => [key, stableValue(entry)])
    return Object.fromEntries(entries)
  }
  return value
}

/** Create a non-secret identity for one benchmark protocol and runtime configuration. */
export function benchmarkCampaignKey(identity: BenchmarkRunIdentity): string {
  return createHash('sha256').update(JSON.stringify(stableValue(identity))).digest('hex')
}

export function createBenchmarkCheckpoint(identity: BenchmarkRunIdentity, now = new Date().toISOString()): BenchmarkCheckpointDocument {
  return {
    schemaVersion: EXTERNAL_BENCHMARK_CHECKPOINT_SCHEMA_VERSION,
    campaignKey: benchmarkCampaignKey(identity),
    identity,
    updatedAt: now,
    items: {},
  }
}

export async function loadBenchmarkCheckpoint(
  path: string,
  identity: BenchmarkRunIdentity,
): Promise<BenchmarkCheckpointDocument | undefined> {
  const text = await readFile(path, 'utf8').catch((error: unknown) => {
    if ((error as { code?: string }).code === 'ENOENT') return undefined
    throw error
  })
  if (text === undefined) return undefined
  let parsed: unknown
  try { parsed = JSON.parse(text) } catch { throw new Error(`benchmark checkpoint is not valid JSON: ${path}`) }
  if (parsed === null || typeof parsed !== 'object') throw new Error(`benchmark checkpoint is not an object: ${path}`)
  const document = parsed as Partial<BenchmarkCheckpointDocument>
  const expectedKey = benchmarkCampaignKey(identity)
  if (
    document.schemaVersion !== EXTERNAL_BENCHMARK_CHECKPOINT_SCHEMA_VERSION ||
    document.campaignKey !== expectedKey ||
    document.identity === undefined ||
    document.items === undefined
  ) {
    throw new Error(`benchmark checkpoint fingerprint mismatch: ${path}; use a new checkpoint path`)
  }
  return document as BenchmarkCheckpointDocument
}

/** Atomically replace a checkpoint so an interruption cannot leave a partial document. */
export async function saveBenchmarkCheckpoint(path: string, document: BenchmarkCheckpointDocument): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.tmp-${String(process.pid)}`
  await writeFile(temporary, JSON.stringify(document, null, 2) + '\n')
  await rename(temporary, path)
}

export function stageCompleted(item: Pick<BenchmarkCheckpointItem, 'status'>, stage: BenchmarkStage): boolean {
  return STAGE_ORDER.indexOf(item.status) >= STAGE_ORDER.indexOf(stage)
}

/** Remove protocol-only thought wrappers without changing the raw model output. */
export function normalizeBenchmarkAnswer(answer: string): string {
  return answer.replace(/<thought\b[^>]*>[\s\S]*?<\/thought>/giu, '').trim()
}

export function recordBenchmarkStage(item: BenchmarkCheckpointItem, stage: BenchmarkStage, patch: Omit<Partial<BenchmarkCheckpointItem>, 'itemId' | 'status' | 'attempts' | 'failure'> = {}): BenchmarkCheckpointItem {
  if (STAGE_ORDER.indexOf(stage) < STAGE_ORDER.indexOf(item.status)) throw new Error(`benchmark stage cannot move backwards: ${item.status} -> ${stage}`)
  const attempts = { ...item.attempts, [stage]: (item.attempts[stage] ?? 0) + 1 }
  const { failure: _failure, ...withoutFailure } = item
  return { ...withoutFailure, ...patch, status: stage, attempts }
}

export function recordBenchmarkFailure(item: BenchmarkCheckpointItem, failure: BenchmarkFailure): BenchmarkCheckpointItem {
  return { ...item, attempts: { ...item.attempts, [failure.stage]: (item.attempts[failure.stage] ?? 0) + 1 }, failure }
}
