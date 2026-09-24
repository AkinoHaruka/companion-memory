/* oxlint-disable @stylistic/max-len */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
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
import { fetchLive } from './support/live-http.ts'

let context: Context | undefined
let root: string | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

async function loadMemoryFixture(): Promise<string> {
  root = await mkdtemp(join(tmpdir(), 'dsh-riko-memory-alias-recall-'))
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
    '    debounceMs: 60000',
    '    dreamIntervalMs: 3600000',
    '    recallEnabled: true',
    '',
  ].join('\n'))
  const dependencies = {
    name: 'fixture-dependencies',
    apply(fixtureContext: Context) {
      fixtureContext.provide('agents', { list: () => [] } as never)
      fixtureContext.provide('llm', { stream: async function* () {} } as never)
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
  return `http://127.0.0.1:${String(context.webServer.port)}/memory/v1`
}

function headers(profile: string): HeadersInit { return { authorization: 'Bearer owner-admin-token', 'x-dsh-memory-profile': profile } }

function pageMarkdown(input: { readonly path: string; readonly title: string; readonly description: string; readonly body: string; readonly tags?: readonly string[]; readonly sensitivity?: 'sensitive' }): string {
  return [
    '---',
    'type: entity',
    `title: ${input.title}`,
    `description: ${input.description}`,
    'sources:',
    '  - management',
    'tags:',
    ...(input.tags ?? []).map(tag => `  - ${tag}`),
    'timestamp: 2026-09-19T00:00:00.000Z',
    'confidence: 1',
    ...(input.sensitivity === undefined ? [] : [`sensitivity: ${input.sensitivity}`]),
    'status: confirmed',
    'consent: true',
    'locked: true',
    '---',
    input.body,
  ].join('\n')
}

async function postPage(base: string, profile: string, input: Parameters<typeof pageMarkdown>[0]): Promise<{ readonly id: string }> {
  const response = await fetchLive(`${base}/wiki/pages`, { method: 'POST', headers: { ...headers(profile), 'content-type': 'application/json' }, body: JSON.stringify({ path: input.path, markdown: pageMarkdown(input) }) })
  expect(response.status).toBe(201)
  return await response.json() as { readonly id: string }
}

async function recordAlias(base: string, profile: string, sessionId: string, text: string): Promise<void> {
  if (!context) throw new Error('fixture context is unavailable')
  const session = context.sessions.create(SessionId(sessionId), { meta: { agentPreset: profile } })
  session.append('user/message', createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }), { surfaceOp: 'append' })
  const response = await fetchLive(`${base}/sessions`, { headers: headers(profile) })
  expect(response.status).toBe(200)
}

async function recall(base: string, profile: string, query: string): Promise<{ readonly results: Array<{ readonly id: string; readonly channels: string[] }>; readonly trace: { readonly candidatesByChannel: Record<string, number>; readonly gateDecisions: Array<{ readonly id: string; readonly channels: string[] }> } }> {
  const response = await fetchLive(`${base}/recall/debug`, { method: 'POST', headers: { ...headers(profile), 'content-type': 'application/json' }, body: JSON.stringify({ query }) })
  expect(response.status).toBe(200)
  return await response.json() as Awaited<ReturnType<typeof recall>>
}

async function renderedRecall(base: string, profile: string, query: string): Promise<{ readonly context: string }> {
  const response = await fetchLive(`${base}/recall`, { method: 'POST', headers: { ...headers(profile), 'content-type': 'application/json' }, body: JSON.stringify({ query }) })
  expect(response.status).toBe(200)
  return await response.json() as { readonly context: string }
}

describe('alias recall through the real Loader', () => {
  it('adds an active alias target through the entity channel', async () => {
    const base = await loadMemoryFixture()
    const page = await postPage(base, 'standard', { path: 'wiki/entities/canonical-alice.md', title: 'Canonical Alice', description: 'canonical page only', body: 'canonical page only' })
    await recordAlias(base, 'standard', 'alias-active', '小爱 Canonical Alice')

    const result = await recall(base, 'standard', '你还记得小爱吗？')
    expect(result.results.map(item => item.id)).toContain(`page:${page.id}`)
    expect(result.results.find(item => item.id === `page:${page.id}`)?.channels).toContain('entity')
    expect(result.trace.candidatesByChannel.entity).toBe(1)
    expect(result.trace.gateDecisions.find(item => item.id === `page:${page.id}`)?.channels).toContain('entity')
  })

  it('uses the new target after alias reassignment', async () => {
    const base = await loadMemoryFixture()
    const oldPage = await postPage(base, 'standard', { path: 'wiki/entities/old-target.md', title: 'Old Target', description: 'old canonical value', body: 'old canonical value' })
    const newPage = await postPage(base, 'standard', { path: 'wiki/entities/new-target.md', title: 'New Target', description: 'new canonical value', body: 'new canonical value' })
    await recordAlias(base, 'standard', 'alias-old', 'boss Old Target')
    await recordAlias(base, 'standard', 'alias-new', 'boss New Target')

    const result = await recall(base, 'standard', '你还记得 boss 吗？')
    expect(result.results.map(item => item.id)).toContain(`page:${newPage.id}`)
    expect(result.results.map(item => item.id)).not.toContain(`page:${oldPage.id}`)
  })

  it('does not expand inactive or contested aliases', async () => {
    const base = await loadMemoryFixture()
    const inactivePage = await postPage(base, 'standard', { path: 'wiki/entities/inactive-target.md', title: 'Inactive Target', description: 'inactive canonical value', body: 'inactive canonical value' })
    await recordAlias(base, 'standard', 'alias-inactive', '弃用 Inactive Target')
    const deleted = await fetchLive(`${base}/wiki/pages/${inactivePage.id}`, { method: 'DELETE', headers: headers('standard') })
    expect(deleted.status).toBe(200)
    const inactiveSnapshot = await fetchLive(`${base}/wiki`, { headers: headers('standard') })
    expect((await inactiveSnapshot.json() as { readonly aliases: Array<{ readonly normalizedAlias: string; readonly status?: string }> }).aliases.find(alias => alias.normalizedAlias === '弃用')).toMatchObject({ status: 'invalidated' })

    const contestedPage = await postPage(base, 'standard', { path: 'wiki/entities/contested-target.md', title: 'Contested Target', description: 'contested canonical value', body: 'contested canonical value', tags: ['争议代号'] })
    const result = await recall(base, 'standard', '你还记得争议代号吗？')
    expect(result.results.some(item => item.id === `page:${contestedPage.id}`)).toBe(false)
    expect(result.trace.candidatesByChannel.entity).toBeUndefined()
    const inactiveResult = await recall(base, 'standard', '你还记得弃用吗？')
    expect(inactiveResult.results.some(item => item.id === `page:${inactivePage.id}`)).toBe(false)
    expect(inactiveResult.trace.candidatesByChannel.entity).toBeUndefined()
  })

  it('withholds a sensitive page reached only through an alias', async () => {
    const base = await loadMemoryFixture()
    await postPage(base, 'standard', { path: 'wiki/entities/sensitive-target.md', title: 'Sensitive Target', description: 'private canonical detail', body: 'private canonical detail', sensitivity: 'sensitive' })
    await recordAlias(base, 'standard', 'alias-sensitive', '暗号 Sensitive Target')

    const result = await recall(base, 'standard', '你还记得暗号吗？')
    expect(result.results.some(item => item.id.startsWith('page:'))).toBe(false)
    expect((await renderedRecall(base, 'standard', '你还记得暗号吗？')).context).not.toContain('private canonical detail')
  })

  it('keeps alias expansion isolated to its profile scope', async () => {
    const base = await loadMemoryFixture()
    const otherPage = await postPage(base, 'other', { path: 'wiki/entities/other-target.md', title: 'Other Target', description: 'other scope canonical value', body: 'other scope canonical value' })
    await recordAlias(base, 'other', 'alias-other', '别名 Other Target')

    const otherResult = await recall(base, 'other', '你还记得别名吗？')
    const standardResult = await recall(base, 'standard', '你还记得别名吗？')
    expect(otherResult.results.map(item => item.id)).toContain(`page:${otherPage.id}`)
    expect(otherResult.trace.candidatesByChannel.entity).toBe(1)
    expect(standardResult.results).toEqual([])
  })
})
