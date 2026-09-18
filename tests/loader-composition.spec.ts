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
import type { Agent } from '@deepseek-ai/dsh-agent'
import RikoMemoryService from '../src/index.ts'

let context: Context | undefined
let root: string | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

describe('real Loader composition', () => {
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
      const pending = nativeFetch(`${base}/dream`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-dsh-memory-profile': 'standard' },
        body: JSON.stringify({ sessionId: 'mimo-session' }),
      })
      const early = await Promise.race([pending, new Promise<undefined>(resolve => setTimeout(resolve, 150))])
      expect(early?.status).toBe(202)
      await vi.waitFor(() => expect(providerFetch).toHaveBeenCalledTimes(1))
      const [, request] = providerFetch.mock.calls[0]!
      expect(request?.headers).toMatchObject({ 'api-key': 'fixture-secret', 'anthropic-version': '2023-06-01' })
      resolveProvider?.(new Response(JSON.stringify({ content: [{ type: 'text', text: '<<<FILE path="wiki/concepts/name.md">>>\n---\ntype: concept\ntitle: 称呼\ndescription: 用户希望被称呼为 Riko\nsources:\n  - forged-session\ntimestamp: 2026-09-18T00:00:00.000Z\nconfidence: 0.9\nstatus: confirmed\nconsent: true\nlocked: true\n---\n\n用户希望被称呼为 Riko。\n<<<END>>>' }] }), { headers: { 'content-type': 'application/json' } }))
      expect((await pending).status).toBe(202)
      await vi.waitFor(async () => {
        const candidates = await nativeFetch(`${base}/candidates`, { headers: { 'x-dsh-memory-profile': 'standard' } })
        expect((await candidates.json() as { candidates: Array<{ page: { sources: string[]; status: string; consent: boolean } }> }).candidates).toEqual([expect.objectContaining({ page: expect.objectContaining({ sources: ['mimo-session'], status: 'candidate', consent: false }) })])
      })
    } finally {
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
      '    debounceMs: 0',
      '    dreamIntervalMs: 3600000',
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

    const session = context.sessions.create(SessionId('memory-session'), { meta: { agentPreset: 'standard' } })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: '请记住：我喜欢简洁直接的回答。' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    await new Promise(resolve => setTimeout(resolve, 30))
    const port = context.webServer.port
    const base = `http://127.0.0.1:${String(port)}/memory/v1`
    const ui = await fetch(`${base}/ui`, { headers: { 'x-dsh-memory-profile': 'standard' } })
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
    const config = await fetch(`${base}/config`, { headers: { 'x-dsh-memory-profile': 'standard' } })
    expect(config.status).toBe(200)
    expect((await config.json() as { profileId: string }).profileId).toBe('standard')
    const rejectedSecretWrite = await fetch(`${base}/config`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-dsh-memory-profile': 'standard' },
      body: JSON.stringify({ apiKey: 'must-not-be-persisted' }),
    })
    expect(rejectedSecretWrite.status).toBe(400)
    expect(await rejectedSecretWrite.text()).not.toContain('must-not-be-persisted')
    const automaticWiki = await fetch(`${base}/wiki`, { headers: { 'x-dsh-memory-profile': 'standard' } })
    expect((await automaticWiki.json() as { records: Array<{ content: string }> }).records).toHaveLength(0)
    const agent = { id: session.id, session, ctx: context } as unknown as Agent
    context.emit('agent/created', { agent, source: 'startup' })
    const prompt = await context.systemPrompt.assemble()
    expect(prompt.contexts.some(contextEntry => contextEntry.name === 'riko-memory')).toBe(true)
    const dream = await fetch(`${base}/dream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-dsh-memory-profile': 'standard' },
      body: JSON.stringify({ sessionId: 'memory-session' }),
    })
    expect(dream.status).toBe(202)

    const wiki = await fetch(`${base}/wiki`, { headers: { 'x-dsh-memory-profile': 'standard' } })
    expect(wiki.status).toBe(200)
    const wikiBody = await wiki.json() as { records: Array<{ content: string }> }
    expect(wikiBody.records).toHaveLength(0)
    const resident = await fetch(`${base}/resident`, { headers: { 'x-dsh-memory-profile': 'standard' } })
    expect(await resident.text()).toContain('"resident":""')

    for (const name of ['memory_get_resident', 'memory_remember', 'memory_correct', 'memory_forget']) expect(context.tools.get(name, agent)).toBeDefined()
    const remember = await context.tools.execute({ signal: new AbortController().signal, callId: ToolCallId('memory-remember'), name: 'memory_remember', arguments: { content: '我喜欢简洁直接的回答。' }, agent })
    expect(remember.isError).toBe(false)
    const rememberedId = (remember.value as { id: string }).id
    await expect((await fetch(`${base}/resident`, { headers: { 'x-dsh-memory-profile': 'standard' } })).text()).resolves.toContain('我喜欢简洁直接的回答。')
    session.append('user/message', createUserMessage({ content: [{ type: 'text', text: '请更正为：我喜欢回答简明扼要。' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
    const correct = await context.tools.execute({ signal: new AbortController().signal, callId: ToolCallId('memory-correct'), name: 'memory_correct', arguments: { id: rememberedId, content: '我喜欢回答简明扼要。' }, agent })
    expect(correct.isError).toBe(false)
    await expect((await fetch(`${base}/resident`, { headers: { 'x-dsh-memory-profile': 'standard' } })).text()).resolves.toContain('我喜欢回答简明扼要。')
    session.append('user/message', createUserMessage({ content: [{ type: 'text', text: `请忘记记忆 ${rememberedId}` }], source: { kind: 'user' } }), { surfaceOp: 'append' })
    const forget = await context.tools.execute({ signal: new AbortController().signal, callId: ToolCallId('memory-forget'), name: 'memory_forget', arguments: { id: rememberedId }, agent })
    expect(forget.isError, JSON.stringify(forget)).toBe(false)
    await expect((await fetch(`${base}/resident`, { headers: { 'x-dsh-memory-profile': 'standard' } })).text()).resolves.toContain('"resident":""')

    const manual = await fetch(`${base}/memories`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-dsh-memory-profile': 'standard' },
      body: JSON.stringify({ content: '用户希望被称呼为 Riko' }),
    })
    expect(manual.status).toBe(201)
    const manualBody = await manual.json() as { id: string }
    const deleted = await fetch(`${base}/memories/${manualBody.id}`, {
      method: 'DELETE',
      headers: { 'x-dsh-memory-profile': 'standard' },
    })
    expect(deleted.status).toBe(200)

    const correctionMemory = await fetch(`${base}/memories`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-dsh-memory-profile': 'standard' },
      body: JSON.stringify({ content: 'HTTP correction before' }),
    })
    expect(correctionMemory.status).toBe(201)
    const correctionMemoryBody = await correctionMemory.json() as { id: string }
    const correctedMemory = await fetch(`${base}/wiki/pages/${correctionMemoryBody.id}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'x-dsh-memory-profile': 'standard' },
      body: JSON.stringify({ content: 'HTTP correction after' }),
    })
    expect(correctedMemory.status).toBe(200)
    const correctedResident = await fetch(`${base}/resident`, { headers: { 'x-dsh-memory-profile': 'standard' } })
    const correctedResidentBody = await correctedResident.json() as { resident: string }
    expect(correctedResidentBody.resident).toContain('HTTP correction after')
    expect(correctedResidentBody.resident).not.toContain('HTTP correction before')
    const deletedCorrectedMemory = await fetch(`${base}/memories/${correctionMemoryBody.id}`, {
      method: 'DELETE',
      headers: { 'x-dsh-memory-profile': 'standard' },
    })
    expect(deletedCorrectedMemory.status).toBe(200)

    const createdPage = await fetch(`${base}/wiki/pages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-dsh-memory-profile': 'standard' },
      body: JSON.stringify({ path: 'wiki/concepts/loader-edit.md', type: 'concept', title: 'Loader edit', description: 'before', content: 'before body' }),
    })
    expect(createdPage.status).toBe(201)
    const createdPageBody = await createdPage.json() as { id: string }
    const editedPage = await fetch(`${base}/wiki/pages/${createdPageBody.id}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'x-dsh-memory-profile': 'standard' },
      body: JSON.stringify({ description: 'after', body: 'after body [[简洁直接]]' }),
    })
    expect(editedPage.status).toBe(200)
    expect((await editedPage.json() as { body: string }).body).toContain('after body')
    const supersededPage = await fetch(`${base}/wiki/pages/${createdPageBody.id}/supersede`, {
      method: 'POST',
      headers: { 'x-dsh-memory-profile': 'standard' },
    })
    expect(supersededPage.status).toBe(200)
    const audits = await fetch(`${base}/audits`, { headers: { 'x-dsh-memory-profile': 'standard' } })
    expect((await audits.json() as { audits: Array<{ event: string }> }).audits.map(audit => audit.event)).toEqual(expect.arrayContaining(['page-corrected', 'page-superseded']))
    const deletedPage = await fetch(`${base}/wiki/pages/${createdPageBody.id}`, {
      method: 'DELETE',
      headers: { 'x-dsh-memory-profile': 'standard' },
    })
    expect(deletedPage.status).toBe(200)

    const sessions = await fetch(`${base}/sessions`, { headers: { 'x-dsh-memory-profile': 'standard' } })
    expect((await sessions.json() as { sessions: string[] }).sessions).toContain('memory-session')

    const evidenceGraph = await fetch(`${base}/wiki/graph?hop=1&evidence=1`, { headers: { 'x-dsh-memory-profile': 'standard' } })
    const aliasGraph = await fetch(`${base}/wiki/graph?hop=1&includeEvidence=1`, { headers: { 'x-dsh-memory-profile': 'standard' } })
    expect(evidenceGraph.status).toBe(200)
    expect(aliasGraph.status).toBe(200)
    expect(await aliasGraph.json()).toEqual(await evidenceGraph.json())
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
      "    host: '0.0.0.0'",
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

    const url = `http://127.0.0.1:${String(context.webServer.port)}/memory/v1/resident`
    expect((await fetch(url)).status).toBe(401)
    expect((await fetch(url, { headers: { authorization: 'Bearer alice-token', 'x-dsh-memory-profile': 'alice' } })).status).toBe(200)
    expect((await fetch(url, { headers: { authorization: 'Bearer alice-token', 'x-dsh-memory-profile': 'bob' } })).status).toBe(401)
    expect((await fetch(url, { headers: { authorization: 'Bearer bob-token', 'x-dsh-memory-profile': 'alice' } })).status).toBe(401)
    expect((await fetch(url, { headers: { authorization: 'Bearer bob-token', 'x-dsh-memory-profile': 'bob' } })).status).toBe(200)
    context.sessions.create(SessionId('alice-session'), { meta: { agentPreset: 'alice' } })
    context.sessions.create(SessionId('bob-session'), { meta: { agentPreset: 'bob' } })
    const dreamUrl = `http://127.0.0.1:${String(context.webServer.port)}/memory/v1/dream`
    const crossProfileDream = await fetch(dreamUrl, {
      method: 'POST',
      headers: { authorization: 'Bearer alice-token', 'content-type': 'application/json', 'x-dsh-memory-profile': 'alice' },
      body: JSON.stringify({ sessionId: 'bob-session' }),
    })
    expect(crossProfileDream.status).toBe(403)
    expect((await fetch(dreamUrl, {
      method: 'POST',
      headers: { authorization: 'Bearer alice-token', 'content-type': 'application/json', 'x-dsh-memory-profile': 'alice' },
      body: '{}',
    })).status).toBe(202)
  })
})
