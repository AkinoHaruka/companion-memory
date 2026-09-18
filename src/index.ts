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
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import type {} from '@deepseek-ai/dsh-agent-presets'
import type {} from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { memoryScopeForPreset, type MemoryScope } from './contracts.ts'
import { MEMORY_DOMAIN, type MemoryDomain, type MemorySessionRecord } from './memory-domain.ts'
import { memoryId, MemoryProfileStore } from './store.ts'
import type { DreamSettings, MemoryCategory, MemoryItem, MemoryKind, MemorySnapshot } from './types.ts'
import { contentHash, pageFolder, pageSlug, parseWikiMarkdown, renderWikiMarkdown, wikiPageId, type WikiPage } from './wiki.ts'
import { memoryUiHtml } from './ui.ts'
import { buildDreamRequest, extractDreamText } from './dream-protocol.ts'

export type { EvidenceRef, MemoryCandidate, MemoryScope, WikiPage as MemoryWikiPage, ResidentSnapshot as MemoryResidentSnapshot, DreamJob } from './contracts.ts'
export type { DreamSettings, MemoryCategory, MemoryItem, MemoryKind, MemorySnapshot, MemoryStatus } from './types.ts'

/** Runtime configuration. Secrets are never accepted here; only credential references are. */
export interface Config {
  readonly ownerNamespace: string
  readonly apiPath: string
  readonly apiToken: string
  readonly apiTokens: Readonly<Record<string, string>>
  readonly dreamApiUrl: string
  readonly dreamCredentialRef: string
  readonly dreamModel: string
  readonly dreamMaxTokens: number
  readonly dreamIntervalMs: number
  readonly debounceMs: number
  readonly maxResidentChars: number
  readonly maxSessionChars: number
  readonly demoEnabled: boolean
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
    dreamApiUrl: z.string().default('https://api.deepseek.com/api/v1/chat/completions'),
    dreamCredentialRef: z.string().default('DSH_MEMORY_DREAM_API_KEY'),
    dreamModel: z.string().default('deepseek-chat'),
    dreamMaxTokens: z.number().step(1).min(128).default(1200),
    dreamIntervalMs: z.number().step(1).min(60_000).default(3_600_000),
    debounceMs: z.number().step(1).min(0).default(5_000),
    maxResidentChars: z.number().step(1).min(256).default(12_000),
    maxSessionChars: z.number().step(1).min(1_000).default(40_000),
    demoEnabled: z.boolean().default(false),
  })

  private readonly stores = new Map<string, MemoryProfileStore>()
  private readonly agentScopes = new Map<string, MemoryScope>()
  private readonly pendingDreams = new Map<string, () => void>()
  private readonly sessionWrites = new Map<string, Promise<void>>()
  private readonly dreaming = new Set<string>()
  private readonly profileDreamQueues = new Map<string, Promise<void>>()
  private readonly inFlight = new Set<Promise<unknown>>()
  private domain: MemoryDomain | undefined

  constructor(ctx: Context, readonly config: Config) {
    super(ctx, 'rikoMemory')
    validateConfig(config)
    ctx.on('session/event', (session, event) => { this.observeSessionEvent(session, event) })
    ctx.on('agent/created', ({ agent }) => { this.attachAgent(agent) })
    ctx.on('agent/disposed', ({ agent }) => { const key = String(agent.id); this.agentScopes.delete(key); this.pendingDreams.get(key)?.(); this.pendingDreams.delete(key) })
    this.ctx.timer.interval(() => { void this.track(this.dreamAll(), 'scheduled Dream') }, config.dreamIntervalMs)
    ctx.effect(() => async () => {
      for (const cancel of this.pendingDreams.values()) cancel()
      this.pendingDreams.clear()
      await Promise.allSettled([...this.inFlight])
      await this.domain?.close()
    }, 'riko-memory: drain and close domain')
    ctx.effect(
      () => ctx.webServer.register({ kind: 'prefix', path: config.apiPath, handler: (req, res) => this.handleRequest(req, res) }),
      `riko-memory: ${config.apiPath}`,
    )
    this.registerTools()
  }

  /** Open the one versioned storage domain and attach existing agents. */
  async [Service.init](): Promise<void> {
    if (this.ctx.webServer.host !== '127.0.0.1' && this.config.apiToken.length === 0 && Object.keys(this.config.apiTokens).length === 0) throw new Error('riko-memory requires apiToken or apiTokens on a non-loopback web server')
    this.domain = await this.ctx.storageDomain.open(MEMORY_DOMAIN)
    for (const agent of this.ctx.agents.list()) this.attachAgent(agent)
    void this.track(this.recoverPersistedDreams(), 'startup Dream recovery')
  }

  /** Read one already-open profile scope for in-process composition tests. */
  async snapshot(profileId: string): Promise<MemorySnapshot> { const store = this.storeForProfile(profileId); await store.waitReady(); return store.snapshot() }

  private attachAgent(agent: Agent): void {
    const key = String(agent.id); if (this.agentScopes.has(key)) return
    try {
      const scope = this.scopeForSession(agent.session); this.agentScopes.set(key, scope); const store = this.storeForScope(scope)
      agent.ctx.systemPrompt.context({ name: 'riko-memory', order: 260, text: () => truncate(store.renderResident(), this.config.maxResidentChars) })
    } catch (error) {
      this.ctx.logger.warn(`riko-memory resident injection skipped: ${safeError(error)}`)
    }
  }

  private observeSessionEvent(session: Session, event: SessionEvent): void {
    let scope: MemoryScope
    try { scope = this.scopeForSession(session) } catch (error) { this.ctx.logger.warn(`riko-memory L0 write rejected: ${safeError(error)}`); return }
    const store = this.storeForScope(scope); const line = JSON.stringify({ schemaVersion: 1, sessionId: String(session.id), seq: event.seq, time: event.time, type: event.type, data: serializableEventData(event) }); const sessionId = String(session.id); const previous = this.sessionWrites.get(sessionId) ?? Promise.resolve(); const write = previous.then(() => store.appendSessionEvent(sessionId, line)); this.sessionWrites.set(sessionId, write.catch(() => undefined)); void this.track(write, 'session evidence'); if (event.type === 'turn/end') this.scheduleDream(session, scope, write)
  }

  private scheduleDream(session: Session, scope: MemoryScope, evidenceBarrier: Promise<void>): void {
    const key = String(session.id); this.pendingDreams.get(key)?.(); const dispose = this.ctx.timer.timeout(() => { this.pendingDreams.delete(key); void this.track(evidenceBarrier.then(() => this.enqueueProfileDream(scope, () => this.dreamSession(session, scope))), `session Dream ${key}`) }, this.config.debounceMs); this.pendingDreams.set(key, dispose)
  }

  private async enqueueProfileDream<T>(scope: MemoryScope, operation: () => Promise<T>): Promise<T> {
    const previous = this.profileDreamQueues.get(scope.key) ?? Promise.resolve(); const next = previous.then(operation); this.profileDreamQueues.set(scope.key, next.then(() => undefined, () => undefined)); return next
  }

  private async dreamAll(): Promise<void> {
    const work: Promise<void>[] = []
    for (const session of this.ctx.sessions.list()) {
      try { const scope = this.scopeForSession(session); work.push(this.enqueueProfileDream(scope, () => this.dreamSession(session, scope))) } catch { /* fail-closed sessions are not durable-memory work */ }
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
      await store.upsertJob({ id: jobId, sessionId: key, scopeKey: scope.key, status: 'succeeded', attempts, cursor: latestEventSeq(await store.sessionEvidence(key)) ?? cursor, createdAt: typeof previous?.createdAt === 'string' ? previous.createdAt : now, updatedAt: new Date().toISOString() })
    } catch (error) {
      await store.markDreamFailure(error).catch(() => undefined)
      await store.upsertJob({ id: jobId, sessionId: key, scopeKey: scope.key, status: 'failed', attempts, cursor, error: safeError(error), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }).catch(() => undefined)
      this.ctx.logger.warn(`riko-memory Dream failed for session ${key}: ${safeError(error)}`)
    } finally {
      this.dreaming.delete(key)
    }
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

  private scopeForSession(session: Session): MemoryScope { return memoryScopeForPreset(this.config.ownerNamespace, this.ctx.sessionProjections.stateOf(session, 'agentPreset')) }
  private scopeForProfile(profileId: string): MemoryScope { return memoryScopeForPreset(this.config.ownerNamespace, normalizeProfileId(profileId)) }
  private storeForProfile(profileId: string): MemoryProfileStore { return this.storeForScope(this.scopeForProfile(profileId)) }
  private storeForScope(scope: MemoryScope): MemoryProfileStore { if (!this.domain) throw new Error('riko-memory storage domain is not initialized'); let store = this.stores.get(scope.key); if (!store) { store = new MemoryProfileStore(this.domain, scope, this.defaultDreamSettings()); this.stores.set(scope.key, store); void store.waitReady().catch(error => this.ctx.logger.warn(`riko-memory scope ${scope.key} failed to load: ${safeError(error)}`)) } return store }
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
      parameters: { content: { type: 'string', required: true, description: 'The exact preference, boundary, goal, fact or event the user explicitly stated.' } },
      output: MEMORY_TOOL_OUTPUT,
      execute: async (args, exec) => {
        const agent = exec.agent; if (!agent) throw new Error('memory tool requires an agent session'); const content = String((args as { content: string }).content).trim(); const userText = latestUserText(agent.session); if (!content || !userText.includes(content)) throw new Error('memory_remember requires an exact claim from the latest raw user message')
        const scope = service.scopeForSession(agent.session); const store = service.storeForScope(scope); const item = explicitMemory(content, String(agent.session.id)); await store.upsertManual(item); return { scopeKey: scope.key, id: store.page(item.id)?.id ?? item.id, resident: store.renderResident(), version: store.snapshot().residentSnapshot?.version ?? '' }
      },
    }))
    this.ctx.tools.register(defineTool({
      name: 'memory_correct',
      description: 'Correct a memory only when the latest raw user message contains the replacement claim.',
      parameters: { id: { type: 'string', required: true, description: 'Canonical Wiki page or memory id.' }, content: { type: 'string', required: true, description: 'Replacement claim explicitly stated by the user.' } },
      output: MEMORY_TOOL_OUTPUT,
      execute: async (args, exec) => {
        const agent = exec.agent; if (!agent) throw new Error('memory tool requires an agent session'); const input = args as { id: string; content: string }; if (!latestUserText(agent.session).includes(input.content.trim())) throw new Error('memory_correct requires replacement text from the latest raw user message')
        const scope = service.scopeForSession(agent.session); const store = service.storeForScope(scope); const page = await store.editPage(input.id, { description: input.content.trim(), body: input.content.trim() }); if (!page) throw new Error('memory page not found'); return { scopeKey: scope.key, id: page.id, resident: store.renderResident(), version: store.snapshot().residentSnapshot?.version ?? '' }
      },
    }))
    this.ctx.tools.register(defineTool({
      name: 'memory_forget',
      description: 'Remove derived memory after an explicit user request in the latest raw message. Raw Session evidence remains and is disclosed.',
      parameters: { id: { type: 'string', required: true, description: 'Canonical Wiki page or memory id.' } },
      output: MEMORY_TOOL_OUTPUT,
      execute: async (args, exec) => {
        const agent = exec.agent; if (!agent) throw new Error('memory tool requires an agent session'); const id = String((args as { id: string }).id); const userText = latestUserText(agent.session); if (!/忘记|删除|forget|remove/i.test(userText) || !userText.includes(id)) throw new Error('memory_forget requires an explicit latest user request naming the memory id')
        const scope = service.scopeForSession(agent.session); const store = service.storeForScope(scope); if (!await store.forget(id)) throw new Error('memory page not found'); return { scopeKey: scope.key, id, resident: store.renderResident(), version: store.snapshot().residentSnapshot?.version ?? '' }
      },
    }))
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      setCors(res); if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return }
      const requestUrl = new URL(req.url ?? '/', 'http://dsh'); const pathname = requestUrl.pathname; const relative = pathname.slice(this.config.apiPath.length).replace(/^\/+/, ''); const publicUi = req.method === 'GET' && (relative.length === 0 || relative === 'ui'); if (publicUi) { sendHtml(res, memoryUiHtml); return }
      const profile = this.authenticatedProfile(req); if (!profile) { sendJson(res, 401, { error: 'unauthorized' }); return }
      const parts = relative.length === 0 ? [] : relative.split('/').map(decodeURIComponent); const store = this.storeForProfile(profile); await store.waitReady()
      if (req.method === 'GET' && ['wiki', 'resident', 'sessions', 'candidates'].includes(parts[0] ?? '')) await Promise.allSettled([...this.inFlight])
      if (req.method === 'GET' && parts[0] === 'config') { sendJson(res, 200, await this.configResponse(profile, store)); return }
      if (req.method === 'POST' && parts[0] === 'config') { const body = await readJsonBody(req); if (!body || typeof body !== 'object') throw new Error('config body must be an object'); const input = body as Record<string, unknown>; if (input.apiKey !== undefined) { sendJson(res, 400, { error: 'apiKey cannot be written through memory API; configure credentials or process environment' }); return } await store.updateDreamSettings({ ...(typeof input.apiUrl === 'string' ? { apiUrl: input.apiUrl } : {}), ...(typeof input.credentialRef === 'string' ? { credentialRef: input.credentialRef } : {}), ...(typeof input.model === 'string' ? { model: input.model } : {}), ...(typeof input.maxTokens === 'number' ? { maxTokens: input.maxTokens } : {}) }); sendJson(res, 200, await this.configResponse(profile, store)); return }
      if (req.method === 'GET' && parts[0] === 'wiki' && parts[1] === 'pages' && parts[2]) { const page = store.page(parts[2]); sendJson(res, page ? 200 : 404, page ?? { error: 'wiki page not found' }); return }
      if (req.method === 'GET' && parts[0] === 'wiki' && parts[1] === 'graph') { const includeEvidence = requestUrl.searchParams.get('evidence') === '1' || requestUrl.searchParams.get('includeEvidence') === '1'; sendJson(res, 200, { profileId: profile, ...store.graph(requestUrl.searchParams.get('root') ?? undefined, queryNumber(requestUrl.searchParams.get('hop'), 1, 0, 8), includeEvidence) }); return }
      if (req.method === 'GET' && parts[0] === 'wiki' && parts[1] === 'search') { sendJson(res, 200, { profileId: profile, query: requestUrl.searchParams.get('q') ?? '', results: store.search(requestUrl.searchParams.get('q') ?? '', queryNumber(requestUrl.searchParams.get('limit'), 20, 1, 100), queryNumber(requestUrl.searchParams.get('hop'), 0, 0, 8)) }); return }
      if (req.method === 'GET' && parts[0] === 'wiki' && parts[1] === 'sources') { sendJson(res, 200, { profileId: profile, sources: store.listSources() }); return }
      if (req.method === 'GET' && parts[0] === 'audits') { sendJson(res, 200, { profileId: profile, audits: store.listAudits() }); return }
      if (req.method === 'GET' && parts[0] === 'wiki') { sendJson(res, 200, store.snapshot()); return }
      if (req.method === 'GET' && parts[0] === 'resident') { sendJson(res, 200, { profileId: profile, resident: truncate(store.renderResident(), this.config.maxResidentChars), rawSessionRetention: 'raw Session evidence is retained unless separately purged by a future capability' }); return }
      if (req.method === 'GET' && parts[0] === 'sessions') { if (parts[1]) { const evidence = await store.sessionEvidence(parts[1]); sendJson(res, evidence ? 200 : 404, evidence ? { profileId: profile, sessionId: parts[1], evidence } : { error: 'session not found' }); return } sendJson(res, 200, { profileId: profile, sessions: store.snapshot().sessions }); return }
      if (req.method === 'GET' && parts[0] === 'candidates') { sendJson(res, 200, { profileId: profile, candidates: store.snapshot().candidates }); return }
      const candidateOffset = parts[0] === 'wiki' ? 1 : 0; const candidateId = parts[candidateOffset + 1]; const candidateAction = parts[candidateOffset + 2]; if (req.method === 'POST' && parts[candidateOffset] === 'candidates' && candidateId && candidateAction) { const changed = candidateAction === 'confirm' ? await store.confirm(candidateId) : candidateAction === 'reject' ? await store.reject(candidateId) : false; sendJson(res, candidateAction === 'confirm' || candidateAction === 'reject' ? (changed ? 200 : 404) : 404, candidateAction === 'confirm' || candidateAction === 'reject' ? { changed } : { error: 'unknown candidate action' }); return }
      if (req.method === 'POST' && parts[0] === 'wiki' && parts[1] === 'pages' && parts[2] && parts[3] === 'supersede') { const changed = await store.supersede(parts[2]); sendJson(res, changed ? 200 : 404, { changed }); return }
      if (req.method === 'POST' && parts[0] === 'wiki' && parts[1] === 'pages' && parts.length === 2) { const page = manualWikiPage(await readJsonBody(req), profile); await store.upsertManualPage(page); sendJson(res, 201, page); return }
      if (req.method === 'PUT' && parts[0] === 'wiki' && parts[1] === 'pages' && parts[2]) { const input = await readJsonBody(req); if (!input || typeof input !== 'object') throw new Error('wiki correction body must be an object'); const body = input as Record<string, unknown>; const content = typeof body.content === 'string' ? body.content : undefined; const page = await store.editPage(parts[2], { ...(typeof body.title === 'string' ? { title: body.title } : {}), ...(typeof body.description === 'string' ? { description: body.description } : content === undefined ? {} : { description: content }), ...(typeof body.body === 'string' ? { body: body.body } : content === undefined ? {} : { body: content }), ...(Array.isArray(body.tags) ? { tags: body.tags.filter((tag): tag is string => typeof tag === 'string') } : {}), ...(body.validUntil === null ? { validUntil: null } : typeof body.validUntil === 'string' ? { validUntil: body.validUntil } : {}) }); sendJson(res, page ? 200 : 404, page ?? { error: 'wiki page not found' }); return }
      if (req.method === 'POST' && parts[0] === 'memories' && parts.length === 1) { const item = manualMemory(await readJsonBody(req), profile); await store.upsertManual(item); const page = store.page(item.id); sendJson(res, 201, { ...item, id: page?.id ?? item.id }); return }
      if (req.method === 'DELETE' && ((parts[0] === 'memories' && parts.length === 2) || (parts[0] === 'wiki' && parts[1] === 'pages' && parts.length === 3))) { const targetId = parts.at(-1); if (!targetId) { sendJson(res, 404, { error: 'memory id is required' }); return } const changed = await store.forget(targetId); sendJson(res, changed ? 200 : 404, { changed, rawSessionRetained: true }); return }
      if (req.method === 'POST' && parts[0] === 'dream') { const body = await readJsonBody(req); const sessionId = optionalString(body, 'sessionId'); const session = sessionId ? this.ctx.sessions.get(SessionId(sessionId)) : undefined; if (sessionId && !session) { sendJson(res, 404, { error: 'session not found' }); return } if (session && this.scopeForSession(session).key !== this.scopeForProfile(profile).key) { sendJson(res, 403, { error: 'session belongs to another scope' }); return } if (session) { const scope = this.scopeForProfile(profile); void this.track(this.enqueueProfileDream(scope, () => this.dreamSession(session, scope)), `manual session Dream ${sessionId}`) } else void this.track(this.dreamAll(), 'manual Dream'); sendJson(res, 202, { accepted: true }); return }
      if (req.method === 'POST' && parts[0] === 'demo' && parts[1] === 'run') { if (!this.config.demoEnabled) { sendJson(res, 404, { error: 'demo route is disabled' }); return } sendJson(res, 501, { error: 'demo route is acceptance-only and has no production implementation' }); return }
      sendJson(res, 404, { error: 'memory route not found' })
    } catch (error) { sendJson(res, 500, { error: safeError(error) }) }
  }

  private async configResponse(profile: string, store: MemoryProfileStore): Promise<Record<string, unknown>> { const settings = store.dreamSettings(); const info = await this.ctx.credentials.describe(credentialRef(settings.credentialRef)); return { profileId: profile, apiPath: this.config.apiPath, dreamApiUrl: settings.apiUrl, dreamCredentialRef: settings.credentialRef, dreamModel: settings.model, dreamMaxTokens: settings.maxTokens, dreamConfigured: info.configured, dreamIntervalMs: this.config.dreamIntervalMs, debounceMs: this.config.debounceMs, maxResidentChars: this.config.maxResidentChars, demoEnabled: this.config.demoEnabled } }
  private authenticatedProfile(req: IncomingMessage): string | undefined { const requested = this.requestedProfile(req); const bearer = bearerToken(req); const entries = Object.entries(this.config.apiTokens); if (entries.length > 0) { if (!bearer) return undefined; const match = entries.find(([, token]) => token === bearer); if (!match) return undefined; const profile = normalizeProfileId(match[0]); return requested === profile ? profile : undefined } if (this.config.apiToken) return bearer === this.config.apiToken && requested ? requested : undefined; return this.ctx.webServer.host === '127.0.0.1' && requested ? requested : undefined }
  private requestedProfile(req: IncomingMessage): string | undefined { try { const raw = req.headers['x-dsh-memory-profile']; const value = Array.isArray(raw) ? raw[0] : raw; return value === undefined ? undefined : normalizeProfileId(value) } catch { return undefined } }
  private track<T>(promise: Promise<T>, label: string): Promise<T> { this.inFlight.add(promise); const settle = (): void => { this.inFlight.delete(promise) }; void promise.then(settle, (error) => { settle(); this.ctx.logger.warn(`riko-memory ${label} failed: ${safeError(error)}`) }); return promise }
}

export default RikoMemoryService

class ProviderError extends Error { constructor(readonly reason: string) { super(`Dream provider failure: ${reason}`); this.name = 'ProviderError' } }

export function validateConfig(config: Config): void {
  if (!config.ownerNamespace.trim()) throw new Error('riko-memory ownerNamespace must not be empty')
  if (!config.apiPath.startsWith('/') || config.apiPath.endsWith('/') || config.apiPath.includes('?')) throw new Error('riko-memory apiPath must be absolute without trailing slash or query')
  if (!isCredentialRefName(config.dreamCredentialRef)) throw new Error('riko-memory dreamCredentialRef must be a credential reference')
  let dreamUrl: URL
  try { dreamUrl = new URL(config.dreamApiUrl) } catch { throw new Error('riko-memory dreamApiUrl must be a valid HTTPS URL') }
  if (dreamUrl.protocol !== 'https:') throw new Error('riko-memory dreamApiUrl must use HTTPS')
  if (dreamUrl.username || dreamUrl.password) throw new Error('riko-memory dreamApiUrl must not contain an embedded credential')
  for (const [profile, token] of Object.entries(config.apiTokens)) { normalizeProfileId(profile); if (!token) throw new Error(`riko-memory apiTokens.${profile} must not be empty`) }
}
function normalizeProfileId(value: string): string { const normalized = value.trim(); if (!/^[A-Za-z0-9._-]{1,64}$/.test(normalized)) throw new Error('riko-memory profile id must contain only letters, numbers, dot, underscore and dash'); return normalized }
function serializableEventData(event: SessionEvent): unknown { switch (event.type) { case 'user/message': return { message: event.data }; case 'assistant/message': return { message: event.data.message, turn: event.data.turn, step: event.data.step }; case 'tool/result': return { message: event.data.message, turn: event.data.turn, step: event.data.step }; default: return event.data } }
function bearerToken(req: IncomingMessage): string | undefined { const raw = req.headers.authorization; const match = typeof raw === 'string' ? /^Bearer\s+(.+)$/.exec(raw) : undefined; return match?.[1] }
function safeError(error: unknown): string { const message = error instanceof Error ? error.message : String(error); return message.replace(/bearer\s+[^\s]+/gi, 'Bearer [redacted]').replace(/sk-[A-Za-z0-9_-]+/g, '[redacted]').slice(0, 500) }
function wait(milliseconds: number): Promise<void> { return new Promise(resolve => setTimeout(resolve, milliseconds)) }
function latestEventSeq(evidence: string | undefined): number | undefined { if (!evidence) return undefined; let latest: number | undefined; for (const line of evidence.split('\n')) { try { const value = JSON.parse(line) as { seq?: unknown }; if (typeof value.seq === 'number' && Number.isInteger(value.seq)) latest = Math.max(latest ?? value.seq, value.seq) } catch { /* malformed legacy line does not advance the cursor */ } } return latest }
function serializableText(value: unknown): string { return typeof value === 'string' ? value : '' }
interface TranscriptMessage { readonly role: string; readonly content: readonly { readonly type: string; readonly text?: string }[] }
function transcriptText(messages: readonly TranscriptMessage[], maxChars: number): string { const lines: string[] = []; for (const message of messages) { const text = message.content.filter(block => block.type === 'text').map(block => serializableText(block.text)).join('\n').trim(); if (text) lines.push(`${message.role}: ${text}`) } return truncate(lines.join('\n\n'), maxChars) }

function transcriptFromEvidence(lines: readonly string[], maxChars: number): string {
  const messages: TranscriptMessage[] = []
  for (const line of lines) {
    try {
      const event = JSON.parse(line) as { type?: unknown; data?: unknown }
      const role = event.type === 'user/message' ? 'user' : event.type === 'assistant/message' ? 'assistant' : undefined
      const message = event.data && typeof event.data === 'object' ? (event.data as { message?: unknown }).message : undefined
      const content = message && typeof message === 'object' && Array.isArray((message as { content?: unknown }).content) ? (message as { content: Array<{ type?: unknown; text?: unknown }> }).content : []
      const text = content.filter(block => block.type === 'text' && typeof block.text === 'string').map(block => block.text as string)
      if (role && text.length > 0) messages.push({ role, content: text.map(value => ({ type: 'text', text: value })) })
    } catch { /* malformed retained L0 lines do not become provider input */ }
  }
  return transcriptText(messages, maxChars)
}

export function parseWikiOutput(text: string, session: Pick<Session, 'id'> | string): WikiPage[] { const sessionId = typeof session === 'string' ? session : String(session.id); const pages: WikiPage[] = []; for (const match of text.matchAll(/<<<FILE\s+path="([^"]+)">>>([\s\S]*?)<<<END>>>/g)) { const path = match[1]?.trim(); const block = match[2]; if (!path || block === undefined || block.length > 30_000) continue; try { const parsed = parseWikiMarkdown(block.trim(), path); const description = truncate((parsed.description || firstBodySentence(parsed.body) || parsed.title).replace(/\s+/g, ' ').trim(), 120); const body = truncate(parsed.body.replace(/\s+/g, ' ').trim(), 1_200); const title = compactGeneratedTitle(parsed.type, parsed.title, description, body); const identity = contentHash(`${parsed.type}\n${title.toLocaleLowerCase()}\n${description.toLocaleLowerCase()}\n${body.toLocaleLowerCase()}`).slice(0, 10); const normalizedPath = `wiki/${pageFolder(parsed.type)}/${pageSlug(title, identity)}-${identity}.md`; pages.push({ ...parsed, id: wikiPageId(normalizedPath), path: normalizedPath, title, description, body, sources: [sessionId], status: 'candidate', consent: false, locked: false, version: 1, updatedAt: new Date().toISOString() }) } catch { /* invalid FILE blocks are rejected, never partially stored */ } } if (pages.length === 0) throw new ProviderError('invalid-file-protocol'); return pages }

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

const MEMORY_TOOL_OUTPUT = {
  schema: {
    type: 'object', additionalProperties: false,
    properties: {
      scopeKey: { type: 'string', required: true },
      id: { type: 'string' },
      resident: { type: 'string', required: true },
      version: { type: 'string', required: true },
    },
  } as const,
  render: (_args: {}, value: { scopeKey: string; id?: string; resident: string; version: string }) => [{ type: 'text' as const, text: value.id === undefined ? `Memory scope ${value.scopeKey}; resident version ${value.version}` : `Memory ${value.id} updated in ${value.scopeKey}; resident version ${value.version}` }],
} as const

function latestUserText(session: Session): string {
  const messages = session.deriveMessages() as unknown as ReadonlyArray<{ role?: string; source?: { kind?: string }; content?: readonly { type?: string; text?: string }[] }>
  for (const message of [...messages].reverse()) {
    if (message.role !== 'user' || (message.source?.kind !== undefined && message.source.kind !== 'user')) continue
    return (message.content ?? []).filter(block => block.type === 'text').map(block => block.text ?? '').join('\n').trim()
  }
  return ''
}

function explicitMemory(content: string, sessionId: string): MemoryItem {
  const category = chooseCategory(content)
  const kind: MemoryKind = category === 'interaction_rules' ? 'preference' : category === 'emotions' ? 'emotion' : category === 'key_experiences' ? 'event' : 'fact'
  return { id: memoryId(category, content), kind, category, content: truncate(content, 2_000), confidence: 1, status: 'confirmed', sourceConversations: [sessionId], observedAt: new Date().toISOString(), sensitivity: 'normal', consent: true }
}
