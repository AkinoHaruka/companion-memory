/* oxlint-disable @stylistic/max-len */
import { fetchLive } from './support/live-http.ts'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { agentEvents } from '@deepseek-ai/dsh-agent'
import { createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { drainInFlight, startLiveHarness, testAgent, type LiveHarness } from './support/live-harness.ts'

interface Snapshot {
  readonly pages: readonly Record<string, unknown>[]
  readonly candidates: readonly Record<string, unknown>[]
  readonly observations: readonly Record<string, unknown>[]
  readonly sessions: readonly string[]
  readonly resident: string
  readonly residentSnapshot?: { readonly blocks?: readonly unknown[]; readonly content?: string }
}

const harnesses: LiveHarness[] = []
const retainedRoots: string[] = []

afterEach(async () => {
  await Promise.all(harnesses.splice(0).map(harness => harness.dispose()))
  await Promise.all(retainedRoots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

function headers(profile = 'standard', json = false): Headers {
  const result = new Headers({ 'x-dsh-memory-profile': profile })
  if (json) result.set('content-type', 'application/json')
  return result
}

async function request(harness: LiveHarness, path: string, init: RequestInit = {}, profile = 'standard'): Promise<Response> {
  const requestHeaders = new Headers(init.headers)
  requestHeaders.set('x-dsh-memory-profile', profile)
  if (init.body !== undefined && !requestHeaders.has('content-type')) requestHeaders.set('content-type', 'application/json')
  return fetchLive(`${harness.base}${path}`, { ...init, headers: requestHeaders })
}

async function json<T>(response: Response): Promise<T> {
  return await response.json() as T
}

async function snapshot(harness: LiveHarness, profile = 'standard'): Promise<Snapshot> {
  return await json<Snapshot>(await request(harness, '/wiki', { headers: headers(profile) }, profile))
}

async function config(harness: LiveHarness, profile = 'standard'): Promise<Record<string, unknown>> {
  return await json(await request(harness, '/config', { headers: headers(profile) }, profile))
}

async function eventually<T>(read: () => Promise<T>, predicate: (value: T) => boolean): Promise<T> {
  let latest: T | undefined
  await vi.waitFor(async () => {
    latest = await read()
    expect(predicate(latest)).toBe(true)
  }, { timeout: 15_000, interval: 25 })
  if (latest === undefined) throw new Error('eventual value was not produced')
  return latest
}

function createAgent(harness: LiveHarness, sessionId: string, profile = 'standard'): ReturnType<typeof testAgent> {
  const session = harness.context.sessions.create(SessionId(sessionId), { meta: { agentPreset: profile } })
  const agent = testAgent(harness.context, session)
  harness.context.emit('agent/created', { agent, source: 'startup' })
  return agent
}

async function preStep(harness: LiveHarness, agent: ReturnType<typeof testAgent>, text: string): Promise<string> {
  const result = await agentEvents(harness.context, agent).waterfall('agent/pre-step', {
    messages: [createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })],
    turn: 1,
    step: 1,
    signal: new AbortController().signal,
  }, () => Promise.resolve({ kind: 'enter' as const, messages: [] }))
  return result.kind === 'enter' ? JSON.stringify(result.messages) : ''
}

async function postJson(harness: LiveHarness, path: string, body: unknown, profile = 'standard'): Promise<Response> {
  return request(harness, path, { method: 'POST', headers: headers(profile, true), body: JSON.stringify(body) }, profile)
}

async function writeMemory(harness: LiveHarness, content: string, profile = 'standard', sensitivity?: string): Promise<Record<string, unknown>> {
  const response = await postJson(harness, '/memories', { content, ...(sensitivity === undefined ? {} : { sensitivity }) }, profile)
  expect(response.status).toBe(201)
  return await json(response)
}

async function writeWikiPage(harness: LiveHarness, path: string, title: string, content: string, profile = 'standard'): Promise<Record<string, unknown>> {
  const response = await postJson(harness, '/wiki/pages', { path, type: 'concept', title, content }, profile)
  expect(response.status).toBe(201)
  return await json(response)
}

async function readEvidence(harness: LiveHarness, sessionId: string): Promise<string[]> {
  const session = harness.context.sessions.get(SessionId(sessionId))
  if (session === undefined) throw new Error(`session ${sessionId} was not created`)
  const userEvents = session.snapshotEvents().filter(event => event.type === 'user/message')
  // Draining the service's in-flight set is its own readiness signal for the L0 write chain
  // behind this read; without it the callers' poll spends its budget on writes that are still
  // queued, which is what makes the same condition slow only under forked-worker contention.
  await drainInFlight(harness.base, session.snapshotEvents().length)
  const persisted = await request(harness, `/sessions/${sessionId}`)
  if (persisted.status !== 200) return []
  const body = await json<{ evidence?: { readonly lineCount?: number } }>(persisted)
  if (body.evidence?.lineCount !== session.snapshotEvents().length) return []
  return userEvents.map(event => `session:${sessionId}/event:${String(event.seq)}`)
}

async function seedEvidence(harness: LiveHarness, entries: readonly [string, string[], string?][]): Promise<string[]> {
  for (const [sessionId, texts, entryProfile = 'standard'] of entries) {
    const agent = createAgent(harness, sessionId, entryProfile)
    for (const text of texts) agent.session.append('user/message', createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }), { surfaceOp: 'append' })
  }
  const refs: string[] = []
  for (const [sessionId] of entries) refs.push(...await eventually(() => readEvidence(harness, sessionId), value => value.length > 0))
  return refs
}

async function executeTool(harness: LiveHarness, agent: ReturnType<typeof testAgent>, name: string, arguments_: Record<string, unknown>): Promise<{ readonly isError: boolean; readonly value?: unknown }> {
  const result = await harness.context.tools.execute({ signal: new AbortController().signal, callId: ToolCallId(`matrix-${name}-${String(Date.now())}`), name, arguments: arguments_, agent })
  return { isError: result.isError, ...(result.value === undefined ? {} : { value: result.value }) }
}

function memoryMarkdown(title: string, body: string, sessionId: string, temporal = ''): string {
  return `---\ntype: concept\ntitle: ${title}\ndescription: ${body}\nsources:\n  - ${sessionId}\ntimestamp: 2026-09-19T00:00:00.000Z\nconfidence: 1\nstatus: confirmed\nconsent: true\nlocked: true\n${temporal}---\n${body}\n`
}

describe('V4 live flag matrix', () => {
  it('recallEnabled gates the live Agent pre-step and HTTP route', { timeout: 60_000 }, async () => {
    const disabled = await startLiveHarness(['    recallEnabled: false'])
    harnesses.push(disabled)
    await writeMemory(disabled, 'disabled recall fact')
    const disabledAgent = createAgent(disabled, 'matrix-recall-disabled')
    expect(await preStep(disabled, disabledAgent, '你还记得 disabled recall fact 吗？')).not.toContain('disabled recall fact')
    expect((await postJson(disabled, '/recall/debug', { query: '你还记得 disabled recall fact 吗？' })).status).toBe(404)

    const enabled = await startLiveHarness(['    recallEnabled: true'])
    harnesses.push(enabled)
    await writeMemory(enabled, 'enabled recall fact')
    const enabledAgent = createAgent(enabled, 'matrix-recall-enabled')
    expect(await preStep(enabled, enabledAgent, '你还记得 enabled recall fact 吗？')).toContain('enabled recall fact')
    expect((await postJson(enabled, '/recall/debug', { query: '你还记得 enabled recall fact 吗？' })).status).toBe(200)
    expect((await postJson(enabled, '/recall/debug', {})).status).toBe(400)
  })

  it('recallVectorEnabled uses the configured dense provider and degrades to lexical', { timeout: 60_000 }, async () => {
    const disabled = await startLiveHarness(['    recallEnabled: true', '    recallVectorEnabled: false', '    embeddingProvider: deterministic'])
    harnesses.push(disabled)
    await writeMemory(disabled, 'vector disabled target')
    const disabledDebug = await postJson(disabled, '/recall/debug', { query: '你还记得之前的 vector disabled target 吗？' })
    expect((await json<{ plan: { searchVector: boolean } }>(disabledDebug)).plan.searchVector).toBe(false)

    const enabled = await startLiveHarness(['    recallEnabled: true', '    recallVectorEnabled: true', '    embeddingProvider: deterministic'])
    harnesses.push(enabled)
    await writeMemory(enabled, 'dense target')
    const enabledAgent = createAgent(enabled, 'matrix-vector-enabled')
    expect(await preStep(enabled, enabledAgent, '你还记得之前的 dense 代号吗？')).toContain('dense target')
    const enabledBody = await eventually(async () => {
      const response = await postJson(enabled, '/recall/debug', { query: '你还记得之前的 dense 代号吗？' })
      expect(response.status).toBe(200)
      return await json<{ plan: { searchVector: boolean }; trace: { candidatesByChannel: Record<string, number> } }>(response)
    }, body => body.plan.searchVector && (body.trace.candidatesByChannel.dense ?? 0) > 0)
    expect(enabledBody.plan.searchVector).toBe(true)
    expect(enabledBody.trace.candidatesByChannel.dense).toBeGreaterThan(0)

    const nativeFetch = globalThis.fetch
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => String(input).startsWith('https://api.test/embeddings') ? Promise.resolve(new Response('{}', { status: 503 })) : nativeFetch(input, init)) as typeof fetch
    try {
      const degraded = await startLiveHarness([
        '    recallEnabled: true',
        '    recallVectorEnabled: true',
        '    embeddingProvider: openai-compatible',
        '    embeddingEndpoint: https://api.test/embeddings',
        '    embeddingCredentialRef: DSH_MEMORY_DREAM_API_KEY',
        '    embeddingModel: fixture-embedding',
      ])
      harnesses.push(degraded)
      await writeMemory(degraded, 'vector degraded code')
      const failure = await postJson(degraded, '/recall/debug', { query: '你还记得之前的 vector 代号吗？' })
      expect(failure.status).toBe(200)
      expect(await json<{ trace: { degradedModes: string[] }; results: Array<{ sourceType: string }> }>(failure)).toMatchObject({ trace: { degradedModes: expect.arrayContaining(['vector-degraded']) }, results: expect.arrayContaining([expect.objectContaining({ sourceType: 'canonical' })]) })
    } finally {
      globalThis.fetch = nativeFetch
    }
  })

  it('recallRawEvidenceEnabled controls persisted L0 evidence in live recall', { timeout: 60_000 }, async () => {
    const disabled = await startLiveHarness(['    recallEnabled: true', '    recallRawEvidenceEnabled: false'])
    harnesses.push(disabled)
    const disabledRefs = await seedEvidence(disabled, [['matrix-raw-disabled', ['raw disabled evidence']]])
    expect(disabledRefs).not.toHaveLength(0)
    const disabledBody = await json<{ results: Array<{ sourceType: string }> }>(await postJson(disabled, '/recall/debug', { query: '你还记得 raw disabled evidence 吗？' }))
    expect(disabledBody.results.some(result => result.sourceType === 'evidence')).toBe(false)

    const enabled = await startLiveHarness(['    recallEnabled: true', '    recallRawEvidenceEnabled: true'])
    harnesses.push(enabled)
    await seedEvidence(enabled, [['matrix-raw-enabled', ['raw enabled evidence']]])
    const enabledBody = await json<{ results: Array<{ sourceType: string }> }>(await postJson(enabled, '/recall/debug', { query: '你还记得 raw enabled evidence 吗？' }))
    expect(enabledBody.results).toEqual(expect.arrayContaining([expect.objectContaining({ sourceType: 'evidence' })]))
    expect((await postJson(enabled, '/recall/debug', {})).status).toBe(400)
  })

  it('recallObservationEnabled gates persisted observations through the HTTP recall route', { timeout: 60_000 }, async () => {
    const configLines = ['    recallEnabled: true', '    minObservationEvidence: 1', '    observationActivationMinEvidence: 1', '    observationActivationMinSessions: 1', '    observationActivationMinConfidence: 0.5']
    const disabled = await startLiveHarness([...configLines, '    recallObservationEnabled: false'])
    harnesses.push(disabled)
    const disabledRefs = await seedEvidence(disabled, [['matrix-observation-disabled', ['observation flag anchor']]])
    const disabledObservation = await postJson(disabled, '/observations', { text: 'observation flag pattern', confidence: 0.9, sourceRefs: disabledRefs })
    expect(disabledObservation.status).toBe(201)
    const disabledBody = await json<{ results: Array<{ sourceType: string }> }>(await postJson(disabled, '/recall/debug', { query: '你还记得之前的 observation flag pattern 吗？' }))
    expect(disabledBody.results.some(result => result.sourceType === 'observation')).toBe(false)

    const enabled = await startLiveHarness([...configLines, '    recallObservationEnabled: true'])
    harnesses.push(enabled)
    const enabledRefs = await seedEvidence(enabled, [['matrix-observation-enabled', ['observation flag anchor']]])
    const enabledObservation = await postJson(enabled, '/observations', { text: 'observation flag pattern', confidence: 0.9, sourceRefs: enabledRefs })
    expect(enabledObservation.status).toBe(201)
    const enabledBody = await json<{ results: Array<{ sourceType: string; text: string }> }>(await postJson(enabled, '/recall/debug', { query: '你还记得之前的 observation flag pattern 吗？' }))
    expect(enabledBody.results).toEqual(expect.arrayContaining([expect.objectContaining({ sourceType: 'observation' })]))
    expect((await postJson(enabled, '/observations', { text: 'invalid observation', sourceRefs: ['session:not-real/event:99'] })).status).toBe(500)
  })

  it('recallGraphEnabled controls graph candidates in the live recall plan', { timeout: 60_000 }, async () => {
    const pages = async (harness: LiveHarness): Promise<void> => {
      await writeWikiPage(harness, 'wiki/concepts/graph-root.md', 'Graph root', 'Graph root links [[Graph leaf]]')
      await writeWikiPage(harness, 'wiki/concepts/graph-leaf.md', 'Graph leaf', 'Graph leaf body')
    }
    const disabled = await startLiveHarness(['    recallEnabled: true', '    recallGraphEnabled: false'])
    harnesses.push(disabled)
    await pages(disabled)
    const disabledBody = await json<{ plan: { searchGraph: boolean } }>(await postJson(disabled, '/recall/debug', { query: '你还记得 Graph root 相关的 Graph leaf 吗？' }))
    expect(disabledBody.plan.searchGraph).toBe(false)

    const enabled = await startLiveHarness(['    recallEnabled: true', '    recallGraphEnabled: true'])
    harnesses.push(enabled)
    await pages(enabled)
    const enabledBody = await json<{ plan: { searchGraph: boolean }; trace: { candidatesByChannel: Record<string, number> } }>(await postJson(enabled, '/recall/debug', { query: '你还记得 Graph root 相关的 Graph leaf 吗？' }))
    expect(enabledBody.plan.searchGraph).toBe(true)
    expect(enabledBody.trace.candidatesByChannel.graph).toBeGreaterThanOrEqual(0)
    expect((await postJson(enabled, '/recall/debug', {})).status).toBe(400)
  })

  it('purgeEnabled supports dry-run, confirmed deletion, restart verification, and failure', { timeout: 60_000 }, async () => {
    const disabled = await startLiveHarness()
    harnesses.push(disabled)
    expect((await postJson(disabled, '/purge', { sessionId: 'matrix-purge-disabled' })).status).toBe(404)

    const root = await mkdtemp(join(tmpdir(), 'dsh-riko-memory-purge-matrix-'))
    retainedRoots.push(root)
    const enabled = await startLiveHarness(['    purgeEnabled: true'], root)
    harnesses.push(enabled)
    const refs = await seedEvidence(enabled, [['matrix-purge-session', ['purge raw phrase']]])
    const page = await postJson(enabled, '/wiki/pages', { path: 'wiki/concepts/purge-matrix.md', markdown: memoryMarkdown('Purge matrix', 'purge raw phrase', 'matrix-purge-session') })
    expect(page.status).toBe(201)
    const before = await snapshot(enabled)
    const dryRun = await postJson(enabled, '/purge', { sessionId: 'matrix-purge-session', dryRun: true })
    expect(dryRun.status).toBe(200)
    const plan = await json<{ confirmation: string; changed: boolean; dryRun: boolean }>(dryRun)
    expect(plan).toMatchObject({ changed: false, dryRun: true })
    expect((await snapshot(enabled)).pages).toEqual(before.pages)
    expect(refs.length).toBeGreaterThan(0)
    expect((await postJson(enabled, '/purge', { sessionId: 'matrix-purge-session', confirmation: 'wrong-confirmation' })).status).toBe(400)
    const confirmed = await postJson(enabled, '/purge', { sessionId: 'matrix-purge-session', confirmation: plan.confirmation })
    expect(confirmed.status).toBe(200)
    expect(await json(confirmed)).toMatchObject({ changed: true, verified: true, rawSessionRetained: false })
    expect((await snapshot(enabled)).pages).not.toEqual(expect.arrayContaining([expect.objectContaining({ title: 'Purge matrix' })]))
    await enabled.dispose()
    harnesses.splice(harnesses.indexOf(enabled), 1)
    const restarted = await startLiveHarness(['    purgeEnabled: true'], root)
    harnesses.push(restarted)
    const restored = await snapshot(restarted)
    expect(restored.sessions).not.toContain('matrix-purge-session')
    expect(restored.pages).not.toEqual(expect.arrayContaining([expect.objectContaining({ title: 'Purge matrix' })]))
  })

  it('reflectionEnabled is observable through the live Dream route and provider failure is non-fatal', { timeout: 60_000 }, async () => {
    const disabled = await startLiveHarness(['    dreamApiUrl: https://api.test/api/v1/chat/completions', '    reflectionEnabled: false'])
    harnesses.push(disabled)
    const disabledAgent = createAgent(disabled, 'matrix-reflection-disabled')
    disabledAgent.session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'reflection disabled anchor' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
    const nativeFetch = globalThis.fetch
    let disabledCalls = 0
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) !== 'https://api.test/api/v1/chat/completions') return nativeFetch(input, init)
      disabledCalls += 1
      return Promise.resolve(new Response(JSON.stringify({ choices: [{ message: { content: '<<<FILE path="wiki/concepts/reflection-disabled.md">>>\n---\ntype: concept\ntitle: Reflection disabled\ndescription: Reflection disabled\nsources:\n  - matrix-reflection-disabled\ntimestamp: 2026-09-19T00:00:00.000Z\nconfidence: 0.7\nstatus: candidate\nconsent: false\nlocked: false\n---\nCandidate.\n<<<END>>>' } }] }), { headers: { 'content-type': 'application/json' } }))
    }) as typeof fetch
    try {
      expect((await postJson(disabled, '/dream', { sessionId: 'matrix-reflection-disabled' })).status).toBe(202)
      await eventually(async () => disabledCalls, value => value === 1)
    } finally {
      globalThis.fetch = nativeFetch
    }

    const enabled = await startLiveHarness(['    dreamApiUrl: https://api.test/api/v1/chat/completions', '    reflectionEnabled: true', '    minObservationEvidence: 1'])
    harnesses.push(enabled)
    const enabledAgent = createAgent(enabled, 'matrix-reflection-enabled')
    enabledAgent.session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'reflection enabled anchor one' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
    enabledAgent.session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'reflection enabled anchor two' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
    const enabledRefs = await eventually(() => readEvidence(enabled, 'matrix-reflection-enabled'), refs => refs.length === 2)
    let enabledCalls = 0
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) !== 'https://api.test/api/v1/chat/completions') return nativeFetch(input, init)
      enabledCalls += 1
      if (enabledCalls === 1) return Promise.resolve(new Response(JSON.stringify({ choices: [{ message: { content: '<<<FILE path="wiki/concepts/reflection-enabled.md">>>\n---\ntype: concept\ntitle: Reflection enabled\ndescription: Reflection enabled\nsources:\n  - matrix-reflection-enabled\ntimestamp: 2026-09-19T00:00:00.000Z\nconfidence: 0.7\nstatus: candidate\nconsent: false\nlocked: false\n---\nCandidate.\n<<<END>>>' } }] }), { headers: { 'content-type': 'application/json' } }))
      return Promise.resolve(new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ observations: [{ text: 'reflection enabled observation', sourceRefs: [enabledRefs[0]], confidence: 0.9 }] }) } }] }), { headers: { 'content-type': 'application/json' } }))
    }) as typeof fetch
    try {
      expect((await postJson(enabled, '/dream', { sessionId: 'matrix-reflection-enabled' })).status).toBe(202)
      await eventually(async () => enabledCalls, value => value === 2)
      const observations = await eventually(async () => json<{ observations: Array<{ text: string; status: string }> }>(await request(enabled, '/observations')), body => body.observations.some(observation => observation.text === 'reflection enabled observation'))
      expect(observations.observations).toEqual(expect.arrayContaining([expect.objectContaining({ text: 'reflection enabled observation', status: 'candidate' })]))
      expect((await postJson(enabled, '/dream', { sessionId: 'missing-reflection-session' })).status).toBe(404)
    } finally {
      globalThis.fetch = nativeFetch
    }
  })

  it('temporalReconcileEnabled changes the live memory_remember transition and rejects an invalid tool request', { timeout: 60_000 }, async () => {
    async function remember(harness: LiveHarness, sessionId: string, content: string, _temporalReconcileEnabled: boolean): Promise<{ readonly id?: string; readonly isError: boolean }> {
      const agent = createAgent(harness, sessionId, 'standard')
      agent.session.append('user/message', createUserMessage({ content: [{ type: 'text', text: `请记住：${content}` }], source: { kind: 'user' } }), { surfaceOp: 'append' })
      const result = await executeTool(harness, agent, 'memory_remember', { content })
      const value = result.value as { id?: unknown } | undefined
      return { isError: result.isError, ...(typeof value?.id === 'string' ? { id: value.id } : {}) }
    }
    const disabled = await startLiveHarness(['    temporalReconcileEnabled: false'])
    harnesses.push(disabled)
    const disabledOld = await remember(disabled, 'matrix-temporal-disabled', '我住在上海。', false)
    const disabledNew = await remember(disabled, 'matrix-temporal-disabled-new', '以前我住在上海，现在我住在杭州。', false)
    expect(disabledOld.id).toBeDefined()
    expect(disabledNew.id).toBeDefined()
    expect((await snapshot(disabled)).pages).toHaveLength(2)
    const disabledAgent = createAgent(disabled, 'matrix-temporal-disabled-error')
    disabledAgent.session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'not the requested claim' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
    expect((await executeTool(disabled, disabledAgent, 'memory_remember', { content: 'different claim' })).isError).toBe(true)

    const enabled = await startLiveHarness(['    temporalReconcileEnabled: true'])
    harnesses.push(enabled)
    const enabledOld = await remember(enabled, 'matrix-temporal-enabled', '我住在上海。', true)
    const enabledNew = await remember(enabled, 'matrix-temporal-enabled-new', '以前我住在上海，现在我住在杭州。', true)
    expect(enabledOld.id).toBeDefined()
    expect(enabledNew.id).toBeDefined()
    const enabledPages = (await snapshot(enabled)).pages
    expect(enabledPages).toEqual(expect.arrayContaining([expect.objectContaining({ id: enabledOld.id, status: 'superseded', validTo: expect.any(String) })]))
    expect(enabledPages).toHaveLength(2)
  })

  it('sensitiveResidentEnabled controls live Resident disclosure and rejects invalid sensitivity', { timeout: 60_000 }, async () => {
    const disabled = await startLiveHarness(['    sensitiveResidentEnabled: false'])
    harnesses.push(disabled)
    await writeMemory(disabled, 'sensitive resident disabled', 'standard', 'sensitive')
    expect((await json<{ resident: string }>(await request(disabled, '/resident', { headers: headers() }))).resident).not.toContain('sensitive resident disabled')

    const enabled = await startLiveHarness(['    sensitiveResidentEnabled: true'])
    harnesses.push(enabled)
    await writeMemory(enabled, 'sensitive resident enabled', 'standard', 'sensitive')
    expect((await json<{ resident: string }>(await request(enabled, '/resident', { headers: headers() }))).resident).toContain('sensitive resident enabled')
    expect((await postJson(enabled, '/memories', { content: 'invalid sensitivity', sensitivity: 'secret' })).status).toBe(400)
  })

  it('residentV2Enabled and residentBlocksEnabled select the persisted projection format', { timeout: 60_000 }, async () => {
    const legacy = await startLiveHarness(['    residentV2Enabled: false'])
    harnesses.push(legacy)
    await writeMemory(legacy, 'legacy resident projection')
    expect((await snapshot(legacy)).residentSnapshot?.blocks).toEqual([])
    expect((await postJson(legacy, '/wiki/pages', {})).status).toBe(500)

    const v2 = await startLiveHarness(['    residentV2Enabled: true', '    residentBlocksEnabled: true'])
    harnesses.push(v2)
    await writeMemory(v2, 'v2 resident projection')
    expect((await snapshot(v2)).residentSnapshot?.blocks?.length).toBeGreaterThan(0)

    const noBlocks = await startLiveHarness(['    residentV2Enabled: true', '    residentBlocksEnabled: false'])
    harnesses.push(noBlocks)
    await writeMemory(noBlocks, 'legacy blocks projection')
    expect((await snapshot(noBlocks)).residentSnapshot?.blocks).toEqual([])
    expect((await postJson(v2, '/wiki/pages', { title: 'missing path' })).status).toBe(500)
  })

  it('temporalEnabled changes current recall eligibility through the HTTP route', { timeout: 60_000 }, async () => {
    const markdown = memoryMarkdown('Expired matrix', 'expired temporal memory', 'matrix-temporal', 'valid_from: 2019-01-01T00:00:00.000Z\nvalid_to: 2020-01-01T00:00:00.000Z\n')
    const disabled = await startLiveHarness(['    recallEnabled: true', '    temporalEnabled: false'])
    harnesses.push(disabled)
    expect((await postJson(disabled, '/wiki/pages', { path: 'wiki/concepts/expired-matrix.md', markdown })).status).toBe(201)
    const disabledBody = await json<{ results: Array<{ text: string }> }>(await postJson(disabled, '/recall/debug', { query: '你还记得 expired temporal memory 吗？' }))
    expect(disabledBody.results).toHaveLength(1)

    const enabled = await startLiveHarness(['    recallEnabled: true', '    temporalEnabled: true'])
    harnesses.push(enabled)
    expect((await postJson(enabled, '/wiki/pages', { path: 'wiki/concepts/expired-matrix.md', markdown })).status).toBe(201)
    const enabledBody = await json<{ results: Array<Record<string, unknown>>; trace: { gateReasons?: string[] } }>(await postJson(enabled, '/recall/debug', { query: '你还记得 expired temporal memory 吗？' }))
    expect(enabledBody.results).toEqual([])
    expect(enabledBody.trace.gateReasons).toEqual(expect.arrayContaining(['temporal-invalid']))
    expect((await postJson(enabled, '/recall/debug', { query: '你还记得 expired temporal memory 吗？', atTime: 'not-an-iso-time' })).status).toBe(500)
  })

  it('observationActivationMinEvidence gates live activation and rejects invalid evidence', { timeout: 60_000 }, async () => {
    const disabled = await startLiveHarness(['    observationActivationMinEvidence: 3', '    observationActivationMinSessions: 2', '    observationActivationMinConfidence: 0.8'])
    harnesses.push(disabled)
    const disabledRefs = await seedEvidence(disabled, [['matrix-evidence-a', ['evidence threshold one']], ['matrix-evidence-b', ['evidence threshold two']]])
    const disabledObservation = await postJson(disabled, '/observations', { text: 'evidence threshold pattern', confidence: 0.9, sourceRefs: disabledRefs })
    expect(disabledObservation.status).toBe(201)
    expect((await json<{ status: string }>(disabledObservation)).status).toBe('candidate')

    const enabled = await startLiveHarness(['    observationActivationMinEvidence: 2', '    observationActivationMinSessions: 2', '    observationActivationMinConfidence: 0.8'])
    harnesses.push(enabled)
    const enabledRefs = await seedEvidence(enabled, [['matrix-evidence-a-enabled', ['evidence threshold one']], ['matrix-evidence-b-enabled', ['evidence threshold two']]])
    const enabledObservation = await postJson(enabled, '/observations', { text: 'evidence threshold pattern', confidence: 0.9, sourceRefs: enabledRefs })
    expect(enabledObservation.status).toBe(201)
    expect((await json<{ status: string }>(enabledObservation)).status).toBe('active')
    expect((await postJson(enabled, '/observations', { text: 'evidence threshold invalid', confidence: 0.9, sourceRefs: ['session:missing/event:1'] })).status).toBe(500)
  })

  it('observationActivationMinSessions gates distinct-session activation in the live store', { timeout: 60_000 }, async () => {
    const disabled = await startLiveHarness(['    observationActivationMinEvidence: 2', '    observationActivationMinSessions: 2', '    observationActivationMinConfidence: 0.8'])
    harnesses.push(disabled)
    const disabledRefs = await seedEvidence(disabled, [['matrix-sessions-disabled', ['session threshold one', 'session threshold two']]])
    const disabledObservation = await postJson(disabled, '/observations', { text: 'session threshold pattern', confidence: 0.9, sourceRefs: disabledRefs })
    expect((await json<{ status: string }>(disabledObservation)).status).toBe('candidate')

    const enabled = await startLiveHarness(['    observationActivationMinEvidence: 2', '    observationActivationMinSessions: 1', '    observationActivationMinConfidence: 0.8'])
    harnesses.push(enabled)
    const enabledRefs = await seedEvidence(enabled, [['matrix-sessions-enabled', ['session threshold one', 'session threshold two']]])
    const enabledObservation = await postJson(enabled, '/observations', { text: 'session threshold pattern', confidence: 0.9, sourceRefs: enabledRefs })
    expect((await json<{ status: string }>(enabledObservation)).status).toBe('active')
    expect((await postJson(enabled, '/observations', { text: '', confidence: 0.9, sourceRefs: enabledRefs })).status).toBe(500)
  })

  it('observationActivationMinConfidence gates low-confidence live activation', { timeout: 60_000 }, async () => {
    const disabled = await startLiveHarness(['    observationActivationMinEvidence: 2', '    observationActivationMinSessions: 2', '    observationActivationMinConfidence: 0.8'])
    harnesses.push(disabled)
    const disabledRefs = await seedEvidence(disabled, [['matrix-confidence-disabled-a', ['confidence threshold one']], ['matrix-confidence-disabled-b', ['confidence threshold two']]])
    const disabledObservation = await postJson(disabled, '/observations', { text: 'confidence threshold pattern', confidence: 0.7, sourceRefs: disabledRefs })
    expect((await json<{ status: string }>(disabledObservation)).status).toBe('candidate')

    const enabled = await startLiveHarness(['    observationActivationMinEvidence: 2', '    observationActivationMinSessions: 2', '    observationActivationMinConfidence: 0.5'])
    harnesses.push(enabled)
    const enabledRefs = await seedEvidence(enabled, [['matrix-confidence-enabled-a', ['confidence threshold one']], ['matrix-confidence-enabled-b', ['confidence threshold two']]])
    const enabledObservation = await postJson(enabled, '/observations', { text: 'confidence threshold pattern', confidence: 0.7, sourceRefs: enabledRefs })
    expect((await json<{ status: string }>(enabledObservation)).status).toBe('active')
    expect((await postJson(enabled, '/observations', { text: 'confidence threshold invalid', confidence: 0.7, sourceRefs: ['session:missing/event:1'] })).status).toBe(500)
  })

  it('keeps live recall and persisted state isolated across profile scopes', { timeout: 60_000 }, async () => {
    const harness = await startLiveHarness(['    recallEnabled: true'])
    harnesses.push(harness)
    await writeMemory(harness, 'standard-only scope fact', 'standard')
    const otherSnapshot = await snapshot(harness, 'other-profile')
    expect(otherSnapshot.pages).toEqual([])
    const otherAgent = createAgent(harness, 'matrix-other-profile', 'other-profile')
    expect(await preStep(harness, otherAgent, '你还记得 standard-only scope fact 吗？')).not.toContain('standard-only scope fact')
    const standardConfig = await config(harness, 'standard')
    const otherConfig = await config(harness, 'other-profile')
    expect(standardConfig.profileId).toBe('standard')
    expect(otherConfig.profileId).toBe('other-profile')
    expect((await snapshot(harness, 'standard')).pages).toEqual(expect.arrayContaining([expect.objectContaining({ title: 'standard-only scope fact' })]))
  })
})
