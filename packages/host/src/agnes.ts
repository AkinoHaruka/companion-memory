/**
 * The Agnes API client.
 *
 * Small on purpose. Every call this project makes is one of three shapes —
 * produce a reply, extract structured facts, consolidate a batch — and the
 * differences that matter are which prompt goes in and whether the output must
 * be JSON.
 *
 * Two properties are non-negotiable here because everything above depends on
 * them.
 *
 * **Credential comes from the environment.** A key in a source file is a key in
 * a git history, and this project's whole subject is private memory.
 *
 * **A malformed response is an error, not a default.** Returning an empty object
 * where JSON was expected would let an extraction failure look like a
 * conversation with nothing worth remembering, which is indistinguishable from a
 * quiet one.
 */

/** Configuration for the client. */
export interface AgnesConfig {
  /** Base URL, without a trailing slash. */
  baseUrl: string;
  /** Bearer token. Read from the environment by `fromEnv`. */
  apiKey: string;
  /** Model identifier, e.g. `agnes-3.0-flash`. */
  model: string;
  /** Per-request timeout, in milliseconds. */
  timeoutMs?: number;
}

/** One turn in a request. */
export interface ChatMessage {
  /** Who produced it. */
  role: 'system' | 'user' | 'assistant';
  /** The text. */
  content: string;
}

/** What one call cost, for the run report. */
export interface CallUsage {
  /** Prompt tokens, as reported by the API. */
  promptTokens: number;
  /** Completion tokens. */
  completionTokens: number;
}

/** A completed call. */
export interface ChatResult {
  /** The assistant's text. */
  text: string;
  /** Reported usage, when the API supplies it. */
  usage: CallUsage;
}

/** The environment variable holding the bearer token. */
export const API_KEY_ENV = 'AGNES_API_KEY';

/** The environment variable overriding the base URL. */
export const BASE_URL_ENV = 'AGNES_BASE_URL';

/** The environment variable overriding the model. */
export const MODEL_ENV = 'AGNES_MODEL';

/** Default endpoint. */
const DEFAULT_BASE_URL = 'https://apihub.agnes-ai.com/v1';

/** Default model. */
const DEFAULT_MODEL = 'agnes-3.0-flash';

/** Default per-request timeout. */
const DEFAULT_TIMEOUT_MS = 60_000;

/** How many times a rate-limited or transiently failed call is retried. */
const DEFAULT_RETRIES = 5;

/** Base delay for the retry backoff, in milliseconds. */
const RETRY_BASE_MS = 2_000;

/** Whether a status is worth waiting out rather than failing on. */
function isRetryable(status: number): boolean {
  // 429 is the free tier's rate limit and clears on its own; 5xx is transient.
  return status === 429 || status === 408 || status >= 500;
}

/**
 * Build a configuration from the environment.
 *
 * Throws when the key is absent rather than deferring the failure to the first
 * call, because a missing credential discovered at call time surfaces as a
 * failed memory read, which the adapter is designed to swallow.
 *
 * @param env - the environment to read, defaulting to `process.env`.
 * @returns the configuration.
 */
export function fromEnv(env: NodeJS.ProcessEnv = process.env): AgnesConfig {
  const apiKey = env[API_KEY_ENV]?.trim();
  if (!apiKey) {
    throw new Error(`${API_KEY_ENV} is not set`);
  }
  return {
    baseUrl: (env[BASE_URL_ENV]?.trim() || DEFAULT_BASE_URL).replace(/\/+$/, ''),
    apiKey,
    model: env[MODEL_ENV]?.trim() || DEFAULT_MODEL,
    timeoutMs: DEFAULT_TIMEOUT_MS,
  };
}

/** The client. */
export class AgnesClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  /** Retry budget remaining for the current call chain. */
  private retries = DEFAULT_RETRIES;
  /** Attempts made in the current chain, for the backoff growth. */
  private attempt = 0;
  /** Notified when a call is about to be retried, for the run log. */
  onRetry?: (status: number, waitMs: number) => void;
  /** Calls made, for the run report. */
  private calls = 0;
  /** Tokens consumed, for the run report. */
  private promptTokens = 0;
  private completionTokens = 0;

  constructor(config: AgnesConfig) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, '');
    this.apiKey = config.apiKey;
    this.model = config.model;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /** How many calls have been made. */
  get callCount(): number {
    return this.calls;
  }

  /** Total tokens consumed across both directions. */
  get totalTokens(): number {
    return this.promptTokens + this.completionTokens;
  }

  /**
   * Produce one completion.
   *
   * @param messages - the conversation to send.
   * @param options - `json` requests a JSON object response; `maxTokens` bounds it.
   * @returns the assistant text and reported usage.
   */
  async chat(
    messages: readonly ChatMessage[],
    options: { json?: boolean; maxTokens?: number; temperature?: number } = {},
  ): Promise<ChatResult> {
    const body: Record<string, unknown> = {
      model: this.model,
      messages,
      max_tokens: options.maxTokens ?? 1_024,
    };
    if (options.temperature !== undefined) body.temperature = options.temperature;
    // Ask for a JSON object rather than merely describing one in the prompt. A
    // prompt-only request works most of the time, and the failure mode is a
    // prose preamble that the caller then has to strip, which is where a
    // truncated response starts looking like a valid empty result.
    if (options.json) body.response_format = { type: 'json_object' };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      // A rate limit clears on its own, so waiting is better than failing a run
      // that is twenty calls in. Backoff is linear in the attempt, and the
      // retry budget is bounded so a genuinely unavailable API still fails
      // rather than hanging.
      if (isRetryable(response.status) && this.retries > 0) {
        this.retries -= 1;
        const wait = RETRY_BASE_MS * Math.min(4, this.attempt + 1);
        this.attempt += 1;
        this.onRetry?.(response.status, wait);
        await new Promise((resolve) => setTimeout(resolve, wait));
        return this.chat(messages, options);
      }
      throw new Error(`agnes ${response.status}: ${detail.slice(0, 400)}`);
    }
    this.attempt = 0;

    const payload = (await response.json()) as {
      choices?: { message?: { content?: unknown } }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const content = payload.choices?.[0]?.message?.content;
    if (typeof content !== 'string') {
      throw new Error('agnes returned no assistant content');
    }

    this.calls += 1;
    this.promptTokens += payload.usage?.prompt_tokens ?? 0;
    this.completionTokens += payload.usage?.completion_tokens ?? 0;

    return {
      text: content,
      usage: {
        promptTokens: payload.usage?.prompt_tokens ?? 0,
        completionTokens: payload.usage?.completion_tokens ?? 0,
      },
    };
  }

  /**
   * Produce one completion and parse it as JSON.
   *
   * @param messages - the conversation to send.
   * @param options - `maxTokens` bounds the response.
   * @returns the parsed object.
   * @throws when the response is not a JSON object, which callers treat as a
   *   failed extraction rather than as an empty one.
   */
  async chatJson(
    messages: readonly ChatMessage[],
    options: { maxTokens?: number } = {},
  ): Promise<Record<string, unknown>> {
    const result = await this.chat(messages, {
      json: true,
      maxTokens: options.maxTokens ?? 2_048,
      temperature: 0,
    });
    const parsed = parseJsonObject(result.text);
    if (!parsed) {
      throw new Error(`agnes returned unparseable JSON: ${result.text.slice(0, 200)}`);
    }
    return parsed;
  }
}

/**
 * Extract a JSON object from a model response.
 *
 * Tolerates a Markdown fence and surrounding prose, because a `json_object`
 * request is a strong hint rather than a guarantee, and rejecting an otherwise
 * usable response over a fence would lose a whole extraction.
 *
 * @param text - the raw response.
 * @returns the parsed object, or `undefined` when none is present.
 */
export function parseJsonObject(text: string): Record<string, unknown> | undefined {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  const attempt = (candidate: string): Record<string, unknown> | undefined => {
    try {
      const value = JSON.parse(candidate) as unknown;
      return value && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : undefined;
    } catch {
      return undefined;
    }
  };
  return (
    attempt(trimmed) ??
    (() => {
      const start = trimmed.indexOf('{');
      const end = trimmed.lastIndexOf('}');
      return start >= 0 && end > start ? attempt(trimmed.slice(start, end + 1)) : undefined;
    })()
  );
}
