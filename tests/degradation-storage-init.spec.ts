import { mkdtemp, rm, rename, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { fetchLive } from './support/live-http.ts'
import { startLiveHarness, type LiveHarness } from './support/live-harness.ts'

async function postMemory(harness: LiveHarness, content: string): Promise<Response> {
  return fetchLive(`${harness.base}/memories`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-dsh-memory-profile': 'standard' },
    body: JSON.stringify({ content }),
  })
}

describe('real JSON storage initialization degradation', () => {
  it('fails closed when the configured JSON root is not a directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-riko-memory-degradation-init-'))
    let healthy: LiveHarness | undefined
    let recovered: LiveHarness | undefined
    try {
      healthy = await startLiveHarness([], root)
      expect((await postMemory(healthy, 'storage initialization baseline')).status).toBe(201)
      await healthy.dispose()
      healthy = undefined

      const storageRoot = join(root, 'storages')
      const storageBackup = `${storageRoot}.degradation-backup`
      await rename(storageRoot, storageBackup)
      await writeFile(storageRoot, 'the JSON storage root is unavailable\n', 'utf8')
      await expect(startLiveHarness([], root)).rejects.toThrow()

      await rm(storageRoot, { force: true })
      await rename(storageBackup, storageRoot)
      recovered = await startLiveHarness([], root)
      const resident = await fetchLive(`${recovered.base}/resident`, { headers: { 'x-dsh-memory-profile': 'standard' } })
      expect(resident.status).toBe(200)
      expect(await resident.text()).toContain('storage initialization baseline')
    } finally {
      await recovered?.dispose()
      await healthy?.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })
})
