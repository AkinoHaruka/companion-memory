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
 * reports what the route did per call, and rotates credentials, because a
 * hundred-call run against a contended free tier meets the contention on every
 * turn. Measured on the Zhipu-compatible platforms: `1305 访问量过大` /
 * `The service may be temporarily overloaded` arrives as HTTP 429, and
 * `1113 余额不足或无可用资源包` arrives as HTTP 429 too -- one is transient and
 * the other is a wall, and for both the productive response is another
 * credential rather than the same one again.
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

/**
 * Statuses worth another attempt, which here means another credential.
 *
 * 429 carries both the transient overload and the per-key quota wall, so it
 * rotates. 401/403 are included because a credential list is allowed to hold a
 * key that does not belong to every host in it: an auth failure on one pairing
 * is recoverable, and rotating is how. 400 is deliberately absent -- a rejected
 * request body (`该模型始终思考，不支持关闭思考`) is rejected identically by
 * every credential, and rotating through six of them to learn that costs six
 * timeouts.
 *
 * Status 0 is a transport failure -- a timeout or a dropped connection -- and it
 * belongs here. Measured on a contended tier, a request that queued past the
 * client's own timeout was recorded as `attempts: 1` and given up on, turning a
 * slow answer into an empty one for no reason.
 */
function retryableStatus(status: number): boolean {
  return status === 0
    || status === 401 || status === 403 || status === 404
    || status === 408 || status === 409 || status === 425 || status === 429
    || status >= 500;
}

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

interface AttemptResult {
  httpStatus: number;
  text: string;
  finishReason: string;
  completionTokens: number;
  reasoningTokens: number;
  model: string;
  /** Set when this attempt failed, so the caller can decide whether to retry. */
  failure?: string;
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

  async function attempt(credential: RouteCredential, messages: readonly EvaluationMessage[], maxTokens: number, wantsJson: boolean): Promise<AttemptResult> {
    const url = `${credential.baseUrl.replace(/\/+$/, '')}/chat/completions`;
    const body: Record<string, unknown> = {
      model: options.model,
      max_tokens: maxTokens,
      messages: messages.map((message) => ({ role: message.role, content: message.content })),
      ...(wantsJson && jsonMode ? { response_format: { type: 'json_object' } } : {}),
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
      return { httpStatus: 0, text: '', finishReason: 'transport', completionTokens: 0, reasoningTokens: 0, model: options.model, failure: cause };
    }
    const raw = await response.text().catch(() => '');
    if (!response.ok) {
      // The provider's own code matters here: `1113 余额不足` is a wall and
      // `1305 访问量过大` is not, and both arrive as HTTP 429. Rotation answers
      // both; the message is kept so the run can say which wall it met.
      return { httpStatus: response.status, text: '', finishReason: 'http_error', completionTokens: 0, reasoningTokens: 0, model: options.model, failure: `HTTP ${response.status}: ${raw.slice(0, 240)}` };
    }
    let payload: unknown;
    try {
      payload = JSON.parse(raw);
    } catch {
      return { httpStatus: response.status, text: '', finishReason: 'unparsable', completionTokens: 0, reasoningTokens: 0, model: options.model, failure: `HTTP 200 body was not JSON: ${raw.slice(0, 240)}` };
    }
    const root = asRecord(payload);
    const providerError = asRecord(root?.error);
    if (providerError !== undefined) {
      return { httpStatus: response.status, text: '', finishReason: 'provider_error', completionTokens: 0, reasoningTokens: 0, model: options.model, failure: JSON.stringify(providerError).slice(0, 240) };
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
    let used = 0;
    for (let attemptNumber = 1; attemptNumber <= maxAttempts; attemptNumber += 1) {
      const index = (attemptNumber - 1) % credentials.length;
      const credential = credentials[index];
      if (credential === undefined) break;
      served = index;
      used = attemptNumber;
      last = await attempt(credential, messages, maxTokens, wantsJson);
      if (last.failure === undefined) break;
      if (attemptNumber === maxAttempts || !retryableStatus(last.httpStatus)) break;
      await sleep(backoffMs(attemptNumber, retryBaseDelayMs));
    }
    const fallback = credentials[0];
    const settled = last ?? { httpStatus: 0, text: '', finishReason: 'transport', completionTokens: 0, reasoningTokens: 0, model: options.model, failure: 'no attempt was made' };
    const report: RouteReport = {
      model: settled.model,
      endpoint: endpointLabel(credentials[served]?.baseUrl ?? fallback?.baseUrl ?? ''),
      credential: served,
      httpStatus: settled.httpStatus,
      finishReason: settled.finishReason,
      textLength: settled.text.length,
      completionTokens: settled.completionTokens,
      reasoningTokens: settled.reasoningTokens,
      attempts: used,
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
      if (!jsonMode) throw new Error(`the route did not answer: ${first.report.error}`);
      const second = await invoke(messages, request.maxTokens, false);
      if (second.report.error !== undefined) throw new Error(`the route did not answer: ${second.report.error}`);
      return parseObject(second.text);
    },
  };
}
