import { fetchLive } from './support/live-http.ts'
import { drainInFlight } from './support/live-harness.ts'
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
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import RikoMemoryService from '../src/index.ts'

let contexts: Context[] = []
let root: string | undefined
let originalFetch: typeof fetch | undefined

afterEach(async () => {
  globalThis.fetch = originalFetch ?? globalThis.fetch
  await Promise.all(contexts.map(context => context.fiber.dispose()))
  contexts = []
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

describe('Dream restart recovery', () => {
  it('replays a failed scoped Dream after host restart while retaining the last valid Resident', { timeout: 60_000 }, async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-riko-memory-recovery-'))
    await writeFile(join(root, 'credentials.yaml'), 'version: 1\nrefs:\n  DSH_MEMORY_DREAM_API_KEY: fixture-secret\n')
    const nativeFetch = globalThis.fetch
    originalFetch = nativeFetch
    let phase: 'fail' | 'recover' = 'fail'
    const providerFetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) !== 'https://api.xiaomimimo.com/anthropic/v1/messages') return nativeFetch(input, init)
      if (phase === 'fail') return Promise.resolve(new Response(JSON.stringify({ error: 'rate limited' }), { status: 429, headers: { 'content-type': 'application/json' } }))
      return Promise.resolve(new Response(JSON.stringify({ content: [{ type: 'text', text: '<<<FILE path="wiki/concepts/communication.md">>>\n---\ntype: concept\ntitle: 回答偏好\ndescription: 用户喜欢简洁回答\nsources:\n  - untrusted-model-id\ntimestamp: 2026-09-18T00:00:00.000Z\nconfidence: 0.9\nstatus: confirmed\nconsent: true\nlocked: true\n---\n\n用户喜欢简洁回答。\n<<<END>>>' }] }), { headers: { 'content-type': 'application/json' } }))
    })
    globalThis.fetch = providerFetch as typeof fetch

    const first = await boot(root)
    const firstBase = baseUrl(first)
    const session = first.sessions.create(SessionId('restart-session'), { meta: { agentPreset: 'standard' } })
    session.append('user/message', createUserMessage({ content: [{ type: 'text', text: '请记住：我喜欢简洁回答。' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
    expect((await fetchLive(`${firstBase}/memories`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-dsh-memory-profile': 'standard' }, body: JSON.stringify({ content: '已经确认的长期偏好。' }) })).status).toBe(201)
    expect((await fetchLive(`${firstBase}/dream`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-dsh-memory-profile': 'standard' }, body: JSON.stringify({ sessionId: 'restart-session' }) })).status).toBe(202)
    // The manual Dream joins the service's in-flight set as its route accepts it, and `/sessions` is
    // that set's own drain, so this is the Dream's readiness signal rather than a retry. The residual
    // wait covers the write-behind window plus one round trip, and carries the same 15 s the sibling
    // live suites give an eventual read: its 1000 ms default expires while the first poll is still in
    // flight once forks contend, which is what made a loaded round fail here.
    await drainInFlight(firstBase)
    await vi.waitFor(async () => {
      const wiki = await fetchLive(`${firstBase}/wiki`, { headers: { 'x-dsh-memory-profile': 'standard' } })
      expect((await wiki.json() as { lastError?: string }).lastError).toContain('http-429')
    }, { timeout: 15_000, interval: 50 })
    expect(await (await fetchLive(`${firstBase}/resident`, { headers: { 'x-dsh-memory-profile': 'standard' } })).text()).toContain('已经确认的长期偏好。')

    await first.fiber.dispose()
    contexts = contexts.filter(context => context !== first)
    phase = 'recover'
    const restarted = await boot(root)
    const restartedBase = baseUrl(restarted)
    expect(restarted.sessions.list()).toEqual([])
    // Startup recovery replays the persisted Dream through the same in-flight set before the fixture
    // answers HTTP, so the drain covers the replay this call count is asserting on.
    await drainInFlight(restartedBase)
    await vi.waitFor(() => expect(providerFetch).toHaveBeenCalledTimes(3), { timeout: 15_000, interval: 50 })
    await vi.waitFor(async () => {
      const candidates = await fetchLive(`${restartedBase}/candidates`, { headers: { 'x-dsh-memory-profile': 'standard' } })
      expect((await candidates.json() as { candidates: Array<{ page: { sources: string[]; status: string; consent: boolean } }> }).candidates).toEqual([expect.objectContaining({ page: expect.objectContaining({ sources: ['restart-session'], status: 'candidate', consent: false }) })])
    }, { timeout: 15_000, interval: 50 })
    expect(await (await fetchLive(`${restartedBase}/resident`, { headers: { 'x-dsh-memory-profile': 'standard' } })).text()).toContain('已经确认的长期偏好。')
  })
})

function baseUrl(context: Context): string { return `http://127.0.0.1:${String(context.webServer.port)}/memory/v1` }

async function boot(rootDir: string): Promise<Context> {
  const configPath = join(rootDir, `fixture-${contexts.length}.yml`)
  await writeFile(configPath, [
    '- name: fixture-dependencies',
    '- name: "@deepseek-ai/dsh-storage"',
    '- name: "@deepseek-ai/dsh-storage-json"',
    '  config:',
    `    root: '${join(rootDir, 'storages').replaceAll('\\', '/')}'`,
    '- name: "@deepseek-ai/dsh-storage-domain"',
    '  config:',
    '    backend: json',
    '- name: "@deepseek-ai/dsh-credentials-local"',
    '  config:',
    `    path: '${join(rootDir, 'credentials.yaml').replaceAll('\\', '/')}'`,
    `    dshHome: '${rootDir.replaceAll('\\', '/')}'`,
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
    '    debounceMs: 60000',
    '    dreamIntervalMs: 3600000',
    '    dreamApiUrl: https://api.xiaomimimo.com/anthropic',
    '    dreamCredentialRef: DSH_MEMORY_DREAM_API_KEY',
    '    dreamModel: mimo-v2.5',
    '',
  ].join('\n'))
  const dependencies = { name: 'fixture-dependencies', apply(ctx: Context) { ctx.provide('agents', { list: () => [] } as never); ctx.provide('llm', { stream: async function* () {} } as never) } }
  const context = new Context()
  context.baseUrl = pathToFileURL(rootDir).href + '/'
  await context.plugin(Loader)
  context.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['fixture-dependencies', dependencies], ['@deepseek-ai/cordis-plugin-timer', Timer], ['@deepseek-ai/dsh-host-webserver', WebServer], ['@deepseek-ai/dsh-system-prompt', SystemPrompt], ['@deepseek-ai/dsh-session', SessionStore], ['@deepseek-ai/dsh-tools', ToolRuntime], ['@deepseek-ai/dsh-session-projection', SessionProjection], ['@deepseek-ai/dsh-agent-presets', AgentPresets], ['@deepseek-ai/dsh-storage', Storage], ['@deepseek-ai/dsh-storage-json', StorageJson], ['@deepseek-ai/dsh-storage-domain', StorageDomain], ['@deepseek-ai/dsh-credentials-local', CredentialsLocal], ['@deepseek-ai/dsh-riko-memory', RikoMemoryService],
  ])
  context.loader.internal = { version: 'v2', async import(specifier: string) { if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`); return modules.get(specifier) } } as unknown as NonNullable<typeof context.loader.internal>
  await context.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await context.loader.await()
  contexts.push(context)
  return context
}
