import { createServer, type Server } from 'node:http'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { fetchLive } from './support/live-http.ts'
import { startLiveHarness, type LiveHarness } from './support/live-harness.ts'

interface EmbeddingFixture {
  readonly endpoint: string
  fail(): void
  close(): Promise<void>
}

interface NormalRecallBody {
  readonly results: Array<{ readonly id: string; readonly channels: readonly string[] }>
  readonly trace: { readonly candidatesByChannel: Record<string, number> }
}

interface DegradedRecallBody {
  readonly results: Array<{ readonly id: string }>
  readonly trace: { readonly degradedModes: readonly string[] }
}

async function startEmbeddingFixture(): Promise<EmbeddingFixture> {
  let failed = false
  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: unknown) => {
      if (typeof chunk === 'string') chunks.push(Buffer.from(chunk))
      else if (Buffer.isBuffer(chunk)) chunks.push(chunk)
    })
    request.on('end', () => {
      response.setHeader('content-type', 'application/json')
      if (failed) {
        response.statusCode = 503
        response.end(JSON.stringify({ error: 'fixture embedding outage' }))
        return
      }
      const payload = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { readonly input?: string | readonly string[] }
      const count = Array.isArray(payload.input) ? payload.input.length : 1
      response.statusCode = 200
      response.end(JSON.stringify({ data: Array.from({ length: count }, () => ({ embedding: [1, 0] })) }))
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => { resolve() })
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('embedding fixture did not receive a loopback address')
  return {
    endpoint: `http://127.0.0.1:${String(address.port)}/embeddings`,
    fail: () => { failed = true },
    close: () => new Promise<void>((resolve, reject) => { server.close((error) => { if (error) reject(error); else resolve() }) }),
  }
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

async function recallDebug(harness: LiveHarness, query: string): Promise<Response> {
  return fetchLive(`${harness.base}/recall/debug`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-dsh-memory-profile': 'standard' },
    body: JSON.stringify({ query }),
  })
}

describe('real persisted vector degradation', () => {
  it('keeps lexical recall available after a corrupt persisted vector and provider outage', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-riko-memory-degradation-vector-'))
    const embedding = await startEmbeddingFixture()
    let first: LiveHarness | undefined
    let second: LiveHarness | undefined
    try {
      const config = [
        '    recallEnabled: true',
        '    recallVectorEnabled: true',
        '    embeddingProvider: openai-compatible',
        `    embeddingEndpoint: ${embedding.endpoint}`,
        '    embeddingCredentialRef: DSH_MEMORY_DREAM_API_KEY',
        '    embeddingModel: fixture-embedding',
      ]
      first = await startLiveHarness(config, root)
      const target = 'dense persisted target'
      const created = await postMemory(first, target)
      expect(created.status).toBe(201)
      expect(created.id).toEqual(expect.any(String))
      const normal = await recallDebug(first, '你还记得之前的 dense 代号吗？')
      expect(normal.status).toBe(200)
      const normalBody = await normal.json() as NormalRecallBody
      expect(normalBody.results.some(result => result.id === `page:${created.id}`)).toBe(true)
      expect(normalBody.trace.candidatesByChannel.dense).toBeGreaterThan(0)

      const domain = first.context.storageDomain.get('riko_memory')
      if (domain === undefined) throw new Error('riko_memory domain was not open')
      const vectorEntry = [...domain.table('vectors').entries()][0]
      if (vectorEntry === undefined) throw new Error('dense vector was not persisted')
      const vectorPath = join(root, 'storages', 'riko_memory', 'vectors', `${vectorEntry[0]}.json`)
      await first.dispose()
      first = undefined

      const persisted = JSON.parse(await readFile(vectorPath, 'utf8')) as { record: { vector: number[] } }
      persisted.record.vector = [1]
      await writeFile(vectorPath, `${JSON.stringify(persisted, null, 2)}\n`, 'utf8')
      embedding.fail()

      second = await startLiveHarness(config, root)
      const degraded = await recallDebug(second, '你还记得之前的 dense 代号吗？')
      expect(degraded.status).toBe(200)
      const degradedBody = await degraded.json() as DegradedRecallBody
      expect(degradedBody.results.some(result => result.id === `page:${created.id}`)).toBe(true)
      expect(degradedBody.trace.degradedModes).toContain('vector-degraded')
    } finally {
      await second?.dispose()
      await first?.dispose()
      await embedding.close()
      await rm(root, { recursive: true, force: true })
    }
  })
})
