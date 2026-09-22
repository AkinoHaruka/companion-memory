/** Real Loader/HTTP/Agent corpus execution, attributed JSON evidence and bounded artifact retention. */
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { expect, vi } from 'vitest'
import { agentEvents } from '@deepseek-ai/dsh-agent'
import { createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { memoryScopeForPreset } from '../../src/contracts.ts'
import { scopedRecordKey } from '../../src/memory-domain.ts'
import type { RecallResult, RecallTrace } from '../../src/recall.ts'
import { companionCorpus, type CompanionScenario } from './companion-corpus.ts'
import {
  answerGeneratorFromEnvironment,
  createProviderRequestGate,
  fetchWithProviderRetry,
  type AnswerProviderSettings,
  type AnswerGenerator,
  type ProviderRequestGate,
} from './answer-evaluation.ts'
import { startLiveHarness, drainInFlight, evidenceDrainBudgetMs, readPersistedEvidence, testAgent, type LiveHarness } from './live-harness.ts'
import { fetchLive } from './live-http.ts'

/** Environment variable selecting the real Dream chat-completions endpoint for a campaign. */
export const DREAM_ENDPOINT_ENV = 'DSH_MEMORY_DREAM_ENDPOINT'
/** Environment variable supplying the credential written to the campaign's disposable credentials file. */
export const DREAM_KEY_ENV = 'DSH_MEMORY_DREAM_KEY'
/** Optional path for a durable per-scenario campaign checkpoint. */
export const CAMPAIGN_CHECKPOINT_ENV = 'DSH_MEMORY_CAMPAIGN_CHECKPOINT'

const FIXTURE_DREAM_API_URL = 'https://api.test/api/v1/chat/completions'
const REAL_PROVIDER_ROUTE_TIMEOUT_MS = 90_000

interface Snapshot {
  pages: Array<{ id: string; description: string; title: string; status: string }>
  candidates: Array<{ status: string; page: { body: string } }>
  observations?: Array<{ text: string }>
  sessions: string[]
  resident: string
  lastError?: string
}

/** Raw observations are retained separately from the human-authored expected outcome. */
export interface RawOutcome {
  scenario: CompanionScenario
  status: 'executed' | 'unsupported' | 'error'
  observedLabel: string
  reason?: string
  injected: string
  resident: string
  results: readonly RecallResult[]
  trace?: RecallTrace
  snapshot?: Snapshot
  checks: Record<string, boolean>
  exchanges: Array<{ path: string; status: number; body: unknown }>
  toolResults: Array<{ isError: boolean; value?: unknown }>
  diskMatches?: string[]
  /** Final assistant answer generated from the same context captured in `injected`. */
  answer?: string
}

async function diskMatches(root: string, needle: string): Promise<string[]> {
  const matches: string[] = []
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) matches.push(...await diskMatches(path, needle))
    else if ((await readFile(path, 'utf8')).includes(needle)) matches.push(path)
  }
  return matches
}

/**
 * Render an error and every cause beneath it as one line-per-link chain.
 *
 * A Node transport failure reaches the caller as a bare `TypeError: fetch failed`, and the
 * detail that classifies it — `ECONNREFUSED`, `ECONNRESET`, `UND_ERR_SOCKET`, a TLS error —
 * lives on `error.cause` one or more levels down, where a stack never shows it. Walking the
 * chain records that detail with the outcome, so the next occurrence names its own cause.
 * @param error - Any thrown value, with or without a cause chain.
 * @returns One link per line, outermost first, joined by `<- caused by`.
 */
export function describeError(error: unknown): string {
  const links: string[] = []
  const seen = new Set<unknown>()
  let current: unknown = error
  while (current !== undefined && current !== null && !seen.has(current)) {
    seen.add(current)
    if (current instanceof Error) {
      const code = (current as { code?: unknown }).code
      links.push(`${current.name}: ${current.message}${code === undefined ? '' : ` [code=${String(code)}]`}`)
    } else links.push(`thrown ${typeof current}: ${String(current)}`)
    current = (current as { cause?: unknown }).cause
  }
  return links.join(' <- caused by ')
}

/** How one corpus execution is configured. */
export interface CorpusRunOptions {
  /**
   * Whether each harness starts with `evidenceClassificationEnabled: true`.
   *
   * On by default: the corpus measures the shipped capability, and the three scenarios that declare
   * `requiresEvidenceClassification` only have an observable channel when it is on. Turning it off is a
   * deliberate capability comparison, and those scenarios are then reported as unsupported.
   */
  readonly evidenceClassification?: boolean
  /** Whether this run uses the keyless deterministic dense provider, and whether vector recall is enabled. */
  readonly denseEnabled?: boolean
  /**
   * Real embedding endpoint used instead of the deterministic provider when dense recall is on.
   * The endpoint must speak the OpenAI `/embeddings` protocol over loopback HTTP; the
   * `embedding-failure` scenario keeps its hardcoded 503 fixture regardless, because that
   * scenario measures degradation, not retrieval quality.
   */
  readonly denseEmbedding?: { readonly endpoint: string; readonly model: string; readonly credentialRef: string }
  /** Optional final-answer provider; when absent, the environment-selected provider is used. */
  readonly answerGenerator?: AnswerGenerator
  /** Optional non-secret answer endpoint/model/key settings for a campaign launcher. */
  readonly answerProvider?: AnswerProviderSettings
  /** Dream endpoint override; defaults to `DSH_MEMORY_DREAM_ENDPOINT` or the fixture endpoint. */
  readonly dreamApiUrl?: string
  /** Credential passed to `startLiveHarness`; defaults to `DSH_MEMORY_DREAM_KEY` when configured. */
  readonly dreamApiKey?: string
  /** Optional Dream model override for a real-provider run. */
  readonly dreamModel?: string
  /** Shared provider pacing state for one corpus run. */
  readonly providerGate?: ProviderRequestGate
  /** Optional durable checkpoint; completed scenarios are reused and errors are retried. */
  readonly checkpointPath?: string
}

/** One corpus execution set for one side of the dense ablation. */
export interface CorpusRun {
  readonly path: string
  readonly outcomes: readonly RawOutcome[]
}

/** Paired corpus runs with the same scenarios and deterministic dense settings. */
export interface DenseAblationRun {
  readonly denseOff: CorpusRun
  readonly denseOn: CorpusRun
}

/** A completed outcome is safe to reuse after an interrupted campaign. */
export function isCompletedCampaignOutcome(outcome: Pick<RawOutcome, 'status'>): boolean {
  return outcome.status === 'executed' || outcome.status === 'unsupported'
}

/**
 * Build a provider/configuration identity without including any credential material.
 *
 * A checkpoint is evidence for one provider configuration, not a general-purpose answer cache.
 * Endpoint and model changes therefore invalidate it, while changing a secret does not leak that
 * secret into the checkpoint or change the identity of the same configured provider.
 * @param options - Corpus options whose non-secret values define the run.
 * @returns A stable SHA-256 identity for checkpoint compatibility checks.
 */
export function campaignCheckpointKey(options: CorpusRunOptions = {}): string {
  const identity = {
    corpus: companionCorpus.map(scenario => scenario.id),
    evidenceClassification: options.evidenceClassification !== false,
    denseEnabled: options.denseEnabled ?? null,
    denseEmbedding: options.denseEmbedding === undefined ? null : {
      endpoint: options.denseEmbedding.endpoint,
      model: options.denseEmbedding.model,
      credentialRef: options.denseEmbedding.credentialRef,
    },
    dreamEndpoint: options.dreamApiUrl?.trim() || process.env[DREAM_ENDPOINT_ENV]?.trim() || FIXTURE_DREAM_API_URL,
    dreamModel: options.dreamModel?.trim() || process.env.DSH_MEMORY_DREAM_MODEL?.trim() || '',
    answerEndpoint: options.answerProvider?.endpoint?.trim() || process.env.DSH_MEMORY_ANSWER_ENDPOINT?.trim() || '',
    answerModel: options.answerProvider?.model?.trim() || process.env.DSH_MEMORY_ANSWER_MODEL?.trim() || '',
    answerMode: options.answerGenerator === undefined ? 'environment' : 'custom',
  }
  return createHash('sha256').update(JSON.stringify(identity)).digest('hex')
}

interface CampaignCheckpointDocument {
  schemaVersion: 1
  campaignKey: string
  updatedAt: string
  outcomes: RawOutcome[]
}

async function loadCampaignCheckpoint(path: string, campaignKey: string): Promise<RawOutcome[]> {
  const text = await readFile(path, 'utf8').catch((error: unknown) => {
    if ((error as { code?: string }).code === 'ENOENT') return undefined
    throw error
  })
  if (text === undefined) return []
  let parsed: unknown
  try { parsed = JSON.parse(text) } catch { throw new Error(`campaign checkpoint is not valid JSON: ${path}; remove it or resume with a new path`) }
  if (typeof parsed !== 'object' || parsed === null) throw new Error(`campaign checkpoint is not an object: ${path}`)
  const document = parsed as Partial<CampaignCheckpointDocument>
  if (document.schemaVersion !== 1 || document.campaignKey !== campaignKey || !Array.isArray(document.outcomes)) {
    throw new Error(`campaign checkpoint does not match the current provider/model/corpus configuration: ${path}; use a new checkpoint path`)
  }
  return document.outcomes.filter((outcome): outcome is RawOutcome => (
    typeof outcome === 'object' && outcome !== null && typeof (outcome as RawOutcome).scenario?.id === 'string'
  ))
}

async function saveCampaignCheckpoint(path: string, campaignKey: string, outcomes: readonly RawOutcome[]): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.tmp-${String(process.pid)}`
  const document: CampaignCheckpointDocument = {
    schemaVersion: 1,
    campaignKey,
    updatedAt: new Date().toISOString(),
    outcomes: [...outcomes],
  }
  await writeFile(temporary, JSON.stringify(document, null, 2) + '\n')
  await rename(temporary, path)
}

/**
 * Why a scenario that needs capture classification is unsupported in a run that has it switched off.
 *
 * An absent capability is not a failed behaviour, so the scenario is removed from every denominator with
 * this reason instead of being scored against an observation the run could not produce.
 * @param scenario - The corpus case the runner declined to interpret.
 * @returns The reason recorded on the unsupported outcome.
 */
export function evidenceClassificationUnsupportedReason(scenario: CompanionScenario): string {
  return `${scenario.id} measures the L0 capture-classification channel, and this run starts every harness with evidenceClassificationEnabled=false`
}

/**
 * Execute one corpus scenario against its own isolated Loader composition.
 *
 * Exported so a spec can exercise a single case under a different capability setting without paying for
 * the whole corpus, which is what lets the `requiresEvidenceClassification` contract be asserted.
 * @param scenario - The corpus case to execute.
 * @param options - Capability settings for this execution; classification is on unless passed false.
 * @returns The attributed raw observation for that case.
 */
export async function executeCompanion(scenario: CompanionScenario, options: CorpusRunOptions = {}): Promise<RawOutcome> {
  const raw: RawOutcome = { scenario, status: 'executed', observedLabel: '', injected: '', resident: '', results: [], checks: {}, exchanges: [], toolResults: [] }
  if (scenario.unsupported !== undefined) return { ...raw, status: 'unsupported', observedLabel: 'unsupported', reason: scenario.unsupported }
  const evidenceClassification = options.evidenceClassification !== false
  if (scenario.requiresEvidenceClassification === true && !evidenceClassification) {
    return { ...raw, status: 'unsupported', observedLabel: 'unsupported', reason: evidenceClassificationUnsupportedReason(scenario) }
  }
  const root = await mkdtemp(join(tmpdir(), 'riko-companion-'))
  let harness: LiveHarness | undefined
  const nativeFetch = globalThis.fetch
  const providerGate = options.providerGate ?? createProviderRequestGate()
  const answerGenerator = options.answerGenerator ?? answerGeneratorFromEnvironment(providerGate, nativeFetch, options.answerProvider)
  const kind = scenario.setup.kind
  const sessionId = `eval-${scenario.id.replace('.', '-')}`
  let providerCalls = 0
  // A scenario that measures the L0 classification channel starts its own harness with the capability on,
  // so every append in this scenario is classified as it is captured rather than being reinterpreted later.
  const denseConfig = options.denseEnabled === undefined
    ? kind === 'embedding-failure' ? ['    recallVectorEnabled: true', '    embeddingProvider: openai-compatible', '    embeddingEndpoint: https://api.test/embeddings', '    embeddingCredentialRef: DSH_MEMORY_DREAM_API_KEY', '    embeddingModel: fixture'] : []
    : options.denseEmbedding
      ? ['    recallVectorEnabled: true', '    embeddingProvider: openai-compatible', `    embeddingEndpoint: ${options.denseEmbedding.endpoint}`, `    embeddingModel: ${options.denseEmbedding.model}`, `    embeddingCredentialRef: ${options.denseEmbedding.credentialRef}`]
      : [`    recallVectorEnabled: ${String(options.denseEnabled)}`, '    embeddingProvider: deterministic']
  const configuredDreamApiUrl = options.dreamApiUrl?.trim() || process.env[DREAM_ENDPOINT_ENV]?.trim()
  const campaignMode = configuredDreamApiUrl !== undefined && configuredDreamApiUrl !== FIXTURE_DREAM_API_URL
  const dreamApiUrl = configuredDreamApiUrl || FIXTURE_DREAM_API_URL
  const dreamApiKey = options.dreamApiKey ?? process.env[DREAM_KEY_ENV]
  const config = [
    '    recallEnabled: true',
    '    purgeEnabled: true',
    '    recallGraphEnabled: true',
    '    temporalEnabled: true',
    `    dreamApiUrl: ${JSON.stringify(dreamApiUrl)}`,
    ...(options.dreamModel === undefined ? [] : [`    dreamModel: ${JSON.stringify(options.dreamModel)}`]),
    ...(scenario.requiresEvidenceClassification === true ? ['    evidenceClassificationEnabled: true'] : []),
    ...(kind === 'purge-crash-recovery' ? ['    minObservationEvidence: 1'] : []),
    ...(kind === 'overflow' || kind === 'long-tail' ? ['    maxResidentChars: 256'] : []),
    ...denseConfig,
  ]
  const markdown = (text: string): string => `---\ntype: concept\ntitle: ${text}\ndescription: ${text}\nsources:\n  - ${sessionId}\ntimestamp: 2026-09-19T00:00:00.000Z\nconfidence: 0.9\nstatus: confirmed\nconsent: true\nlocked: true\n---\n${text}\n`
  globalThis.fetch = campaignMode
    ? ((input: RequestInfo | URL, init?: RequestInit) => {
      const inputUrl = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (inputUrl.startsWith('https://api.test/embeddings')) return Promise.resolve(new Response('{}', { status: 503 }))
      const isDreamRequest = inputUrl === dreamApiUrl || inputUrl.startsWith(`${dreamApiUrl}/`)
      if (!isDreamRequest) return nativeFetch(input, init)
      // The degradation trial injects its own provider failure. A live endpoint would answer it, so the
      // fault stays in the fixture; the call is counted once because the plugin did make one.
      if (kind === 'dream-failure') { providerCalls += 1; return Promise.resolve(new Response('{}', { status: 503 })) }
      if (kind === 'purge-crash-recovery') return Promise.resolve(new Response('{"choices":[]}', { status: 200 }))
      return fetchWithProviderRetry(input, init, { gate: providerGate, fetchImpl: nativeFetch, onAttempt: () => { providerCalls += 1 } })
    })
    : ((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).startsWith('https://api.test/embeddings')) return Promise.resolve(new Response('{}', { status: 503 }))
      if (String(input) !== FIXTURE_DREAM_API_URL) return nativeFetch(input, init)
      providerCalls += 1
      if (kind === 'dream-failure') return Promise.resolve(new Response('{}', { status: 503 }))
      if (kind === 'purge-crash-recovery') return Promise.resolve(new Response('{"choices":[]}', { status: 200 }))
      return Promise.resolve(new Response(JSON.stringify({ choices: [{ message: { content: `<<<FILE path="wiki/concepts/candidate.md">>>\n${markdown(scenario.setup.text)}<<<END>>>` } }] })))
    })
  try {
    harness = await startLiveHarness(config, root, dreamApiKey)
    await vi.waitFor(() => { expect(harness?.context.webServer.port).toBeGreaterThan(0) }, { timeout: 15_000 })
    const request = async <T>(path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST', profile = 'standard', timeoutMs?: number): Promise<T> => {
      let response: Response
      try {
        // `fetchLive`, not the native fetch: this URL's port is OS-assigned, and Fetch refuses a
        // blocklisted port before it opens a socket. Windows here hands out ephemeral ports from
        // 1024-15000 (`netsh int ipv4 show dynamicport tcp`), which overlaps the blocklist, so the
        // native transport turns one scenario into `TypeError: fetch failed <- caused by Error: bad
        // port` often enough to fail a round. `fetchLive` is node:http for exactly this reason.
        response = await fetchLive(`http://127.0.0.1:${String(harness!.context.webServer.port)}/memory/v1${path}`, { method, headers: { 'content-type': 'application/json', 'x-dsh-memory-profile': profile }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, timeoutMs === undefined ? {} : { timeoutMs })
      } catch (error) {
        // A fetch-level failure carries no request identity of its own, so name the route on
        // the thrown error and keep its cause chain intact for the recorded outcome.
        throw new Error(`transport failure on ${method} ${path}: ${describeError(error)}`)
      }
      const value: unknown = await response.json()
      raw.exchanges.push({ path, status: response.status, body: value })
      if (!response.ok) throw new Error(`${path}: ${String(response.status)} ${JSON.stringify(value)}`)
      return value as T
    }
    const agentFor = (id: string, profile = 'standard'): ReturnType<typeof testAgent> => {
      const session = harness!.context.sessions.create(SessionId(id), { meta: { agentPreset: profile } })
      const agent = testAgent(harness!.context, session)
      harness!.context.emit('agent/created', { agent, source: 'startup' })
      return agent
    }
    let agent = agentFor(sessionId)
    const appendTo = (target: ReturnType<typeof testAgent>, text: string): void => {
      target.session.append('user/message', createUserMessage({
        content: [{ type: 'text', text }], source: { kind: 'user' },
      }), { surfaceOp: 'append' })
    }
    const append = (text: string): void => { appendTo(agent, text) }
    const tool = async (name: string, args: Record<string, unknown>): Promise<void> => {
      const result = await harness!.context.tools.execute({ signal: new AbortController().signal, callId: ToolCallId(`eval-${raw.toolResults.length}`), name, arguments: args, agent })
      raw.toolResults.push(result)
    }
    const base = (): string => `http://127.0.0.1:${String(harness!.context.webServer.port)}/memory/v1`
    const evidence = async (): Promise<void> => {
      // Every append in this scenario is synchronous, so the Session's L0 count is already
      // final here: freeze it once instead of re-deriving it inside the poll, because a
      // target that moves with the writer can never be awaited to a stable equality.
      const expected = agent.session.snapshotEvents().length
      // Draining the service's own in-flight set is the explicit readiness signal for the
      // persistence chain behind that count; it is not a retry.
      await drainInFlight(base(), expected)
      // Residual: a write accepted after the drain snapshotted the in-flight set. Observing it
      // necessarily waits, so the wait keeps both original assertions and takes a budget
      // derived from the chain's measured O(n^2) cost rather than a constant unrelated to the
      // awaited work. A healthy run already satisfies it on the first poll.
      await vi.waitFor(async () => {
        const persisted = await readPersistedEvidence(base(), sessionId)
        expect(persisted.status).toBe(200)
        expect(persisted.lineCount).toBe(expected)
      }, { timeout: evidenceDrainBudgetMs(expected), interval: 50 })
    }
    let pageId = ''
    if (kind === 'observation-weakening') {
      const supportAgents = [
        agent, agentFor(`${sessionId}-support`), agentFor(`${sessionId}-third-support`),
      ]
      supportAgents.forEach((supportAgent, index) => appendTo(
        supportAgent, `supporting work-routine evidence ${String(index + 1)}`,
      ))
      const contradictionAgents = ['one', 'two', 'three', 'four'].map(name => agentFor(`${sessionId}-contradiction-${name}`))
      contradictionAgents.forEach((contradictionAgent, index) => appendTo(
        contradictionAgent, `contradicting work-routine evidence ${String(index + 1)}`,
      ))
      await drainInFlight(base(), supportAgents.length + contradictionAgents.length)
      const created = await request<{ id: string; status: string }>('/observations', {
        text: scenario.setup.text,
        sourceRefs: supportAgents.map(supportAgent => `session:${String(supportAgent.session.id)}/event:0`),
      })
      raw.checks.observationActivated = created.status === 'active'
      const updated = await request<{
        status: string
        contradictingRefs?: readonly string[]
      }>(`/observations/${created.id}/evidence`, {
        contradictingRefs: contradictionAgents.map(contradictionAgent => (
          `session:${String(contradictionAgent.session.id)}/event:0`
        )),
      })
      raw.checks.observationInvalidated = updated.status === 'invalidated'
        && updated.contradictingRefs?.length === contradictionAgents.length
    }
    if (['remember', 'authority', 'dream', 'evidence', 'purge', 'forget', 'purge-crash-recovery'].includes(kind)) {
      append(scenario.setup.source ?? scenario.setup.text)
      await evidence()
    }
    if (kind === 'remember' || kind === 'authority') {
      await tool('memory_remember', { content: scenario.setup.text })
      raw.checks.authority = kind === 'authority' ? raw.toolResults[0]!.isError : !raw.toolResults[0]!.isError
    } else if (kind !== 'dream' && kind !== 'evidence' && kind !== 'observation-weakening') {
      const text = scenario.setup.text
      const page = await request<{ id: string }>('/wiki/pages', { path: 'wiki/concepts/target.md', ...(kind === 'purge' || kind === 'forget' || kind === 'purge-crash-recovery' ? { markdown: markdown(text) } : { type: 'concept', title: kind === 'graph' ? 'Orion' : text.slice(0, 60), content: text }) })
      pageId = page.id
      if (scenario.setup.sensitivity) await request(`/wiki/pages/${pageId}`, { sensitivity: scenario.setup.sensitivity }, 'PUT')
    }
    if (kind === 'purge-crash-recovery') {
      const domain = harness?.context.storageDomain.get('riko_memory')
      if (domain === undefined) throw new Error('riko_memory storage domain is not registered by the live harness')
      const scope = memoryScopeForPreset('test-owner', 'standard')
      await request('/observations', {
        text: scenario.setup.text,
        sourceRefs: [`session:${sessionId}/event:0`],
      })
      await domain.table('sessions').put(scopedRecordKey(scope, sessionId), {
        schemaVersion: 2,
        scope,
        sessionId,
        lines: [JSON.stringify({ seq: 0, type: 'user/message', data: scenario.setup.text })],
      })
      const jobId = `${sessionId}-purge-job`
      await domain.table('jobs').put(scopedRecordKey(scope, jobId), {
        schemaVersion: 2,
        scope,
        job: { id: jobId, sessionId, status: 'pending' },
      })
      const plan = await request<{ confirmation: string }>('/purge', { sessionId, dryRun: true })
      const operationId = `purge-${plan.confirmation}`
      await domain.table('purges').put(scopedRecordKey(scope, operationId), {
        schemaVersion: 2,
        scope,
        purge: { operationId, sessionId, status: 'started', startedAt: new Date().toISOString() },
      })
    }
    if (kind === 'long-tail') {
      for (let index = 0; index < 300; index += 1) append(`unrelated intervening turn ${index}`)
      await evidence()
      raw.checks.longTail = agent.session.snapshotEvents().filter(event => event.type === 'user/message').length === 300
    }
    if (kind === 'correct') await request(`/wiki/pages/${pageId}`, { title: scenario.setup.replacement, content: scenario.setup.replacement }, 'PUT')
    if (kind === 'temporal' || kind === 'historical') await request(`/wiki/pages/${pageId}/temporal`, { validFrom: '2026-01-01T00:00:00.000Z', title: scenario.setup.replacement, content: scenario.setup.replacement })
    if (kind === 'supersede') await request(`/wiki/pages/${pageId}/supersede`, {})
    if (kind === 'suppress') {
      append(`不要再主动提 ${scenario.setup.text}`)
      await tool('memory_suppress', { target: scenario.setup.text })
      raw.checks.suppressed = !raw.toolResults[0]!.isError
    }
    if (kind === 'forget') {
      const deletion = await request<{ rawSessionRetained: boolean }>(`/wiki/pages/${pageId}`, undefined, 'DELETE')
      raw.checks.rawRetentionDisclosed = deletion.rawSessionRetained
      await request(`/sessions/${sessionId}`)
    }
    if (kind === 'purge') {
      const plan = await request<{ confirmation: string }>('/purge', { sessionId, dryRun: true })
      const deletion = await request<{ verified: boolean; rawSessionRetained: boolean }>('/purge', { sessionId, confirmation: plan.confirmation })
      raw.checks.purgeVerified = deletion.verified && !deletion.rawSessionRetained
    }
    if (kind === 'graph') await request('/wiki/pages', { path: 'wiki/concepts/vega.md', type: 'concept', title: 'Vega', content: scenario.setup.replacement })
    if (kind === 'dream' || kind === 'dream-failure') {
      if (kind === 'dream-failure') { append('dream failure anchor'); await evidence() }
      await request('/dream', { sessionId })
      await vi.waitFor(async () => {
        const state = await request<Snapshot>('/wiki', undefined, 'GET', 'standard', REAL_PROVIDER_ROUTE_TIMEOUT_MS)
        expect(providerCalls).toBeGreaterThan(0)
        if (kind === 'dream') expect(state.candidates.length).toBeGreaterThan(0)
        else expect(state.lastError).toBeTruthy()
      }, { timeout: 120_000 })
    }
    if (kind === 'restart' || kind === 'purge' || kind === 'evidence' || kind === 'purge-crash-recovery') {
      // The evidence trial restarts for the same reason the others do — to read state back from durable
      // records rather than from the process that wrote it. Its classification is not patched on the way:
      // the value the capture rule wrote is what the restarted service has to reload and honour.
      await harness.dispose()
      harness = undefined
      harness = await startLiveHarness(config, root, dreamApiKey)
      await vi.waitFor(() => { expect(harness?.context.webServer.port).toBeGreaterThan(0) }, { timeout: 15_000 })
      agent = agentFor(`${sessionId}-restart`)
    }
    const profile = kind === 'scope' ? 'other-profile' : 'standard'
    if (kind === 'scope') agent = agentFor(`${sessionId}-other`, profile)
    raw.snapshot = await request<Snapshot>('/wiki', undefined, 'GET', profile)
    raw.resident = raw.snapshot.resident
    if (kind === 'purge-crash-recovery') {
      const domain = harness?.context.storageDomain.get('riko_memory')
      if (domain === undefined) throw new Error('riko_memory storage domain is not registered by the live harness')
      const scope = memoryScopeForPreset('test-owner', 'standard')
      const purges = await request<{ purges: Array<{ operationId: string; sessionId: string; status: string }> }>('/purges')
      const journal = [...domain.table('purges').entries()]
        .map(([, value]) => (value as { purge?: { operationId?: string; sessionId?: string; status?: string } }).purge)
        .find(value => value?.sessionId === sessionId)
      const completed = purges.purges.some(purge => purge.sessionId === sessionId && purge.status === 'completed')
      const cascadeTables = [
        'profiles', 'pages', 'candidates', 'sources', 'sessions', 'jobs', 'observations', 'audits',
        'suppressions', 'activation', 'index_meta', 'vectors', 'aliases', 'projections', 'conflicts',
      ]
      const residue = cascadeTables.flatMap(tableName => [...domain.table(tableName).entries()].filter(([, value]) => {
        const text = JSON.stringify(value)
        return text.includes(sessionId) || text.includes(scenario.setup.text)
      }))
      raw.checks.purgeCrashRecovery = completed
        && journal !== undefined
        && domain.table('purges').get(scopedRecordKey(scope, journal.operationId!)) !== undefined
        && !raw.snapshot.sessions.includes(sessionId)
        && !JSON.stringify(raw.snapshot.pages).includes(scenario.setup.text)
        && !(raw.snapshot.observations ?? []).some(observation => observation.text.includes(scenario.setup.text))
        && residue.length === 0
    }
    const recalled = await request<{ results: RecallResult[]; context: string }>('/recall', { query: scenario.userTurn, ...(kind === 'historical' ? { history: true } : {}) }, 'POST', profile)
    raw.results = recalled.results
    const debug = await request<{ trace: RecallTrace }>('/recall/debug', { query: scenario.userTurn, ...(kind === 'historical' ? { history: true } : {}) }, 'POST', profile)
    raw.trace = debug.trace
    const step = await agentEvents(harness.context, agent).waterfall('agent/pre-step', {
      messages: [createUserMessage({ content: [{ type: 'text', text: scenario.userTurn }], source: { kind: 'user' } })], turn: 1, step: 1, signal: new AbortController().signal,
    }, () => Promise.resolve({ kind: 'enter' as const, messages: [] }))
    raw.injected = kind === 'historical' ? recalled.context : JSON.stringify(step.kind === 'enter' ? step.messages : [])
    if (answerGenerator !== undefined) {
      raw.answer = await answerGenerator({
        scenario,
        userTurn: scenario.userTurn,
        injectedContext: raw.injected,
        resident: raw.resident,
        results: raw.results,
        trace: raw.trace,
      })
    }
    if (kind === 'dream') raw.checks.authority = raw.snapshot.pages.every(page => !page.description.includes(scenario.setup.text)) && raw.snapshot.candidates.length > 0
    if (kind === 'embedding-failure' && options.denseEnabled === undefined) raw.checks.providerFallback = raw.trace.degradedModes.includes('vector-degraded')
    if (kind === 'overflow') raw.checks.wholeItemBudget = raw.resident.length <= 256 && !raw.resident.includes('oversized whole item')
    if (kind === 'evidence') raw.checks.rawRecovery = raw.results.some(result => result.sourceType === 'evidence' && result.text.includes('B-417'))
    if (kind === 'correct') raw.checks.correction = !JSON.stringify([raw.snapshot.pages, raw.resident, raw.results]).includes(scenario.setup.text) && raw.snapshot.pages.some(page => page.description.includes(scenario.setup.replacement!))
    if (kind === 'forget' || kind === 'purge' || kind === 'purge-crash-recovery') raw.checks.derivedLeakage = !JSON.stringify([raw.snapshot.pages, raw.snapshot.candidates, raw.resident, raw.results, raw.injected]).includes(scenario.setup.text)
    if (kind === 'purge') { raw.diskMatches = await diskMatches(join(root, 'storages'), scenario.setup.text); raw.checks.diskLeakage = raw.diskMatches.length === 0 }
    const output = scenario.id === 'F.27' || scenario.id === 'F.24' ? raw.injected : raw.injected + raw.resident
    if (scenario.expected.excludes !== undefined) raw.checks.exclusion = !output.includes(scenario.expected.excludes)
    if (scenario.expected.contains !== undefined) raw.checks.inclusion = output.includes(scenario.expected.contains)
    const hasInjection = raw.results.some(result => result.mentionDecision === 'explicit') || (scenario.id !== 'F.27' && raw.resident.length > 0)
    raw.observedLabel = hasInjection ? 'correct injection' : raw.injected.includes('<internal-memory-guidance>') ? 'governed use' : 'correct silence'
    if (Object.values(raw.checks).some(check => !check)) raw.observedLabel = raw.checks.authority === false ? 'authority violation' : raw.checks.derivedLeakage === false ? kind === 'purge' ? 'purge leakage' : 'forget leakage' : raw.checks.diskLeakage === false ? 'purge leakage' : raw.checks.exclusion === false ? 'unwanted mention' : 'wrong injection'
  } catch (error) {
    raw.status = 'error'
    raw.observedLabel = 'execution error'
    // Record the cause chain alongside the stack: without it a transport failure is recorded
    // as an unattributable `TypeError: fetch failed` that no later reader can classify.
    const stack = error instanceof Error ? error.stack : undefined
    raw.reason = stack === undefined ? describeError(error) : `${describeError(error)}\n${stack}`
  } finally {
    try { await harness?.dispose() } finally { globalThis.fetch = nativeFetch; await rm(root, { recursive: true, force: true }) }
  }
  return raw
}

/** How many of the most recent corpus runs are kept on disk after a round. */
export const RETAINED_RUNS = 3

/** Marker a run drops in its own directory so a concurrent prune can see that it is still writing. */
const RUN_OWNER_FILE = 'owner.json'

/**
 * How long a run directory counts as live from its own timestamp alone.
 *
 * `raw-results.json` is rewritten after every scenario, so a live directory's timestamp is at most
 * one scenario old. The window only has to cover the gap between `mkdtemp` and the owner marker
 * landing — the one moment a directory exists without a readable owner.
 */
const LIVE_RUN_GRACE_MS = 30_000

/** Whether a pid still names a running process; EPERM means it exists but is not ours to signal. */
function isRunning(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch (error) { return (error as { code?: string }).code === 'EPERM' }
}

/** The pid that claimed one run directory, or undefined when no readable marker claims it. */
async function runOwner(path: string): Promise<number | undefined> {
  const marker = await readFile(join(path, RUN_OWNER_FILE), 'utf8').catch(() => undefined)
  if (marker === undefined) return undefined
  try {
    const pid = (JSON.parse(marker) as { pid?: unknown }).pid
    return typeof pid === 'number' ? pid : undefined
  } catch { return undefined }
}

/**
 * Delete corpus run directories beyond the newest `keep` ones that no live run still owns.
 *
 * Run directories are `mkdtemp`-minted as `companion-<random>`, and a run only ever creates
 * entries inside its own directory, so the directory's own timestamp is its start time. Only
 * directories carrying the `companion-` prefix are candidates, so the artifacts directory's
 * own files — its `.gitignore` above all — are never touched.
 *
 * Recency alone is not enough to decide this. "Beyond the newest `keep`" is a statement about one
 * process's view of the directory, and the newest runs on disk are precisely the ones a second
 * corpus process started concurrently may still be writing into: it mints `companion-<x>`, a third
 * process mints three newer directories, and the next prune deletes `companion-<x>` out from under
 * its owner, whose following `writeFile` then fails with ENOENT. A run therefore claims its
 * directory, and a directory whose claiming pid is still running is never a candidate — with the
 * timestamp window covering the moment before the claim exists.
 * @param directory - The artifacts directory that holds the run directories.
 * @param keep - How many of the newest run directories to retain.
 * @returns The removed paths, oldest first.
 */
export async function pruneCompanionRuns(directory: string, keep: number): Promise<string[]> {
  const runs: Array<{ path: string; startedAt: number }> = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith('companion-')) continue
    const path = join(directory, entry.name)
    runs.push({ path, startedAt: (await stat(path)).mtimeMs })
  }
  runs.sort((left, right) => right.startedAt - left.startedAt || right.path.localeCompare(left.path))
  const removed: string[] = []
  for (const run of runs.slice(Math.max(keep, 0))) {
    const owner = await runOwner(run.path)
    if ((owner !== undefined && isRunning(owner)) || Date.now() - run.startedAt < LIVE_RUN_GRACE_MS) continue
    await rm(run.path, { recursive: true, force: true })
    removed.push(run.path)
  }
  return removed.reverse()
}

/** Execute each case in an isolated Loader and retain results even when assertions fail.
 * @param options - Capability settings shared by every scenario in this run.
 * @returns Unique artifact path and the raw observations used by assertions and scorers.
 */
export async function runCompanionCorpus(options: CorpusRunOptions = {}): Promise<{ path: string; outcomes: RawOutcome[] }> {
  const directory = fileURLToPath(new URL('../artifacts/', import.meta.url))
  await mkdir(directory, { recursive: true })
  // Prune before minting this run's directory, so the retained set is the newest runs on
  // disk — the ones a concurrently started run may still be writing into — and this run is
  // simply the newest of `RETAINED_RUNS` afterwards. A round therefore leaves one artifact
  // per round instead of one per corpus execution, bounded at `RETAINED_RUNS` on disk.
  await pruneCompanionRuns(directory, RETAINED_RUNS - 1)
  const run = await mkdtemp(join(directory, 'companion-'))
  // Claim the directory immediately: another process's prune may push it out of the retained set
  // by recency long before this run stops writing into it.
  await writeFile(join(run, RUN_OWNER_FILE), JSON.stringify({ pid: process.pid }))
  const path = join(run, 'raw-results.json')
  const checkpointPath = options.checkpointPath?.trim() || process.env[CAMPAIGN_CHECKPOINT_ENV]?.trim()
  const checkpointKey = campaignCheckpointKey(options)
  const restored = checkpointPath === undefined ? [] : await loadCampaignCheckpoint(checkpointPath, checkpointKey)
  const scenarioIds = new Set(companionCorpus.map(scenario => scenario.id))
  const byScenario = new Map(restored.filter(outcome => scenarioIds.has(outcome.scenario.id)).map(outcome => [outcome.scenario.id, outcome]))
  let outcomes = companionCorpus.flatMap(scenario => {
    const outcome = byScenario.get(scenario.id)
    return outcome === undefined ? [] : [outcome]
  })
  const providerGate = options.providerGate ?? createProviderRequestGate()
  for (const scenario of companionCorpus) {
    const restoredOutcome = byScenario.get(scenario.id)
    if (restoredOutcome !== undefined && isCompletedCampaignOutcome(restoredOutcome)) continue
    byScenario.set(scenario.id, await executeCompanion(scenario, { ...options, providerGate }))
    outcomes = companionCorpus.flatMap(current => {
      const outcome = byScenario.get(current.id)
      return outcome === undefined ? [] : [outcome]
    })
    await writeFile(path, JSON.stringify({ schemaVersion: 1, outcomes }, null, 2) + '\n')
    if (checkpointPath !== undefined) await saveCampaignCheckpoint(checkpointPath, checkpointKey, outcomes)
  }
  if (outcomes.length > 0) await writeFile(path, JSON.stringify({ schemaVersion: 1, outcomes }, null, 2) + '\n')
  return { path, outcomes }
}

/**
 * Run every corpus case once with dense disabled and once with deterministic dense recall enabled.
 * @returns Paired raw observations and their artifact paths.
 */
export async function runDenseAblation(): Promise<DenseAblationRun> {
  const denseOff = await runCompanionCorpus({ denseEnabled: false })
  const denseOn = await runCompanionCorpus({ denseEnabled: true })
  return { denseOff, denseOn }
}

/**
 * Same pairing as {@link runDenseAblation}, but the dense-on trial uses a real OpenAI-compatible
 * embedding endpoint instead of the deterministic provider.
 * @param embedding Loopback endpoint, model name, and credential ref for the real provider.
 * @returns Paired raw observations and their artifact paths.
 */
export async function runDenseAblationWithProvider(embedding: NonNullable<CorpusRunOptions['denseEmbedding']>): Promise<DenseAblationRun> {
  const denseOff = await runCompanionCorpus({ denseEnabled: false })
  const denseOn = await runCompanionCorpus({ denseEnabled: true, denseEmbedding: embedding })
  return { denseOff, denseOn }
}
