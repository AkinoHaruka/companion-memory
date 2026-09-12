/**
 * An OpenAI-compatible route for the Oracle, so an acceptance run does not need
 * a live DSH session.
 *
 * The harness route is the right client for the harness, but it made the
 * acceptance unlaunchable except from inside a session, and it could only report
 * the text it assembled. Both mattered. Ten repetitions inside one launcher
 * process aborted with `0xC0000409` partway through the first repetition, and a
 * run that dies at call sixty has already paid for sixty calls. Separately, the
 * route client's `invoke` keeps only the text blocks, so a reply that never
 * arrived and a model that chose to say nothing were the same empty string --
 * which is what an entire scoring defect was built on top of.
 *
 * This client speaks the wire format the providers being compared actually use,
 * reports what the route did per call, and learns per credential, because the
 * refusals a run meets are not all the same kind and treating them alike cost a
 * recorded run most of its quota:
 *
 * - `1305 访问量过大` and `1302` are transient, so rotate and come back.
 * - `1113 余额不足` is a wall for that key. Rotate, but it will not recover.
 * - `free-models-per-day` with `X-RateLimit-Remaining: 0` is that key's day being
 *   over. Rotating back into it burns ten 25-second attempts to learn the same
 *   thing, so the credential is skipped for the rest of the run.
 * - `does not support feature: structured-outputs` is a body problem, not a
 *   credential problem, and it is permanent -- so the field is not sent to that
 *   credential again, and the extractor's fallback runs without burning the
 *   attempts the first refusal costs.
 */

import type { EvaluationClient, EvaluationMessage, EvaluationReply } from './evaluator.js';
import type { RouteReport } from './route-report.js';

/** One endpoint and the key to use with it. The key is never written into an artifact. */
export interface RouteCredential {
  /** Base of the OpenAI-compatible API; `/chat/completions` is appended. */
  baseUrl: string;
  apiKey: string;
  /**
   * Body fields for this host only, merged over the client-wide `body`.
   *
   * The field that turns a reasoning route into a usable one is not the same
   * field everywhere, and the wrong one is silently ignored rather than
   * rejected. Measured: Zhipu's platforms need `{"thinking":{"type":"disabled"}}`,
   * while OpenRouter passes `thinking` through to a model that ignores it and
   * needs `{"reasoning":{"enabled":false}}` -- with the wrong field in place the
   * route still spent 239 tokens reasoning against a 400-token budget.
   *
   * A credential may not change the model. The model is a property of the run,
   * because an arm answered by one model and an arm answered by another is not
   * an arm comparison.
   */
  body?: Record<string, unknown>;
}

export interface OpenAiCompatibleOptions {
  /**
   * Endpoints to rotate through, in order. Every attempt after the first moves
   * to the next one, so a run against a free tier spreads its calls instead of
   * re-asking a route that just refused.
   */
  credentials: readonly RouteCredential[];
  model: string;
  /** Merged into every request body verbatim, e.g. `{ thinking: { type: 'disabled' } }`. */
  body?: Record<string, unknown>;
  /**
   * Ask for a JSON object through `response_format`. Providers differ on whether
   * they accept the field, and a rejection is not retryable, so it is opt-out.
   */
  jsonMode?: boolean;
  requestTimeoutMs?: number;
  maxAttempts?: number;
  retryBaseDelayMs?: number;
  /** Called once per call with what the route did, whether or not it answered. */
  onCall?: (report: RouteReport) => void;
  fetchImpl?: typeof fetch;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_RETRY_BASE_MS = 1_500;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** Content arrives as a string on most providers and as text parts on a few. */
function readContent(message: Record<string, unknown> | undefined): string {
  if (message === undefined) return '';
  const direct = asString(message.content);
  if (direct !== undefined) return direct;
  const parts = Array.isArray(message.content) ? message.content : [];
  return parts.map((part) => asString(asRecord(part)?.text) ?? '').join('');
}

function parseObject(text: string): Record<string, unknown> {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('the route returned no JSON object');
  const parsed: unknown = JSON.parse(trimmed.slice(start, end + 1));
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('the route returned a non-object JSON payload');
  }
  return parsed as Record<string, unknown>;
}

/**
 * A deterministic stagger rather than random jitter.
 *
 * The four arms of a turn issue their calls together, so a shared backoff would
 * have all four return to an overloaded route at the same instant. The offset
 * depends only on the attempt number, which keeps two runs comparable.
 */
function backoffMs(attempt: number, base: number): number {
  return Math.min(base * 2 ** (attempt - 1), 30_000) + (attempt * 137) % 250;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

/** Host only. An artifact must never be able to carry a key. */
function endpointLabel(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}

type FailureKind = 'transport' | 'overload' | 'auth' | 'quota' | 'unsupported' | 'rejected';

interface AttemptResult {
  httpStatus: number;
  text: string;
  finishReason: string;
  completionTokens: number;
  reasoningTokens: number;
  model: string;
  /** Why this attempt failed, so the caller can decide what to do about it. */
  failure?: string;
  /**
   * The kind of failure, which decides the response rather than the status code
   * alone: a 429 can be a busy route or a day that is over, and those want
   * opposite answers.
   */
  kind?: FailureKind;
}

interface CallOutcome {
  text: string;
  report: RouteReport;
}

/**
 * Creates a client that answers through OpenAI-compatible endpoints.
 *
 * `chat` deliberately does not throw when every attempt fails. One overloaded
 * route would otherwise take down a hundred-call run at whichever call it hit,
 * losing every turn before it, and the report it returns already names the
 * failure. `chatJson` does throw, because the extractor already has a fallback
 * for "the extraction call did not work" and an empty object is not a better
 * answer than the absence of one.
 */
export function createOpenAiCompatibleClient(options: OpenAiCompatibleOptions): EvaluationClient {
  const credentials = options.credentials.filter((credential) => credential.baseUrl.length > 0 && credential.apiKey.length > 0);
  if (credentials.length === 0) throw new Error('at least one route credential is required');
  // Two passes over the credential list, so a route that is briefly refusing
  // everything is asked again rather than abandoned, and so rotation is never
  // cut short by a default written for the single-credential case.
  const maxAttempts = Math.max(1, options.maxAttempts ?? Math.max(4, credentials.length * 2));
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  const retryBaseDelayMs = options.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_MS;
  const jsonMode = options.jsonMode ?? true;
  const doFetch = options.fetchImpl ?? fetch;

  // Credentials whose day is over, and the (credential, model) pairs that have
  // rejected `response_format`. Both are learned from refusals and consulted
  // before the next call, which is what turned a 25-second refusal repeated four
  // times per extraction into one call.
  const exhausted = new Set<number>();
  const noStructuredOutput = new Set<number>();

  function classify(status: number, body: string, transport: boolean, providerCode?: string): FailureKind {
    if (transport) return 'transport';
    const text = body.toLowerCase();
    if (/structured-outputs|response_format/.test(text) || providerCode === '1210') return 'unsupported';
    if (/per-day|daily|models-per-day/.test(text) || providerCode === '1113' || providerCode === '1213') return 'quota';
    if (status === 401 || status === 403) return 'auth';
    // A provider can refuse over HTTP 200 with its own error object, so its own
    // code decides when there is one: 1305 and 1302 are busy, not broken.
    if (status >= 400 && (status === 429 || status === 408 || status === 409 || status === 425 || status >= 500 || providerCode === '1305' || providerCode === '1302')) return 'overload';
    if (status >= 400) return 'rejected';
    return providerCode === undefined ? 'rejected' : 'overload';
  }

  async function attempt(credential: RouteCredential, index: number, messages: readonly EvaluationMessage[], maxTokens: number, wantsJson: boolean): Promise<AttemptResult> {
    const url = `${credential.baseUrl.replace(/\/+$/, '')}/chat/completions`;
    const body: Record<string, unknown> = {
      model: options.model,
      max_tokens: maxTokens,
      messages: messages.map((message) => ({ role: message.role, content: message.content })),
      ...(wantsJson && jsonMode && !noStructuredOutput.has(index) ? { response_format: { type: 'json_object' } } : {}),
      ...(options.body ?? {}),
      ...(credential.body ?? {}),
    };
    let response: Response;
    try {
      response = await doFetch(url, {
        method: 'POST',
        headers: { authorization: `Bearer ${credential.apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(requestTimeoutMs),
      });
    } catch (error) {
      const cause = error instanceof Error ? (error.cause instanceof Error ? error.cause.message : error.message) : String(error);
      return { httpStatus: 0, text: '', finishReason: 'transport', completionTokens: 0, reasoningTokens: 0, model: options.model, failure: cause, kind: 'transport' };
    }
    const raw = await response.text().catch(() => '');
    if (!response.ok) {
      const kind = classify(response.status, raw, false);
      return { httpStatus: response.status, text: '', finishReason: 'http_error', completionTokens: 0, reasoningTokens: 0, model: options.model, failure: `HTTP ${response.status}: ${raw.slice(0, 240)}`, kind };
    }
    let payload: unknown;
    try {
      payload = JSON.parse(raw);
    } catch {
      return { httpStatus: response.status, text: '', finishReason: 'unparsable', completionTokens: 0, reasoningTokens: 0, model: options.model, failure: `HTTP 200 body was not JSON: ${raw.slice(0, 240)}`, kind: 'rejected' };
    }
    const root = asRecord(payload);
    const providerError = asRecord(root?.error);
    if (providerError !== undefined) {
      const message = JSON.stringify(providerError).slice(0, 240);
      const code = asString(providerError.code);
      return { httpStatus: response.status, text: '', finishReason: 'provider_error', completionTokens: 0, reasoningTokens: 0, model: options.model, failure: message, kind: classify(response.status, message, false, code) };
    }
    const choices = Array.isArray(root?.choices) ? root.choices : [];
    const choice = asRecord(choices[0]);
    const usage = asRecord(root?.usage);
    const details = asRecord(usage?.completion_tokens_details);
    return {
      httpStatus: response.status,
      text: readContent(asRecord(choice?.message)),
      finishReason: asString(choice?.finish_reason) ?? 'unknown',
      completionTokens: asNumber(usage?.completion_tokens) ?? 0,
      reasoningTokens: asNumber(details?.reasoning_tokens) ?? 0,
      model: asString(root?.model) ?? options.model,
    };
  }

  async function invoke(messages: readonly EvaluationMessage[], maxTokens: number, wantsJson: boolean): Promise<CallOutcome> {
    const startedAt = Date.now();
    let last: AttemptResult | undefined;
    let served = 0;
    let tries = 0;
    for (let pass = 0; pass < maxAttempts; pass += 1) {
      // Credentials whose day is over are dropped before they are asked again.
      const pool = credentials.map((_, index) => index).filter((index) => !exhausted.has(index));
      if (pool.length === 0) break;
      const index = pool[pass % pool.length]!;
      tries += 1;
      served = index;
      last = await attempt(credentials[index]!, index, messages, maxTokens, wantsJson);
      if (last.failure === undefined) break;
      // A day that is over does not recover inside a run, so the credential is
      // dropped and the next one is tried without waiting.
      if (last.kind === 'quota') { exhausted.add(index); continue; }
      // The body is the problem and it is permanent for this credential and
      // model; `chatJson` reads the set and stops sending the field.
      if (last.kind === 'unsupported') { noStructuredOutput.add(index); break; }
      if (last.kind === 'rejected') break;
      if (tries >= maxAttempts) break;
      await sleep(backoffMs(tries, retryBaseDelayMs));
    }
    const fallback = credentials[0];
    const settled = last ?? { httpStatus: 0, text: '', finishReason: 'transport', completionTokens: 0, reasoningTokens: 0, model: options.model, failure: 'no attempt was made', kind: 'transport' as const };
    const report: RouteReport = {
      model: settled.model,
      endpoint: endpointLabel(credentials[served]?.baseUrl ?? fallback?.baseUrl ?? ''),
      credential: served,
      httpStatus: settled.httpStatus,
      finishReason: settled.finishReason,
      textLength: settled.text.length,
      completionTokens: settled.completionTokens,
      reasoningTokens: settled.reasoningTokens,
      attempts: tries,
      elapsedMs: Date.now() - startedAt,
      ...(settled.failure === undefined ? {} : { error: settled.failure }),
    };
    options.onCall?.(report);
    return { text: settled.text, report };
  }

  return {
    async chat(messages, request): Promise<EvaluationReply> {
      const outcome = await invoke(messages, request.maxTokens, false);
      return { text: outcome.text, route: outcome.report };
    },
    async chatJson(messages, request) {
      const first = await invoke(messages, request.maxTokens, true);
      if (first.report.error === undefined) return parseObject(first.text);
      // A provider may refuse the field outright rather than ignore it. Measured
      // on OpenRouter: `model: inclusionai/ling-3.0-flash-sante does not support
      // feature: structured-outputs`, arriving as HTTP 400 from the upstream
      // provider, while the same prompt without the field returned well-formed
      // JSON. Retrying once without it is worth far more than losing the
      // extraction, because a failed extraction leaves the normal arm with no
      // memory at all -- and that reads downstream as "memory does not help".
      // The credential is remembered, so this costs once per run and not once
      // per turn.
      if (!jsonMode) throw new Error(`the route did not answer: ${first.report.error}`);
      const second = await invoke(messages, request.maxTokens, false);
      if (second.report.error !== undefined) throw new Error(`the route did not answer: ${second.report.error}`);
      return parseObject(second.text);
    },
  };
}
