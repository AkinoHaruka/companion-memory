/**
 * What one evaluation model call actually did.
 *
 * The Oracle used to infer the route's behaviour from the reply text alone: an
 * empty string meant "the route did not answer" and a short string meant "the
 * model was terse". Both readings are wrong for a route that bills hidden
 * reasoning against the same `max_tokens` budget as the visible answer. Measured
 * on a real reasoning route, a 400-token reply budget was spent 397 tokens deep
 * on reasoning and returned `content: ""` with `finish_reason: "length"` — an
 * empty reply that has nothing to do with the model, the memory, or the route.
 *
 * The report exists so a missing reply can be named instead of guessed at.
 */

export interface RouteReport {
  model: string;
  /** Host that served the call, e.g. `open.bigmodel.cn`. Never carries a key. */
  endpoint: string;
  /** Index of the credential in the rotation that served the last attempt. */
  credential: number;
  /** HTTP status of the last attempt. Zero means the request never reached the provider. */
  httpStatus: number;
  /**
   * Why the provider stopped. `length` means the budget cut the answer; with a
   * reasoning route, hidden reasoning is spent from that same budget first.
   */
  finishReason: string;
  /** Characters of visible answer the provider returned. */
  textLength: number;
  completionTokens: number;
  /** Hidden reasoning tokens. Anything above zero is budget that never became text. */
  reasoningTokens: number;
  /** Attempts made, including the one that produced this report. */
  attempts: number;
  elapsedMs: number;
  /** Set when every attempt failed, so an empty answer is not the model's doing. */
  error?: string;
}

/** True when the reply is missing for a reason the model did not choose. */
export function routeRefused(report: RouteReport | undefined): boolean {
  return report !== undefined && report.error !== undefined;
}

/**
 * True when the provider stopped on the token budget with nothing to show.
 *
 * Distinguished from a refusal because the fix is different: a refusal needs
 * another attempt, a starved answer needs a bigger budget or a route that does
 * not think in silence.
 */
export function starvedByReasoning(report: RouteReport | undefined): boolean {
  return report !== undefined
    && report.error === undefined
    && report.finishReason === 'length'
    && report.textLength === 0;
}

export function describeRouteReport(report: RouteReport): string {
  const status = report.httpStatus === 0 ? 'no response' : `HTTP ${report.httpStatus}`;
  const reason = report.error === undefined ? report.finishReason : `error ${report.error}`;
  return `${report.model}@${report.endpoint} #${report.credential} ${status} finish=${reason} text=${report.textLength} reasoning=${report.reasoningTokens} attempts=${report.attempts} ${report.elapsedMs}ms`;
}
