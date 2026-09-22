import { createHash } from 'node:crypto'

/** Version of the deterministic, label-blind benchmark query transformation. */
export const BENCHMARK_QUERY_ADAPTER_VERSION = 'benchmark-query-v2'

const MEMORY_INTENT_PREFIX = 'Do you remember my previous conversation context relevant to this question?'
const NO_MEMORY_INSTRUCTION = 'If no relevant memory is available, say so instead of inventing.'

/** The only benchmark fields allowed to affect the retrieval query. */
export interface BenchmarkQuestionInput {
  readonly question: string
  /** Optional evaluation time used by a caller as an as-of value, never as answer content. */
  readonly asOf?: string
}

/** Audit-visible result kept separate from the question sent to the answer grader. */
export interface BenchmarkQueryPlan {
  readonly adapterVersion: typeof BENCHMARK_QUERY_ADAPTER_VERSION
  readonly originalQuestion: string
  readonly retrievalQuery: string
  readonly asOf?: string
  readonly originalQuestionDigest: string
}

function normalizedQuestion(question: string): string {
  return question.normalize('NFKC').replace(/\s+/gu, ' ').trim()
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

/**
 * Turn an implicit benchmark memory question into an explicit retrieval request.
 *
 * The answer-side question remains byte-for-byte intact. Only a fixed memory-intent prefix and a
 * no-invention instruction are added to the retrieval query; benchmark labels are not accepted by
 * this input shape and therefore cannot influence retrieval. The prefix is deliberately free of
 * production temporal cues such as "before", "earlier", "last year", and "recent".
 */
export function adaptBenchmarkQuestion(input: BenchmarkQuestionInput): BenchmarkQueryPlan {
  if (typeof input.question !== 'string' || input.question.trim().length === 0) {
    throw new Error('benchmark question must be a non-empty string')
  }
  const originalQuestion = input.question
  const queryQuestion = normalizedQuestion(originalQuestion)
  const asOf = input.asOf?.trim() || undefined
  return {
    adapterVersion: BENCHMARK_QUERY_ADAPTER_VERSION,
    originalQuestion,
    retrievalQuery: `${MEMORY_INTENT_PREFIX}\n${NO_MEMORY_INSTRUCTION}\n\nQuestion:\n${queryQuestion}`,
    ...(asOf === undefined ? {} : { asOf }),
    originalQuestionDigest: digest(originalQuestion),
  }
}

/** Return the stable task-intent prefix for protocol documentation and tests. */
export function benchmarkMemoryIntentPrefix(): string {
  return MEMORY_INTENT_PREFIX
}
