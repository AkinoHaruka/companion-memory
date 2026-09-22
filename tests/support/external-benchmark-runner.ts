import {
  recordBenchmarkFailure,
  recordBenchmarkStage,
  stageCompleted,
  type BenchmarkCheckpointItem,
  type BenchmarkStage,
} from './benchmark-checkpoint.ts'
import type { BenchmarkQueryPlan } from './benchmark-query-adapter.ts'

export class BenchmarkStageError extends Error {
  readonly retryable: boolean

  constructor(message: string, retryable: boolean) {
    super(message)
    this.name = 'BenchmarkStageError'
    this.retryable = retryable
  }
}

export interface BenchmarkStageHandlers {
  readonly ingest: (item: BenchmarkCheckpointItem) => Promise<Partial<BenchmarkCheckpointItem>>
  readonly recall: (item: BenchmarkCheckpointItem) => Promise<Pick<BenchmarkCheckpointItem, 'recallContext' | 'recallTrace'>>
  readonly answer: (item: BenchmarkCheckpointItem) => Promise<Pick<BenchmarkCheckpointItem, 'answer'>>
  readonly score: (item: BenchmarkCheckpointItem) => Promise<Pick<BenchmarkCheckpointItem, 'score'>>
}

export interface BenchmarkExecutionOptions {
  readonly item: BenchmarkCheckpointItem
  readonly query: BenchmarkQueryPlan
  readonly handlers: BenchmarkStageHandlers
  readonly onCheckpoint?: (item: BenchmarkCheckpointItem) => Promise<void>
}

function nextStage(status: BenchmarkStage): BenchmarkStage {
  if (status === 'pending') return 'ingested'
  if (status === 'ingested') return 'recalled'
  if (status === 'recalled') return 'answered'
  if (status === 'answered') return 'scored'
  return 'completed'
}

function failureStage(status: BenchmarkStage): BenchmarkStage {
  return nextStage(status)
}

/** Execute one item without hiding stage boundaries or retrying provider calls implicitly. */
export async function executeBenchmarkItem(options: BenchmarkExecutionOptions): Promise<BenchmarkCheckpointItem> {
  let item = options.item
  const checkpoint = async (): Promise<void> => {
    if (options.onCheckpoint !== undefined) await options.onCheckpoint(item)
  }
  try {
    if (!stageCompleted(item, 'ingested')) {
      item = recordBenchmarkStage(item, 'ingested', await options.handlers.ingest(item))
      await checkpoint()
    }
    if (!stageCompleted(item, 'recalled')) {
      item = recordBenchmarkStage(item, 'recalled', await options.handlers.recall(item))
      await checkpoint()
    }
    if (!stageCompleted(item, 'answered')) {
      item = recordBenchmarkStage(item, 'answered', await options.handlers.answer(item))
      await checkpoint()
    }
    if (!stageCompleted(item, 'scored')) {
      item = recordBenchmarkStage(item, 'scored', await options.handlers.score(item))
      await checkpoint()
    }
    if (!stageCompleted(item, 'completed')) {
      item = recordBenchmarkStage(item, 'completed')
      await checkpoint()
    }
    return item
  } catch (error) {
    const failure = error instanceof BenchmarkStageError
      ? { stage: failureStage(item.status), retryable: error.retryable, message: error.message }
      : { stage: failureStage(item.status), retryable: false, message: error instanceof Error ? error.message : String(error) }
    item = recordBenchmarkFailure(item, failure)
    await checkpoint()
    return item
  }
}
