/* oxlint-disable @stylistic/max-len */
import { fetchLive } from './support/live-http.ts'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
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
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import { agentEvents } from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import RikoMemoryService, { parseWikiOutput, validateConfig } from '../src/index.ts'
import { awaitLiveReady, drainInFlight, evidenceDrainBudgetMs, readPersistedEvidence } from './support/live-harness.ts'

let context: Context | undefined
let root: string | undefined
const waitTimeoutMs = 15_000
const waitIntervalMs = 25

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

async function loadMemoryFixture(memoryConfig: readonly string[] = []): Promise<string> {
  root = await mkdtemp(join(tmpdir(), 'dsh-riko-memory-wave-'))
  const debounceConfig = memoryConfig.find(line => /^\s*debounceMs\s*:/.test(line))
  const extraConfig = memoryConfig.filter(line => !/^\s*debounceMs\s*:/.test(line))
  const configPath = join(root, 'cordis.yml')
  await writeFile(join(root, 'credentials.yaml'), 'version: 1\nrefs:\n  DSH_MEMORY_DREAM_API_KEY: fixture-secret\n  GEMINI_API_KEY: fixture-secret\n')
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
    '    ownerAdminToken: owner-admin-token',
    ...(debounceConfig === undefined ? ['    debounceMs: 60000'] : [debounceConfig]),
    '    dreamIntervalMs: 3600000',
    ...extraConfig,
    '',
  ].join('\n'))
  const dependencies = {
    name: 'fixture-dependencies',
    apply(ctx: Context) {
      ctx.provide('agents', { list: () => [] } as never)
      ctx.provide('llm', { stream: async function* () {} } as never)
    },
  }
  context = new Context()
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
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof context.loader.internal>
  await context.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await context.loader.await()
  await waitForWebServerPort()
  return `http://127.0.0.1:${String(context.webServer.port)}/memory/v1`
}

async function waitForPersistedSession(base: string, sessionId: string, lineCount: number): Promise<void> {
  // `GET /memory/v1/sessions` awaits the service's in-flight set, so it is the explicit
  // readiness signal for the L0 write chain; polling `/sessions/:id` alone spends the budget
  // on writes that are merely still queued.
  await drainInFlight(base, lineCount)
  await vi.waitFor(async () => {
    const persisted = await readPersistedEvidence(base, sessionId)
    expect(persisted.status).toBe(200)
    expect(persisted.lineCount).toBe(lineCount)
  }, { timeout: evidenceDrainBudgetMs(lineCount), interval: waitIntervalMs })
}

async function waitForWebServerPort(): Promise<number> {
  if (!context) throw new Error('fixture context is unavailable')
  await awaitLiveReady(context)
  return context.webServer.port
}

function testAgent(session: ReturnType<NonNullable<typeof context>['sessions']['create']>): Agent {
  if (!context) throw new Error('fixture context is unavailable')
  return { id: session.id, session, ctx: context } as unknown as Agent
}

async function executeMemoryTool(agent: Agent, name: string, arguments_: Record<string, unknown>): Promise<{ readonly isError: boolean; readonly value?: unknown }> {
  if (!context) throw new Error('fixture context is unavailable')
  return context.tools.execute({ signal: new AbortController().signal, callId: ToolCallId(`wave-${name}`), name, arguments: arguments_, agent })
}

describe('real Loader composition', () => {
  it('rejects an unbound single bearer and a colliding owner-admin credential', () => {
    const base = {
      ownerNamespace: 'test-owner', apiPath: '/memory/v1', apiToken: 'single-token', apiTokens: {}, apiTokenProfile: '', ownerAdminToken: '', dreamApiUrl: 'https://api.test/api/v1/chat/completions', dreamCredentialRef: 'DSH_MEMORY_DREAM_API_KEY',
    } as unknown as Parameters<typeof validateConfig>[0]
    expect(() => validateConfig(base)).toThrow(/apiTokenProfile is required/i)
    expect(() => validateConfig({ ...base, apiTokenProfile: 'alice', ownerAdminToken: 'single-token' })).toThrow(/distinct from apiToken/i)
  })

  it('promotes explicit sensitive claims and provides live suppress, restore, and natural forget controls', { timeout: 60_000 }, async () => {
    const base = await loadMemoryFixture(['    recallEnabled: true', '    temporalReconcileEnabled: true', '    observationActivationMinEvidence: 3', '    observationActivationMinSessions: 2', '    observationActivationMinConfidence: 0.8'])
    if (!context) throw new Error('fixture context is unavailable')
    const configResponse = await fetchLive(`${base}/config`, { headers: { 'x-dsh-memory-profile': 'standard' } })
    expect(configResponse.status).toBe(200)
    expect(await configResponse.json()).toMatchObject({ maxSessionChars: 40_000, observationActivationMinEvidence: 3, observationActivationMinSessions: 2, observationActivationMinConfidence: 0.8 })
    const session = context.sessions.create(SessionId('controls-session'), { meta: { agentPreset: 'standard' } })
    const agent = testAgent(session)
    context.emit('agent/created', { agent, source: 'startup' })
    const append = (text: string): void => { session.append('user/message', createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }), { surfaceOp: 'append' }) }
    append('请记住：我的糖尿病诊断是二型。')
    const health = await executeMemoryTool(agent, 'memory_remember', { content: '我的糖尿病诊断是二型。' })
    expect(health.isError).toBe(false)
    append('请记住：我的银行账户密码是 Safe123。')
    const credential = await executeMemoryTool(agent, 'memory_remember', { content: '我的银行账户密码是 Safe123。', sensitivity: 'normal' })
    expect(credential.isError).toBe(false)
    const initialResident = await fetchLive(`${base}/resident`, { headers: { 'x-dsh-memory-profile': 'standard' } })
    expect(await initialResident.text()).not.toContain('糖尿病诊断')
    const initialWiki = await fetchLive(`${base}/wiki`, { headers: { 'x-dsh-memory-profile': 'standard' } })
    const initialBody = await initialWiki.json() as { records: Array<Record<string, unknown>> }
    expect(JSON.stringify(initialBody)).not.toContain('糖尿病诊断')
    expect(JSON.stringify(initialBody)).not.toContain('银行账户密码')
    expect(initialBody.records.filter(record => record.sensitivity === 'sensitive' && record.redacted === true)).toHaveLength(2)

    append('请记住：我喜欢周末跑步。')
    const remembered = await executeMemoryTool(agent, 'memory_remember', { content: '我喜欢周末跑步。' })
    expect(remembered.isError).toBe(false)
    const rememberedId = (remembered.value as { id: string }).id
    const tightened = await fetchLive(`${base}/wiki/pages/${rememberedId}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'x-dsh-memory-profile': 'standard' },
      body: JSON.stringify({ sensitivity: 'sensitive', sensitivityReason: 'operator review' }),
    })
    expect(tightened.status).toBe(200)
    expect(await (await fetchLive(`${base}/resident`, { headers: { 'x-dsh-memory-profile': 'standard' } })).text()).not.toContain('周末跑步')
    const loosened = await fetchLive(`${base}/wiki/pages/${rememberedId}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'x-dsh-memory-profile': 'standard' },
      body: JSON.stringify({ sensitivity: 'normal', sensitivityReason: 'operator restoration' }),
    })
    expect((await loosened.json() as { sensitivity: string }).sensitivity).toBe('normal')
    const sensitivityAudits = await fetchLive(`${base}/audits`, { headers: { 'x-dsh-memory-profile': 'standard' } })
    const sensitivityAuditRecords = (await sensitivityAudits.json() as { audits: Array<{ event: string; detail?: { id?: string; authority?: string } }> }).audits
    const rememberedSensitivityAudits = sensitivityAuditRecords.filter(audit => audit.detail?.id === rememberedId && (audit.event === 'memory-sensitivity-changed' || audit.event === 'memory-sensitivity-rejected'))
    expect(rememberedSensitivityAudits.some(audit => audit.event === 'memory-sensitivity-changed' && audit.detail?.authority === 'management')).toBe(true)
    expect(rememberedSensitivityAudits.some(audit => audit.event === 'memory-sensitivity-changed' && audit.detail?.authority === 'deterministic_rule')).toBe(false)
    append(`不要再主动提起这条记忆 ${rememberedId}`)
    const suppressed = await executeMemoryTool(agent, 'memory_suppress', { id: rememberedId })
    expect(suppressed.isError).toBe(false)
    expect(await (await fetchLive(`${base}/resident`, { headers: { 'x-dsh-memory-profile': 'standard' } })).text()).not.toContain('周末跑步')
    const suppressedRecall = await fetchLive(`${base}/recall`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-dsh-memory-profile': 'standard' }, body: JSON.stringify({ query: '你还记得我喜欢周末跑步吗？' }) })
    expect((await suppressedRecall.json() as { results: Array<{ text: string }> }).results.some(result => result.text.includes('周末跑步'))).toBe(false)
    const retainedEvidence = await fetchLive(`${base}/sessions`, { headers: { 'x-dsh-memory-profile': 'standard' } })
    expect((await retainedEvidence.json() as { sessions: string[] }).sessions).toContain('controls-session')
    append(`恢复提及这条记忆 ${rememberedId}`)
    const restored = await executeMemoryTool(agent, 'memory_restore', { id: rememberedId })
    expect(restored.isError).toBe(false)
    expect(await (await fetchLive(`${base}/resident`, { headers: { 'x-dsh-memory-profile': 'standard' } })).text()).toContain('周末跑步')

    append('请记住：老板那件事让我难过。')
    const unique = await executeMemoryTool(agent, 'memory_remember', { content: '老板那件事让我难过。' })
    expect(unique.isError).toBe(false)
    append('忘掉老板那件事')
    const naturalForget = await executeMemoryTool(agent, 'memory_forget', {})
    expect(naturalForget.isError).toBe(false)
    expect((naturalForget.value as { id: string }).id).toBeDefined()
    const afterUnique = await fetchLive(`${base}/wiki`, { headers: { 'x-dsh-memory-profile': 'standard' } })
    expect((await afterUnique.json() as { records: Array<{ content?: string }> }).records.some(record => typeof record.content === 'string' && record.content.includes('老板那件事'))).toBe(false)

    append('请记住：旅行计划是去上海。')
    expect((await executeMemoryTool(agent, 'memory_remember', { content: '旅行计划是去上海。' })).isError).toBe(false)
    append('请记住：旅行计划是去杭州。')
    expect((await executeMemoryTool(agent, 'memory_remember', { content: '旅行计划是去杭州。' })).isError).toBe(false)
    append('请忘记旅行计划')
    const ambiguous = await executeMemoryTool(agent, 'memory_forget', {})
    expect(ambiguous.isError).toBe(false)
    expect(ambiguous.value).toMatchObject({ confirmationRequired: true })
    expect((ambiguous.value as { candidates: string[] }).candidates).toHaveLength(2)
    const afterAmbiguous = await fetchLive(`${base}/wiki`, { headers: { 'x-dsh-memory-profile': 'standard' } })
    expect((await afterAmbiguous.json() as { records: Array<{ content?: string }> }).records.filter(record => typeof record.content === 'string' && record.content.includes('旅行计划')).length).toBe(2)

    const aliasPage = await fetchLive(`${base}/wiki/pages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-dsh-memory-profile': 'standard' },
      body: JSON.stringify({ path: 'wiki/entities/alice.md', type: 'entity', title: 'Alice', description: 'Alice', content: 'Alice', tags: [] }),
    })
    expect(aliasPage.status).toBe(201)
    const aliasSession = context.sessions.create(SessionId('alias-session'), { meta: { agentPreset: 'standard' } })
    aliasSession.append('user/message', createUserMessage({ content: [{ type: 'text', text: '小爱 Alice' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
    await fetchLive(`${base}/wiki`, { headers: { 'x-dsh-memory-profile': 'standard' } })
    aliasSession.append('user/message', createUserMessage({ content: [{ type: 'text', text: '忘记小爱' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
    const aliasAgent = testAgent(aliasSession)
    const forgottenByAlias = await executeMemoryTool(aliasAgent, 'memory_forget', {})
    expect(forgottenByAlias.isError).toBe(false)
    expect((forgottenByAlias.value as { id: string }).id).toBe((await aliasPage.json() as { id: string }).id)
  })

  it('rejects a provider downgrade to normal while retaining the sensitive canonical page', { timeout: 60_000 }, async () => {
    const base = await loadMemoryFixture(['    dreamApiUrl: https://api.test/api/v1/chat/completions'])
    if (!context) throw new Error('fixture context is unavailable')
    const providerFile = '<<<FILE path="wiki/entities/provider-guard.md">>>\n---\ntype: entity\ntitle: 提供方页面\ndescription: 提供方页面\nsources:\n  - provider-session\ntimestamp: 2026-09-19T00:00:00.000Z\nconfidence: 1\nsensitivity: normal\nstatus: candidate\nconsent: false\nlocked: false\n---\n提供方页面。\n<<<END>>>'
    const generated = parseWikiOutput(providerFile, 'provider-session')[0]
    if (!generated) throw new Error('provider fixture did not parse')
    const canonical = await fetchLive(`${base}/wiki/pages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-dsh-memory-profile': 'standard' },
      body: JSON.stringify({
        path: generated.path,
        markdown: `---\ntype: ${generated.type}\ntitle: ${generated.title}\ndescription: ${generated.description}\nsources:\n  - management\ntags:\ntimestamp: ${generated.timestamp}\nconfidence: 1\nsensitivity: sensitive\nstatus: confirmed\nconsent: true\nlocked: true\n---\n${generated.body}`,
      }),
    })
    expect(canonical.status).toBe(201)
    const session = context.sessions.create(SessionId('provider-session'), { meta: { agentPreset: 'standard' } })
    session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'provider guard input' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
    await fetchLive(`${base}/wiki`, { headers: { 'x-dsh-memory-profile': 'standard' } })
    const nativeFetch = globalThis.fetch
    const providerFetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === 'https://api.test/api/v1/chat/completions') return Promise.resolve(new Response(JSON.stringify({ choices: [{ message: { content: providerFile } }] }), { headers: { 'content-type': 'application/json' } }))
      return nativeFetch(input, init)
    })
    globalThis.fetch = providerFetch as typeof fetch
    try {
      const dream = await fetchLive(`${base}/dream`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-dsh-memory-profile': 'standard' }, body: JSON.stringify({ sessionId: 'provider-session' }) })
      expect(dream.status).toBe(202)
      await vi.waitFor(() => expect(providerFetch.mock.calls.some(call => String(call[0]) === 'https://api.test/api/v1/chat/completions')).toBe(true), { timeout: waitTimeoutMs, interval: waitIntervalMs })
      const page = await fetchLive(`${base}/wiki/pages/${(await canonical.json() as { id: string }).id}?reveal=sensitive`, { headers: { authorization: 'Bearer owner-admin-token', 'x-dsh-memory-profile': 'standard' } })
      expect((await page.json() as { sensitivity: string }).sensitivity).toBe('sensitive')
      const audits = await fetchLive(`${base}/audits`, { headers: { 'x-dsh-memory-profile': 'standard' } })
      expect((await audits.json() as { audits: Array<{ event: string; detail?: { to?: string; authority?: string } }> }).audits).toEqual(expect.arrayContaining([expect.objectContaining({ event: 'memory-sensitivity-rejected', detail: expect.objectContaining({ to: 'normal', authority: 'model_proposal' }) })]))
    } finally {
      globalThis.fetch = nativeFetch
    }
  })

  it('defaults Dream candidates to exact user-grounded auto-confirmation and classifies sensitivity locally', { timeout: 60_000 }, async () => {
    const base = await loadMemoryFixture(['    dreamApiUrl: https://api.test/api/v1/chat/completions', '    debounceMs: 0', '    recallEnabled: true'])
    if (!context) throw new Error('fixture context is unavailable')
    const statements = ['我喜欢“周末跑步”\\计划。', '我的邮箱是 riko@example.com', '项目编号 ABCD', '我喜欢晨间散步。']
    const file = (path: string, title: string, description: string, body: string, sensitivity?: string, groundingEventRef?: string): string => [
      `<<<FILE path="${path}">>>`, '---', 'type: concept', `title: ${title}`, `description: ${description}`, ...(groundingEventRef === undefined ? [] : [`grounding_event_ref: ${groundingEventRef}`]), 'sources:', '  - forged-session', 'timestamp: 2026-09-19T00:00:00.000Z', 'confidence: 0.9', ...(sensitivity === undefined ? [] : [`sensitivity: ${sensitivity}`]), 'status: candidate', 'consent: false', 'locked: false', '---', body, '<<<END>>>',
    ].join('\n')
    const outputFor = (groundingEventRef: string): string => [
      file('wiki/concepts/grounded.md', '周末运动偏好', '模型概括的跑步偏好', '模型生成的候选正文', undefined, groundingEventRef),
      file('wiki/concepts/partial.md', '跑步片段', '周末跑步', '周末跑步'),
      file('wiki/concepts/private.md', '邮箱信息', '模型概括的个人资料', statements[1]!, 'normal', [...dreamRequestBody.matchAll(/grounding_event_ref=(session:[^\]]+)/g)][1]?.[1]),
      file('wiki/concepts/identifier.md', '项目编号', statements[2]!, statements[2]!),
      file('wiki/concepts/malformed-sensitivity.md', '晨间散步', statements[3]!, statements[3]!, 'unknown'),
      file('wiki/concepts/wrong-session-ref.md', '错误会话锚点', statements[0]!, statements[0]!, undefined, 'session:some-other-session/event:1'),
    ].join('\n')
    const nativeFetch = globalThis.fetch
    let dreamRequestBody = ''
    const providerFetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === 'https://api.test/api/v1/chat/completions') {
        dreamRequestBody = String(init?.body ?? '')
        const prompt = JSON.parse(dreamRequestBody) as { messages: Array<{ content: string }> }
        const groundingEventRef = /grounding_event_ref=(session:[^\]]+)/.exec(prompt.messages[0]?.content ?? '')?.[1]
        if (!groundingEventRef) throw new Error('Dream prompt omitted L0 grounding event references')
        return Promise.resolve(new Response(JSON.stringify({ choices: [{ message: { content: outputFor(groundingEventRef) } }] }), { headers: { 'content-type': 'application/json' } }))
      }
      return nativeFetch(input, init)
    })
    globalThis.fetch = providerFetch as typeof fetch
    try {
      const session = context.sessions.create(SessionId('default-policy-session'), { meta: { agentPreset: 'standard' } })
      for (const text of statements) session.append('user/message', createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }), { surfaceOp: 'append' })
      session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
      await vi.waitFor(async () => {
        expect(providerFetch.mock.calls.some(call => String(call[0]) === 'https://api.test/api/v1/chat/completions')).toBe(true)
        const response = await fetchLive(`${base}/wiki`, { headers: { 'x-dsh-memory-profile': 'standard' } })
        const current = await response.json() as { pages: Array<{ description: string; status: string }>; candidates: unknown[] }
        expect(current.pages).toEqual(expect.arrayContaining([expect.objectContaining({ description: statements[0], status: 'confirmed' })]))
        expect(current.candidates).toHaveLength(5)
      }, { timeout: waitTimeoutMs, interval: waitIntervalMs })
      const wiki = await fetchLive(`${base}/wiki`, { headers: { 'x-dsh-memory-profile': 'standard' } })
      const snapshot = await wiki.json() as { pages: Array<{ description: string; status: string }>; candidates: Array<{ page: { description?: string; sensitivity: string; status: string } }> }
      expect(snapshot.pages).toEqual(expect.arrayContaining([expect.objectContaining({ description: statements[0], status: 'confirmed' })]))
      expect(snapshot.candidates).toHaveLength(5)
      expect(snapshot.candidates).toEqual(expect.arrayContaining([
        expect.objectContaining({ page: expect.objectContaining({ description: '周末跑步', sensitivity: 'normal', status: 'candidate' }) }),
        expect.objectContaining({ page: expect.objectContaining({ sensitivity: 'sensitive', status: 'candidate' }) }),
        expect.objectContaining({ page: expect.objectContaining({ sensitivity: 'provisional_sensitive', status: 'candidate' }) }),
      ]))
      expect(snapshot.candidates.filter(candidate => candidate.page.sensitivity === 'provisional_sensitive')).toHaveLength(3)
      expect(dreamRequestBody).toContain('grounding_event_ref')
      expect(dreamRequestBody).toContain('runtime will replace description with the source text only after validating scope, length, and sensitivity')
      const audits = await fetchLive(`${base}/audits`, { headers: { 'x-dsh-memory-profile': 'standard' } })
      const auditRecords = (await audits.json() as { audits: Array<{ event: string; detail?: { mode?: string; groundingRef?: string } }> }).audits
      expect(auditRecords.filter(audit => audit.event === 'candidate-auto-confirmed')).toEqual([
        expect.objectContaining({ detail: expect.objectContaining({ mode: 'user_grounded', groundingRef: expect.stringMatching(/^session:default-policy-session\/event:/) }) }),
      ])

      const agent = { id: session.id, session, ctx: context } as unknown as Agent
      context.emit('agent/created', { agent, source: 'startup' })
      const prompt = await context.systemPrompt.assemble()
      expect(prompt.contexts.find(entry => entry.name === 'riko-memory')?.text).toContain(statements[0])

      const recalledStep = await agentEvents(context, agent).waterfall('agent/pre-step', {
        messages: [createUserMessage({ content: [{ type: 'text', text: '你还记得我说过我喜欢周末跑步吗？' }], source: { kind: 'user' } })],
        turn: 2,
        step: 1,
        signal: new AbortController().signal,
      }, () => Promise.resolve({ kind: 'enter' as const, messages: [] }))
      if (recalledStep.kind !== 'enter') throw new Error('expected proactive recall to enter')
      const recalledMessages = recalledStep.messages as ReadonlyArray<{
        readonly source: { readonly kind?: string; readonly plugin?: string }
        readonly content: readonly { readonly type?: string; readonly text?: string }[]
      }>
      expect(recalledMessages.some(message => message.source.kind === 'plugin'
        && message.source.plugin === '@deepseek-ai/dsh-riko-memory'
        && message.content.some(block => block.type === 'text'
          && typeof block.text === 'string'
          && block.text.includes(statements[0]!)))).toBe(true)
    } finally {
      globalThis.fetch = nativeFetch
    }
  })

  it('fails over in order, anchors referenced L0 text, and preserves Resident when a later task is denied', { timeout: 60_000 }, async () => {
    const base = await loadMemoryFixture([
      '    dreamApiUrl: https://primary.test/v1/chat/completions',
      '    dreamModel: primary-model',
      '    dreamFallbacks:',
      '      - apiUrl: https://fallback-one.test/v1/chat/completions',
      '        model: fallback-one',
      '        credentialRef: DSH_MEMORY_DREAM_API_KEY',
      '      - apiUrl: https://fallback-two.test/v1/chat/completions',
      '        model: fallback-two',
      '        credentialRef: DSH_MEMORY_DREAM_API_KEY',
      '    debounceMs: 0',
      '    recallEnabled: true',
    ])
    if (!context) throw new Error('fixture context is unavailable')
    const nativeFetch = globalThis.fetch
    const calls: Array<{ endpoint: string; model: string; session: string }> = []
    const providerFetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const endpoint = String(input)
      if (!endpoint.startsWith('https://primary.test/') && !endpoint.startsWith('https://fallback-one.test/') && !endpoint.startsWith('https://fallback-two.test/')) return nativeFetch(input, init)
      const request = JSON.parse(String(init?.body ?? '{}')) as { model?: string; messages?: Array<{ content?: string }> }
      const prompt = request.messages?.[0]?.content ?? ''
      const session = prompt.includes('session:fallback-collision-session') ? 'fallback-collision-session' : prompt.includes('session:fallback-failed-session') ? 'fallback-failed-session' : prompt.includes('session:fallback-pending-session') ? 'fallback-pending-session' : 'fallback-success-session'
      calls.push({ endpoint, model: request.model ?? '', session })
      if (session === 'fallback-collision-session' && endpoint.startsWith('https://fallback-two.test/')) {
        const content = ['<<<FILE path="wiki/concepts/collision-pending.md">>>', '---', 'type: concept', 'title: 重名后切换到第二备选', 'description: 按规则回退到第二个唯一模型', 'sources:', '  - forged-session', 'timestamp: 2026-09-19T00:00:00.000Z', 'confidence: 0.8', 'status: candidate', 'consent: false', 'locked: false', '---', '模型生成的待确认内容。', '<<<END>>>'].join('\n')
        return Promise.resolve(new Response(JSON.stringify({ choices: [{ message: { content } }] }), { headers: { 'content-type': 'application/json' } }))
      }
      if (session === 'fallback-collision-session') return Promise.resolve(new Response('{}', { status: 503 }))
      if (endpoint.startsWith('https://primary.test/') && session === 'fallback-success-session') {
        const partialPage = '<<<FILE path="wiki/concepts/partial-primary.md">>>\n---\ntype: concept\ntitle: 部分页面不应写入\ndescription: 部分页面不应写入\n---\nprimary partial output\n<<<END>>>'
        const invalidPage = '<<<FILE path="wiki/concepts/invalid-primary.md">>>\nnot frontmatter\n<<<END>>>'
        const content = `${partialPage}\n${invalidPage}`
        return Promise.resolve(new Response(JSON.stringify({ choices: [{ message: { content } }] }), { headers: { 'content-type': 'application/json' } }))
      }
      if (endpoint.startsWith('https://primary.test/')) return Promise.resolve(new Response('{}', { status: 503 }))
      if (endpoint.startsWith('https://fallback-two.test/')) return Promise.resolve(new Response('{}', { status: 200 }))
      if (session === 'fallback-failed-session') return Promise.resolve(new Response('{}', { status: 401 }))
      if (session === 'fallback-pending-session') {
        const content = ['<<<FILE path="wiki/concepts/pending-only.md">>>', '---', 'type: concept', 'title: 待确认候选', 'description: 模型提议的公园散步习惯', 'sources:', '  - forged-session', 'timestamp: 2026-09-19T00:00:00.000Z', 'confidence: 0.8', 'status: candidate', 'consent: false', 'locked: false', '---', '模型整理的候选内容。', '<<<END>>>'].join('\n')
        return Promise.resolve(new Response(JSON.stringify({ choices: [{ message: { content } }] }), { headers: { 'content-type': 'application/json' } }))
      }
      const eventRef = /grounding_event_ref=(session:[^\]]+)/.exec(prompt)?.[1]
      if (!eventRef) throw new Error('Dream prompt omitted L0 event references')
      const content = [
        '<<<FILE path="wiki/concepts/fallback-grounded.md">>>',
        '---',
        'type: concept',
        'title: 周末运动偏好',
        'description: 模型概括的偏好',
        `grounding_event_ref: ${eventRef}`,
        'sources:',
        '  - forged-session',
        'timestamp: 2026-09-19T00:00:00.000Z',
        'confidence: 0.9',
        'status: candidate',
        'consent: false',
        'locked: false',
        '---',
        '模型生成的正文',
        '<<<END>>>',
      ].join('\n')
      return Promise.resolve(new Response(JSON.stringify({ choices: [{ message: { content } }] }), { headers: { 'content-type': 'application/json' } }))
    })
    globalThis.fetch = providerFetch as typeof fetch
    try {
      const successful = context.sessions.create(SessionId('fallback-success-session'), { meta: { agentPreset: 'standard' } })
      const statement = '我喜欢周末登山。'
      successful.append('user/message', createUserMessage({ content: [{ type: 'text', text: statement }], source: { kind: 'user' } }), { surfaceOp: 'append' })
      successful.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
      await vi.waitFor(async () => {
        const response = await fetchLive(`${base}/audits`, { headers: { 'x-dsh-memory-profile': 'standard' } })
        const value = await response.json() as { audits: Array<{ event: string; detail?: { outcome?: string; failureCategory?: string } }> }
        expect(value.audits.filter(item => item.event === 'dream-provider-attempt')).toHaveLength(2)
        expect(value.audits.some(item => item.event === 'dream-provider-attempt' && item.detail?.failureCategory === 'invalid-file-protocol')).toBe(true)
        expect(value.audits.filter(item => item.event === 'candidate-auto-confirmed')).toHaveLength(1)
      }, { timeout: waitTimeoutMs, interval: waitIntervalMs })
      const beforeFailure = await fetchLive(`${base}/resident`, { headers: { 'x-dsh-memory-profile': 'standard' } })
      const priorResident = await beforeFailure.text()
      expect(priorResident).toContain(statement)

      const pending = context.sessions.create(SessionId('fallback-pending-session'), { meta: { agentPreset: 'standard' } })
      pending.append('user/message', createUserMessage({ content: [{ type: 'text', text: '我有时会去公园散步。' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
      pending.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
      await vi.waitFor(async () => {
        const response = await fetchLive(`${base}/audits`, { headers: { 'x-dsh-memory-profile': 'standard' } })
        const value = await response.json() as { audits: Array<{ event: string }> }
        expect(value.audits.filter(item => item.event === 'dream-provider-attempt')).toHaveLength(4)
        expect(value.audits.filter(item => item.event === 'dream-succeeded')).toHaveLength(2)
      }, { timeout: waitTimeoutMs, interval: waitIntervalMs })

      const denied = context.sessions.create(SessionId('fallback-failed-session'), { meta: { agentPreset: 'standard' } })
      denied.append('user/message', createUserMessage({ content: [{ type: 'text', text: '我习惯用纸笔整理想法。' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
      denied.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
      await vi.waitFor(async () => {
        const response = await fetchLive(`${base}/audits`, { headers: { 'x-dsh-memory-profile': 'standard' } })
        const value = await response.json() as { audits: Array<{ event: string; detail?: { failureCategory?: string } }> }
        expect(value.audits.filter(item => item.event === 'dream-provider-attempt')).toHaveLength(6)
        expect(value.audits.some(item => item.event === 'dream-failed')).toBe(true)
      }, { timeout: waitTimeoutMs, interval: waitIntervalMs })
      expect(calls.map(call => call.model)).toEqual(['primary-model', 'fallback-one', 'primary-model', 'fallback-one', 'primary-model', 'fallback-one'])
      expect(calls.map(call => call.session)).toEqual(['fallback-success-session', 'fallback-success-session', 'fallback-pending-session', 'fallback-pending-session', 'fallback-failed-session', 'fallback-failed-session'])
      expect(calls.every(call => !call.endpoint.includes('fallback-two'))).toBe(true)
      const finalResident = await fetchLive(`${base}/resident`, { headers: { 'x-dsh-memory-profile': 'standard' } })
      expect(await finalResident.text()).toBe(priorResident)
      const wiki = await fetchLive(`${base}/wiki`, { headers: { 'x-dsh-memory-profile': 'standard' } })
      const snapshot = await wiki.json() as { pages: Array<{ description: string; status: string }>; candidates: Array<{ page: { title: string; description: string; status: string } }> }
      expect(snapshot.pages).toEqual(expect.arrayContaining([expect.objectContaining({ description: statement, status: 'confirmed' })]))
      expect(snapshot.candidates.map(candidate => candidate.page.description)).not.toContain('我习惯用纸笔整理想法。')
      expect(snapshot.candidates.map(candidate => candidate.page.description)).not.toContain('部分页面不应写入')
      expect(snapshot.candidates).toEqual(expect.arrayContaining([expect.objectContaining({ page: expect.objectContaining({ title: '待确认候选', status: 'candidate' }) })]))
      const audits = await fetchLive(`${base}/audits`, { headers: { 'x-dsh-memory-profile': 'standard' } })
      const records = (await audits.json() as { audits: Array<{ event: string; detail?: { model?: string; outcome?: string; failureCategory?: string; candidateCount?: number; exactAnchoredCount?: number } }> }).audits
      expect(records.filter(item => item.event === 'dream-provider-attempt').map(item => item.detail)).toEqual(expect.arrayContaining([
        expect.objectContaining({ model: 'primary-model', outcome: 'failed', failureCategory: 'http-503' }),
        expect.objectContaining({ model: 'fallback-one', outcome: 'succeeded', candidateCount: 1, exactAnchoredCount: 1 }),
        expect.objectContaining({ model: 'fallback-one', outcome: 'succeeded', candidateCount: 1, exactAnchoredCount: 0 }),
        expect.objectContaining({ model: 'fallback-one', outcome: 'failed', failureCategory: 'http-401' }),
      ]))

      const updatedSettings = await fetchLive(`${base}/config`, {
        method: 'POST',
        headers: { authorization: 'Bearer owner-admin-token', 'content-type': 'application/json', 'x-dsh-memory-profile': 'standard' },
        body: JSON.stringify({ model: 'fallback-one' }),
      })
      expect(updatedSettings.status).toBe(200)
      const collision = context.sessions.create(SessionId('fallback-collision-session'), { meta: { agentPreset: 'standard' } })
      collision.append('user/message', createUserMessage({ content: [{ type: 'text', text: '请记录：重复模型名时只调用一次。' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
      collision.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
      await vi.waitFor(async () => {
        const response = await fetchLive(`${base}/audits`, { headers: { 'x-dsh-memory-profile': 'standard' } })
        const value = await response.json() as { audits: Array<{ event: string; detail?: { model?: string; outcome?: string } }> }
        expect(value.audits.filter(item => item.event === 'dream-provider-attempt')).toHaveLength(8)
        expect(value.audits.filter(item => item.event === 'dream-succeeded'), JSON.stringify(value.audits.filter(item => item.event.startsWith('dream-')))).toHaveLength(3)
      }, { timeout: waitTimeoutMs, interval: waitIntervalMs })
      expect(calls.filter(call => call.session === 'fallback-collision-session')).toEqual([
        { endpoint: 'https://primary.test/v1/chat/completions', model: 'fallback-one', session: 'fallback-collision-session' },
        { endpoint: 'https://fallback-two.test/v1/chat/completions', model: 'fallback-two', session: 'fallback-collision-session' },
      ])
      const updatedWiki = await fetchLive(`${base}/wiki`, { headers: { 'x-dsh-memory-profile': 'standard' } })
      const updatedSnapshot = await updatedWiki.json() as { candidates: Array<{ page: { title: string; status: string } }> }
      expect(updatedSnapshot.candidates).toEqual(expect.arrayContaining([expect.objectContaining({ page: expect.objectContaining({ title: '重名后切换到第二备选', status: 'candidate' }) })]))

      const agent = testAgent(successful)
      context.emit('agent/created', { agent, source: 'startup' })
      const prompt = await context.systemPrompt.assemble()
      expect(prompt.contexts.find(entry => entry.name === 'riko-memory')?.text).toContain(statement)
      const recalledStep = await agentEvents(context, agent).waterfall('agent/pre-step', {
        messages: [createUserMessage({ content: [{ type: 'text', text: '你还记得我周末喜欢做什么运动吗？' }], source: { kind: 'user' } })],
        turn: 2,
        step: 1,
        signal: new AbortController().signal,
      }, () => Promise.resolve({ kind: 'enter' as const, messages: [] }))
      if (recalledStep.kind !== 'enter') throw new Error('expected proactive recall to enter')
      expect((recalledStep.messages as Array<{ source: { kind?: string; plugin?: string }; content: Array<{ type?: string; text?: string }> }>).some(message => message.source.kind === 'plugin' && message.source.plugin === '@deepseek-ai/dsh-riko-memory' && message.content.some(block => block.type === 'text' && block.text?.includes(statement)))).toBe(true)
    } finally {
      globalThis.fetch = nativeFetch
    }
  })

  it('passes observation activation thresholds into the live store', { timeout: 60_000 }, async () => {
    const base = await loadMemoryFixture(['    minObservationEvidence: 1', '    observationActivationMinEvidence: 1', '    observationActivationMinSessions: 1', '    observationActivationMinConfidence: 0.5'])
    if (!context) throw new Error('fixture context is unavailable')
    const config = await fetchLive(`${base}/config`, { headers: { 'x-dsh-memory-profile': 'standard' } })
    expect(await config.json()).toMatchObject({ observationActivationMinEvidence: 1, observationActivationMinSessions: 1, observationActivationMinConfidence: 0.5 })
    const session = context.sessions.create(SessionId('activation-session'), { meta: { agentPreset: 'standard' } })
    session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'activation evidence' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
    await fetchLive(`${base}/wiki`, { headers: { 'x-dsh-memory-profile': 'standard' } })
    const evidenceResponse = await fetchLive(`${base}/sessions/activation-session?reveal=sensitive`, { headers: { authorization: 'Bearer owner-admin-token', 'x-dsh-memory-profile': 'standard' } })
    const evidence = (await evidenceResponse.json() as { evidence: string }).evidence.trim().split('\n').map(line => JSON.parse(line) as { seq?: number; type?: string })
    const event = evidence.find(item => item.type === 'user/message' && typeof item.seq === 'number')
    if (!event || event.seq === undefined) throw new Error('activation evidence event was not persisted')
    const observation = await fetchLive(`${base}/observations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-dsh-memory-profile': 'standard' },
      body: JSON.stringify({ text: 'one-anchor observation', confidence: 0.5, sourceRefs: [`session:activation-session/event:${String(event.seq)}`] }),
    })
    expect(observation.status).toBe(201)
    expect((await observation.json() as { status: string }).status).toBe('active')
  })

  it('runs bounded reflection candidates, historical live recall, and explicit temporal reconciliation', { timeout: 60_000 }, async () => {
    const base = await loadMemoryFixture([
      '    dreamApiUrl: https://api.test/api/v1/chat/completions',
      '    reflectionEnabled: true',
      '    reflectionMaxObservations: 3',
      '    minObservationEvidence: 2',
      '    recallEnabled: true',
      '    temporalReconcileEnabled: true',
    ])
    if (!context) throw new Error('fixture context is unavailable')
    const nativeFetch = globalThis.fetch
    let reflectionCount = 0
    const providerFetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) !== 'https://api.test/api/v1/chat/completions') return nativeFetch(input, init)
      const prompt = String(init?.body ?? '')
      if (prompt.includes('Valid anchors:')) {
        reflectionCount += 1
        if (reflectionCount === 2) return Promise.resolve(new Response(JSON.stringify({ choices: [{ message: { content: 'not-json' } }] }), { headers: { 'content-type': 'application/json' } }))
        const requestBody = JSON.parse(prompt) as { messages?: Array<{ content?: unknown }> }
        const requestPrompt = typeof requestBody.messages?.[0]?.content === 'string' ? requestBody.messages[0].content : ''
        const anchorLine = /Valid anchors: ([^\n]*)/.exec(requestPrompt)?.[1] ?? ''
        const anchors = anchorLine.split(',').map(anchor => anchor.trim()).filter(anchor => anchor.startsWith('session:')).slice(0, 2)
        return Promise.resolve(new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ observations: [{ text: '用户在多次压力事件后倾向独处。', sourceRefs: anchors, confidence: 0.8 }] }) } }] }), { headers: { 'content-type': 'application/json' } }))
      }
      return Promise.resolve(new Response(JSON.stringify({ choices: [{ message: { content: '<<<FILE path="wiki/episodes/reflection-source.md">>>\n---\ntype: episode\ntitle: Reflection source\ndescription: Reflection source candidate\nsources:\n  - forged\ntimestamp: 2026-09-19T00:00:00.000Z\nconfidence: 0.7\nstatus: candidate\nconsent: false\nlocked: false\n---\n\nReflection source.\n<<<END>>>' } }] }), { headers: { 'content-type': 'application/json' } }))
    })
    globalThis.fetch = providerFetch as typeof fetch
    try {
      const firstSession = context.sessions.create(SessionId('reflection-session'), { meta: { agentPreset: 'standard' } })
      firstSession.append('user/message', createUserMessage({ content: [{ type: 'text', text: '我在压力下会减少社交。' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
      firstSession.append('user/message', createUserMessage({ content: [{ type: 'text', text: '工作压力大时我喜欢独处。' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
      await fetchLive(`${base}/wiki`, { headers: { 'x-dsh-memory-profile': 'standard' } })
      const firstDream = await fetchLive(`${base}/dream`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-dsh-memory-profile': 'standard' }, body: JSON.stringify({ sessionId: 'reflection-session' }) })
      expect(firstDream.status).toBe(202)
      await vi.waitFor(() => expect(providerFetch.mock.calls.filter(call => String(call[0]) === 'https://api.test/api/v1/chat/completions')).toHaveLength(2), { timeout: waitTimeoutMs, interval: waitIntervalMs })
      const observations = await fetchLive(`${base}/observations`, { headers: { 'x-dsh-memory-profile': 'standard' } })
      const observationBody = await observations.json() as { observations: Array<{ text?: string; status: string; epistemicStatus: string; sourceRefs?: string[]; redacted?: boolean }> }
      expect(observationBody.observations, JSON.stringify({ observationBody, providerCalls: providerFetch.mock.calls.map(call => String(call[1]?.body ?? '')) })).toHaveLength(1)
      expect(observationBody.observations[0]).toMatchObject({ status: 'candidate', epistemicStatus: 'inferred_observation' })
      if (observationBody.observations[0]?.redacted === true) expect(observationBody.observations[0]?.sourceRefs).toBeUndefined()
      else expect(observationBody.observations[0]?.sourceRefs).toHaveLength(2)
      const candidates = await fetchLive(`${base}/candidates`, { headers: { 'x-dsh-memory-profile': 'standard' } })
      expect((await candidates.json() as { candidates: unknown[] }).candidates).toHaveLength(1)

      const malformedSession = context.sessions.create(SessionId('reflection-malformed'), { meta: { agentPreset: 'standard' } })
      malformedSession.append('user/message', createUserMessage({ content: [{ type: 'text', text: '我会在压力下减少社交。' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
      malformedSession.append('user/message', createUserMessage({ content: [{ type: 'text', text: '压力大时我会独处。' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
      await fetchLive(`${base}/wiki`, { headers: { 'x-dsh-memory-profile': 'standard' } })
      const malformedDream = await fetchLive(`${base}/dream`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-dsh-memory-profile': 'standard' }, body: JSON.stringify({ sessionId: 'reflection-malformed' }) })
      expect(malformedDream.status).toBe(202)
      await vi.waitFor(() => expect(providerFetch.mock.calls.filter(call => String(call[0]) === 'https://api.test/api/v1/chat/completions')).toHaveLength(4), { timeout: waitTimeoutMs, interval: waitIntervalMs })
      const afterMalformed = await fetchLive(`${base}/observations`, { headers: { 'x-dsh-memory-profile': 'standard' } })
      expect((await afterMalformed.json() as { observations: unknown[] }).observations).toHaveLength(1)

      const temporalSession = context.sessions.create(SessionId('temporal-session'), { meta: { agentPreset: 'standard' } })
      const append = (text: string): void => { temporalSession.append('user/message', createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }), { surfaceOp: 'append' }) }
      const temporalAgent = testAgent(temporalSession)
      context.emit('agent/created', { agent: temporalAgent, source: 'startup' })
      append('请记住：我住在上海。')
      const oldMemory = await executeMemoryTool(temporalAgent, 'memory_remember', { content: '我住在上海。' })
      const oldId = (oldMemory.value as { id: string }).id
      append('请记住：以前我住在上海，现在我住在杭州。')
      const newMemory = await executeMemoryTool(temporalAgent, 'memory_remember', { content: '以前我住在上海，现在我住在杭州。' })
      expect(newMemory.isError).toBe(false)
      expect((newMemory.value as { id: string }).id).not.toBe(oldId)
      const temporalWiki = await fetchLive(`${base}/wiki`, { headers: { 'x-dsh-memory-profile': 'standard' } })
      const temporalPages = (await temporalWiki.json() as { pages: Array<{ id: string; status: string; validTo?: string }> }).pages
      expect(temporalPages.find(page => page.id === oldId)).toMatchObject({ status: 'superseded' })
      expect(temporalPages.find(page => page.id === oldId)?.validTo).toBeDefined()

      const createTemporalPage = async (path: string, title: string, content: string, validFrom: string): Promise<void> => {
        const response = await fetchLive(`${base}/wiki/pages`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-dsh-memory-profile': 'standard' }, body: JSON.stringify({ path, markdown: `---\ntype: concept\ntitle: ${title}\ndescription: ${content}\nsources:\n  - client:standard\ntimestamp: 2026-09-19T00:00:00.000Z\nobserved_at: ${validFrom}\nrecorded_at: 2026-09-19T00:00:00.000Z\nvalid_from: ${validFrom}\nconfidence: 1\nstatus: confirmed\nconsent: true\nlocked: true\n---\n\n${content}` }) })
        expect(response.status).toBe(201)
      }
      await createTemporalPage('wiki/concepts/home-shanghai.md', '住址档案上海', '住址档案：上海', '2020-01-01T00:00:00.000Z')
      await createTemporalPage('wiki/concepts/home-hangzhou.md', '住址档案杭州', '住址档案：杭州', '2025-01-01T00:00:00.000Z')
      const recallSession = context.sessions.create(SessionId('historical-session'), { meta: { agentPreset: 'standard' } })
      const recallAgent = testAgent(recallSession)
      context.emit('agent/created', { agent: recallAgent, source: 'startup' })
      const historicalApi = await fetchLive(`${base}/recall/debug`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-dsh-memory-profile': 'standard' }, body: JSON.stringify({ query: '你还记得2023年的住址档案吗？', atTime: '2023-01-01T00:00:00.000Z' }) })
      const historicalApiBody = await historicalApi.json() as { plan: unknown; results: Array<{ text: string }> }
      expect(historicalApiBody.results).not.toHaveLength(0)
      const recalledStep = await agentEvents(context, recallAgent).waterfall('agent/pre-step', { messages: [createUserMessage({ content: [{ type: 'text', text: '你还记得2023年的住址档案吗？' }], source: { kind: 'user' } })], turn: 1, step: 1, signal: new AbortController().signal }, () => Promise.resolve({ kind: 'enter' as const, messages: [] }))
      if (recalledStep.kind !== 'enter') throw new Error('expected historical recall to enter')
      expect((recalledStep.messages as ReadonlyArray<{ content: readonly { text?: string }[] }>).some(message => message.content.some(block => block.text?.includes('住址档案：上海')))).toBe(true)
      expect((recalledStep.messages as ReadonlyArray<{ content: readonly { text?: string }[] }>).some(message => message.content.some(block => block.text?.includes('住址档案：杭州')))).toBe(false)
    } finally {
      globalThis.fetch = nativeFetch
    }
  })

  it('accepts a MiMo Dream job immediately and persists its controlled output asynchronously', { timeout: 60_000 }, async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-riko-memory-mimo-'))
    const configPath = join(root, 'cordis.yml')
    await writeFile(join(root, 'credentials.yaml'), 'version: 1\nrefs:\n  DSH_MEMORY_DREAM_API_KEY: fixture-secret\n')
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
      "- name: '@deepseek-ai/cordis-plugin-timer'",
      "- name: '@deepseek-ai/dsh-host-webserver'",
      '  config:',
      "    host: '0.0.0.0'",
      '    port: 0',
      "- name: '@deepseek-ai/dsh-system-prompt'",
      "- name: '@deepseek-ai/dsh-session'",
      "- name: '@deepseek-ai/dsh-riko-memory'",
      '  config:',
      '    ownerNamespace: test-owner',
      '    ownerAdminToken: owner-admin-token',
      '    debounceMs: 60000',
      '    dreamIntervalMs: 3600000',
      '    dreamApiUrl: https://api.xiaomimimo.com/anthropic',
      '    dreamCredentialRef: DSH_MEMORY_DREAM_API_KEY',
      '    dreamModel: mimo-v2.5',
      '',
    ].join('\n'))
    const dependencies = {
      name: 'fixture-dependencies',
      apply(ctx: Context) {
        ctx.provide('agents', { list: () => [] } as never)
        ctx.provide('llm', { stream: async function* () {} } as never)
      },
    }
    context = new Context()
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
        if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
        return modules.get(specifier)
      },
    } as unknown as NonNullable<typeof context.loader.internal>
    await context.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
    await context.loader.await()
    await waitForWebServerPort()

    const session = context.sessions.create(SessionId('mimo-session'), { meta: { agentPreset: 'standard' } })
    session.append('user/message', createUserMessage({ content: [{ type: 'text', text: '请记住：我的称呼是 Riko。' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
    let resolveProvider: ((response: Response) => void) | undefined
    const providerResponse = new Promise<Response>((resolve) => { resolveProvider = resolve })
    const nativeFetch = globalThis.fetch
    const providerFetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) !== 'https://api.xiaomimimo.com/anthropic/v1/messages') return nativeFetch(input, init)
      return providerResponse
    })
    globalThis.fetch = providerFetch as typeof fetch
    try {
      const base = `http://127.0.0.1:${String(context.webServer.port)}/memory/v1`
      const pending = fetchLive(`${base}/dream`, {
        method: 'POST',
        signal: AbortSignal.timeout(waitTimeoutMs),
        headers: { authorization: 'Bearer owner-admin-token', 'content-type': 'application/json', 'x-dsh-memory-profile': 'standard' },
        body: JSON.stringify({ sessionId: 'mimo-session' }),
      })
      // The provider stays blocked until the HTTP acknowledgement has arrived.
      expect((await pending).status).toBe(202)
      await vi.waitFor(() => expect(providerFetch).toHaveBeenCalledTimes(1), { timeout: waitTimeoutMs, interval: waitIntervalMs })
      const [, request] = providerFetch.mock.calls[0]!
      expect(request?.headers).toMatchObject({ 'api-key': 'fixture-secret', 'anthropic-version': '2023-06-01' })
      resolveProvider?.(new Response(JSON.stringify({ content: [{ type: 'text', text: '<<<FILE path="wiki/concepts/name.md">>>\n---\ntype: concept\ntitle: 称呼\ndescription: 用户希望被称呼为 Riko\nsources:\n  - forged-session\ntimestamp: 2026-09-18T00:00:00.000Z\nconfidence: 0.9\nstatus: confirmed\nconsent: true\nlocked: true\n---\n\n用户希望被称呼为 Riko。\n<<<END>>>' }] }), { headers: { 'content-type': 'application/json' } }))
      expect((await pending).status).toBe(202)
      await vi.waitFor(async () => {
        const candidates = await fetchLive(`${base}/candidates`, { headers: { authorization: 'Bearer owner-admin-token', 'x-dsh-memory-profile': 'standard' } })
        expect((await candidates.json() as { candidates: Array<{ page: { sources: string[]; status: string; consent: boolean } }> }).candidates).toEqual([expect.objectContaining({ page: expect.objectContaining({ sources: ['mimo-session'], status: 'candidate', consent: false }) })])
      }, { timeout: waitTimeoutMs, interval: waitIntervalMs })
    } finally {
      resolveProvider?.(new Response(null, { status: 503 }))
      globalThis.fetch = nativeFetch
    }
  })

  it('records a conversation, builds a Wiki, injects resident memory, and exposes the client API', { timeout: 60_000 }, async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-riko-memory-loader-'))
    const configPath = join(root, 'cordis.yml')
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
      "- name: '@deepseek-ai/cordis-plugin-timer'",
      "- name: '@deepseek-ai/dsh-host-webserver'",
      '  config:',
      "    host: '127.0.0.1'",
      '    port: 0',
      "- name: '@deepseek-ai/dsh-system-prompt'",
      "- name: '@deepseek-ai/dsh-session'",
      "- name: '@deepseek-ai/dsh-riko-memory'",
      '  config:',
      '    ownerNamespace: test-owner',
      '    ownerAdminToken: owner-admin-token',
      '    debounceMs: 0',
      '    dreamIntervalMs: 3600000',
      '    recallEnabled: true',
      '    purgeEnabled: true',
      '',
    ].join('\n'))

    const dependencies = {
      name: 'fixture-dependencies',
      apply(ctx: Context) {
        ctx.provide('agents', { list: () => [] } as never)
        ctx.provide('llm', { stream: async function* () {} } as never)
      },
    }
    context = new Context()
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
        if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
        return modules.get(specifier)
      },
    } as unknown as NonNullable<typeof context.loader.internal>
    await context.loader.create({
      name: 'cordis:include',
      config: { path: pathToFileURL(configPath).href },
    })
    await context.loader.await()
    await waitForWebServerPort()

    const session = context.sessions.create(SessionId('memory-session'), { meta: { agentPreset: 'standard' } })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: '请记住：我喜欢简洁直接的回答。' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    const port = context.webServer.port
    const base = `http://127.0.0.1:${String(port)}/memory/v1`
    await waitForPersistedSession(base, 'memory-session', 2)
    const ui = await fetchLive(`${base}/ui`, { headers: { 'x-dsh-memory-profile': 'standard' } })
    expect(ui.status).toBe(200)
    const uiText = await ui.text()
    expect(uiText).toContain('当前自动注入的提示词')
    expect(uiText).not.toContain('dream-api-key')
    expect(uiText).not.toContain('apiKey')
    const scriptStart = uiText.indexOf('<script>') + '<script>'.length
    const scriptEnd = uiText.indexOf('</script>', scriptStart)
    expect(scriptStart).toBeGreaterThan('<script>'.length - 1)
    expect(scriptEnd).toBeGreaterThan(scriptStart)
    expect(() => new Function(uiText.slice(scriptStart, scriptEnd))).not.toThrow()
    const config = await fetchLive(`${base}/config`, { headers: { 'x-dsh-memory-profile': 'standard' } })
    expect(config.status).toBe(200)
    expect((await config.json() as { profileId: string }).profileId).toBe('standard')
    const rejectedSecretWrite = await fetchLive(`${base}/config`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-dsh-memory-profile': 'standard' },
      body: JSON.stringify({ apiKey: 'must-not-be-persisted' }),
    })
    expect(rejectedSecretWrite.status).toBe(400)
    expect(await rejectedSecretWrite.text()).not.toContain('must-not-be-persisted')
    for (const credentialRef of ['not a credential ref', 'sk-live-secret']) {
      const rejectedCredentialWrite = await fetchLive(`${base}/config`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-dsh-memory-profile': 'standard' },
        body: JSON.stringify({ credentialRef }),
      })
      expect(rejectedCredentialWrite.status).toBe(400)
      expect(await rejectedCredentialWrite.text()).not.toContain(credentialRef)
    }
    const unchangedConfig = await fetchLive(`${base}/config`, { headers: { 'x-dsh-memory-profile': 'standard' } })
    expect((await unchangedConfig.json() as { dreamCredentialRef: string }).dreamCredentialRef).toBe('GEMINI_API_KEY')
    const automaticWiki = await fetchLive(`${base}/wiki`, { headers: { 'x-dsh-memory-profile': 'standard' } })
    expect((await automaticWiki.json() as { records: Array<{ content: string }> }).records).toHaveLength(0)
    const agent = { id: session.id, session, ctx: context } as unknown as Agent
    context.emit('agent/created', { agent, source: 'startup' })
    const prompt = await context.systemPrompt.assemble()
    expect(prompt.contexts.some(contextEntry => contextEntry.name === 'riko-memory')).toBe(true)
    const dream = await fetchLive(`${base}/dream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-dsh-memory-profile': 'standard' },
      body: JSON.stringify({ sessionId: 'memory-session' }),
    })
    expect(dream.status).toBe(202)

    const wiki = await fetchLive(`${base}/wiki`, { headers: { 'x-dsh-memory-profile': 'standard' } })
    expect(wiki.status).toBe(200)
    const wikiBody = await wiki.json() as { records: Array<{ content: string }> }
    expect(wikiBody.records).toHaveLength(0)
    const resident = await fetchLive(`${base}/resident`, { headers: { 'x-dsh-memory-profile': 'standard' } })
    expect(await resident.text()).toContain('"resident":""')

    for (const name of ['memory_get_resident', 'memory_remember', 'memory_correct', 'memory_forget']) expect(context.tools.get(name, agent)).toBeDefined()
    const remember = await context.tools.execute({ signal: new AbortController().signal, callId: ToolCallId('memory-remember'), name: 'memory_remember', arguments: { content: '我喜欢简洁直接的回答。' }, agent })
    expect(remember.isError).toBe(false)
    const rememberedId = (remember.value as { id: string }).id
    await expect((await fetchLive(`${base}/resident`, { headers: { 'x-dsh-memory-profile': 'standard' } })).text()).resolves.toContain('我喜欢简洁直接的回答。')
    const recalledStep = await agentEvents(context, agent).waterfall('agent/pre-step', { messages: [createUserMessage({ content: [{ type: 'text', text: '你还记得我喜欢什么回答吗？' }], source: { kind: 'user' } })], turn: 1, step: 1, signal: new AbortController().signal }, () => Promise.resolve({ kind: 'enter' as const, messages: [] }))
    if (recalledStep.kind !== 'enter') throw new Error('expected pre-step to enter')
    const recalledMessages = recalledStep.messages as ReadonlyArray<{
      readonly source: { readonly kind?: string }
      readonly content: readonly { readonly type?: string; readonly text?: string }[]
    }>
    expect(recalledMessages.some(message => message.source.kind === 'plugin'
      && message.content.some(block => block.type === 'text'
        && typeof block.text === 'string'
        && block.text.includes('我喜欢简洁直接的回答')))).toBe(true)
    const recall = await fetchLive(`${base}/recall`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-dsh-memory-profile': 'standard' },
      body: JSON.stringify({ query: '我喜欢简洁直接的回答吗？' }),
    })
    expect(recall.status).toBe(200)
    expect((await recall.json() as { results: Array<{ text: string }> }).results.some(result => result.text.includes('我喜欢简洁直接的回答'))).toBe(true)
    session.append('user/message', createUserMessage({ content: [{ type: 'text', text: '请更正为：我喜欢回答简明扼要。' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
    const correct = await context.tools.execute({ signal: new AbortController().signal, callId: ToolCallId('memory-correct'), name: 'memory_correct', arguments: { id: rememberedId, content: '我喜欢回答简明扼要。' }, agent })
    expect(correct.isError).toBe(false)
    await expect((await fetchLive(`${base}/resident`, { headers: { 'x-dsh-memory-profile': 'standard' } })).text()).resolves.toContain('我喜欢回答简明扼要。')
    session.append('user/message', createUserMessage({ content: [{ type: 'text', text: `请忘记记忆 ${rememberedId}` }], source: { kind: 'user' } }), { surfaceOp: 'append' })
    const forget = await context.tools.execute({ signal: new AbortController().signal, callId: ToolCallId('memory-forget'), name: 'memory_forget', arguments: { id: rememberedId }, agent })
    expect(forget.isError, JSON.stringify(forget)).toBe(false)
    await expect((await fetchLive(`${base}/resident`, { headers: { 'x-dsh-memory-profile': 'standard' } })).text()).resolves.toContain('"resident":""')

    const manual = await fetchLive(`${base}/memories`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-dsh-memory-profile': 'standard' },
      body: JSON.stringify({ content: '用户希望被称呼为 Riko' }),
    })
    expect(manual.status).toBe(201)
    const manualBody = await manual.json() as { id: string }
    const deleted = await fetchLive(`${base}/memories/${manualBody.id}`, {
      method: 'DELETE',
      headers: { 'x-dsh-memory-profile': 'standard' },
    })
    expect(deleted.status).toBe(200)

    const correctionMemory = await fetchLive(`${base}/memories`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-dsh-memory-profile': 'standard' },
      body: JSON.stringify({ content: 'HTTP correction before' }),
    })
    expect(correctionMemory.status).toBe(201)
    const correctionMemoryBody = await correctionMemory.json() as { id: string }
    const correctedMemory = await fetchLive(`${base}/wiki/pages/${correctionMemoryBody.id}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'x-dsh-memory-profile': 'standard' },
      body: JSON.stringify({ content: 'HTTP correction after' }),
    })
    expect(correctedMemory.status).toBe(200)
    const correctedResident = await fetchLive(`${base}/resident`, { headers: { 'x-dsh-memory-profile': 'standard' } })
    const correctedResidentBody = await correctedResident.json() as { resident: string }
    expect(correctedResidentBody.resident).toContain('HTTP correction after')
    expect(correctedResidentBody.resident).not.toContain('HTTP correction before')
    const deletedCorrectedMemory = await fetchLive(`${base}/memories/${correctionMemoryBody.id}`, {
      method: 'DELETE',
      headers: { 'x-dsh-memory-profile': 'standard' },
    })
    expect(deletedCorrectedMemory.status).toBe(200)

    const createdPage = await fetchLive(`${base}/wiki/pages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-dsh-memory-profile': 'standard' },
      body: JSON.stringify({ path: 'wiki/concepts/loader-edit.md', type: 'concept', title: 'Loader edit', description: 'before', content: 'before body' }),
    })
    expect(createdPage.status).toBe(201)
    const createdPageBody = await createdPage.json() as { id: string }
    const editedPage = await fetchLive(`${base}/wiki/pages/${createdPageBody.id}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'x-dsh-memory-profile': 'standard' },
      body: JSON.stringify({ description: 'after', body: 'after body [[简洁直接]]' }),
    })
    expect(editedPage.status).toBe(200)
    expect((await editedPage.json() as { body: string }).body).toContain('after body')
    const supersededPage = await fetchLive(`${base}/wiki/pages/${createdPageBody.id}/supersede`, {
      method: 'POST',
      headers: { 'x-dsh-memory-profile': 'standard' },
    })
    expect(supersededPage.status).toBe(200)
    const audits = await fetchLive(`${base}/audits`, { headers: { 'x-dsh-memory-profile': 'standard' } })
    expect((await audits.json() as { audits: Array<{ event: string }> }).audits.map(audit => audit.event)).toEqual(expect.arrayContaining(['page-corrected', 'page-superseded']))
    const deletedPage = await fetchLive(`${base}/wiki/pages/${createdPageBody.id}`, {
      method: 'DELETE',
      headers: { 'x-dsh-memory-profile': 'standard' },
    })
    expect(deletedPage.status).toBe(200)

    const sessions = await fetchLive(`${base}/sessions`, { headers: { 'x-dsh-memory-profile': 'standard' } })
    expect((await sessions.json() as { sessions: string[] }).sessions).toContain('memory-session')

    const evidenceGraph = await fetchLive(`${base}/wiki/graph?hop=1&evidence=1`, { headers: { 'x-dsh-memory-profile': 'standard' } })
    const aliasGraph = await fetchLive(`${base}/wiki/graph?hop=1&includeEvidence=1`, { headers: { 'x-dsh-memory-profile': 'standard' } })
    expect(evidenceGraph.status).toBe(200)
    expect(aliasGraph.status).toBe(200)
    expect(await aliasGraph.json()).toEqual(await evidenceGraph.json())

    const sensitiveMemory = await fetchLive(`${base}/memories`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-dsh-memory-profile': 'standard' },
      body: JSON.stringify({ content: 'sensitive-body-must-not-leak', sensitivity: 'sensitive' }),
    })
    expect(sensitiveMemory.status).toBe(201)
    const sensitiveMemoryBody = await sensitiveMemory.json() as { id: string }
    const provisionalMemory = await fetchLive(`${base}/memories`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-dsh-memory-profile': 'standard' },
      body: JSON.stringify({ content: 'provisional-body-must-not-leak', sensitivity: 'provisional_sensitive' }),
    })
    expect(provisionalMemory.status).toBe(201)
    const observationSession = context.sessions.create(SessionId('redaction-observation-session'), { meta: { agentPreset: 'standard' } })
    for (const text of ['private observation anchor one', 'private observation anchor two']) observationSession.append('user/message', createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }), { surfaceOp: 'append' })
    await fetchLive(`${base}/sessions`, { headers: { 'x-dsh-memory-profile': 'standard' } })
    const observationRefs = observationSession.snapshotEvents().filter(event => event.type === 'user/message').map(event => `session:redaction-observation-session/event:${String(event.seq)}`)
    const sensitiveObservation = await fetchLive(`${base}/observations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-dsh-memory-profile': 'standard' },
      body: JSON.stringify({ text: 'sensitive-observation-body-must-not-leak', sensitivity: 'sensitive', sourceRefs: observationRefs }),
    })
    expect(sensitiveObservation.status).toBe(201)
    for (const path of ['/wiki', '/candidates', '/observations']) {
      const response = await fetchLive(`${base}${path}`, { headers: { 'x-dsh-memory-profile': 'standard' } })
      expect(response.status).toBe(200)
      const body = await response.text()
      expect(body).not.toContain('sensitive-body-must-not-leak')
      expect(body).not.toContain('provisional-body-must-not-leak')
      expect(body).not.toContain('sensitive-observation-body-must-not-leak')
    }
    const search = await fetchLive(`${base}/wiki/search?q=sensitive-body-must-not-leak`, { headers: { 'x-dsh-memory-profile': 'standard' } })
    expect(search.status).toBe(200)
    const searchBody = await search.json() as { results: unknown[] }
    expect(JSON.stringify(searchBody.results)).not.toContain('sensitive-body-must-not-leak')
    const debugRecall = await fetchLive(`${base}/recall/debug`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-dsh-memory-profile': 'standard' },
      body: JSON.stringify({ query: '你还记得 sensitive-body-must-not-leak 吗？' }),
    })
    expect(debugRecall.status).toBe(200)
    const debugBody = await debugRecall.json() as { results: Array<Record<string, unknown>>; trace: { candidatesByChannel: Record<string, number>; fusedCandidates: number } }
    expect(JSON.stringify(debugBody)).not.toContain('sensitive-body-must-not-leak')
    expect(debugBody.results.every(result => !Object.hasOwn(result, 'text'))).toBe(true)
    expect(debugBody.trace.candidatesByChannel).toEqual(expect.any(Object))
    expect(debugBody.trace.fusedCandidates).toEqual(expect.any(Number))

    const redactedPage = await fetchLive(`${base}/wiki/pages/${sensitiveMemoryBody.id}`, { headers: { 'x-dsh-memory-profile': 'standard' } })
    expect(redactedPage.status).toBe(200)
    const redactedPageBody = await redactedPage.json() as { redacted: boolean; body?: string }
    expect(redactedPageBody.redacted).toBe(true)
    expect(redactedPageBody.body).toBeUndefined()
    const rejectedPageReveal = await fetchLive(`${base}/wiki/pages/${sensitiveMemoryBody.id}?reveal=sensitive`, { headers: { 'x-dsh-memory-profile': 'standard' } })
    expect(rejectedPageReveal.status).toBe(403)
    const revealedPage = await fetchLive(`${base}/wiki/pages/${sensitiveMemoryBody.id}?reveal=sensitive`, { headers: { authorization: 'Bearer owner-admin-token', 'x-dsh-memory-profile': 'standard' } })
    expect((await revealedPage.json() as { body: string }).body).toContain('sensitive-body-must-not-leak')
    const revealAudits = await fetchLive(`${base}/audits`, { headers: { 'x-dsh-memory-profile': 'standard' } })
    const auditRecords = (await revealAudits.json() as { audits: Array<{ event: string; detail?: { targetKind?: string } }> }).audits
    expect(auditRecords.map(audit => audit.event)).toContain('sensitive-content-revealed')

    const redactedSession = await fetchLive(`${base}/sessions/memory-session`, { headers: { 'x-dsh-memory-profile': 'standard' } })
    const redactedSessionBody = await redactedSession.json() as { redacted: boolean; evidence: unknown }
    expect(redactedSessionBody.redacted).toBe(true)
    expect(typeof redactedSessionBody.evidence).toBe('object')
    expect(JSON.stringify(redactedSessionBody)).not.toContain('简洁直接')
    const rejectedSessionReveal = await fetchLive(`${base}/sessions/memory-session?reveal=sensitive`, { headers: { 'x-dsh-memory-profile': 'standard' } })
    expect(rejectedSessionReveal.status).toBe(403)
    const revealedSession = await fetchLive(`${base}/sessions/memory-session?reveal=sensitive`, { headers: { authorization: 'Bearer owner-admin-token', 'x-dsh-memory-profile': 'standard' } })
    const revealedSessionBody = await revealedSession.json() as { redacted: boolean; evidence: string }
    expect(revealedSessionBody.redacted).toBe(false)
    expect(revealedSessionBody.evidence).toContain('简洁直接')
    const finalAudits = await fetchLive(`${base}/audits`, { headers: { 'x-dsh-memory-profile': 'standard' } })
    const finalAuditRecords = (await finalAudits.json() as { audits: Array<{ event: string; detail?: { targetKind?: string } }> }).audits
    expect(finalAuditRecords.filter(audit => audit.event === 'sensitive-content-reveal-rejected').map(audit => audit.detail?.targetKind)).toEqual(expect.arrayContaining(['wiki-page', 'session']))

    const purgeDryRun = await fetchLive(`${base}/purge`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-dsh-memory-profile': 'standard' },
      body: JSON.stringify({ sessionId: 'memory-session', dryRun: true }),
    })
    expect(purgeDryRun.status).toBe(200)
    expect((await purgeDryRun.json() as { dryRun: boolean; confirmation: string }).dryRun).toBe(true)
    expect((await fetchLive(`${base}/sessions`, { headers: { 'x-dsh-memory-profile': 'standard' } })).status).toBe(200)
    const missingPurgeConfirmation = await fetchLive(`${base}/purge`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-dsh-memory-profile': 'standard' },
      body: JSON.stringify({ sessionId: 'memory-session' }),
    })
    expect(missingPurgeConfirmation.status).toBe(400)

    const createGraphPage = async (path: string, title: string, content: string): Promise<string> => {
      const response = await fetchLive(`${base}/wiki/pages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-dsh-memory-profile': 'standard' },
        body: JSON.stringify({ path, type: 'concept', title, content }),
      })
      expect(response.status).toBe(201)
      return (await response.json() as { id: string }).id
    }
    const graphA = await createGraphPage('wiki/concepts/hop-a.md', 'Hop A', '[[Hop B]]')
    await createGraphPage('wiki/concepts/hop-b.md', 'Hop B', '[[Hop C]]')
    await createGraphPage('wiki/concepts/hop-c.md', 'Hop C', '[[Hop D]]')
    await createGraphPage('wiki/concepts/hop-d.md', 'Hop D', 'terminal')
    const boundedGraph = await fetchLive(`${base}/wiki/graph?root=${encodeURIComponent(graphA)}&hop=8`, { headers: { 'x-dsh-memory-profile': 'standard' } })
    const boundedGraphBody = await boundedGraph.json() as { nodes: Array<{ title: string }> }
    expect(boundedGraphBody.nodes.some(node => node.title === 'Hop D')).toBe(false)
  })

  it('requires the configured bearer token for a remotely bound server', { timeout: 60_000 }, async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-riko-memory-auth-'))
    const configPath = join(root, 'cordis.yml')
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
      "- name: '@deepseek-ai/cordis-plugin-timer'",
      "- name: '@deepseek-ai/dsh-host-webserver'",
      '  config:',
      "    host: '127.0.0.1'",
      '    port: 0',
      "- name: '@deepseek-ai/dsh-system-prompt'",
      "- name: '@deepseek-ai/dsh-session'",
      "- name: '@deepseek-ai/dsh-riko-memory'",
      '  config:',
      '    apiTokens:',
      '      alice: alice-token',
      '      bob: bob-token',
      '',
    ].join('\n'))
    const dependencies = {
      name: 'fixture-dependencies',
      apply(ctx: Context) {
        ctx.provide('agents', { list: () => [] } as never)
        ctx.provide('llm', { stream: async function* () {} } as never)
      },
    }
    context = new Context()
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
        if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
        return modules.get(specifier)
      },
    } as unknown as NonNullable<typeof context.loader.internal>
    await context.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
    await context.loader.await()
    await waitForWebServerPort()

    const url = `http://127.0.0.1:${String(context.webServer.port)}/memory/v1/resident`
    expect((await fetchLive(url)).status).toBe(401)
    expect((await fetchLive(url, { headers: { authorization: 'Bearer alice-token', 'x-dsh-memory-profile': 'alice' } })).status).toBe(200)
    expect((await fetchLive(url, { headers: { authorization: 'Bearer alice-token', 'x-dsh-memory-profile': 'bob' } })).status).toBe(401)
    expect((await fetchLive(url, { headers: { authorization: 'Bearer bob-token', 'x-dsh-memory-profile': 'alice' } })).status).toBe(401)
    expect((await fetchLive(url, { headers: { authorization: 'Bearer bob-token', 'x-dsh-memory-profile': 'bob' } })).status).toBe(200)
    context.sessions.create(SessionId('alice-session'), { meta: { agentPreset: 'alice' } })
    context.sessions.create(SessionId('bob-session'), { meta: { agentPreset: 'bob' } })
    const dreamUrl = `http://127.0.0.1:${String(context.webServer.port)}/memory/v1/dream`
    const crossProfileDream = await fetchLive(dreamUrl, {
      method: 'POST',
      headers: { authorization: 'Bearer alice-token', 'content-type': 'application/json', 'x-dsh-memory-profile': 'alice' },
      body: JSON.stringify({ sessionId: 'bob-session' }),
    })
    expect(crossProfileDream.status).toBe(403)
    expect((await fetchLive(dreamUrl, {
      method: 'POST',
      headers: { authorization: 'Bearer alice-token', 'content-type': 'application/json', 'x-dsh-memory-profile': 'alice' },
      body: '{}',
    })).status).toBe(202)

    const aliceAllSession = context.sessions.create(SessionId('alice-all-session'), { meta: { agentPreset: 'alice' } })
    aliceAllSession.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'alice scoped dream' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
    const bobAllSession = context.sessions.create(SessionId('bob-all-session'), { meta: { agentPreset: 'bob' } })
    bobAllSession.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'bob scoped dream' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
    const scopedDream = await fetchLive(dreamUrl, {
      method: 'POST',
      headers: { authorization: 'Bearer alice-token', 'content-type': 'application/json', 'x-dsh-memory-profile': 'alice' },
      body: '{}',
    })
    expect(scopedDream.status).toBe(202)
    await fetchLive(`http://127.0.0.1:${String(context.webServer.port)}/memory/v1/wiki`, { headers: { authorization: 'Bearer alice-token', 'x-dsh-memory-profile': 'alice' } })
    await fetchLive(`http://127.0.0.1:${String(context.webServer.port)}/memory/v1/wiki`, { headers: { authorization: 'Bearer bob-token', 'x-dsh-memory-profile': 'bob' } })
    const aliceAudits = await fetchLive(`http://127.0.0.1:${String(context.webServer.port)}/memory/v1/audits`, { headers: { authorization: 'Bearer alice-token', 'x-dsh-memory-profile': 'alice' } })
    const bobAudits = await fetchLive(`http://127.0.0.1:${String(context.webServer.port)}/memory/v1/audits`, { headers: { authorization: 'Bearer bob-token', 'x-dsh-memory-profile': 'bob' } })
    expect((await aliceAudits.json() as { audits: Array<{ event: string }> }).audits.map(audit => audit.event)).toContain('dream-failed')
    expect((await bobAudits.json() as { audits: Array<{ event: string }> }).audits.map(audit => audit.event)).not.toContain('dream-failed')
  })

  it('binds a single bearer token to its configured profile', { timeout: 60_000 }, async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-riko-memory-single-token-'))
    const configPath = join(root, 'cordis.yml')
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
      "- name: '@deepseek-ai/cordis-plugin-timer'",
      "- name: '@deepseek-ai/dsh-host-webserver'",
      '  config:',
      "    host: '127.0.0.1'",
      '    port: 0',
      "- name: '@deepseek-ai/dsh-system-prompt'",
      "- name: '@deepseek-ai/dsh-session'",
      "- name: '@deepseek-ai/dsh-riko-memory'",
      '  config:',
      '    apiToken: single-token',
      '    apiTokenProfile: alice',
      '',
    ].join('\n'))
    const dependencies = {
      name: 'fixture-dependencies',
      apply(ctx: Context) {
        ctx.provide('agents', { list: () => [] } as never)
        ctx.provide('llm', { stream: async function* () {} } as never)
      },
    }
    context = new Context()
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
        if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
        return modules.get(specifier)
      },
    } as unknown as NonNullable<typeof context.loader.internal>
    await context.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
    await context.loader.await()
    await waitForWebServerPort()

    const url = `http://127.0.0.1:${String(context.webServer.port)}/memory/v1/resident`
    expect((await fetchLive(url, { headers: { authorization: 'Bearer single-token', 'x-dsh-memory-profile': 'alice' } })).status).toBe(200)
    expect((await fetchLive(url, { headers: { authorization: 'Bearer single-token', 'x-dsh-memory-profile': 'bob' } })).status).toBe(401)
    const config = await fetchLive(`http://127.0.0.1:${String(context.webServer.port)}/memory/v1/config`, { headers: { authorization: 'Bearer single-token', 'x-dsh-memory-profile': 'alice' } })
    expect(await config.json() as { scopeBinding: string; apiTokenProfile?: string; ownerAdminConfigured?: boolean }).toMatchObject({ scopeBinding: 'profile', apiTokenProfile: 'alice', ownerAdminConfigured: false })
  })
})
