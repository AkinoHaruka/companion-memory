/** Native, scoped Session -> Candidate -> Wiki -> Resident memory plugin. */

import type { IncomingMessage, ServerResponse } from 'node:http'
/* oxlint-disable @stylistic/max-len */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/cordis-plugin-timer'
import type {} from '@deepseek-ai/dsh-credentials'
import { credentialRef, isCredentialRefName } from '@deepseek-ai/dsh-credentials'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-tools'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import type {} from '@deepseek-ai/dsh-agent-presets'
import type {} from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { memoryScopeForPreset, type MemoryScope } from './contracts.ts'
import { MEMORY_DOMAIN, type MemoryDomain, type MemorySessionRecord } from './memory-domain.ts'
import { memoryId, MemoryProfileStore } from './store.ts'
import type { DreamSettings, MemoryCategory, MemoryItem, MemoryKind, MemoryObservation, MemorySensitivity, MemorySnapshot, UnclassifiedEvidenceDisclosure } from './types.ts'
import { contentHash, pageFolder, pageSlug, parseWikiMarkdown, renderWikiMarkdown, wikiPageId, type WikiPage } from './wiki.ts'
import { WIKI_GRAPH_MAX_HOPS } from './wiki.ts'
import { memoryUiHtml } from './ui.ts'
import { buildDreamRequest, extractDreamText } from './dream-protocol.ts'
import { analyzeRecallQuery, renderRecallContext, type EmbeddingProvider, type RecallResponse } from './recall.ts'
import { createEmbeddingProvider } from './embedding-provider.ts'
import { classifyMemorySensitivity } from './sensitivity.ts'

export type { EvidenceRef, MemoryCandidate, MemoryScope, WikiPage as MemoryWikiPage, ResidentSnapshot as MemoryResidentSnapshot, DreamJob } from './contracts.ts'
export type { MemoryObservation, ObservationStatus, ResidentBlock, ResidentBlockKind } from './types.ts'
export type { DreamSettings, MemoryCategory, MemoryItem, MemoryKind, MemorySnapshot, MemoryStatus, RecallAuthorityTier } from './types.ts'
export type { EmbeddingProvider, MemoryReranker, RecallIntent, RecallOptions, RecallPlan, RecallResponse, RecallResult, RecallTrace } from './recall.ts'

/** Runtime configuration. Secrets are never accepted here; only credential references are. */
export interface Config {
  /** Owner namespace used to derive the isolated memory scope. */
  readonly ownerNamespace: string
  /** HTTP prefix for the management API and UI. */
  readonly apiPath: string
  /** Single bearer token for the default profile. */
  readonly apiToken: string
  /** Bearer-token map that binds profiles to separate scopes. */
  readonly apiTokens: Readonly<Record<string, string>>
  /** Profile selected by the single-token authentication mode. */
  readonly apiTokenProfile: string
  /** Owner-admin bearer token that grants management access across profiles. */
  readonly ownerAdminToken: string
  /** Dream provider endpoint used for Wiki extraction. */
  readonly dreamApiUrl: string
  /** Credential reference resolved when Dream calls the provider. */
  readonly dreamCredentialRef: string
  /** Model name sent to the Dream provider. */
  readonly dreamModel: string
  /** Maximum Dream completion tokens. */
  readonly dreamMaxTokens: number
  /** Interval for scheduled Dream recovery and sweep work. */
  readonly dreamIntervalMs: number
  /** Delay before session activity schedules Dream. */
  readonly debounceMs: number
  /** Maximum serialized Resident prompt length. */
  readonly maxResidentChars: number
  /** Maximum transcript length used for Dream input and recovery. */
  readonly maxSessionChars: number
  /** Enables query-time recall in the Agent hook and HTTP route. */
  readonly recallEnabled: boolean
  /** Enables planner-gated dense vector recall. */
  readonly recallVectorEnabled: boolean
  /** Allows bounded raw L0 evidence as a recall channel. */
  readonly recallRawEvidenceEnabled: boolean
  /** Allows active observations as a recall channel. */
  readonly recallObservationEnabled: boolean
  /** Enables bounded Wiki graph expansion during recall. */
  readonly recallGraphEnabled: boolean
  /** Enables authenticated raw-session purge transactions. */
  readonly purgeEnabled: boolean
  /** Maximum recall results before rendering. */
  readonly recallMaxCandidates: number
  /** Maximum rendered recall context length. */
  readonly recallMaxContextChars: number
  /** Minimum reserved seats for non-L0 authoritative recall candidates; defaults to 4. */
  readonly recallAuthoritativeReserve: number
  /** Maximum raw L0 evidence candidates admitted per recall; defaults to 2. */
  readonly recallRawEvidenceMaxCandidates: number
  /** Enables the structured Resident projection path. */
  readonly residentV2Enabled: boolean
  /** Enables bounded structured Resident blocks. */
  readonly residentBlocksEnabled: boolean
  /** Allows eligible sensitive pages in Resident output. */
  readonly sensitiveResidentEnabled: boolean
  /** Enables temporal validity and historical recall semantics. */
  readonly temporalEnabled: boolean
  /** Classify user-origin L0 evidence at capture; off leaves every unmarked event fail-closed sensitive. */
  readonly evidenceClassificationEnabled: boolean
  /**
   * Disclosure policy for unclassified fail-closed L0 evidence.
   * Defaults to `user_explicit_only`; raw text returns only when the user initiates the turn, explicitly recalls
   * the topic, and the topic matches.
   */
  readonly unclassifiedEvidenceDisclosure: UnclassifiedEvidenceDisclosure
  /** Minimum distinct valid anchors for an observation candidate. */
  readonly minObservationEvidence: number
  /** Minimum distinct evidence anchors for automatic observation activation. */
  readonly observationActivationMinEvidence: number
  /** Minimum distinct sessions for automatic observation activation. */
  readonly observationActivationMinSessions: number
  /** Minimum confidence for automatic observation activation. */
  readonly observationActivationMinConfidence: number
  /** Enables Dream reflection that proposes anchored observations. */
  readonly reflectionEnabled: boolean
  /** Maximum observation proposals accepted from one reflection. */
  readonly reflectionMaxObservations: number
  /** Enables temporal reconciliation during Dream processing. */
  readonly temporalReconcileEnabled: boolean
  /** Selects no, deterministic, or OpenAI-compatible embeddings. */
  readonly embeddingProvider: 'off' | 'deterministic' | 'openai-compatible'
  /** HTTPS endpoint for the OpenAI-compatible embedding provider. */
  readonly embeddingEndpoint: string
  /** Credential reference for the embedding provider. */
  readonly embeddingCredentialRef: string
  /** Model name sent to the OpenAI-compatible embedding provider. */
  readonly embeddingModel: string
  /** Vector dimension used by deterministic and compatible providers. */
  readonly embeddingDimension: number
}

interface AuthenticatedRequest {
  readonly profile: string
  readonly ownerAdmin: boolean
}

const categories: readonly MemoryCategory[] = ['traits_roles', 'interaction_rules', 'key_experiences', 'promises_goals', 'emotions']
const kinds: readonly MemoryKind[] = ['fact', 'preference', 'event', 'boundary', 'emotion']

/** Service implementation. Storage and scope are resolved through native DSH seams. */
export class RikoMemoryService extends Service {
  static inject = ['agents', 'sessions', 'systemPrompt', 'webServer', 'timer', 'sessionProjections', 'storageDomain', 'credentials', 'tools']

  static Config: z<Config> = z.object({
    ownerNamespace: z.string().default('local'),
    apiPath: z.string().default('/memory/v1'),
    apiToken: z.string().default(''),
    apiTokens: z.dict(z.string()).default({}),
    apiTokenProfile: z.string().default(''),
    ownerAdminToken: z.string().default(''),
    dreamApiUrl: z.string().default('https://api.deepseek.com/api/v1/chat/completions'),
    dreamCredentialRef: z.string().default('DSH_MEMORY_DREAM_API_KEY'),
    dreamModel: z.string().default('deepseek-chat'),
    dreamMaxTokens: z.number().step(1).min(128).default(1200),
    dreamIntervalMs: z.number().step(1).min(60_000).default(3_600_000),
    debounceMs: z.number().step(1).min(0).default(5_000),
    maxResidentChars: z.number().step(1).min(256).default(12_000),
    maxSessionChars: z.number().step(1).min(1_000).default(40_000),
    recallEnabled: z.boolean().default(false),
    recallVectorEnabled: z.boolean().default(false),
    recallRawEvidenceEnabled: z.boolean().default(true),
    recallObservationEnabled: z.boolean().default(false),
    recallGraphEnabled: z.boolean().default(false),
    purgeEnabled: z.boolean().default(false),
    recallMaxCandidates: z.number().step(1).min(1).max(32).default(8),
    recallMaxContextChars: z.number().step(1).min(256).max(16_000).default(3_000),
    recallAuthoritativeReserve: z.number().step(1).min(0).max(32).default(4),
    recallRawEvidenceMaxCandidates: z.number().step(1).min(0).max(32).default(2),
    residentV2Enabled: z.boolean().default(true),
    residentBlocksEnabled: z.boolean().default(true),
    sensitiveResidentEnabled: z.boolean().default(false),
    temporalEnabled: z.boolean().default(true),
    evidenceClassificationEnabled: z.boolean().default(false),
    unclassifiedEvidenceDisclosure: z.union(['never_explicit', 'user_explicit_only'] as const).default('user_explicit_only'),
    minObservationEvidence: z.number().step(1).min(1).default(2),
    observationActivationMinEvidence: z.number().step(1).min(1).default(3),
    observationActivationMinSessions: z.number().step(1).min(1).default(2),
    observationActivationMinConfidence: z.number().min(0).max(1).default(0.8),
    reflectionEnabled: z.boolean().default(false),
    reflectionMaxObservations: z.number().step(1).min(1).default(3),
    temporalReconcileEnabled: z.boolean().default(false),
    embeddingProvider: z.union(['off', 'deterministic', 'openai-compatible'] as const).default('off'),
    embeddingEndpoint: z.string().default(''),
    embeddingCredentialRef: z.string().default('DSH_MEMORY_EMBEDDING_API_KEY'),
    embeddingModel: z.string().default(''),
    embeddingDimension: z.number().step(1).min(8).default(256),
  })

  private readonly stores = new Map<string, MemoryProfileStore>()
  private readonly agentScopes = new Map<string, MemoryScope>()
  private readonly pendingDreams = new Map<string, () => void>()
  private readonly sessionWrites = new Map<string, Promise<void>>()
  private readonly dreaming = new Set<string>()
  private readonly profileDreamQueues = new Map<string, Promise<void>>()
  private readonly inFlight = new Set<Promise<unknown>>()
  private readonly embeddingCredentialCache = new Map<string, string>()
  private readonly embeddingProvider: EmbeddingProvider | undefined
  private domain: MemoryDomain | undefined

  constructor(ctx: Context, readonly config: Config) {
    super(ctx, 'rikoMemory')
    validateConfig(config)
    this.embeddingProvider = this.buildEmbeddingProvider()
    ctx.on('session/event', (session, event) => { this.observeSessionEvent(session, event) })
    ctx.on('agent/pre-step', async ({ agent, messages, signal }, next) => {
      const decision = await next()
      if (!this.config.recallEnabled || decision.kind !== 'enter' || signal.aborted) return decision
      const query = userQueryFromMessages(messages)
      if (!query) return decision
      try {
        const scope = this.scopeForSession(agent.session)
        const store = this.storeForScope(scope)
        const atTime = explicitRecallAtTime(query)
        const plan = analyzeRecallQuery(query, {
          maxCandidates: this.config.recallMaxCandidates,
          maxContextChars: this.config.recallMaxContextChars,
          authoritativeReserve: this.config.recallAuthoritativeReserve,
          rawEvidenceMaxCandidates: this.config.recallRawEvidenceMaxCandidates,
          vectorEnabled: this.config.recallVectorEnabled,
          ...(atTime === undefined && hasHistoricalRecallCue(query) ? { history: true } : {}),
          ...(atTime === undefined ? {} : { atTime }),
          observationsEnabled: this.config.recallObservationEnabled,
          graphEnabled: this.config.recallGraphEnabled,
        })
        const resolvedAtTime = plan.atTime ?? atTime
        const recalled = await store.recall(query, {
          maxCandidates: this.config.recallMaxCandidates,
          maxContextChars: this.config.recallMaxContextChars,
          authoritativeReserve: this.config.recallAuthoritativeReserve,
          rawEvidenceMaxCandidates: this.config.recallRawEvidenceMaxCandidates,
          vectorEnabled: this.config.recallVectorEnabled,
          rawEvidenceEnabled: this.config.recallRawEvidenceEnabled,
          observationsEnabled: this.config.recallObservationEnabled,
          graphEnabled: this.config.recallGraphEnabled,
          ...(resolvedAtTime === undefined ? {} : { atTime: resolvedAtTime }),
          ...(plan.temporalMode === 'history' || (resolvedAtTime === undefined && hasHistoricalRecallCue(query)) ? { history: true } : {}),
          ...(this.embeddingProvider === undefined ? {} : { embeddingProvider: this.embeddingProvider }),
          signal,
        })
        const context = createRecallMessage(recalled)
        return context === undefined ? decision : { ...decision, messages: [...decision.messages, context] }
      } catch (error) {
        this.ctx.logger.warn(`riko-memory recall degraded: ${safeError(error)}`)
        return decision
      }
    })
    ctx.on('agent/created', ({ agent }) => { this.attachAgent(agent) })
    ctx.on('agent/disposed', ({ agent }) => { const key = String(agent.id); this.agentScopes.delete(key); this.pendingDreams.get(key)?.(); this.pendingDreams.delete(key) })
    this.ctx.timer.interval(() => { void this.track(this.dreamAll(), 'scheduled Dream') }, config.dreamIntervalMs)
    ctx.effect(() => async () => {
      for (const cancel of this.pendingDreams.values()) cancel()
      this.pendingDreams.clear()
      // An L0 append settles before the records it derives are durable: the session's source record and the
      // scope state wait in a write-behind buffer, and closing the domain with that buffer still in memory
      // drops it. `flush()` is not enough here — it starts by awaiting readiness, and the domain refuses
      // every job enqueued after the sibling plugin that owns it begins closing. That sibling's disposer
      // runs concurrently with this one, so the buffer has to be handed over in this synchronous turn.
      const submitted = this.submitWriteBehind()
      await Promise.allSettled([...this.inFlight])
      // Anything an append marked while that barrier was draining is submitted best-effort: the domain may
      // already be closing, in which case the write is refused rather than silently forgotten.
      await Promise.allSettled([...submitted, ...this.submitWriteBehind()])
      // Last resort for a composition where the domain outlives this plugin — the queued path, with its
      // durable rollback, which is all a writable domain needs.
      await Promise.allSettled([...this.stores.values()].map(store => store.flush()))
      await this.domain?.close()
    }, 'riko-memory: submit, drain, flush and close domain')
    ctx.effect(
      () => ctx.webServer.register({ kind: 'prefix', path: config.apiPath, handler: (req, res) => this.handleRequest(req, res) }),
      `riko-memory: ${config.apiPath}`,
    )
    this.registerTools()
  }

  /** Open the one versioned storage domain and attach existing agents. */
  async [Service.init](): Promise<void> {
    if (this.ctx.webServer.host !== '127.0.0.1' && this.config.apiToken.length === 0 && Object.keys(this.config.apiTokens).length === 0 && this.config.ownerAdminToken.length === 0) throw new Error('riko-memory requires apiToken, apiTokens or ownerAdminToken on a non-loopback web server')
    this.domain = await this.ctx.storageDomain.open(MEMORY_DOMAIN)
    for (const agent of this.ctx.agents.list()) this.attachAgent(agent)
    void this.track(this.recoverPersistedDreams(), 'startup Dream recovery')
  }

  /**
   * Read one already-open profile scope for in-process composition tests.
   * @param profileId - Profile identifier whose snapshot is read.
   * @returns The durable snapshot for that profile.
   */
  async snapshot(profileId: string): Promise<MemorySnapshot> { const store = this.storeForProfile(profileId); await store.waitReady(); return store.snapshot() }

  private attachAgent(agent: Agent): void {
    const key = String(agent.id); if (this.agentScopes.has(key)) return
    try {
      const scope = this.scopeForSession(agent.session); this.agentScopes.set(key, scope); const store = this.storeForScope(scope)
      agent.ctx.systemPrompt.context({ name: 'riko-memory', order: 260, text: () => store.renderResident() })
    } catch (error) {
      this.ctx.logger.warn(`riko-memory resident injection skipped: ${safeError(error)}`)
    }
  }

  private observeSessionEvent(session: Session, event: SessionEvent): void {
    if (event.type === 'user/message' && event.data.source.kind === 'plugin') return
    let scope: MemoryScope
    try { scope = this.scopeForSession(session) } catch (error) { this.ctx.logger.warn(`riko-memory L0 write rejected: ${safeError(error)}`); return }
    const store = this.storeForScope(scope); const line = JSON.stringify({ schemaVersion: 1, sessionId: String(session.id), seq: event.seq, time: event.time, type: event.type, data: serializableEventData(event) }); const sessionId = String(session.id); const previous = this.sessionWrites.get(sessionId) ?? Promise.resolve(); const write = previous.then(async () => { await store.appendSessionEvent(sessionId, line); if (event.type === 'user/message') await this.applyExplicitCoreferences(store, messageText(event.data), [`session:${sessionId}/event:${String(event.seq)}`]) }); this.sessionWrites.set(sessionId, write.catch(() => undefined)); void this.track(write, 'session evidence'); if (event.type === 'turn/end') this.scheduleDream(session, scope, write)
  }

  private scheduleDream(session: Session, scope: MemoryScope, evidenceBarrier: Promise<void>): void {
    const key = String(session.id); this.pendingDreams.get(key)?.(); const dispose = this.ctx.timer.timeout(() => { this.pendingDreams.delete(key); void this.track(evidenceBarrier.then(() => this.enqueueProfileDream(scope, () => this.dreamSession(session, scope))), `session Dream ${key}`) }, this.config.debounceMs); this.pendingDreams.set(key, dispose)
  }

  private async enqueueProfileDream<T>(scope: MemoryScope, operation: () => Promise<T>): Promise<T> {
    const previous = this.profileDreamQueues.get(scope.key) ?? Promise.resolve(); const next = previous.then(operation); this.profileDreamQueues.set(scope.key, next.then(() => undefined, () => undefined)); return next
  }

  private async dreamAll(scope?: MemoryScope): Promise<void> {
    const work: Promise<void>[] = []
    for (const session of this.ctx.sessions.list()) {
      try {
        const sessionScope = this.scopeForSession(session)
        if (scope !== undefined && sessionScope.key !== scope.key) continue
        work.push(this.enqueueProfileDream(sessionScope, () => this.dreamSession(session, sessionScope)))
      } catch { /* fail-closed sessions are not durable-memory work */ }
    }
    await Promise.all(work)
  }

  /** Recover durable L0 evidence even when the host has not restored a Session object yet. */
  private async recoverPersistedDreams(): Promise<void> {
    if (!this.domain) return
    const work: Promise<void>[] = []
    for (const [, record] of this.domain.table('sessions').entries() as IterableIterator<[string, MemorySessionRecord]>) {
      if (record.scope.ownerNamespace !== this.config.ownerNamespace) continue
      const transcript = transcriptFromEvidence(record.lines, this.config.maxSessionChars)
      if (!transcript) continue
      work.push(this.enqueueProfileDream(record.scope, () => this.dreamPersistedSession(record, transcript)))
    }
    await Promise.all(work)
  }

  private async dreamSession(session: Session, scope: MemoryScope): Promise<void> {
    return this.dreamEvidence(String(session.id), scope, transcriptText(session.deriveMessages() as unknown as readonly TranscriptMessage[], this.config.maxSessionChars))
  }

  private async dreamPersistedSession(record: MemorySessionRecord, transcript: string): Promise<void> {
    return this.dreamEvidence(record.sessionId, record.scope, transcript)
  }

  private async dreamEvidence(key: string, scope: MemoryScope, transcript: string): Promise<void> {
    if (this.dreaming.has(key)) return
    this.dreaming.add(key)
    const store = this.storeForScope(scope)
    const jobId = contentHash(`${scope.key}:${key}`).slice(0, 24)
    let attempts = 1
    let cursor = 0
    let reflectionResult: Record<string, unknown> | undefined
    try {
      const previous = store.job(jobId)
      attempts = typeof previous?.attempts === 'number' && Number.isInteger(previous.attempts) ? previous.attempts + 1 : 1
      cursor = latestEventSeq(await store.sessionEvidence(key)) ?? 0
      const now = new Date().toISOString()
      await store.upsertJob({ id: jobId, sessionId: key, scopeKey: scope.key, status: 'running', attempts, cursor, createdAt: typeof previous?.createdAt === 'string' ? previous.createdAt : now, updatedAt: now })
      if (!transcript || !(await store.shouldDreamSession(key))) {
        await store.upsertJob({ id: jobId, sessionId: key, scopeKey: scope.key, status: 'succeeded', attempts, cursor, createdAt: typeof previous?.createdAt === 'string' ? previous.createdAt : now, updatedAt: new Date().toISOString() })
        return
      }
      const generated = await this.generateWikiPages(key, transcript, store.dreamSettings())
      const sourced = generated.map(page => page.sources.includes(key) ? page : { ...page, sources: [...page.sources, key] })
      await store.ingestPages(sourced, new Date().toISOString(), key)
      await this.applyDreamOutputPolicy(store, sourced, key)
      if (this.config.reflectionEnabled) {
        try {
          const count = await this.reflectObservations(key, transcript, store.dreamSettings(), store)
          reflectionResult = { status: 'succeeded', observations: count }
        } catch (error) {
          reflectionResult = { status: 'failed', error: safeError(error) }
          await store.noteReflectionFailure(error).catch(noteError => this.ctx.logger.warn(`riko-memory reflection note failed: ${safeError(noteError)}`))
          this.ctx.logger.warn(`riko-memory reflection degraded for session ${key}: ${safeError(error)}`)
        }
      }
      await store.upsertJob({ id: jobId, sessionId: key, scopeKey: scope.key, status: 'succeeded', attempts, cursor: latestEventSeq(await store.sessionEvidence(key)) ?? cursor, createdAt: typeof previous?.createdAt === 'string' ? previous.createdAt : now, updatedAt: new Date().toISOString(), ...(reflectionResult === undefined ? {} : { reflection: reflectionResult }) })
    } catch (error) {
      await store.markDreamFailure(error).catch(() => undefined)
      await store.upsertJob({ id: jobId, sessionId: key, scopeKey: scope.key, status: 'failed', attempts, cursor, error: safeError(error), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }).catch(() => undefined)
      this.ctx.logger.warn(`riko-memory Dream failed for session ${key}: ${safeError(error)}`)
    } finally {
      this.dreaming.delete(key)
    }
  }

  private async applyDreamOutputPolicy(store: MemoryProfileStore, pages: readonly WikiPage[], sourceRef: string): Promise<void> {
    for (const page of pages) {
      if (page.sensitivity === undefined) continue
      await store.setMemorySensitivity({ id: page.id, target: 'page', sensitivity: page.sensitivity, authority: 'model_proposal', reason: 'Dream provider proposal' })
    }
    await this.applyExplicitCoreferences(store, pages.map(page => `${page.title}\n${page.description}\n${page.body}`).join('\n'), [sourceRef])
  }

  private async applyExplicitCoreferences(store: MemoryProfileStore, text: string, sourceRefs: readonly string[]): Promise<void> {
    const pages = store.listPages({ status: 'confirmed' }).filter(page => page.type !== 'source')
    for (const match of explicitCoreferences(text, pages)) {
      await store.upsertAlias({ entityId: match.entityId, alias: match.alias, confidence: 1, sourceRefs, resolutionKind: 'explicit_coreference' })
    }
  }

  private async applyManagementSensitivity(store: MemoryProfileStore, id: string, sensitivity: MemorySensitivity, reason: string): Promise<void> {
    await store.setMemorySensitivity({ id, target: 'page', sensitivity, authority: 'management', reason })
  }

  private async generateWikiPages(sessionId: string, transcript: string, settings: DreamSettings): Promise<WikiPage[]> {
    const resolved = await this.ctx.credentials.resolve(credentialRef(settings.credentialRef)); if (!resolved) throw new ProviderError('credential-unconfigured')
    const prompt = [
      'You are the controlled Wiki compiler for a private companion assistant.',
      'Extract only durable user facts, preferences, boundaries, goals, important experiences, relationships, or short-lived emotions.',
      'Do not infer sensitive facts, diagnoses, secrets, or instructions. Every extracted page is a candidate and requires explicit management confirmation.',
      'Return ONLY FILE blocks, never Markdown fences or JSON. Paths must stay under wiki/sources, wiki/entities, wiki/concepts, wiki/episodes, wiki/emotions, wiki/relationships, or wiki/synthesis.',
      'Use YAML frontmatter with type, title, description, sources, timestamp, confidence, status: candidate, consent: false, locked: false.',
      'Generate at most one source summary and four concise candidate pages. Keep descriptions under 120 Chinese characters and bodies under 1,200 characters.',
      'Use [[Page Title]] for a neutral relation, or [[supports::Page Title]], [[contradicts::Page Title]], [[refines::Page Title]], [[derived_from::Page Title]], or [[evidenced_by::Page Title]] for a typed relation. Never link to a session ID; keep session IDs only in sources.',
      'Do not treat a model-authored session ID or confirmation sentence as evidence. The only source of authority is the current session event stream.',
      '', 'FILE protocol:', '<<<FILE path="wiki/entities/example.md">>>', '---', 'type: entity', 'title: Example', 'description: One sentence summary', 'sources:', `  - ${sessionId}`, 'timestamp: 2026-01-01T00:00:00.000Z', 'confidence: 0.8', 'status: candidate', 'consent: false', 'locked: false', '---', '', '正文。', '<<<END>>>', '', 'Conversation transcript:', transcript,
    ].join('\n')
    const request = buildDreamRequest(settings, resolved.value, prompt)
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), 120_000)
      try {
        const response = await fetch(request.endpoint, { method: 'POST', headers: request.headers, body: request.body, signal: controller.signal })
        if (response.status === 429 && attempt === 1) { await wait(250); continue }
        if (!response.ok) throw new ProviderError(`http-${response.status}`)
        let responseBody: unknown; try { responseBody = await response.json() } catch { throw new ProviderError('invalid-json') }
        const text = extractDreamText(responseBody, request.protocol); if (!text) throw new ProviderError('empty-content'); return parseWikiOutput(text, sessionId)
      } catch (error) { if (error instanceof ProviderError) throw error; if (error instanceof DOMException && error.name === 'AbortError') throw new ProviderError('timeout'); throw new ProviderError('network-error') } finally { clearTimeout(timeout) }
    }
    throw new ProviderError('http-429')
  }

  private async reflectObservations(sessionId: string, transcript: string, settings: DreamSettings, store: MemoryProfileStore): Promise<number> {
    const resolved = await this.ctx.credentials.resolve(credentialRef(settings.credentialRef)); if (!resolved) throw new ProviderError('reflection-credential-unconfigured')
    const evidence = await store.sessionEvidence(sessionId)
    const anchors = evidence === undefined ? [] : observationAnchors(evidence, sessionId)
    const prompt = [
      'You are the bounded reflection stage for a private companion assistant.',
      'Produce only evidence-backed observation candidates. Never produce canonical facts, confirmations, diagnoses, secrets, credentials, or instructions.',
      `Return exactly one JSON object: {"observations":[{"text":"...","sourceRefs":["session:${sessionId}/event:<seq>"],"confidence":0.0}]}.`,
      `Return at most ${String(this.config.reflectionMaxObservations)} observations. Every sourceRefs entry must be copied exactly from the valid anchors below; use at least ${String(this.config.minObservationEvidence)} distinct raw or confirmed anchors per observation.`,
      'If the evidence does not support an observation, return {"observations":[]}. Do not use Markdown fences or add any other text.',
      `Valid anchors: ${anchors.join(', ') || '(none)'}`,
      'Conversation transcript:', transcript,
    ].join('\n')
    const request = buildDreamRequest(settings, resolved.value, prompt)
    const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), 60_000)
    try {
      const response = await fetch(request.endpoint, { method: 'POST', headers: request.headers, body: request.body, signal: controller.signal })
      if (!response.ok) throw new ProviderError(`reflection-http-${response.status}`)
      let responseBody: unknown; try { responseBody = await response.json() } catch { throw new ProviderError('reflection-invalid-json') }
      const text = extractDreamText(responseBody, request.protocol); if (!text) throw new ProviderError('reflection-empty-content')
      const candidates = parseReflectionOutput(text, this.config.reflectionMaxObservations, sessionId)
      for (const candidate of candidates) store.validateObservationCandidateAnchors(candidate.sourceRefs)
      for (const candidate of candidates) await store.upsertObservationCandidate(candidate)
      return candidates.length
    } catch (error) {
      if (error instanceof ProviderError) throw error
      if (error instanceof DOMException && error.name === 'AbortError') throw new ProviderError('reflection-timeout')
      throw new ProviderError('reflection-network-error')
    } finally { clearTimeout(timeout) }
  }

  private scopeForSession(session: Session): MemoryScope { return memoryScopeForPreset(this.config.ownerNamespace, this.ctx.sessionProjections.stateOf(session, 'agentPreset')) }
  private scopeForProfile(profileId: string): MemoryScope { return memoryScopeForPreset(this.config.ownerNamespace, normalizeProfileId(profileId)) }
  /** Hand every live store's deferred records to the domain; only the stores that owe a write answer. */
  private submitWriteBehind(): Promise<void>[] {
    return [...this.stores.values()].map(store => store.submitWriteBehind()).filter((job): job is Promise<void> => job !== undefined)
  }
  private storeForProfile(profileId: string): MemoryProfileStore { return this.storeForScope(this.scopeForProfile(profileId)) }
  private storeForScope(scope: MemoryScope): MemoryProfileStore {
    if (!this.domain) throw new Error('riko-memory storage domain is not initialized')
    let store = this.stores.get(scope.key)
    if (!store) {
      const options = {
        residentV2: this.config.residentV2Enabled,
        residentBlocks: this.config.residentBlocksEnabled,
        sensitiveResident: this.config.sensitiveResidentEnabled,
        temporal: this.config.temporalEnabled,
        evidenceClassification: this.config.evidenceClassificationEnabled,
        unclassifiedEvidenceDisclosure: this.config.unclassifiedEvidenceDisclosure,
        minObservationEvidence: this.config.minObservationEvidence,
        observationActivationMinEvidence: this.config.observationActivationMinEvidence,
        observationActivationMinSessions: this.config.observationActivationMinSessions,
        observationActivationMinConfidence: this.config.observationActivationMinConfidence,
        embeddingProvider: this.embeddingProvider,
        embeddingModel: this.config.embeddingModel,
      }
      store = new MemoryProfileStore(this.domain, scope, this.defaultDreamSettings(), this.config.maxResidentChars, options)
      this.stores.set(scope.key, store)
      void store.waitReady().catch(error => this.ctx.logger.warn(`riko-memory scope ${scope.key} failed to load: ${safeError(error)}`))
    }
    return store
  }
  private buildEmbeddingProvider(): EmbeddingProvider | undefined {
    const providerConfig = this.config.embeddingProvider === 'off'
      ? { kind: 'disabled' as const }
      : this.config.embeddingProvider === 'deterministic'
        ? { kind: 'deterministic-local' as const, dimension: this.config.embeddingDimension }
        : { kind: 'openai-compatible' as const, endpoint: this.config.embeddingEndpoint, model: this.config.embeddingModel, credentialRef: this.config.embeddingCredentialRef }
    try {
      const provider = createEmbeddingProvider(providerConfig, {
        resolveCredential: name => this.embeddingCredentialCache.get(name),
      })
      if (provider === undefined || this.config.embeddingProvider !== 'openai-compatible') return provider
      const ref = this.config.embeddingCredentialRef
      return {
        ...provider,
        embedDocuments: async (texts, signal) => {
          await this.resolveEmbeddingCredential(ref)
          return provider.embedDocuments(texts, signal)
        },
        embedQuery: async (query, signal) => {
          await this.resolveEmbeddingCredential(ref)
          return provider.embedQuery(query, signal)
        },
      }
    } catch (error) {
      this.ctx.logger.warn(`riko-memory embedding provider degraded: ${safeError(error)}`)
      return undefined
    }
  }
  private async resolveEmbeddingCredential(ref: string): Promise<void> {
    this.embeddingCredentialCache.delete(ref)
    try {
      const resolved = await this.ctx.credentials.resolve(credentialRef(ref))
      if (resolved !== undefined) this.embeddingCredentialCache.set(ref, resolved.value)
    } catch {
      /* Credential resolution failures are converted to provider degradation. */
    }
  }
  private defaultDreamSettings(): DreamSettings { return { apiUrl: this.config.dreamApiUrl, credentialRef: this.config.dreamCredentialRef, model: this.config.dreamModel, maxTokens: this.config.dreamMaxTokens } }

  /** Register the explicit memory control loop; every write is scope-bound and evidence-checked. */
  private registerTools(): void {
    // oxlint-disable-next-line typescript/no-this-alias -- tool callbacks need a stable service reference.
    const service = this
    this.ctx.tools.register(defineTool({
      name: 'memory_get_resident',
      description: 'Read the current Resident Snapshot for the current stable Agent preset. Missing preset fails closed.',
      parameters: {},
      output: MEMORY_TOOL_OUTPUT,
      execute: async (_args, exec) => {
        const agent = exec.agent; if (!agent) throw new Error('memory tool requires an agent session')
        const scope = service.scopeForSession(agent.session); const store = service.storeForScope(scope); await store.waitReady(); const snapshot = store.snapshot()
        return { scopeKey: scope.key, resident: snapshot.resident, version: snapshot.residentSnapshot?.version ?? '' }
      },
    }))
    this.ctx.tools.register(defineTool({
      name: 'memory_remember',
      description: 'Persist one explicit user preference only when the latest raw user message contains the same claim. The model cannot self-confirm a claim.',
      parameters: { content: { type: 'string', required: true, description: 'The exact preference, boundary, goal, fact or event the user explicitly stated.' }, sensitivity: { type: 'string', enum: ['normal', 'sensitive'], description: 'Mark a private claim as sensitive; sensitive pages remain out of ordinary Resident injection.' } },
      output: MEMORY_TOOL_OUTPUT,
      execute: async (args, exec) => {
        const agent = exec.agent; if (!agent) throw new Error('memory tool requires an agent session'); const input = args as { content: string; sensitivity?: 'normal' | 'sensitive' }; const content = String(input.content).trim(); const userText = latestUserText(agent.session); if (!content || !userText.includes(content)) throw new Error('memory_remember requires an exact claim from the latest raw user message')
        const scope = service.scopeForSession(agent.session); const store = service.storeForScope(scope); const item = explicitMemory(content, String(agent.session.id), input.sensitivity); const transition = service.config.temporalReconcileEnabled ? classifyTemporalTransition(content) : undefined; const temporalTarget = transition === undefined ? undefined : resolveTemporalTarget(store, transition.sourceText, item.id); const temporalPage = temporalTarget === undefined ? undefined : await store.updatePageTemporal(temporalTarget.id, { description: content, body: content, validFrom: new Date().toISOString(), observedAt: new Date().toISOString() }); if (temporalPage === undefined) await store.upsertManual(item); const page = temporalPage ?? store.page(item.id); if (page !== undefined) await store.setMemorySensitivity({ id: page.id, target: 'page', sensitivity: item.sensitivity, authority: 'deterministic_rule', reason: 'memory_remember conservative classification' }); await service.applyExplicitCoreferences(store, userText, [String(agent.session.id)]); return { scopeKey: scope.key, id: page?.id ?? item.id, resident: store.renderResident(), version: store.snapshot().residentSnapshot?.version ?? '' }
      },
    }))
    this.ctx.tools.register(defineTool({
      name: 'memory_correct',
      description: 'Correct a memory only when the latest raw user message contains the replacement claim.',
      parameters: { id: { type: 'string', required: true, description: 'Canonical Wiki page or memory id.' }, content: { type: 'string', required: true, description: 'Replacement claim explicitly stated by the user.' } },
      output: MEMORY_TOOL_OUTPUT,
      execute: async (args, exec) => {
        const agent = exec.agent; if (!agent) throw new Error('memory tool requires an agent session'); const input = args as { id: string; content: string }; const content = input.content.trim(); if (!latestUserText(agent.session).includes(content)) throw new Error('memory_correct requires replacement text from the latest raw user message')
        const scope = service.scopeForSession(agent.session); const store = service.storeForScope(scope); const page = await store.editPage(input.id, { description: content, body: content }); if (!page) throw new Error('memory page not found'); await store.setMemorySensitivity({ id: page.id, target: 'page', sensitivity: classifyMemorySensitivity(content), authority: 'deterministic_rule', reason: 'memory_correct conservative classification' }); return { scopeKey: scope.key, id: page.id, resident: store.renderResident(), version: store.snapshot().residentSnapshot?.version ?? '' }
      },
    }))
    this.ctx.tools.register(defineTool({
      name: 'memory_forget',
      description: 'Remove derived memory after an explicit user request in the latest raw message. Raw Session evidence remains and is disclosed.',
      parameters: { id: { type: 'string', description: 'Canonical Wiki page or memory id when the latest user message names it.' }, target: { type: 'string', description: 'Natural-language target copied from the latest user message.' } },
      output: MEMORY_TOOL_OUTPUT,
      execute: async (args, exec) => {
        const agent = exec.agent; if (!agent) throw new Error('memory tool requires an agent session'); const input = args as { id?: string; target?: string }; const userText = latestUserText(agent.session); if (!deletionCue.test(userText)) throw new Error('memory_forget requires an explicit latest user request')
        const scope = service.scopeForSession(agent.session); const store = service.storeForScope(scope); const resolution = resolveCanonicalTarget(store, userText, input.id ?? input.target); if (resolution.kind === 'ambiguous') return confirmationResult(scope.key, store, resolution.pages); if (resolution.page === undefined) throw new Error('memory_forget found no canonical target in the latest user message'); if (!await store.forget(resolution.page.id)) throw new Error('memory page not found'); return { scopeKey: scope.key, id: resolution.page.id, resident: store.renderResident(), version: store.snapshot().residentSnapshot?.version ?? '' }
      },
    }))
    this.ctx.tools.register(defineTool({
      name: 'memory_suppress',
      description: 'Reversibly suppress one canonical memory only when the latest raw user message explicitly asks not to mention that target.',
      parameters: { id: { type: 'string', description: 'Canonical Wiki page or memory id named in the latest user message.' }, target: { type: 'string', description: 'Natural-language target copied from the latest user message.' } },
      output: MEMORY_TOOL_OUTPUT,
      execute: async (args, exec) => {
        const agent = exec.agent; if (!agent) throw new Error('memory tool requires an agent session'); const input = args as { id?: string; target?: string }; const userText = latestUserText(agent.session); if (!suppressionCue.test(userText)) throw new Error('memory_suppress requires an explicit latest raw request not to mention the target')
        const scope = service.scopeForSession(agent.session); const store = service.storeForScope(scope); const resolution = resolveCanonicalTarget(store, userText, input.id ?? input.target); if (resolution.kind === 'ambiguous') return confirmationResult(scope.key, store, resolution.pages); if (resolution.page === undefined) throw new Error('memory_suppress found no canonical target in the latest user message'); if (!await store.suppressCanonical(resolution.page.id, 'user-requested-suppression')) throw new Error('memory page is already suppressed or not found'); return { scopeKey: scope.key, id: resolution.page.id, resident: store.renderResident(), version: store.snapshot().residentSnapshot?.version ?? '' }
      },
    }))
    this.ctx.tools.register(defineTool({
      name: 'memory_restore',
      description: 'Restore one suppressed canonical memory only when the latest raw user message explicitly asks to restore mentioning that target.',
      parameters: { id: { type: 'string', description: 'Canonical Wiki page or memory id named in the latest user message.' }, target: { type: 'string', description: 'Natural-language target copied from the latest user message.' } },
      output: MEMORY_TOOL_OUTPUT,
      execute: async (args, exec) => {
        const agent = exec.agent; if (!agent) throw new Error('memory tool requires an agent session'); const input = args as { id?: string; target?: string }; const userText = latestUserText(agent.session); if (!restoreCue.test(userText)) throw new Error('memory_restore requires an explicit latest raw restore request')
        const scope = service.scopeForSession(agent.session); const store = service.storeForScope(scope); const resolution = resolveCanonicalTarget(store, userText, input.id ?? input.target); if (resolution.kind === 'ambiguous') return confirmationResult(scope.key, store, resolution.pages); if (resolution.page === undefined) throw new Error('memory_restore found no canonical target in the latest user message'); if (!await store.restoreCanonical(resolution.page.id, 'user-requested-restore')) throw new Error('memory page is not suppressed or not found'); return { scopeKey: scope.key, id: resolution.page.id, resident: store.renderResident(), version: store.snapshot().residentSnapshot?.version ?? '' }
      },
    }))
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      setCors(res); if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return }
      const requestUrl = new URL(req.url ?? '/', 'http://dsh'); const pathname = requestUrl.pathname; const relative = pathname.slice(this.config.apiPath.length).replace(/^\/+/, ''); const publicUi = req.method === 'GET' && (relative.length === 0 || relative === 'ui'); if (publicUi) { sendHtml(res, memoryUiHtml); return }
      const authentication = this.authenticatedRequest(req); if (authentication === undefined) { sendJson(res, 401, { error: 'unauthorized' }); return }; const profile = authentication.profile
      const parts = relative.length === 0 ? [] : relative.split('/').map(decodeURIComponent); const store = this.storeForProfile(profile); await store.waitReady()
      if (req.method === 'GET' && ['wiki', 'resident', 'sessions', 'candidates', 'conflicts'].includes(parts[0] ?? '')) await Promise.allSettled([...this.inFlight])
      if (req.method === 'GET' && parts[0] === 'config') { sendJson(res, 200, await this.configResponse(profile, store)); return }
      if (req.method === 'POST' && parts[0] === 'recall' && (parts.length === 1 || parts[1] === 'debug')) {
        if (!this.config.recallEnabled) { sendJson(res, 404, { error: 'recall is disabled' }); return }
        const body = await readJsonBody(req); const query = optionalString(body, 'query')?.trim() ?? ''
        if (!query) { sendJson(res, 400, { error: 'recall query is required' }); return }
        const atTime = optionalString(body, 'atTime')?.trim(); const history = body && typeof body === 'object' && (body as Record<string, unknown>).history === true
        const recalled = await store.recall(query, { maxCandidates: this.config.recallMaxCandidates, maxContextChars: this.config.recallMaxContextChars, authoritativeReserve: this.config.recallAuthoritativeReserve, rawEvidenceMaxCandidates: this.config.recallRawEvidenceMaxCandidates, vectorEnabled: this.config.recallVectorEnabled, rawEvidenceEnabled: this.config.recallRawEvidenceEnabled, observationsEnabled: this.config.recallObservationEnabled, graphEnabled: this.config.recallGraphEnabled, ...(this.embeddingProvider === undefined ? {} : { embeddingProvider: this.embeddingProvider }), ...(atTime ? { atTime } : {}), ...(history ? { history: true } : {}) })
        sendJson(res, 200, parts[1] === 'debug' ? { profileId: profile, plan: sanitizeRecallPlan(recalled.plan), results: recalled.results.map(sanitizeRecallResult), trace: recalled.trace } : { profileId: profile, results: recalled.results, context: renderRecallContext(recalled.results, this.config.recallMaxContextChars) })
        return
      }
      if (req.method === 'POST' && parts[0] === 'config') {
        const body = await readJsonBody(req)
        if (!body || typeof body !== 'object') throw new Error('config body must be an object')
        const input = body as Record<string, unknown>
        if (input.apiKey !== undefined) { sendJson(res, 400, { error: 'apiKey cannot be written through memory API; configure credentials or process environment' }); return }
        if (input.credentialRef !== undefined && (typeof input.credentialRef !== 'string' || !isCredentialRefName(input.credentialRef) || secretLikeCredential(input.credentialRef))) { sendJson(res, 400, { error: 'credentialRef must be a credential reference, not a secret' }); return }
        await store.updateDreamSettings({ ...(typeof input.apiUrl === 'string' ? { apiUrl: input.apiUrl } : {}), ...(typeof input.credentialRef === 'string' ? { credentialRef: input.credentialRef } : {}), ...(typeof input.model === 'string' ? { model: input.model } : {}), ...(typeof input.maxTokens === 'number' ? { maxTokens: input.maxTokens } : {}) })
        sendJson(res, 200, await this.configResponse(profile, store)); return
      }
      if (req.method === 'GET' && parts[0] === 'wiki' && parts[1] === 'pages' && parts[2]) {
        const page = store.page(parts[2])
        if (page === undefined) { sendJson(res, 404, { error: 'wiki page not found' }); return }
        const reveal = requestUrl.searchParams.get('reveal') === 'sensitive'
        if (reveal && !authentication.ownerAdmin) { await this.auditSensitiveRevealRejected(store, 'wiki-page', page.id); sendJson(res, 403, { error: 'owner-admin capability required for sensitive reveal' }); return }
        if (reveal) await this.auditSensitiveReveal(store, 'wiki-page', page.id)
        sendJson(res, 200, reveal ? page : (page.sensitivity ?? 'normal') === 'normal' ? page : redactWikiPage(page)); return
      }
      if (req.method === 'GET' && parts[0] === 'wiki' && parts[1] === 'graph') { const includeEvidence = requestUrl.searchParams.get('evidence') === '1' || requestUrl.searchParams.get('includeEvidence') === '1'; sendJson(res, 200, { profileId: profile, ...store.graph(requestUrl.searchParams.get('root') ?? undefined, queryNumber(requestUrl.searchParams.get('hop'), 1, 0, WIKI_GRAPH_MAX_HOPS), includeEvidence) }); return }
      if (req.method === 'GET' && parts[0] === 'wiki' && parts[1] === 'search') { const results = store.search(requestUrl.searchParams.get('q') ?? '', queryNumber(requestUrl.searchParams.get('limit'), 20, 1, 100), queryNumber(requestUrl.searchParams.get('hop'), 0, 0, WIKI_GRAPH_MAX_HOPS)).map(result => (result.page.sensitivity ?? 'normal') === 'normal' ? result : { ...result, page: redactWikiPage(result.page) }); sendJson(res, 200, { profileId: profile, query: requestUrl.searchParams.get('q') ?? '', results }); return }
      if (req.method === 'GET' && parts[0] === 'wiki' && parts[1] === 'sources') { sendJson(res, 200, { profileId: profile, sources: store.listSources() }); return }
      if (req.method === 'GET' && parts[0] === 'audits') { sendJson(res, 200, { profileId: profile, audits: store.listAudits() }); return }
      if (req.method === 'GET' && parts[0] === 'wiki') { sendJson(res, 200, managementSnapshot(store.snapshot(), store)); return }
      if (req.method === 'GET' && parts[0] === 'resident') { sendJson(res, 200, { profileId: profile, resident: store.renderResident(), rawSessionRetention: 'raw Session evidence is retained unless separately purged by a future capability' }); return }
      if (req.method === 'GET' && parts[0] === 'sessions') { if (parts[1]) { const evidence = await store.sessionEvidence(parts[1]); if (evidence === undefined) { sendJson(res, 404, { error: 'session not found' }); return } const reveal = requestUrl.searchParams.get('reveal') === 'sensitive'; if (reveal && !authentication.ownerAdmin) { await this.auditSensitiveRevealRejected(store, 'session', parts[1]); sendJson(res, 403, { error: 'owner-admin capability required for sensitive reveal' }); return } if (reveal) await this.auditSensitiveReveal(store, 'session', parts[1]); sendJson(res, 200, reveal ? { profileId: profile, sessionId: parts[1], evidence, redacted: false } : { profileId: profile, sessionId: parts[1], evidence: { lineCount: evidence.trimEnd().split('\n').length, sha256: contentHash(evidence), bytes: Buffer.byteLength(evidence), classificationCounts: store.evidenceClassificationCounts(parts[1]) }, redacted: true }); return } sendJson(res, 200, { profileId: profile, sessions: store.snapshot().sessions }); return }
      if (req.method === 'GET' && parts[0] === 'candidates') { sendJson(res, 200, { profileId: profile, candidates: store.snapshot().candidates.map(projectCandidate) }); return }
      if (req.method === 'GET' && parts[0] === 'observations') { sendJson(res, 200, { profileId: profile, observations: store.listObservations().map(projectObservation) }); return }
      if (req.method === 'GET' && parts[0] === 'purges') { sendJson(res, 200, { profileId: profile, purges: store.listPurges() }); return }
      if (req.method === 'GET' && parts[0] === 'conflicts' && parts.length === 1) { sendJson(res, 200, { profileId: profile, conflicts: store.listConflicts() }); return }
      if (req.method === 'POST' && parts[0] === 'observations' && parts.length === 1) { const body = await readJsonBody(req); if (!body || typeof body !== 'object') throw new Error('observation body must be an object'); const input = body as Record<string, unknown>; const text = typeof input.text === 'string' ? input.text : ''; const sourceRefs = Array.isArray(input.sourceRefs) ? input.sourceRefs.filter((ref): ref is string => typeof ref === 'string') : []; const observation = await store.upsertObservationCandidate({ text, sourceRefs, ...(typeof input.id === 'string' ? { id: input.id } : {}), ...(typeof input.confidence === 'number' ? { confidence: input.confidence } : {}), sensitivity: input.sensitivity === 'sensitive' ? 'sensitive' : 'normal', ...(typeof input.observedAt === 'string' ? { observedAt: input.observedAt } : {}), ...(typeof input.recordedAt === 'string' ? { recordedAt: input.recordedAt } : {}), ...(input.validFrom === null ? { validFrom: null } : typeof input.validFrom === 'string' ? { validFrom: input.validFrom } : {}), ...(input.validTo === null ? { validTo: null } : typeof input.validTo === 'string' ? { validTo: input.validTo } : {}), ...(Array.isArray(input.derivedFromObservationIds) ? { derivedFromObservationIds: input.derivedFromObservationIds.filter((id): id is string => typeof id === 'string') } : {}) }); sendJson(res, 201, observation); return }
      if (req.method === 'POST' && parts[0] === 'observations' && parts[1] && parts[2]) { const id = parts[1]; const changed = parts[2] === 'activate' ? await store.activateObservation(id) : parts[2] === 'invalidate' ? await store.invalidateObservation(id) : parts[2] === 'suppress' ? await store.suppressObservation(id) : false; sendJson(res, changed ? 200 : 404, { changed }); return }
      if (req.method === 'POST' && parts[0] === 'conflicts' && parts[1] && parts[2] === 'resolve' && parts.length === 3) { const body = await readJsonBody(req); const resolution = optionalString(body, 'resolution'); if (resolution !== 'correction' && resolution !== 'temporal_transition' && resolution !== 'management') { sendJson(res, 400, { error: 'resolution must be one of correction, temporal_transition or management' }); return } const changed = await store.resolveConflict(parts[1], resolution); sendJson(res, changed ? 200 : 404, { changed }); return }
      if (req.method === 'POST' && parts[0] === 'purge') {
        if (!this.config.purgeEnabled) { sendJson(res, 404, { error: 'purge is disabled' }); return }
        const body = await readJsonBody(req); const sessionId = optionalString(body, 'sessionId')?.trim() ?? ''
        if (!sessionId) { sendJson(res, 400, { error: 'sessionId is required' }); return }
        const plan = store.purgePlan(sessionId)
        if (body && typeof body === 'object' && (body as Record<string, unknown>).dryRun === true) { sendJson(res, 200, { ...plan, dryRun: true, changed: false }); return }
        const confirmation = optionalString(body, 'confirmation')
        if (confirmation !== plan.confirmation) { sendJson(res, 400, { error: 'purge confirmation does not match the current plan' }); return }
        const changed = await store.purgeSession(sessionId, { confirmation })
        sendJson(res, changed === true ? 200 : 404, { changed, verified: changed === true, rawSessionRetained: false }); return
      }
      const candidateOffset = parts[0] === 'wiki' ? 1 : 0; const candidateId = parts[candidateOffset + 1]; const candidateAction = parts[candidateOffset + 2]; if (req.method === 'POST' && parts[candidateOffset] === 'candidates' && candidateId && candidateAction) { const changed = candidateAction === 'confirm' ? await store.confirm(candidateId) : candidateAction === 'reject' ? await store.reject(candidateId) : false; sendJson(res, candidateAction === 'confirm' || candidateAction === 'reject' ? (changed ? 200 : 404) : 404, candidateAction === 'confirm' || candidateAction === 'reject' ? { changed } : { error: 'unknown candidate action' }); return }
      if (req.method === 'POST' && parts[0] === 'wiki' && parts[1] === 'pages' && parts[2] && parts[3] === 'supersede') { const changed = await store.supersede(parts[2]); sendJson(res, changed ? 200 : 404, { changed }); return }
      if (req.method === 'POST' && parts[0] === 'wiki' && parts[1] === 'pages' && parts[2] && parts[3] === 'temporal') { const input = await readJsonBody(req); if (!input || typeof input !== 'object') throw new Error('temporal update body must be an object'); const body = input as Record<string, unknown>; if (typeof body.validFrom !== 'string' || !body.validFrom.trim()) { sendJson(res, 400, { error: 'validFrom is required for temporal update' }); return } const page = await store.updatePageTemporal(parts[2], { validFrom: body.validFrom, ...(typeof body.title === 'string' ? { title: body.title } : {}), ...(typeof body.description === 'string' ? { description: body.description } : {}), ...(typeof body.body === 'string' ? { body: body.body } : typeof body.content === 'string' ? { body: body.content, description: body.content } : {}), ...(Array.isArray(body.tags) ? { tags: body.tags.filter((tag): tag is string => typeof tag === 'string') } : {}), ...(typeof body.observedAt === 'string' ? { observedAt: body.observedAt } : {}), ...(typeof body.recordedAt === 'string' ? { recordedAt: body.recordedAt } : {}), ...(body.validTo === null ? { validTo: null } : typeof body.validTo === 'string' ? { validTo: body.validTo } : typeof body.validUntil === 'string' ? { validUntil: body.validUntil } : {}) }); sendJson(res, page ? 200 : 404, page ?? { error: 'wiki page not found' }); return }
      if (req.method === 'POST' && parts[0] === 'wiki' && parts[1] === 'pages' && parts.length === 2) { const page = manualWikiPage(await readJsonBody(req), profile); await store.upsertManualPage(page); sendJson(res, 201, page); return }
      if (req.method === 'PUT' && parts[0] === 'wiki' && parts[1] === 'pages' && parts[2]) { const input = await readJsonBody(req); if (!input || typeof input !== 'object') throw new Error('wiki correction body must be an object'); const body = input as Record<string, unknown>; const sensitivity = body.sensitivity === undefined ? undefined : parseMemorySensitivity(body.sensitivity); if (body.sensitivity !== undefined && sensitivity === undefined) { sendJson(res, 400, { error: 'sensitivity must be normal, provisional_sensitive or sensitive' }); return } const content = typeof body.content === 'string' ? body.content : undefined; const page = await store.editPage(parts[2], { ...(typeof body.title === 'string' ? { title: body.title } : {}), ...(typeof body.description === 'string' ? { description: body.description } : content === undefined ? {} : { description: content }), ...(typeof body.body === 'string' ? { body: body.body } : content === undefined ? {} : { body: content }), ...(Array.isArray(body.tags) ? { tags: body.tags.filter((tag): tag is string => typeof tag === 'string') } : {}), ...(body.validUntil === null ? { validUntil: null } : typeof body.validUntil === 'string' ? { validUntil: body.validUntil } : {}) }); if (page === undefined) { sendJson(res, 404, { error: 'wiki page not found' }); return } if (sensitivity !== undefined) await this.applyManagementSensitivity(store, page.id, sensitivity, optionalString(body, 'sensitivityReason') ?? 'management page edit'); sendJson(res, 200, store.page(page.id) ?? page); return }
      if (req.method === 'POST' && parts[0] === 'memories' && parts.length === 1) { const input = await readJsonBody(req); const requestedSensitivity = input && typeof input === 'object' && Object.hasOwn(input, 'sensitivity') ? parseMemorySensitivity((input as Record<string, unknown>).sensitivity) : undefined; if (input && typeof input === 'object' && Object.hasOwn(input, 'sensitivity') && requestedSensitivity === undefined) { sendJson(res, 400, { error: 'sensitivity must be normal, provisional_sensitive or sensitive' }); return } const item = manualMemory(input, profile); await store.upsertManual(item); const page = store.page(item.id); if (page !== undefined && requestedSensitivity !== undefined) await this.applyManagementSensitivity(store, page.id, requestedSensitivity, 'management memory create'); sendJson(res, 201, { ...item, id: store.page(item.id)?.id ?? item.id }); return }
      if (req.method === 'DELETE' && ((parts[0] === 'memories' && parts.length === 2) || (parts[0] === 'wiki' && parts[1] === 'pages' && parts.length === 3))) { const targetId = parts.at(-1); if (!targetId) { sendJson(res, 404, { error: 'memory id is required' }); return } const changed = await store.forget(targetId); sendJson(res, changed ? 200 : 404, { changed, rawSessionRetained: true }); return }
      if (req.method === 'POST' && parts[0] === 'dream') { const body = await readJsonBody(req); const sessionId = optionalString(body, 'sessionId'); const session = sessionId ? this.ctx.sessions.get(SessionId(sessionId)) : undefined; if (sessionId && !session) { sendJson(res, 404, { error: 'session not found' }); return } const profileScope = this.scopeForProfile(profile); if (session && this.scopeForSession(session).key !== profileScope.key) { sendJson(res, 403, { error: 'session belongs to another scope' }); return } if (session) void this.track(this.enqueueProfileDream(profileScope, () => this.dreamSession(session, profileScope)), `manual session Dream ${sessionId}`); else void this.track(this.dreamAll(profileScope), 'manual Dream'); sendJson(res, 202, { accepted: true }); return }
      sendJson(res, 404, { error: 'memory route not found' })
    } catch (error) { sendJson(res, 500, { error: safeError(error) }) }
  }

  private async configResponse(profile: string, store: MemoryProfileStore): Promise<Record<string, unknown>> {
    const settings = store.dreamSettings()
    const dreamInfo = await this.ctx.credentials.describe(credentialRef(settings.credentialRef))
    const embeddingInfo = this.config.embeddingProvider === 'openai-compatible'
      ? await this.ctx.credentials.describe(credentialRef(this.config.embeddingCredentialRef))
      : undefined
    return {
      profileId: profile,
      apiPath: this.config.apiPath,
      scopeBinding: this.config.ownerAdminToken && (Object.keys(this.config.apiTokens).length > 0 || this.config.apiTokenProfile) ? 'profile+owner-admin' : Object.keys(this.config.apiTokens).length > 0 || this.config.apiTokenProfile ? 'profile' : 'owner-admin',
      ...(this.config.apiTokenProfile ? { apiTokenProfile: this.config.apiTokenProfile } : {}),
      ownerAdminConfigured: this.config.ownerAdminToken.length > 0,
      dreamApiUrl: settings.apiUrl,
      dreamCredentialRef: settings.credentialRef,
      dreamModel: settings.model,
      dreamMaxTokens: settings.maxTokens,
      dreamConfigured: dreamInfo.configured,
      dreamIntervalMs: this.config.dreamIntervalMs,
      debounceMs: this.config.debounceMs,
      maxResidentChars: this.config.maxResidentChars,
      maxSessionChars: this.config.maxSessionChars,
      residentV2Enabled: this.config.residentV2Enabled,
      residentBlocksEnabled: this.config.residentBlocksEnabled,
      sensitiveResidentEnabled: this.config.sensitiveResidentEnabled,
      temporalEnabled: this.config.temporalEnabled,
      evidenceClassificationEnabled: this.config.evidenceClassificationEnabled,
      unclassifiedEvidenceDisclosure: this.config.unclassifiedEvidenceDisclosure,
      minObservationEvidence: this.config.minObservationEvidence,
      observationActivationMinEvidence: this.config.observationActivationMinEvidence,
      observationActivationMinSessions: this.config.observationActivationMinSessions,
      observationActivationMinConfidence: this.config.observationActivationMinConfidence,
      reflectionEnabled: this.config.reflectionEnabled,
      reflectionMaxObservations: this.config.reflectionMaxObservations,
      temporalReconcileEnabled: this.config.temporalReconcileEnabled,
      recallEnabled: this.config.recallEnabled,
      recallVectorEnabled: this.config.recallVectorEnabled,
      recallRawEvidenceEnabled: this.config.recallRawEvidenceEnabled,
      recallObservationEnabled: this.config.recallObservationEnabled,
      recallGraphEnabled: this.config.recallGraphEnabled,
      purgeEnabled: this.config.purgeEnabled,
      recallMaxCandidates: this.config.recallMaxCandidates,
      recallMaxContextChars: this.config.recallMaxContextChars,
      recallAuthoritativeReserve: this.config.recallAuthoritativeReserve,
      recallRawEvidenceMaxCandidates: this.config.recallRawEvidenceMaxCandidates,
      embeddingProvider: this.config.embeddingProvider,
      embeddingEndpoint: this.config.embeddingEndpoint,
      embeddingCredentialRef: this.config.embeddingCredentialRef,
      embeddingModel: this.config.embeddingModel,
      embeddingDimension: this.config.embeddingDimension,
      embeddingConfigured: this.config.embeddingProvider === 'off' ? false : this.config.embeddingProvider === 'deterministic' ? true : embeddingInfo?.configured === true,
    }
  }
  private async auditSensitiveReveal(store: MemoryProfileStore, targetKind: 'wiki-page' | 'session', target: string): Promise<void> {
    const audit = (store as unknown as { audit?: (event: string, detail?: Record<string, unknown>) => Promise<void> }).audit
    if (audit === undefined) throw new Error('sensitive reveal audit is unavailable')
    await audit.call(store, 'sensitive-content-revealed', { targetKind, targetHash: contentHash(target).slice(0, 24) })
  }
  private async auditSensitiveRevealRejected(store: MemoryProfileStore, targetKind: 'wiki-page' | 'session', target: string): Promise<void> {
    const audit = (store as unknown as { audit?: (event: string, detail?: Record<string, unknown>) => Promise<void> }).audit
    if (audit === undefined) throw new Error('sensitive reveal audit is unavailable')
    await audit.call(store, 'sensitive-content-reveal-rejected', { targetKind, targetHash: contentHash(target).slice(0, 24), reason: 'owner-admin capability required' })
  }
  private authenticatedRequest(req: IncomingMessage): AuthenticatedRequest | undefined {
    const requested = this.requestedProfile(req)
    const bearer = bearerToken(req)
    if (this.config.ownerAdminToken && bearer === this.config.ownerAdminToken) return requested === undefined ? undefined : { profile: requested, ownerAdmin: true }
    const entries = Object.entries(this.config.apiTokens)
    if (entries.length > 0) {
      if (!bearer) return undefined
      const match = entries.find(([, token]) => token === bearer)
      if (!match) return undefined
      const profile = normalizeProfileId(match[0])
      return requested === profile ? { profile, ownerAdmin: false } : undefined
    }
    if (this.config.apiToken) {
      if (bearer !== this.config.apiToken || requested === undefined) return undefined
      return requested === normalizeProfileId(this.config.apiTokenProfile) ? { profile: requested, ownerAdmin: false } : undefined
    }
    return this.ctx.webServer.host === '127.0.0.1' && requested ? { profile: requested, ownerAdmin: false } : undefined
  }
  private requestedProfile(req: IncomingMessage): string | undefined { try { const raw = req.headers['x-dsh-memory-profile']; const value = Array.isArray(raw) ? raw[0] : raw; return value === undefined ? undefined : normalizeProfileId(value) } catch { return undefined } }
  private track<T>(promise: Promise<T>, label: string): Promise<T> { this.inFlight.add(promise); const settle = (): void => { this.inFlight.delete(promise) }; void promise.then(settle, (error) => { settle(); this.ctx.logger.warn(`riko-memory ${label} failed: ${safeError(error)}`) }); return promise }
}

export default RikoMemoryService

class ProviderError extends Error { constructor(readonly reason: string) { super(`Dream provider failure: ${reason}`); this.name = 'ProviderError' } }

/**
 * Reject an invalid plugin configuration before any durable state is opened.
 * @param config - Configuration to validate.
 */
export function validateConfig(config: Config): void {
  const apiToken = config.apiToken ?? ''
  const apiTokens = config.apiTokens ?? {}
  const apiTokenProfile = config.apiTokenProfile ?? ''
  const ownerAdminToken = config.ownerAdminToken ?? ''
  const embeddingProvider = config.embeddingProvider ?? 'off'
  const embeddingCredentialRef = config.embeddingCredentialRef ?? 'DSH_MEMORY_EMBEDDING_API_KEY'
  const embeddingDimension = config.embeddingDimension ?? 256
  const minObservationEvidence = config.minObservationEvidence ?? 2
  const observationActivationMinEvidence = config.observationActivationMinEvidence ?? 3
  const observationActivationMinSessions = config.observationActivationMinSessions ?? 2
  const observationActivationMinConfidence = config.observationActivationMinConfidence ?? 0.8
  const unclassifiedEvidenceDisclosure = config.unclassifiedEvidenceDisclosure ?? 'user_explicit_only'
  const authoritativeReserve = config.recallAuthoritativeReserve ?? 4
  const rawEvidenceMaxCandidates = config.recallRawEvidenceMaxCandidates ?? 2
  if (!config.ownerNamespace.trim()) throw new Error('riko-memory ownerNamespace must not be empty')
  if (!config.apiPath.startsWith('/') || config.apiPath.endsWith('/') || config.apiPath.includes('?')) throw new Error('riko-memory apiPath must be absolute without trailing slash or query')
  if (apiToken && Object.keys(apiTokens).length > 0) throw new Error('riko-memory apiToken and apiTokens are mutually exclusive')
  if (apiToken && !apiTokenProfile.trim()) throw new Error('riko-memory apiTokenProfile is required when apiToken is set')
  if (!apiToken && apiTokenProfile.trim()) throw new Error('riko-memory apiTokenProfile requires apiToken')
  if (ownerAdminToken.trim().length === 0 && ownerAdminToken.length > 0) throw new Error('riko-memory ownerAdminToken must not be whitespace')
  if (ownerAdminToken && ownerAdminToken === apiToken) throw new Error('riko-memory ownerAdminToken must be distinct from apiToken')
  if (ownerAdminToken && Object.values(apiTokens).some(token => token === ownerAdminToken)) throw new Error('riko-memory ownerAdminToken must be distinct from apiTokens')
  if (!isCredentialRefName(config.dreamCredentialRef)) throw new Error('riko-memory dreamCredentialRef must be a credential reference')
  if (!isCredentialRefName(embeddingCredentialRef)) throw new Error('riko-memory embeddingCredentialRef must be a credential reference')
  if (apiTokenProfile) normalizeProfileId(apiTokenProfile)
  if (!Number.isInteger(minObservationEvidence) || minObservationEvidence < 1) throw new Error('riko-memory minObservationEvidence must be an integer of at least 1')
  if (!Number.isInteger(observationActivationMinEvidence) || observationActivationMinEvidence < 1) throw new Error('riko-memory observationActivationMinEvidence must be an integer of at least 1')
  if (!Number.isInteger(observationActivationMinSessions) || observationActivationMinSessions < 1) throw new Error('riko-memory observationActivationMinSessions must be an integer of at least 1')
  if (!Number.isFinite(observationActivationMinConfidence) || observationActivationMinConfidence < 0 || observationActivationMinConfidence > 1) throw new Error('riko-memory observationActivationMinConfidence must be between 0 and 1')
  if (!Number.isInteger(authoritativeReserve) || authoritativeReserve < 0 || authoritativeReserve > 32) throw new Error('riko-memory recallAuthoritativeReserve must be an integer from 0 through 32')
  if (!Number.isInteger(rawEvidenceMaxCandidates) || rawEvidenceMaxCandidates < 0 || rawEvidenceMaxCandidates > 32) throw new Error('riko-memory recallRawEvidenceMaxCandidates must be an integer from 0 through 32')
  if (unclassifiedEvidenceDisclosure !== 'never_explicit' && unclassifiedEvidenceDisclosure !== 'user_explicit_only') throw new Error('riko-memory unclassifiedEvidenceDisclosure must be never_explicit or user_explicit_only')
  if (!Number.isInteger(embeddingDimension) || embeddingDimension < 8 || embeddingDimension > 4_096) throw new Error('riko-memory embeddingDimension must be an integer from 8 through 4096')
  if (embeddingProvider !== 'off' && embeddingProvider !== 'deterministic' && embeddingProvider !== 'openai-compatible') throw new Error('riko-memory embeddingProvider is invalid')
  let dreamUrl: URL
  try { dreamUrl = new URL(config.dreamApiUrl) } catch { throw new Error('riko-memory dreamApiUrl must be a valid HTTPS URL') }
  if (dreamUrl.protocol !== 'https:') throw new Error('riko-memory dreamApiUrl must use HTTPS')
  if (dreamUrl.username || dreamUrl.password) throw new Error('riko-memory dreamApiUrl must not contain an embedded credential')
  if (embeddingProvider === 'openai-compatible') {
    let embeddingUrl: URL
    try { embeddingUrl = new URL(config.embeddingEndpoint ?? '') } catch { throw new Error('riko-memory embeddingEndpoint must be a valid HTTPS URL') }
    if (embeddingUrl.protocol !== 'https:' && !isLoopbackHttpUrl(embeddingUrl)) throw new Error('riko-memory embeddingEndpoint must use HTTPS (plain HTTP is allowed only for loopback hosts)')
    if (embeddingUrl.username || embeddingUrl.password) throw new Error('riko-memory embeddingEndpoint must not contain an embedded credential')
    if (!(config.embeddingModel ?? '').trim()) throw new Error('riko-memory embeddingModel is required for openai-compatible embeddings')
  }
  for (const [profile, token] of Object.entries(apiTokens)) { normalizeProfileId(profile); if (!token.trim()) throw new Error(`riko-memory apiTokens.${profile} must not be empty`) }
}
function normalizeProfileId(value: string): string { const normalized = value.trim(); if (!/^[A-Za-z0-9._-]{1,64}$/.test(normalized)) throw new Error('riko-memory profile id must contain only letters, numbers, dot, underscore and dash'); return normalized }
/** Plain-HTTP embedding endpoints are only acceptable for loopback hosts, where the traffic never leaves the machine (local inference servers). */
function isLoopbackHttpUrl(url: URL): boolean { return url.protocol === 'http:' && (url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '::1' || url.hostname === '[::1]') }
function serializableEventData(event: SessionEvent): unknown { switch (event.type) { case 'user/message': return { message: event.data }; case 'assistant/message': return { message: event.data.message, turn: event.data.turn, step: event.data.step }; case 'tool/result': return { message: event.data.message, turn: event.data.turn, step: event.data.step }; default: return event.data } }
function bearerToken(req: IncomingMessage): string | undefined { const raw = req.headers.authorization; const match = typeof raw === 'string' ? /^Bearer\s+(.+)$/.exec(raw) : undefined; return match?.[1] }
function safeError(error: unknown): string { const message = error instanceof Error ? error.message : String(error); return message.replace(/bearer\s+[^\s]+/gi, 'Bearer [redacted]').replace(/sk-[A-Za-z0-9_-]+/g, '[redacted]').slice(0, 500) }
// oxlint-disable-next-line sonarjs/duplicates-in-character-class -- ASCII credential-key alphabet; no character is repeated
function secretLikeCredential(value: string): boolean { return /^(?:sk|pk|rk|token|bearer)(?:-|_)[A-Za-z0-9]/i.test(value.trim()) }
function sanitizeRecallPlan(plan: RecallResponse['plan']): Record<string, unknown> {
  return {
    intent: plan.intent,
    searchCanonical: plan.searchCanonical,
    searchEvidence: plan.searchEvidence,
    searchObservation: plan.searchObservation,
    searchGraph: plan.searchGraph,
    graphMaxHop: plan.graphMaxHop,
    searchVector: plan.searchVector,
    temporalMode: plan.temporalMode,
    ...(plan.atTime === undefined ? {} : { atTime: plan.atTime }),
    maxCandidates: plan.maxCandidates,
    maxContextChars: plan.maxContextChars,
    authoritativeReserve: plan.authoritativeReserve,
    rawEvidenceMaxCandidates: plan.rawEvidenceMaxCandidates,
  }
}
function sanitizeRecallResult(result: RecallResponse['results'][number]): Record<string, unknown> {
  return {
    id: result.id,
    sourceType: result.sourceType,
    authorityTier: result.authorityTier,
    sourceRefs: [...result.sourceRefs],
    epistemicStatus: result.epistemicStatus,
    temporalStatus: result.temporalStatus,
    sensitivity: result.sensitivity,
    channels: [...result.channels],
    fusedScore: result.fusedScore,
    mentionDecision: result.mentionDecision,
    ...(result.role === undefined ? {} : { role: result.role }),
    eligibility: result.eligibility,
    ...(result.rejectionReason === undefined ? {} : { rejectionReason: result.rejectionReason }),
  }
}
function redactWikiPage(page: WikiPage): Record<string, unknown> {
  const sensitivity = page.sensitivity ?? 'normal'
  return {
    id: page.id,
    type: page.type,
    status: page.status,
    consent: page.consent,
    ...(page.timestamp === undefined ? {} : { timestamp: page.timestamp }),
    ...(page.observedAt === undefined ? {} : { observedAt: page.observedAt }),
    ...(page.recordedAt === undefined ? {} : { recordedAt: page.recordedAt }),
    ...(page.updatedAt === undefined ? {} : { updatedAt: page.updatedAt }),
    ...(page.validFrom === undefined ? {} : { validFrom: page.validFrom }),
    ...(page.validTo === undefined ? {} : { validTo: page.validTo }),
    ...(page.validUntil === undefined ? {} : { validUntil: page.validUntil }),
    sensitivity,
    version: page.version,
    sourceCount: page.sources.length,
    tagCount: page.tags.length,
    bodyLineCount: page.body.trimEnd().length === 0 ? 0 : page.body.trimEnd().split('\n').length,
    bodyBytes: Buffer.byteLength(page.body),
    redacted: true,
  }
}
function projectMemoryRecord(record: MemoryItem): object {
  if (record.sensitivity === 'normal') return record
  return {
    id: record.id,
    kind: record.kind,
    category: record.category,
    status: record.status,
    confidence: record.confidence,
    consent: record.consent,
    observedAt: record.observedAt,
    ...(record.recordedAt === undefined ? {} : { recordedAt: record.recordedAt }),
    ...(record.validFrom === undefined ? {} : { validFrom: record.validFrom }),
    ...(record.validTo === undefined ? {} : { validTo: record.validTo }),
    ...(record.validUntil === undefined ? {} : { validUntil: record.validUntil }),
    sensitivity: record.sensitivity,
    sourceConversationCount: record.sourceConversations.length,
    sensitivityHistoryCount: record.sensitivityHistory?.length ?? 0,
    redacted: true,
  }
}
function projectCandidate(candidate: MemorySnapshot['candidates'][number]): object {
  if ((candidate.page.sensitivity ?? 'normal') === 'normal') return candidate
  return {
    id: candidate.id,
    status: candidate.status,
    createdAt: candidate.createdAt,
    ...(candidate.conflictPageId === undefined ? {} : { conflictPageId: candidate.conflictPageId }),
    sourceConversationCount: candidate.sourceConversations.length,
    page: redactWikiPage(candidate.page),
    redacted: true,
  }
}
function projectObservation(observation: MemoryObservation): object {
  if (observation.sensitivity === 'normal') return observation
  return {
    id: observation.id,
    status: observation.status,
    epistemicStatus: observation.epistemicStatus,
    confidence: observation.confidence,
    evidenceCount: observation.evidenceCount,
    supportingEvidenceCount: observation.supportingRefs?.length ?? observation.sourceRefs.length,
    contradictingEvidenceCount: observation.contradictingRefs?.length ?? 0,
    observedAt: observation.observedAt,
    recordedAt: observation.recordedAt,
    ...(observation.lastEvidenceAt === undefined ? {} : { lastEvidenceAt: observation.lastEvidenceAt }),
    ...(observation.validFrom === undefined ? {} : { validFrom: observation.validFrom }),
    ...(observation.validTo === undefined ? {} : { validTo: observation.validTo }),
    sensitivity: observation.sensitivity,
    sensitivityHistoryCount: observation.sensitivityHistory?.length ?? 0,
    redacted: true,
  }
}
function managementSnapshot(snapshot: MemorySnapshot, store: MemoryProfileStore): Record<string, unknown> {
  const protectedPageIds = new Set(store.listPages().filter(page => page.sensitivity !== undefined && page.sensitivity !== 'normal').map(page => page.id))
  const pages = snapshot.pages?.map((page) => {
    if (!protectedPageIds.has(page.id)) return page
    const fullPage = store.page(page.id)
    return fullPage === undefined ? page : redactWikiPage(fullPage)
  })
  const graph = snapshot.graph === undefined ? undefined : {
    nodes: snapshot.graph.nodes.map(node => protectedPageIds.has(node.id) ? { id: node.id, type: node.type, ...(node.layer === undefined ? {} : { layer: node.layer }), redacted: true } : node),
    edges: snapshot.graph.edges.filter(edge => !protectedPageIds.has(edge.sourcePageId) && (edge.targetPageId === undefined || !protectedPageIds.has(edge.targetPageId))),
  }
  return {
    ...snapshot,
    records: snapshot.records.map(projectMemoryRecord),
    candidates: snapshot.candidates.map(projectCandidate),
    observations: snapshot.observations?.map(projectObservation),
    ...(pages === undefined ? {} : { pages }),
    ...(graph === undefined ? {} : { graph }),
  }
}
function wait(milliseconds: number): Promise<void> { return new Promise(resolve => setTimeout(resolve, milliseconds)) }
function latestEventSeq(evidence: string | undefined): number | undefined { if (!evidence) return undefined; let latest: number | undefined; for (const line of evidence.split('\n')) { try { const value = JSON.parse(line) as { seq?: unknown }; if (typeof value.seq === 'number' && Number.isInteger(value.seq)) latest = Math.max(latest ?? value.seq, value.seq) } catch { /* malformed legacy line does not advance the cursor */ } } return latest }
function serializableText(value: unknown): string { return typeof value === 'string' ? value : '' }
interface TranscriptMessage { readonly role: string; readonly source?: { readonly kind?: string }; readonly content: readonly { readonly type: string; readonly text?: string }[] }
function transcriptText(messages: readonly TranscriptMessage[], maxChars: number): string { const lines: string[] = []; for (const message of messages) { if (message.role === 'user' && message.source?.kind !== undefined && message.source.kind !== 'user') continue; const text = message.content.filter(block => block.type === 'text').map(block => serializableText(block.text)).join('\n').trim(); if (text) lines.push(`${message.role}: ${text}`) } return truncate(lines.join('\n\n'), maxChars) }

function transcriptFromEvidence(lines: readonly string[], maxChars: number): string {
  const messages: TranscriptMessage[] = []
  for (const line of lines) {
    try {
      const event = JSON.parse(line) as { type?: unknown; data?: unknown }
      const role = event.type === 'user/message' ? 'user' : event.type === 'assistant/message' ? 'assistant' : undefined
      const message = event.data && typeof event.data === 'object' ? (event.data as { message?: unknown }).message : undefined
      const content = message && typeof message === 'object' && Array.isArray((message as { content?: unknown }).content) ? (message as { content: Array<{ type?: unknown; text?: unknown }>; source?: { kind?: unknown } }).content : []
      const sourceKind = message && typeof message === 'object' && typeof (message as { source?: { kind?: unknown } }).source?.kind === 'string' ? String((message as { source: { kind: string } }).source.kind) : undefined
      if (role === 'user' && sourceKind !== undefined && sourceKind !== 'user') continue
      const text = content.filter(block => block.type === 'text' && typeof block.text === 'string').map(block => block.text as string)
      if (role && text.length > 0) messages.push({ role, ...(sourceKind === undefined ? {} : { source: { kind: sourceKind } }), content: text.map(value => ({ type: 'text', text: value })) })
    } catch { /* malformed retained L0 lines do not become provider input */ }
  }
  return transcriptText(messages, maxChars)
}

/**
 * Parse one Dream provider response into bounded Wiki page candidates.
 * @param text - Raw provider response carrying `<<<FILE>>>` blocks.
 * @param session - Owning session, or its identifier.
 * @returns The parsed pages; a response with no valid block raises a provider failure.
 */
export function parseWikiOutput(text: string, session: Pick<Session, 'id'> | string): WikiPage[] { const sessionId = typeof session === 'string' ? session : String(session.id); const pages: WikiPage[] = []; for (const match of text.matchAll(/<<<FILE\s+path="([^"]+)">>>([\s\S]*?)<<<END>>>/g)) { const path = match[1]?.trim(); const block = match[2]; if (!path || block === undefined || block.length > 30_000) continue; try { const parsed = parseWikiMarkdown(block.trim(), path); const description = truncate((parsed.description || firstBodySentence(parsed.body) || parsed.title).replace(/\s+/g, ' ').trim(), 120); const body = truncate(parsed.body.replace(/\s+/g, ' ').trim(), 1_200); const title = compactGeneratedTitle(parsed.type, parsed.title, description, body); const identity = contentHash(`${parsed.type}\n${title.toLocaleLowerCase()}\n${description.toLocaleLowerCase()}\n${body.toLocaleLowerCase()}`).slice(0, 10); const normalizedPath = `wiki/${pageFolder(parsed.type)}/${pageSlug(title, identity)}-${identity}.md`; pages.push({ ...parsed, id: wikiPageId(normalizedPath), path: normalizedPath, title, description, body, sources: [sessionId], status: 'candidate', consent: false, locked: false, version: 1, updatedAt: new Date().toISOString() }) } catch { /* invalid FILE blocks are rejected, never partially stored */ } } if (pages.length === 0) throw new ProviderError('invalid-file-protocol'); return pages }

interface ExplicitCoreference {
  readonly entityId: string
  readonly alias: string
}

function explicitCoreferences(text: string, pages: readonly WikiPage[]): ExplicitCoreference[] {
  const matches: ExplicitCoreference[] = []
  for (const sentence of text.split(/[。！？!?；;\n]/).map(value => value.trim()).filter(Boolean)) {
    const sentenceMatches = new Map<string, ExplicitCoreference>()
    for (const page of pages) {
      const title = page.title.trim()
      if (!title) continue
      const escapedTitle = escapeRegExp(title)
      const before = new RegExp(`(?:^|[：:,，、])\\s*([A-Za-z0-9\\u3400-\\u9fff_-]{2,32})\\s+${escapedTitle}(?=$|[\\s，、。！？!?；;])`).exec(sentence)?.[1]
      const after = new RegExp(`${escapedTitle}\\s*[（(]\\s*([A-Za-z0-9\\u3400-\\u9fff_-]{2,32})\\s*[）)]`).exec(sentence)?.[1]
      for (const alias of [before, after]) {
        if (alias === undefined || alias === title) continue
        sentenceMatches.set(`${page.id}\n${alias.toLocaleLowerCase()}`, { entityId: page.id, alias })
      }
    }
    const byEntity = [...sentenceMatches.values()]
    const entityIds = new Set(byEntity.map(match => match.entityId))
    const only = byEntity[0]
    if (entityIds.size === 1 && byEntity.length === 1 && only !== undefined) matches.push(only)
  }
  return matches
}

function compactGeneratedTitle(type: WikiPage['type'], title: string, description: string, body: string): string {
  const clean = title.replace(/[“”"'「」『』]/g, '').replace(/\s+/g, ' ').trim().replace(/[。！？!?；;：:]$/, '')
  const latinRatio = (clean.match(/[A-Za-z]/g)?.length ?? 0) / Math.max(1, clean.length)
  if (clean.length >= 2 && clean.length <= 24 && !/[。！？!?；;]/.test(clean) && latinRatio < .45) return clean
  const signal = `${clean}\n${description}\n${body}`.toLocaleLowerCase()
  if (type === 'source') return '会话摘要'
  if (type === 'entity') return /项目|工具|产品|project|tool/.test(signal) ? '长期项目' : '用户事实'
  if (type === 'concept') return /边界|不要|不喜欢|安静|打扰|quiet|boundary|22:00|十点/.test(signal) ? '沟通边界' : /偏好|喜欢|称呼|沟通|prefer|like/.test(signal) ? '沟通偏好' : '长期偏好'
  if (type === 'episode') return /工作|转行|项目|经历|experience|project/.test(signal) ? '重要经历' : '关键事件'
  if (type === 'emotion') return '近期状态'
  if (type === 'relationship') return '陪伴关系'
  if (type === 'synthesis') return '长期记忆总览'
  return '用户记忆'
}

function firstBodySentence(body: string): string { return body.split(/[。！？!?\n]/, 1)[0]?.trim() ?? '' }

function messageText(value: unknown): string {
  if (!value || typeof value !== 'object') return ''
  const content = (value as { readonly content?: unknown }).content
  if (!Array.isArray(content)) return ''
  return content.filter((block): block is { readonly type?: unknown; readonly text?: unknown } => typeof block === 'object' && block !== null).filter(block => block.type === 'text' && typeof block.text === 'string').map(block => block.text as string).join('\n').trim()
}

function parseMemorySensitivity(value: unknown): MemorySensitivity | undefined {
  return value === 'normal' || value === 'provisional_sensitive' || value === 'sensitive' ? value : undefined
}

function manualMemory(body: unknown, profile: string): MemoryItem { if (!body || typeof body !== 'object') throw new Error('memory body must be an object'); const input = body as Record<string, unknown>; const content = typeof input.content === 'string' ? input.content.trim() : ''; if (!content) throw new Error('memory content must be non-empty'); const category = categories.includes(input.category as MemoryCategory) ? input.category as MemoryCategory : chooseCategory(content); const kind = kinds.includes(input.kind as MemoryKind) ? input.kind as MemoryKind : 'fact'; const confidence = typeof input.confidence === 'number' && Number.isFinite(input.confidence) ? Math.min(1, Math.max(0, input.confidence)) : 1; const now = new Date().toISOString(); return { id: typeof input.id === 'string' && input.id ? input.id : memoryId(category, content), kind, category, content: truncate(content, 2_000), confidence, status: 'confirmed', sourceConversations: typeof input.sourceConversation === 'string' ? [input.sourceConversation] : [`client:${profile}`], observedAt: typeof input.observedAt === 'string' ? input.observedAt : now, sensitivity: input.sensitivity === 'sensitive' ? 'sensitive' : 'normal', consent: true } }
function manualWikiPage(body: unknown, profile: string): WikiPage { if (!body || typeof body !== 'object') throw new Error('wiki page body must be an object'); const input = body as Record<string, unknown>; const path = typeof input.path === 'string' ? input.path.trim() : ''; if (!path) throw new Error('wiki page path must be non-empty'); const markdown = typeof input.markdown === 'string' ? input.markdown : renderWikiMarkdown({ path, type: typeof input.type === 'string' ? input.type as WikiPage['type'] : 'concept', title: typeof input.title === 'string' ? input.title : 'Manual page', description: typeof input.description === 'string' ? input.description : typeof input.content === 'string' ? input.content : '', body: typeof input.content === 'string' ? input.content : '', sources: [`client:${profile}`], tags: [], timestamp: new Date().toISOString(), confidence: 1, status: 'confirmed', consent: true, locked: true }); const parsed = parseWikiMarkdown(markdown, path); return { ...parsed, id: wikiPageId(parsed.path), status: 'confirmed', consent: true, locked: true, version: typeof input.version === 'number' && Number.isInteger(input.version) && input.version > 0 ? input.version : 1, updatedAt: new Date().toISOString() } }
function chooseCategory(content: string): MemoryCategory { if (/情绪|心情|难过|开心|焦虑|感觉|emotion|feel/i.test(content)) return 'emotions'; if (/不要|不喜欢|偏好|沟通|称呼|追问|喜欢|prefer|like/i.test(content)) return 'interaction_rules'; if (/目标|希望|想要|计划|goal|want|plan/i.test(content)) return 'promises_goals'; if (/经历|发生|过去|事件|experience|when i/i.test(content)) return 'key_experiences'; return 'traits_roles' }
function setCors(res: ServerResponse): void { res.setHeader('access-control-allow-origin', 'null'); res.setHeader('access-control-allow-headers', 'authorization, content-type, x-dsh-memory-profile'); res.setHeader('access-control-allow-methods', 'GET,POST,PUT,DELETE,OPTIONS') }
function sendJson(res: ServerResponse, status: number, body: unknown): void { if (res.headersSent) return; res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)) }
function sendHtml(res: ServerResponse, html: string): void { if (res.headersSent) return; res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); res.end(html) }
async function readJsonBody(req: IncomingMessage): Promise<unknown> { const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk)); if (chunks.length === 0) return {}; return JSON.parse(Buffer.concat(chunks).toString('utf8')) }
function optionalString(body: unknown, key: string): string | undefined { return body && typeof body === 'object' && typeof (body as Record<string, unknown>)[key] === 'string' ? String((body as Record<string, unknown>)[key]) : undefined }
function queryNumber(value: string | null, fallback: number, min: number, max: number): number { const number = value === null ? NaN : Number(value); return Number.isFinite(number) ? Math.min(max, Math.max(min, Math.round(number))) : fallback }
function truncate(value: string, max: number): string { return value.length <= max ? value : `${value.slice(0, Math.max(0, max - 1))}…` }

interface MemoryToolValue {
  readonly scopeKey: string
  readonly id?: string
  readonly resident: string
  readonly version: string
  readonly confirmationRequired?: boolean
  readonly candidates?: string[]
}

const MEMORY_TOOL_OUTPUT = {
  schema: {
    type: 'object', additionalProperties: false,
    properties: {
      scopeKey: { type: 'string', required: true },
      id: { type: 'string' },
      resident: { type: 'string', required: true },
      version: { type: 'string', required: true },
      confirmationRequired: { type: 'boolean' },
      candidates: { type: 'array', items: { type: 'string' } },
    },
  } as const,
  render: (_args: {}, value: MemoryToolValue) => [{ type: 'text' as const, text: value.confirmationRequired === true ? `Confirmation required for memory targets: ${(value.candidates ?? []).join(', ')}` : value.id === undefined ? `Memory scope ${value.scopeKey}; resident version ${value.version}` : `Memory ${value.id} updated in ${value.scopeKey}; resident version ${value.version}` }],
} as const

function latestUserText(session: Session): string {
  const messages = session.deriveMessages() as unknown as ReadonlyArray<{ role?: string; source?: { kind?: string }; content?: readonly { type?: string; text?: string }[] }>
  for (const message of [...messages].reverse()) {
    if (message.role !== 'user' || (message.source?.kind !== undefined && message.source.kind !== 'user')) continue
    return (message.content ?? []).filter(block => block.type === 'text').map(block => block.text ?? '').join('\n').trim()
  }
  return ''
}

function userQueryFromMessages(messages: readonly UserMessage[]): string {
  const text = messages
    .filter(message => message.source.kind === 'user')
    .flatMap(message => message.content)
    .filter((block): block is { readonly type: 'text'; readonly text: string } => block.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('\n')
    .trim()
  return text
}

function createRecallMessage(response: RecallResponse): UserMessage | undefined {
  const text = renderRecallContext(response.results, response.plan.maxContextChars)
  if (!text) return undefined
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'plugin', plugin: '@deepseek-ai/dsh-riko-memory', form: 'recall' } })
}

const deletionCue = /忘记|忘掉|删除|移除|forget|remove|delete/i
const suppressionCue = /不要再主动提|别说|别提起|不要再提|don't mention|do not mention|stop mentioning/i
const restoreCue = /恢复(?:提及|这条|记忆)?|可以(?:再)?提|再(?:说|提)(?:这个|这件事)?|restore|mention again/i



interface TargetResolution {
  readonly kind: 'resolved' | 'ambiguous'
  readonly page?: WikiPage
  readonly pages: readonly WikiPage[]
}

function explicitMemory(content: string, sessionId: string, sensitivity?: MemoryItem['sensitivity']): MemoryItem {
  const category = chooseCategory(content)
  const kind: MemoryKind = category === 'interaction_rules' ? 'preference' : category === 'emotions' ? 'emotion' : category === 'key_experiences' ? 'event' : 'fact'
  const effectiveSensitivity = classifyMemorySensitivity(content, sensitivity)
  return { id: memoryId(category, content), kind, category, content: truncate(content, 2_000), confidence: 1, status: 'confirmed', sourceConversations: [sessionId], observedAt: new Date().toISOString(), sensitivity: effectiveSensitivity, consent: true }
}



function confirmationResult(scopeKey: string, store: MemoryProfileStore, pages: readonly WikiPage[]): MemoryToolValue {
  return { scopeKey, confirmationRequired: true, candidates: pages.map(page => `${page.title} (${page.id})`), resident: store.renderResident(), version: store.snapshot().residentSnapshot?.version ?? '' }
}

function resolveCanonicalTarget(store: MemoryProfileStore, userText: string, requestedTarget: string | undefined): TargetResolution {
  const requested = requestedTarget?.trim()
  if (requested !== undefined && requested.length > 0 && !userText.includes(requested)) throw new Error('memory target must appear in the latest raw user message')
  const direct = requested === undefined ? undefined : store.page(requested)
  if (direct !== undefined) return { kind: 'resolved', page: direct, pages: [direct] }
  const query = (requested ?? userText).replace(new RegExp(deletionCue.source, 'gi'), ' ').replace(/请|帮我|把|这个|这条|刚才|please|help me|the memory/gi, ' ').replace(/\s+/g, ' ').trim()
  const matches = new Map<string, WikiPage>()
  for (const result of store.search(query, 32)) if (result.page.type !== 'source' && result.page.status !== 'candidate') matches.set(result.page.id, result.page)
  for (const alias of store.listAliases().filter(alias => alias.status === 'active')) {
    if (!query.toLocaleLowerCase().includes(alias.normalizedAlias)) continue
    const page = store.page(alias.entityId); if (page !== undefined && page.type !== 'source' && page.status !== 'candidate') matches.set(page.id, page)
  }
  const pages = [...matches.values()].sort((left, right) => left.title.localeCompare(right.title) || left.id.localeCompare(right.id))
  const only = pages[0]
  return pages.length === 1 && only !== undefined ? { kind: 'resolved', page: only, pages } : pages.length === 0 ? { kind: 'resolved', pages } : { kind: 'ambiguous', pages }
}

function classifyTemporalTransition(content: string): { readonly sourceText: string } | undefined {
  const historical = /(?:以前|过去|之前|原来)([^，,。；;]{1,80})(?:现在|如今|目前)/.exec(content)?.[1]?.trim()
  if (historical) return { sourceText: historical }
  const moved = /(?:从|由)([^，,。；;]{1,60})(?:搬到|改到|换到)/.exec(content)?.[1]?.trim()
  if (moved) return { sourceText: moved }
  return /以前|过去|之前|原来|搬到|改成|改为|换成|现在住|现在在/.test(content) ? { sourceText: content } : undefined
}

function resolveTemporalTarget(store: MemoryProfileStore, sourceText: string, newMemoryId: string): WikiPage | undefined {
  const matches = store.search(sourceText, 16).map(result => result.page).filter(page => page.id !== newMemoryId && page.type !== 'source' && page.status === 'confirmed' && page.consent && page.usagePolicy !== 'suppressed')
  const unique = [...new Map(matches.map(page => [page.id, page])).values()]
  return unique.length === 1 ? unique[0] : undefined
}

function parseReflectionOutput(text: string, maxObservations: number, sessionId: string): Array<{ readonly text: string; readonly sourceRefs: readonly string[]; readonly confidence: number }> {
  let value: unknown
  try { value = JSON.parse(text.trim()) } catch { throw new ProviderError('reflection-invalid-output') }
  if (!value || typeof value !== 'object' || !Array.isArray((value as { observations?: unknown }).observations)) throw new ProviderError('reflection-invalid-output')
  const observations = (value as { observations: unknown[] }).observations
  if (observations.length > maxObservations) throw new ProviderError('reflection-limit-exceeded')
  const parsed: Array<{ readonly text: string; readonly sourceRefs: readonly string[]; readonly confidence: number }> = []
  for (const item of observations) {
    if (!item || typeof item !== 'object') throw new ProviderError('reflection-invalid-observation')
    const candidate = item as { text?: unknown; sourceRefs?: unknown; confidence?: unknown }
    const observationText = typeof candidate.text === 'string' ? candidate.text.trim() : ''
    const sourceRefs = Array.isArray(candidate.sourceRefs) ? candidate.sourceRefs.filter((ref): ref is string => typeof ref === 'string').map(ref => ref.trim()).filter(Boolean) : []
    const confidence = typeof candidate.confidence === 'number' ? candidate.confidence : NaN
    if (!observationText || sourceRefs.length === 0 || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) throw new ProviderError('reflection-invalid-observation')
    if (sourceRefs.some(ref => !new RegExp(`^session:${escapeRegExp(sessionId)}/event:[0-9]+$`).test(ref) && !/^page:[^/]+$/.test(ref))) throw new ProviderError('reflection-invalid-anchor')
    parsed.push({ text: truncate(observationText, 2_000), sourceRefs: [...new Set(sourceRefs)], confidence })
  }
  return parsed
}

function observationAnchors(evidence: string, sessionId: string): string[] {
  const anchors: string[] = []
  for (const line of evidence.split('\n')) {
    try {
      const value = JSON.parse(line) as { type?: unknown; seq?: unknown }
      if (value.type === 'user/message' && typeof value.seq === 'number' && Number.isInteger(value.seq)) anchors.push(`session:${sessionId}/event:${String(value.seq)}`)
    } catch { /* malformed retained evidence is not a provider anchor */ }
  }
  return [...new Set(anchors)].slice(-64)
}

function explicitRecallAtTime(query: string): string | undefined {
  const month = /(?:^|[^0-9])(20\d{2})\s*(?:年|[-/])\s*(0?[1-9]|1[0-2])\s*(?:月|[-/])?/.exec(query)
  if (month) return new Date(Date.UTC(Number(month[1]), Number(month[2]) - 1, 1)).toISOString()
  const year = /(?:^|[^0-9])(20\d{2})\s*年/.exec(query)
  return year ? new Date(Date.UTC(Number(year[1]), 0, 1)).toISOString() : undefined
}

function hasHistoricalRecallCue(query: string): boolean { return /以前|过去|曾经|之前|去年|上个月|上周|before|earlier|in the past|last year|last month/i.test(query) }
function escapeRegExp(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') }
