/** Run Oracle through either a configured HTTP route or a live DSH route. */

import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { runOracleEvaluation, type EvaluationClient } from './evaluator.js';
import { createOpenAiCompatibleClient, type RouteCredential } from './openai-client.js';

interface EvaluationBridgeModule {
  createEvaluationClient?: () => EvaluationClient | Promise<EvaluationClient>;
}

interface HttpRouteConfig {
  credentials: RouteCredential[];
  model: string;
  body?: Record<string, unknown>;
}

function splitList(value: string | undefined): string[] {
  if (value === undefined) return [];
  return value.split(',').map((part) => part.trim()).filter((part) => part.length > 0);
}

/**
 * A direct HTTP route, when one is configured.
 *
 * Two things make this the preferred route when it is available. It runs
 * without a live DSH session, so a run does not need a session, an agent, or a
 * mounted profile to exist. And it reports `finishReason`, token counts, HTTP
 * status and which credential served each call, which the harness route cannot
 * -- without that, an overloaded provider and a model that said nothing are
 * both just an empty string, and the scoring rules get built on top of that
 * ambiguity.
 *
 * Several credentials are the normal case rather than an exception, because a
 * contention refusal is how these tiers behave. `COMPANION_MEMORY_EVAL_CREDENTIALS`
 * is a JSON array of `{baseUrl, apiKey}` and pairs each key with the host it
 * belongs to:
 *
 *   [{"baseUrl":"https://open.bigmodel.cn/api/paas/v4","apiKey":"..."},
 *    {"baseUrl":"https://api.z.ai/api/paas/v4","apiKey":"..."}]
 *
 * The comma-separated `_BASE_URLS` and `_API_KEYS` remain for the one-host case
 * and produce their cross product. They are not the way to express two hosts,
 * because a key that belongs to one host authenticates against the other as a
 * 401 -- which is recoverable by rotating, but means listing keys per host is
 * how a route is meant to be described.
 *
 * `COMPANION_MEMORY_EVAL_BODY_JSON` carries provider-specific fields. It exists
 * because thinking is the difference between a run and a void one on a
 * reasoning route: `{"thinking":{"type":"disabled"}}` was measured to be the
 * difference between 400 tokens of silent reasoning that produced an empty
 * answer, and a normal answer.
 */
function httpRouteFromEnvironment(): HttpRouteConfig | undefined {
  const model = process.env.COMPANION_MEMORY_EVAL_MODEL?.trim();
  const rawCredentials = process.env.COMPANION_MEMORY_EVAL_CREDENTIALS?.trim();
  const rawBody = process.env.COMPANION_MEMORY_EVAL_BODY_JSON?.trim();
  const body = rawBody === undefined || rawBody.length === 0 ? undefined : ((): Record<string, unknown> => {
    const parsed: unknown = JSON.parse(rawBody);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('COMPANION_MEMORY_EVAL_BODY_JSON must be a JSON object');
    }
    return parsed as Record<string, unknown>;
  })();

  if (rawCredentials !== undefined && rawCredentials.length > 0) {
    const parsed: unknown = JSON.parse(rawCredentials);
    if (!Array.isArray(parsed)) throw new Error('COMPANION_MEMORY_EVAL_CREDENTIALS must be a JSON array');
    const credentials: RouteCredential[] = parsed.map((entry) => {
      const record = typeof entry === 'object' && entry !== null ? entry as Record<string, unknown> : {};
      const baseUrl = typeof record.baseUrl === 'string' ? record.baseUrl.trim() : '';
      const apiKey = typeof record.apiKey === 'string' ? record.apiKey.trim() : '';
      if (baseUrl.length === 0 || apiKey.length === 0) {
        throw new Error('every COMPANION_MEMORY_EVAL_CREDENTIALS entry needs a baseUrl and an apiKey');
      }
      const own = typeof record.body === 'object' && record.body !== null && !Array.isArray(record.body)
        ? record.body as Record<string, unknown>
        : undefined;
      return { baseUrl, apiKey, ...(own === undefined ? {} : { body: own }) };
    });
    if (model === undefined || model.length === 0) return undefined;
    return { credentials, model, ...(body === undefined ? {} : { body }) };
  }

  const baseUrls = [...splitList(process.env.COMPANION_MEMORY_EVAL_BASE_URLS), ...splitList(process.env.COMPANION_MEMORY_EVAL_BASE_URL)];
  const apiKeys = [...splitList(process.env.COMPANION_MEMORY_EVAL_API_KEYS), ...splitList(process.env.COMPANION_MEMORY_EVAL_API_KEY)];
  if (baseUrls.length === 0 || apiKeys.length === 0) return undefined;
  if (model === undefined || model.length === 0) return undefined;
  const credentials: RouteCredential[] = [];
  for (const baseUrl of [...new Set(baseUrls)]) {
    for (const apiKey of [...new Set(apiKeys)]) credentials.push({ baseUrl, apiKey });
  }
  return { credentials, model, ...(body === undefined ? {} : { body }) };
}

async function loadDshRouteClient(): Promise<EvaluationClient> {
  const bridgePath = process.env.COMPANION_MEMORY_DSH_EVALUATION_BRIDGE?.trim();
  if (bridgePath === undefined || bridgePath.length === 0) {
    throw new Error('COMPANION_MEMORY_DSH_EVALUATION_BRIDGE must point to a module that creates a client from createDshRouteEvaluationClient(ctx, agent) inside DSH');
  }
  const bridge = await import(pathToFileURL(resolve(bridgePath)).href) as EvaluationBridgeModule;
  if (typeof bridge.createEvaluationClient !== 'function') {
    throw new Error('DSH evaluation bridge must export createEvaluationClient()');
  }
  return bridge.createEvaluationClient();
}

/** A named client, so a run's artifacts say which route produced them. */
async function selectClient(): Promise<{ client: EvaluationClient; routeDescription: string }> {
  const http = httpRouteFromEnvironment();
  if (http !== undefined) {
    // Every refusal is logged to stderr rather than to the artifacts, because a
    // hundred-call run should not bury its own rows. What it buys is that a
    // refusal is visible while it is happening, not only in the aggregate.
    const client = createOpenAiCompatibleClient({
      credentials: http.credentials,
      model: http.model,
      ...(http.body === undefined ? {} : { body: http.body }),
      onCall: (report) => {
        if (report.error !== undefined) process.stderr.write(`route refused: ${JSON.stringify(report)}\n`);
      },
    });
    const hosts = [...new Set(http.credentials.map((credential) => credential.baseUrl))].join(' ');
    return { client, routeDescription: `http model=${http.model} credentials=${http.credentials.length} hosts=[${hosts}]` };
  }
  return { client: await loadDshRouteClient(), routeDescription: 'dsh route' };
}

async function main(): Promise<void> {
  const workerCommand = process.env.COMPANION_MEMORY_WORKER_COMMAND
    ?? join(process.cwd(), 'target', 'debug', process.platform === 'win32' ? 'companion-memory-worker.exe' : 'companion-memory-worker');
  const mode = process.env.COMPANION_MEMORY_EVAL_MODE === 'acceptance' ? 'acceptance' : 'development';
  // One directory per invocation. Scope names repeat between invocations, so a
  // shared database would let the second run read the first run's memories while
  // reporting itself as ten independent repetitions. The evaluator refuses a
  // database that already holds records; this is what keeps that refusal from
  // firing on the second honest run, and it also stops a new run from
  // overwriting the previous run's per-repetition artifacts.
  const invocationId = process.env.COMPANION_MEMORY_EVAL_RUN_ID?.trim()
    || new Date().toISOString().replace(/[:.]/g, '-');
  const runDirectory = join(process.cwd(), 'runs', 'oracle', invocationId);
  // Repetitions per invocation. The crash-isolated workflow runs one repetition
  // per process, because ten inside one launcher process aborted twice with
  // `0xC0000409` partway through the first. That workflow needed a way to say
  // "one", which neither the acceptance default nor the development default is.
  const requested = Number(process.env.COMPANION_MEMORY_EVAL_REPETITIONS?.trim() ?? '');
  const runCount = Number.isInteger(requested) && requested > 0
    ? requested
    : (mode === 'acceptance' ? 10 : 5);
  const selected = await selectClient();
  const summary = await runOracleEvaluation({
    client: selected.client,
    databasePath: join(runDirectory, 'oracle.db'),
    workerCommand,
    runCount,
    outputDirectory: runDirectory,
    includeProbes: true,
    // A free tier answers a four-arm burst with 1305 and 1302 on every turn; the
    // same calls spaced out answer normally. The snapshot is frozen either way,
    // so spacing costs wall clock and buys refusals.
    sequentialArms: true,
    interCallDelayMs: 1_500,
  });
  process.stdout.write(`${JSON.stringify({ mode, route: selected.routeDescription, runDirectory, runCount, ...summary.acceptance, routeRefusals: summary.routeRefusals, starvedReplies: summary.starvedReplies, extractionFailures: summary.extractionFailures })}\n`);
  if (mode === 'acceptance' && !summary.acceptance.passed) process.exitCode = 1;
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
