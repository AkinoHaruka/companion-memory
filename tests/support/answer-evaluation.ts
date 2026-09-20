import type { RecallResult, RecallTrace } from '../../src/recall.ts'
import type { CompanionScenario } from './companion-corpus.ts'

/** Environment variable selecting an HTTP final-answer provider for the companion campaign. */
export const ANSWER_ENDPOINT_ENV = 'DSH_MEMORY_ANSWER_ENDPOINT'
/** Environment variable selecting the OpenAI-compatible chat model for the answer campaign. */
export const ANSWER_MODEL_ENV = 'DSH_MEMORY_ANSWER_MODEL'
/** Optional environment variable supplying the answer provider bearer credential. */
export const ANSWER_KEY_ENV = 'DSH_MEMORY_ANSWER_KEY'
/** Environment variable setting the minimum delay between calls to an opt-in provider. */
export const PROVIDER_MIN_INTERVAL_ENV = 'DSH_MEMORY_PROVIDER_MIN_INTERVAL_MS'
/** Environment variable setting the maximum number of retries after a retryable response. */
export const PROVIDER_MAX_RETRIES_ENV = 'DSH_MEMORY_PROVIDER_MAX_RETRIES'

/** Default delay between calls to an opt-in provider, including calls from both provider adapters. */
export const DEFAULT_PROVIDER_MIN_INTERVAL_MS = 2_000
/** Default number of additional attempts after a retryable provider response. */
export const DEFAULT_PROVIDER_MAX_RETRIES = 3
const DEFAULT_PROVIDER_BACKOFF_MS = 1_000
const MAX_PROVIDER_RETRIES = 8

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

/** Shared pacing state for the Dream and final-answer provider adapters in one campaign. */
export interface ProviderRequestGate {
  readonly minIntervalMs: number
  readonly maxRetries: number
  nextRequestAt: number
  queue: Promise<void>
}

/** Options for the keyless provider retry helper. */
export interface ProviderFetchOptions {
  readonly gate?: ProviderRequestGate
  readonly fetchImpl?: typeof globalThis.fetch
  readonly sleep?: (milliseconds: number) => Promise<void>
  readonly now?: () => number
  readonly onAttempt?: () => void
}

/** Create shared provider pacing state from the process environment or the supplied test values.
 * @param overrides - Optional values used by keyless tests and local callers.
 * @returns Mutable request state shared by provider calls in one campaign.
 */
export function createProviderRequestGate(overrides: {
  readonly minIntervalMs?: number
  readonly maxRetries?: number
} = {}): ProviderRequestGate {
  const minIntervalMs = overrides.minIntervalMs ?? readNonNegativeInteger(PROVIDER_MIN_INTERVAL_ENV, DEFAULT_PROVIDER_MIN_INTERVAL_MS)
  const maxRetries = overrides.maxRetries ?? readRetryCount()
  if (!Number.isSafeInteger(minIntervalMs) || minIntervalMs < 0) {
    throw new Error(`${PROVIDER_MIN_INTERVAL_ENV} must be a non-negative integer`)
  }
  if (!Number.isSafeInteger(maxRetries) || maxRetries < 0 || maxRetries > MAX_PROVIDER_RETRIES) {
    throw new Error(`${PROVIDER_MAX_RETRIES_ENV} must be an integer from 0 through ${String(MAX_PROVIDER_RETRIES)}`)
  }
  return { minIntervalMs, maxRetries, nextRequestAt: 0, queue: Promise.resolve() }
}

/** Decide whether a provider response may be retried and how long the next wait lasts.
 * @param response - Provider response whose status and `Retry-After` header are inspected.
 * @param retryNumber - One-based retry number for the response.
 * @param nowMs - Current epoch time used for an HTTP-date `Retry-After` value.
 * @returns Delay in milliseconds, or `undefined` when the response is not retryable.
 */
export function providerRetryDelayMs(
  response: Pick<Response, 'status' | 'headers'>,
  retryNumber: number,
  nowMs = Date.now(),
): number | undefined {
  if (!isRetryableStatus(response.status) || retryNumber < 1) return undefined
  const retryAfter = response.headers.get('retry-after')?.trim()
  if (retryAfter !== undefined && retryAfter.length > 0) {
    const seconds = Number(retryAfter)
    if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1_000)
    const retryAt = Date.parse(retryAfter)
    if (Number.isFinite(retryAt)) return Math.max(0, retryAt - nowMs)
  }
  return DEFAULT_PROVIDER_BACKOFF_MS * 2 ** (retryNumber - 1)
}

/** Fetch one provider request with pacing and bounded retries for 429 and 5xx responses.
 * @param input - Provider URL or request input.
 * @param init - Fetch options for the provider request.
 * @param options - Shared pacing state and injectable keyless test dependencies.
 * @returns The first non-retryable response or the last retryable response.
 */
export async function fetchWithProviderRetry(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  options: ProviderFetchOptions = {},
): Promise<Response> {
  const gate = options.gate ?? createProviderRequestGate()
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  const sleep = options.sleep ?? delay
  const now = options.now ?? Date.now
  for (let retryNumber = 0; ; retryNumber += 1) {
    await waitForProviderTurn(gate, now, sleep)
    options.onAttempt?.()
    const response = await fetchImpl(input, init)
    const waitMs = providerRetryDelayMs(response, retryNumber + 1, now())
    if (waitMs === undefined || retryNumber >= gate.maxRetries) return response
    await sleep(waitMs)
  }
}

/** Resolve the opt-in HTTP answer provider from the process environment.
 *
 * Without `DSH_MEMORY_ANSWER_MODEL`, the endpoint receives the existing companion JSON request and
 * must return `{"answer":"..."}`. With a model, the endpoint receives OpenAI-compatible chat
 * completions messages and returns `choices[0].message.content`; `DSH_MEMORY_ANSWER_KEY` is optional.
 * @param providerGate - Optional shared request state for the campaign's provider calls.
 * @param fetchImpl - Fetch implementation used for the endpoint, captured before the Dream proxy is installed.
 * @returns An HTTP generator when `DSH_MEMORY_ANSWER_ENDPOINT` is non-empty; otherwise `undefined`.
 */
export function answerGeneratorFromEnvironment(
  providerGate?: ProviderRequestGate,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): AnswerGenerator | undefined {
  const endpoint = process.env[ANSWER_ENDPOINT_ENV]?.trim()
  if (endpoint === undefined || endpoint.length === 0) return undefined
  const model = process.env[ANSWER_MODEL_ENV]?.trim()
  const key = process.env[ANSWER_KEY_ENV]?.trim()
  const gate = providerGate ?? createProviderRequestGate()
  return async (request) => {
    if (model !== undefined && model.length > 0) {
      const headers: Record<string, string> = { 'content-type': 'application/json' }
      if (key !== undefined && key.length > 0) headers.authorization = `Bearer ${key}`
      const response = await fetchWithProviderRetry(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: request.injectedContext },
            { role: 'user', content: request.userTurn },
          ],
        }),
      }, { gate, fetchImpl })
      if (!response.ok) throw new Error(`${ANSWER_ENDPOINT_ENV} returned ${String(response.status)}`)
      const payload: unknown = await response.json()
      if (!isChatCompletionPayload(payload)) {
        throw new Error(`${ANSWER_ENDPOINT_ENV} must return JSON {"choices":[{"message":{"content":"..."}}]}`)
      }
      return payload.choices[0].message.content
    }
    const response = await fetchWithProviderRetry(endpoint, {
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
    }, { gate, fetchImpl })
    if (!response.ok) throw new Error(`${ANSWER_ENDPOINT_ENV} returned ${String(response.status)}`)
    const payload: unknown = await response.json()
    if (!isAnswerPayload(payload)) throw new Error(`${ANSWER_ENDPOINT_ENV} must return JSON {"answer":"..."}`)
    return payload.answer
  }
}

function isAnswerPayload(value: unknown): value is { readonly answer: string } {
  return typeof value === 'object' && value !== null && 'answer' in value && typeof value.answer === 'string'
}

function isChatCompletionPayload(
  value: unknown,
): value is { readonly choices: readonly [{ readonly message: { readonly content: string } }] } {
  if (
    typeof value !== 'object' || value === null || !('choices' in value) || !Array.isArray(value.choices) || value.choices.length === 0
  ) return false
  const first = value.choices[0]
  if (typeof first !== 'object' || first === null || !('message' in first)) return false
  const message = first.message
  return typeof message === 'object' && message !== null && 'content' in message && typeof message.content === 'string'
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599)
}

function readRetryCount(): number {
  return readNonNegativeInteger(PROVIDER_MAX_RETRIES_ENV, DEFAULT_PROVIDER_MAX_RETRIES)
}

function readNonNegativeInteger(name: string, fallback: number): number {
  const raw = process.env[name]?.trim()
  if (raw === undefined || raw.length === 0) return fallback
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer`)
  return value
}

function waitForProviderTurn(
  gate: ProviderRequestGate,
  now: () => number,
  sleep: (milliseconds: number) => Promise<void>,
): Promise<void> {
  const previous = gate.queue
  let release!: () => void
  gate.queue = new Promise<void>((resolve) => { release = resolve })
  return previous.then(async () => {
    try {
      const waitMs = Math.max(0, gate.nextRequestAt - now())
      if (waitMs > 0) await sleep(waitMs)
      gate.nextRequestAt = now() + gate.minIntervalMs
    } finally {
      release()
    }
  })
}

function delay(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds))
}
