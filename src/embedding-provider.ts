/* oxlint-disable @stylistic/max-len */
import type { EmbeddingProvider } from './recall.ts'

/** Default dimension for the credential-free deterministic provider. */
export const DEFAULT_DETERMINISTIC_EMBEDDING_DIMENSION = 256

/** Default deadline for one OpenAI-compatible embedding request. */
export const DEFAULT_OPENAI_EMBEDDING_TIMEOUT_MS = 10_000

const MAX_DETERMINISTIC_EMBEDDING_DIMENSION = 4_096
const MAX_OPENAI_EMBEDDING_TIMEOUT_MS = 120_000

/** Configuration for the deterministic local embedding provider. */
export interface DeterministicEmbeddingProviderConfig {
  readonly kind: 'deterministic-local'
  readonly dimension?: number
}

/** Configuration for a provider using the OpenAI embeddings HTTP protocol. */
export interface OpenAICompatibleEmbeddingProviderConfig {
  readonly kind: 'openai-compatible'
  readonly endpoint: string
  readonly model: string
  /** Credential reference resolved for every request; this is never the secret itself. */
  readonly credentialRef: string
  readonly timeoutMs?: number
}

/** Explicitly disables dense embeddings while leaving lexical recall available. */
export interface DisabledEmbeddingProviderConfig {
  readonly kind: 'disabled'
}

/** Provider configuration accepted by the embedding factory. */
export type EmbeddingProviderConfig =
  | DisabledEmbeddingProviderConfig
  | DeterministicEmbeddingProviderConfig
  | OpenAICompatibleEmbeddingProviderConfig

/** Transport injected by tests or hosts for OpenAI-compatible requests. */
export type EmbeddingTransport = typeof fetch

/** Dependencies used while constructing an HTTP provider. */
export interface EmbeddingProviderFactoryOptions {
  /** Resolves a credential reference at request time. */
  readonly resolveCredential?: (name: string) => string | undefined
  /** HTTP transport; defaults to the process fetch implementation. */
  readonly fetch?: EmbeddingTransport
}

/** Stable details attached to providers created by this module. */
export interface EmbeddingProviderDescriptor {
  readonly providerId: string
  readonly model?: string
  readonly dimension?: number
}

/** Sanitized failure category exposed without provider response or credential data. */
export type EmbeddingProviderErrorReason =
  | 'aborted'
  | 'credential-unavailable'
  | 'invalid-config'
  | 'invalid-response'
  | 'network-error'
  | 'timeout'
  | `http-${number}`

/** Error raised by a remote embedding provider without including secret material. */
export class EmbeddingProviderError extends Error {
  /** Sanitized category that callers can use for degraded-mode reporting. */
  readonly reason: EmbeddingProviderErrorReason

  /**
   * @param reason Sanitized failure category.
   */
  constructor(reason: EmbeddingProviderErrorReason) {
    super(`embedding provider ${reason}`)
    this.name = 'EmbeddingProviderError'
    this.reason = reason
  }
}

/**
 * Create a configured dense embedding provider, or disable dense recall.
 *
 * The local provider hashes character trigrams and lexical tokens into a fixed
 * L2-normalized vector. The HTTP provider sends only the resolved credential in
 * an Authorization header and never includes it in a URL or error message.
 *
 * @param config Provider configuration, or undefined to disable dense recall.
 * @param options Credential resolver and optional transport dependencies.
 * @returns An embedding provider, or undefined when disabled or absent.
 */
export function createEmbeddingProvider(config: EmbeddingProviderConfig | undefined, options: EmbeddingProviderFactoryOptions = {}): EmbeddingProvider | undefined {
  if (config === undefined || config.kind === 'disabled') return undefined
  if (config.kind === 'deterministic-local') return createDeterministicProvider(config.dimension)
  if (config.kind === 'openai-compatible') return createOpenAICompatibleProvider(config, options)
  return assertNever(config)
}

interface DescribedEmbeddingProvider extends EmbeddingProvider, EmbeddingProviderDescriptor {}

function createDeterministicProvider(configuredDimension: number | undefined): DescribedEmbeddingProvider {
  const dimension = validateDimension(configuredDimension ?? DEFAULT_DETERMINISTIC_EMBEDDING_DIMENSION)
  return {
    providerId: 'deterministic-local-v1',
    model: 'deterministic-local-v1',
    dimension,
    async embedDocuments(texts, signal) {
      throwIfAborted(signal)
      return texts.map(text => deterministicVector(text, dimension))
    },
    async embedQuery(text, signal) {
      throwIfAborted(signal)
      return deterministicVector(text, dimension)
    },
  }
}

function createOpenAICompatibleProvider(config: OpenAICompatibleEmbeddingProviderConfig, options: EmbeddingProviderFactoryOptions): DescribedEmbeddingProvider {
  const endpoint = validateEndpoint(config.endpoint)
  const model = nonEmpty(config.model, 'model')
  const credentialRef = nonEmpty(config.credentialRef, 'credentialRef')
  const timeoutMs = validateTimeout(config.timeoutMs ?? DEFAULT_OPENAI_EMBEDDING_TIMEOUT_MS)
  const resolveCredential = options.resolveCredential
  if (resolveCredential === undefined) throw new EmbeddingProviderError('invalid-config')
  const transport = options.fetch ?? globalThis.fetch
  if (typeof transport !== 'function') throw new EmbeddingProviderError('invalid-config')

  return {
    providerId: 'openai-compatible',
    model,
    async embedDocuments(texts, signal) {
      if (texts.length === 0) return []
      const embeddings = await requestEmbeddings(texts, endpoint, model, credentialRef, timeoutMs, resolveCredential, transport, signal)
      return embeddings
    },
    async embedQuery(text, signal) {
      const embeddings = await requestEmbeddings(text, endpoint, model, credentialRef, timeoutMs, resolveCredential, transport, signal)
      if (embeddings.length !== 1) throw new EmbeddingProviderError('invalid-response')
      return embeddings[0] ?? []
    },
  }
}

async function requestEmbeddings(input: string | readonly string[], endpoint: string, model: string, credentialRef: string, timeoutMs: number, resolveCredential: (name: string) => string | undefined, transport: EmbeddingTransport, signal?: AbortSignal): Promise<readonly (readonly number[])[]> {
  throwIfAborted(signal)
  let credential: string | undefined
  try {
    credential = resolveCredential(credentialRef)
  } catch {
    throw new EmbeddingProviderError('credential-unavailable')
  }
  if (credential === undefined || credential.length === 0) throw new EmbeddingProviderError('credential-unavailable')

  const response = await requestWithRetry({ endpoint, model, credential, input, timeoutMs, transport, ...(signal === undefined ? {} : { signal }) })
  let body: unknown
  try {
    body = await response.json()
  } catch {
    throw new EmbeddingProviderError('invalid-response')
  }
  const embeddings = parseEmbeddings(body)
  if (embeddings.length === 0 || embeddings.some(vector => vector.length === 0)) throw new EmbeddingProviderError('invalid-response')
  const dimension = embeddings[0]?.length ?? 0
  if (embeddings.some(vector => vector.length !== dimension || vector.some(value => !Number.isFinite(value)))) throw new EmbeddingProviderError('invalid-response')
  return embeddings
}

interface EmbeddingRequest {
  readonly endpoint: string
  readonly model: string
  readonly credential: string
  readonly input: string | readonly string[]
  readonly timeoutMs: number
  readonly transport: EmbeddingTransport
  readonly signal?: AbortSignal
}

async function requestWithRetry(request: EmbeddingRequest): Promise<Response> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await requestOnce(request)
    if (isRetryableStatus(response.status) && attempt === 0) continue
    if (!response.ok) throw new EmbeddingProviderError(`http-${response.status}`)
    return response
  }
  throw new EmbeddingProviderError('network-error')
}

async function requestOnce(request: EmbeddingRequest): Promise<Response> {
  const controller = new AbortController()
  let abortReason: 'aborted' | 'timeout' | undefined
  const onCallerAbort = (): void => {
    abortReason = 'aborted'
    controller.abort(request.signal?.reason)
  }
  const onTimeout = (): void => {
    abortReason = 'timeout'
    controller.abort()
  }
  request.signal?.throwIfAborted()
  request.signal?.addEventListener('abort', onCallerAbort, { once: true })
  const timer = setTimeout(onTimeout, request.timeoutMs)
  try {
    const response = await Promise.race([
      request.transport(request.endpoint, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${request.credential}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ model: request.model, input: request.input }),
        signal: controller.signal,
      }),
      new Promise<Response>((_, reject) => {
        controller.signal.addEventListener('abort', () => {
          reject(new EmbeddingProviderError(abortReason ?? 'aborted'))
        }, { once: true })
      }),
    ])
    return response
  } catch (error) {
    if (error instanceof EmbeddingProviderError) throw error
    if (abortReason !== undefined) throw new EmbeddingProviderError(abortReason)
    throw new EmbeddingProviderError('network-error')
  } finally {
    clearTimeout(timer)
    request.signal?.removeEventListener('abort', onCallerAbort)
  }
}

function parseEmbeddings(value: unknown): readonly (readonly number[])[] {
  if (!isRecord(value) || !Array.isArray(value.data)) throw new EmbeddingProviderError('invalid-response')
  const vectors: number[][] = []
  for (const item of value.data) {
    if (!isRecord(item) || !Array.isArray(item.embedding) || !item.embedding.every((entry): entry is number => typeof entry === 'number')) throw new EmbeddingProviderError('invalid-response')
    vectors.push([...item.embedding])
  }
  return vectors
}

function deterministicVector(text: string, dimension: number): readonly number[] {
  const normalized = text.normalize('NFKC').toLocaleLowerCase().replace(/\s+/g, ' ').trim()
  const codePoints = [...normalized]
  const vector = Array.from({ length: dimension }, () => 0)
  const tokens = normalized.match(/[a-z0-9]+|[\u3400-\u9fff]+/g) ?? []
  if (tokens.length === 0 && codePoints.length === 0) addFeature(vector, '<empty>', 1)
  for (const token of tokens) addFeature(vector, `token:${token}`, 1)
  for (let index = 0; index + 2 < codePoints.length; index += 1) addFeature(vector, `char:${codePoints.slice(index, index + 3).join(' ')}`, 0.5)
  const norm = Math.hypot(...vector)
  if (norm === 0) {
    vector[hashFeature('fallback') % dimension] = 1
    return vector
  }
  return vector.map(value => value / norm)
}

function addFeature(vector: number[], feature: string, weight: number): void {
  const hash = hashFeature(feature)
  const index = hash % vector.length
  const sign = (hash & 0x80000000) === 0 ? 1 : -1
  vector[index] = (vector[index] ?? 0) + sign * weight
}

function hashFeature(value: string): number {
  let hash = 2_166_136_261
  for (const character of value) {
    hash = Math.imul(hash ^ (character.codePointAt(0) ?? 0), 16_777_619) >>> 0
  }
  return hash >>> 0
}

function validateDimension(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > MAX_DETERMINISTIC_EMBEDDING_DIMENSION) throw new EmbeddingProviderError('invalid-config')
  return value
}

function validateTimeout(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > MAX_OPENAI_EMBEDDING_TIMEOUT_MS) throw new EmbeddingProviderError('invalid-config')
  return value
}

function validateEndpoint(value: string): string {
  try {
    const endpoint = new URL(nonEmpty(value, 'endpoint'))
    if ((endpoint.protocol !== 'https:' && endpoint.protocol !== 'http:') || endpoint.username !== '' || endpoint.password !== '') throw new Error('invalid endpoint')
    return endpoint.toString()
  } catch {
    throw new EmbeddingProviderError('invalid-config')
  }
}

function nonEmpty(value: string, field: string): string {
  const normalized = value.trim()
  if (normalized.length === 0) {
    void field
    throw new EmbeddingProviderError('invalid-config')
  }
  return normalized
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  signal?.throwIfAborted()
}

function assertNever(_value: never): never {
  throw new EmbeddingProviderError('invalid-config')
}
