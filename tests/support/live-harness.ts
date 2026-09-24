import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { fetchLive } from './live-http.ts'
import { Context, FiberState } from '@deepseek-ai/cordis'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Timer from '@deepseek-ai/cordis-plugin-timer'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import SessionStore from '@deepseek-ai/dsh-session'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SessionProjection from '@deepseek-ai/dsh-session-projection'
import AgentPresets from '@deepseek-ai/dsh-agent-presets'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import CredentialsLocal from '@deepseek-ai/dsh-credentials-local'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session } from '@deepseek-ai/dsh-session'
import RikoMemoryService from '../../src/index.ts'

const DEFAULT_DREAM_API_KEY = 'fixture-secret'

/**
 * Optional `candidateAutoConfirm` override for live runs, e.g.
 * `DSH_MEMORY_CANDIDATE_AUTO_CONFIRM=off`. Unset keeps the plugin default; a per-fixture setting may
 * explicitly pin benchmark semantics while this environment variable remains the top-level override.
 * @returns One config line when the variable names a supported policy, otherwise nothing.
 */
function candidateAutoConfirmLines(): string[] {
  const value = process.env.DSH_MEMORY_CANDIDATE_AUTO_CONFIRM?.trim()
  if (value !== 'off' && value !== 'user_grounded' && value !== 'all') return []
  return [`    candidateAutoConfirm: ${value}`]
}

/**
 * Budget for the L0 persistence chain behind one drain, derived from its measured cost.
 *
 * One append now persists the session record it wrote and defers the two records derived from it, so
 * persisting n lines costs about 1.1 durable writes per line rather than one whole-scope rewrite per
 * line. Measured through this fixture, on an idle machine, the chain behind a burst of `n` appends
 * costs 0.58 s at n=60, 1.49 s at n=150 and 3.43 s at n=300 — a slope of roughly 11 ms per append,
 * near enough linear that the old O(n^2) allowance of 150 ms per append no longer describes it.
 *
 * The slope here is four times that measurement, because the same chain stretches when parallel forks
 * contend for one disk, and the flat part covers a store that has not finished `load()` yet, the drain's
 * own HTTP round trip, and scheduler delay. A healthy drain finishes well inside it; the budget exists to
 * fail a genuine stall, not to wait out one that keeps moving.
 */
export function evidenceDrainBudgetMs(events: number): number {
  return 10_000 + 45 * events
}

/**
 * Await the fixture's L0 write chain — the explicit readiness signal behind every
 * persisted-evidence assertion.
 *
 * `GET /memory/v1/sessions` is the service's own readiness signal for that chain: the route
 * awaits its in-flight set before answering, and every `session/event` append is tracked
 * there, so the reply arrives only after the last queued `appendSessionEvent` + `persist()`
 * settled. `/sessions/:id` deliberately does NOT drain — reading one session has to stay
 * observable while its write is pending — so polling that route is what turns a bounded
 * persistence cost into an unbounded wait under load.
 * @param base - The fixture's memory API base URL.
 * @param events - L0 event count the caller is about to require, for the derived budget.
 * @param profile - Profile whose store the caller reads.
 * @returns Once every L0 write accepted before this call has been persisted.
 */
export async function drainInFlight(base: string, events = 0, profile = 'standard'): Promise<void> {
  const response = await fetchLive(`${base}/sessions`, { headers: { 'x-dsh-memory-profile': profile } }, { timeoutMs: evidenceDrainBudgetMs(events) })
  if (response.status !== 200) throw new Error(`fixture drain failed: /sessions answered ${String(response.status)}`)
  await response.arrayBuffer()
}

/** One read of a session's persisted L0 evidence stream. */
export interface PersistedEvidence {
  /** HTTP status of the read; a session with no persisted line answers 404. */
  readonly status: number
  /** Persisted L0 line count, or undefined while the session has no line. */
  readonly lineCount: number | undefined
}

/**
 * Read one persisted L0 evidence stream.
 * @param base - The fixture's memory API base URL.
 * @param sessionId - Session whose evidence stream is read.
 * @param profile - Profile whose store the caller reads.
 * @returns The read's status and persisted line count, so callers keep asserting both.
 */
export async function readPersistedEvidence(base: string, sessionId: string, profile = 'standard'): Promise<PersistedEvidence> {
  const response = await fetchLive(`${base}/sessions/${encodeURIComponent(sessionId)}`, { headers: { 'x-dsh-memory-profile': profile } })
  if (response.status !== 200) return { status: response.status, lineCount: undefined }
  const body = await response.json() as { evidence?: { lineCount?: number } }
  return { status: response.status, lineCount: body.evidence?.lineCount }
}

/** A disposable real Loader composition used by live memory acceptance tests. */
export interface LiveHarness {
  readonly context: Context
  readonly base: string
  readonly root: string
  dispose(): Promise<void>
}

/**
 * Await Loader initialization, including the HTTP listen callback and memory effects.
 * @param context - The fixture's Loader root.
 * @returns Once every configured entry is active; rejects on startup failure.
 */
export async function awaitLiveReady(context: Context): Promise<void> {
  await context.loader.await()
  for (const entry of context.loader.entries()) {
    if (entry.fiber === undefined) throw new Error(`fixture plugin did not load: ${entry.options.name}`)
    await entry.fiber.await()
    if (entry.fiber.state !== FiberState.ACTIVE) throw new Error(`fixture plugin is not active: ${entry.options.name}`)
  }
  if (!(context.webServer.port > 0)) throw new Error('fixture HTTP listener has no assigned port')
}

/**
 * Start one isolated Loader composition with deterministic local storage.
 * @param config - Memory plugin YAML fields.
 * @param rootOverride - Caller-owned storage root for sequential restart tests.
 * @param dreamApiKey - Fixture credential written to both legacy and Gemini Dream references; defaults to the fixture value.
 * @returns A ready composition; disposal removes only a harness-owned root.
 */
export async function startLiveHarness(
  config: readonly string[] = [], rootOverride?: string, dreamApiKey = DEFAULT_DREAM_API_KEY,
  additionalCredentials: Readonly<Record<string, string>> = {},
): Promise<LiveHarness> {
  const root = rootOverride ?? await mkdtemp(join(tmpdir(), 'dsh-riko-memory-live-'))
  const context = new Context()
  async function dispose(): Promise<void> {
    try {
      await context.fiber.dispose()
    } finally {
      if (rootOverride === undefined) await rm(root, { recursive: true, force: true })
    }
  }
  try {
    const credentialRefs = new Map<string, string>([['DSH_MEMORY_DREAM_API_KEY', dreamApiKey], ['GEMINI_API_KEY', dreamApiKey], ['DSH_MEMORY_BGE_KEY', 'bge-local']])
    for (const [name, value] of Object.entries(additionalCredentials)) credentialRefs.set(name, value)
    const credentials = ['version: 1', 'refs:', ...[...credentialRefs.entries()].map(([name, value]) => `  ${name}: ${JSON.stringify(value)}`), ''].join('\n')
    await writeFile(join(root, 'credentials.yaml'), credentials)
    const configPath = join(root, `cordis-${String(Date.now())}-${String(Math.random()).slice(2)}.yml`)
    await writeFile(configPath, [
      '- name: fixture-dependencies',
      '- name: "@deepseek-ai/dsh-storage"',
      '- name: "@deepseek-ai/dsh-storage-json"',
      '  config:',
      `    root: '${join(root, 'storages').replaceAll('\\', '/')}'`,
      '- name: "@deepseek-ai/dsh-storage-domain"',
      '  config:',
      '    backend: json',
      '- name: "@deepseek-ai/dsh-credentials-local"',
      '  config:',
      `    path: '${join(root, 'credentials.yaml').replaceAll('\\', '/')}'`,
      `    dshHome: '${root.replaceAll('\\', '/')}'`,
      '    watch: false',
      '- name: "@deepseek-ai/dsh-session-projection"',
      '- name: "@deepseek-ai/dsh-agent-presets"',
      '  config:',
      '    default: standard',
      '- name: "@deepseek-ai/dsh-tools"',
      '- name: "@deepseek-ai/cordis-plugin-timer"',
      '- name: "@deepseek-ai/dsh-host-webserver"',
      '  config:',
      '    host: "127.0.0.1"',
      '    port: 0',
      '- name: "@deepseek-ai/dsh-system-prompt"',
      '- name: "@deepseek-ai/dsh-session"',
      '- name: "@deepseek-ai/dsh-riko-memory"',
      '  config:',
      '    ownerNamespace: test-owner',
      '    debounceMs: 60000',
      '    dreamIntervalMs: 3600000',
      ...config,
      ...candidateAutoConfirmLines(),
      '',
    ].join('\n'))

    const dependencies = {
      name: 'fixture-dependencies',
      apply(ctx: Context) {
        ctx.provide('agents', { list: () => [] } as never)
        ctx.provide('llm', { stream: async function* () {} } as never)
      },
    }
    context.baseUrl = pathToFileURL(root).href + '/'
    await context.plugin(Loader)
    context.loader.builtins.include = Include
    const modules = new Map<string, unknown>([
      ['fixture-dependencies', dependencies],
      ['@deepseek-ai/cordis-plugin-timer', Timer],
      ['@deepseek-ai/dsh-host-webserver', WebServer],
      ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
      ['@deepseek-ai/dsh-session', SessionStore],
      ['@deepseek-ai/dsh-tools', ToolRuntime],
      ['@deepseek-ai/dsh-session-projection', SessionProjection],
      ['@deepseek-ai/dsh-agent-presets', AgentPresets],
      ['@deepseek-ai/dsh-storage', Storage],
      ['@deepseek-ai/dsh-storage-json', StorageJson],
      ['@deepseek-ai/dsh-storage-domain', StorageDomain],
      ['@deepseek-ai/dsh-credentials-local', CredentialsLocal],
      ['@deepseek-ai/dsh-riko-memory', RikoMemoryService],
    ])
    context.loader.internal = {
      version: 'v2',
      async import(specifier: string) {
        const module = modules.get(specifier)
        if (module === undefined) throw new Error(`unexpected Loader import: ${specifier}`)
        return module
      },
    } as unknown as NonNullable<typeof context.loader.internal>
    await context.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
    await awaitLiveReady(context)
    return {
      context,
      base: `http://127.0.0.1:${String(context.webServer.port)}/memory/v1`,
      root,
      dispose,
    }
  } catch (error) {
    await dispose()
    throw error
  }
}

/** Create the minimal Agent object accepted by DSH's event waterfall. */
export function testAgent(context: Context, session: Session): Agent {
  return { id: session.id, session, ctx: context } as unknown as Agent
}
