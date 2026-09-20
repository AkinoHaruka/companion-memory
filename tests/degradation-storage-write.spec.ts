import { mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { fetchLive } from './support/live-http.ts'
import { startLiveHarness, type LiveHarness } from './support/live-harness.ts'

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
})
