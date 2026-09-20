import { mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { fetchLive } from './support/live-http.ts'
import { drainInFlight, startLiveHarness, type LiveHarness } from './support/live-harness.ts'

interface RecallDebugBody {
  readonly results: readonly Record<string, unknown>[]
  readonly trace: { readonly degradedModes: readonly string[] }
}

async function postMemory(harness: LiveHarness, content: string): Promise<{ readonly status: number; readonly id?: string }> {
  const response = await fetchLive(`${harness.base}/memories`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-dsh-memory-profile': 'standard' },
    body: JSON.stringify({ content }),
  })
  const body = await response.json() as { readonly id?: string }
  return { status: response.status, ...(body.id === undefined ? {} : { id: body.id }) }
}

async function readResident(harness: LiveHarness): Promise<string> {
  const response = await fetchLive(`${harness.base}/resident`, { headers: { 'x-dsh-memory-profile': 'standard' } })
  expect(response.status).toBe(200)
  return response.text()
}

async function recallDebug(
  harness: LiveHarness,
  query: string,
): Promise<{ readonly status: number; readonly body: RecallDebugBody }> {
  const response = await fetchLive(`${harness.base}/recall/debug`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-dsh-memory-profile': 'standard' },
    body: JSON.stringify({ query }),
  })
  return { status: response.status, body: await response.json() as RecallDebugBody }
}

async function blockTableDirectory(root: string, table: string): Promise<() => Promise<void>> {
  const directory = join(root, 'storages', 'riko_memory', table)
  const backup = `${directory}.degradation-backup`
  await rename(directory, backup)
  await writeFile(directory, 'storage table is blocked by the fixture\n', 'utf8')
  return async () => {
    await rm(directory, { force: true })
    await rename(backup, directory)
  }
}

describe('real JSON storage degradation', () => {
  it('rejects a canonical write at the JSON record boundary without a fallback store', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-riko-memory-degradation-write-'))
    let first: LiveHarness | undefined
    let second: LiveHarness | undefined
    let third: LiveHarness | undefined
    try {
      const baseline = 'durable storage baseline'
      const failed = 'must not be stored after write failure'
      first = await startLiveHarness([], root)
      const created = await postMemory(first, baseline)
      expect(created.status).toBe(201)
      expect(created.id).toEqual(expect.any(String))
      expect(await readResident(first)).toContain(baseline)
      await first.dispose()
      first = undefined

      second = await startLiveHarness([], root)
      expect(await readResident(second)).toContain(baseline)
      const restorePages = await blockTableDirectory(root, 'pages')
      try {
        expect((await postMemory(second, failed)).status).toBe(500)
      } finally {
        await restorePages()
      }
      await second.dispose()
      second = undefined

      third = await startLiveHarness([], root)
      const residentAfterFailure = await readResident(third)
      expect(residentAfterFailure).toContain(baseline)
      expect(residentAfterFailure).not.toContain(failed)
      const wiki = await fetchLive(`${third.base}/wiki`, { headers: { 'x-dsh-memory-profile': 'standard' } })
      expect(wiki.status).toBe(200)
      expect(await wiki.text()).not.toContain(failed)
    } finally {
      await third?.dispose()
      await second?.dispose()
      await first?.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('keeps recall available when the JSON activation write fails and recovers after the table is restored', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-riko-memory-degradation-activation-'))
    let harness: LiveHarness | undefined
    try {
      const target = 'activation failure recall target'
      harness = await startLiveHarness(['    recallEnabled: true'], root)
      const created = await postMemory(harness, target)
      expect(created.status).toBe(201)
      expect(created.id).toEqual(expect.any(String))
      const normal = await recallDebug(harness, `你还记得之前的 ${target} 吗？`)
      expect(normal.status).toBe(200)
      expect(normal.body.results).toEqual(expect.arrayContaining([expect.objectContaining({ id: `page:${created.id}` })]))

      const restoreActivation = await blockTableDirectory(root, 'activation')
      try {
        const degraded = await recallDebug(harness, `你还记得之前的 ${target} 吗？`)
        expect(degraded.status).toBe(200)
        expect(degraded.body.results).toEqual(expect.arrayContaining([expect.objectContaining({ id: `page:${created.id}` })]))
        const trace = degraded.body.trace
        expect(trace.degradedModes).toContain('activation-degraded')
      } finally {
        await restoreActivation()
      }

      const recovered = await recallDebug(harness, `你还记得之前的 ${target} 吗？`)
      expect(recovered.status).toBe(200)
      expect(recovered.body.results).toEqual(expect.arrayContaining([expect.objectContaining({ id: `page:${created.id}` })]))
      const recoveredTrace = recovered.body.trace
      expect(recoveredTrace.degradedModes).not.toContain('activation-degraded')
    } finally {
      await harness?.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('keeps the last Resident when Dream ingest loses its durable pages write', { timeout: 60_000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-riko-memory-degradation-dream-'))
    const nativeFetch = globalThis.fetch
    const dreamEndpoint = 'https://api.test/api/v1/chat/completions'
    const failedText = 'dream page must not survive a failed ingest write'
    const baseline = 'dream durable baseline'
    const recovered = 'dream durable recovery'
    let harness: LiveHarness | undefined
    let restorePages: (() => Promise<void>) | undefined
    let resolveProviderEntered: (() => void) | undefined
    const providerEntered = new Promise<void>((resolve) => { resolveProviderEntered = resolve })
    try {
      const providerFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        if (String(input) !== dreamEndpoint) return nativeFetch(input, init)
        restorePages = await blockTableDirectory(root, 'pages')
        resolveProviderEntered?.()
        const content = [
          '<<<FILE path="wiki/concepts/failed-dream.md">>>',
          '---',
          'type: concept',
          'title: Failed Dream page',
          `description: ${failedText}`,
          'sources:',
          '  - dream-storage-failure',
          'timestamp: 2026-09-19T00:00:00.000Z',
          'confidence: 0.9',
          'status: candidate',
          'consent: false',
          'locked: false',
          '---',
          '',
          failedText,
          '<<<END>>>',
        ].join('\n')
        return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { headers: { 'content-type': 'application/json' } })
      }
      globalThis.fetch = providerFetch as typeof fetch
      harness = await startLiveHarness([`    dreamApiUrl: ${dreamEndpoint}`], root)

      expect((await postMemory(harness, baseline)).status).toBe(201)
      expect(await readResident(harness)).toContain(baseline)
      const session = harness.context.sessions.create(SessionId('dream-storage-failure'), { meta: { agentPreset: 'standard' } })
      session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'Dream durable failure evidence' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
      await drainInFlight(harness.base, 1)

      const dream = await fetchLive(`${harness.base}/dream`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-dsh-memory-profile': 'standard' },
        body: JSON.stringify({ sessionId: 'dream-storage-failure' }),
      })
      expect(dream.status).toBe(202)
      await providerEntered
      await drainInFlight(harness.base)
      expect(restorePages).toBeDefined()
      await restorePages?.()
      restorePages = undefined

      const failedWiki = await fetchLive(`${harness.base}/wiki`, { headers: { 'x-dsh-memory-profile': 'standard' } })
      const failedWikiBody = await failedWiki.json() as {
        readonly lastError?: string
        readonly records: readonly Record<string, unknown>[]
        readonly candidates: readonly Record<string, unknown>[]
        readonly resident: string
      }
      expect(failedWikiBody.lastError).toBeDefined()
      expect(failedWikiBody.resident).toContain(baseline)
      expect(failedWikiBody.resident).not.toContain(failedText)
      expect(failedWikiBody.records).not.toEqual(expect.arrayContaining([
        expect.objectContaining({ content: expect.stringContaining(failedText) }),
      ]))
      expect(failedWikiBody.candidates).toHaveLength(0)

      expect((await postMemory(harness, recovered)).status).toBe(201)
      const recoveredResident = await readResident(harness)
      expect(recoveredResident).toContain(baseline)
      expect(recoveredResident).toContain(recovered)
      expect(recoveredResident).not.toContain(failedText)
    } finally {
      await restorePages?.()
      await harness?.dispose()
      globalThis.fetch = nativeFetch
      await rm(root, { recursive: true, force: true })
    }
  })
})
