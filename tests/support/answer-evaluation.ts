import type { RecallResult, RecallTrace } from '../../src/recall.ts'
import type { CompanionScenario } from './companion-corpus.ts'

/** Environment variable selecting an HTTP final-answer provider for the companion campaign. */
export const ANSWER_ENDPOINT_ENV = 'DSH_MEMORY_ANSWER_ENDPOINT'

/** Context and memory records supplied to one final-answer provider call. */
export interface AnswerGenerationRequest {
  readonly scenario: CompanionScenario
  readonly userTurn: string
  readonly injectedContext: string
  readonly resident: string
  readonly results: readonly RecallResult[]
  readonly trace?: RecallTrace
}

/** Injected provider used to create one final assistant answer from the live prompt context. */
export type AnswerGenerator = (request: AnswerGenerationRequest) => Promise<string> | string

/** Resolve the opt-in HTTP answer provider from the process environment.
 * @returns An HTTP generator when `DSH_MEMORY_ANSWER_ENDPOINT` is non-empty; otherwise `undefined`.
 */
export function answerGeneratorFromEnvironment(): AnswerGenerator | undefined {
  const endpoint = process.env[ANSWER_ENDPOINT_ENV]?.trim()
  if (endpoint === undefined || endpoint.length === 0) return undefined
  return async (request) => {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        scenarioId: request.scenario.id,
        userTurn: request.userTurn,
        injectedContext: request.injectedContext,
        resident: request.resident,
        results: request.results,
        trace: request.trace,
      }),
    })
    if (!response.ok) throw new Error(`${ANSWER_ENDPOINT_ENV} returned ${String(response.status)}`)
    const payload: unknown = await response.json()
    if (!isAnswerPayload(payload)) throw new Error(`${ANSWER_ENDPOINT_ENV} must return JSON {"answer":"..."}`)
    return payload.answer
  }
}

function isAnswerPayload(value: unknown): value is { readonly answer: string } {
  return typeof value === 'object' && value !== null && 'answer' in value && typeof value.answer === 'string'
}
