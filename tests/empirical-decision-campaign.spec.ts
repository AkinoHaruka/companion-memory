import { createServer, type Server } from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createEmbeddingProvider, EmbeddingProviderError } from '../src/embedding-provider.ts'
import { companionCorpus } from './support/companion-corpus.ts'
import { executeCompanion } from './support/companion-runner.ts'
import { startGeminiEmbeddingAdapter, type GeminiEmbeddingAdapter } from './support/gemini-embedding-adapter.ts'

const GEMINI_KEY_ENV = 'DSH_MEMORY_DREAM_KEY'
const apiKey = process.env[GEMINI_KEY_ENV]?.trim()
const missing = apiKey === undefined || apiKey.length === 0 ? [GEMINI_KEY_ENV] : []

let adapter: GeminiEmbeddingAdapter | undefined

describe.skipIf(missing.length > 0)('empirical provider and graph decision campaign', () => {
  beforeAll(async () => {
    if (apiKey === undefined) throw new Error(`missing ${GEMINI_KEY_ENV}`)
    adapter = await startGeminiEmbeddingAdapter(apiKey)
  })

  afterAll(async () => {
    await adapter?.close()
    adapter = undefined
  })

  it('measures a real Gemini embedding request and records a finite vector', async () => {
    const started = performance.now()
    const provider = createEmbeddingProvider({ kind: 'openai-compatible', endpoint: adapter!.endpoint, model: 'gemini-embedding-001', credentialRef: GEMINI_KEY_ENV, timeoutMs: 30_000 }, { resolveCredential: name => name === GEMINI_KEY_ENV ? apiKey : undefined })
    if (provider === undefined) throw new Error('expected an enabled embedding provider')
    const vector = await provider.embedQuery('真实 embedding 语义回忆测试')
    const elapsedMs = Math.round(performance.now() - started)
    expect(vector.length).toBeGreaterThan(0)
    expect(vector.every(value => Number.isFinite(value))).toBe(true)
    console.log(`Gemini embedding evidence: dimension=${String(vector.length)} elapsedMs=${String(elapsedMs)}`)
  }, 45_000)

  it('keeps retry, timeout, and sanitized failure behavior bounded under controlled faults', async () => {
    let retryCalls = 0
    const retryServer = await startFaultServer(() => {
      retryCalls += 1
      return retryCalls === 1 ? { status: 503, body: 'secret response must not escape' } : { status: 200, body: JSON.stringify({ data: [{ embedding: [1, 0, 0] }] }) }
    })
    try {
      const provider = createEmbeddingProvider({ kind: 'openai-compatible', endpoint: retryServer.endpoint, model: 'fault-probe', credentialRef: GEMINI_KEY_ENV, timeoutMs: 500 }, { resolveCredential: () => apiKey })
      if (provider === undefined) throw new Error('expected an enabled embedding provider')
      await expect(provider.embedQuery('bounded retry')).resolves.toEqual([1, 0, 0])
      expect(retryCalls).toBe(2)
    } finally {
      await retryServer.close()
    }

    const timeoutServer = await startFaultServer(() => ({ status: 200, body: undefined, hang: true }))
    try {
      const provider = createEmbeddingProvider({ kind: 'openai-compatible', endpoint: timeoutServer.endpoint, model: 'fault-probe', credentialRef: GEMINI_KEY_ENV, timeoutMs: 80 }, { resolveCredential: () => apiKey })
      if (provider === undefined) throw new Error('expected an enabled embedding provider')
      const started = performance.now()
      const error = await provider.embedQuery('bounded timeout').catch(value => value)
      const elapsedMs = performance.now() - started
      expect(error).toBeInstanceOf(EmbeddingProviderError)
      expect((error as EmbeddingProviderError).reason).toBe('timeout')
      expect(elapsedMs).toBeLessThan(1_000)
      expect(String(error)).not.toContain(apiKey!)
    } finally {
      await timeoutServer.close()
    }

    const failureScenario = companionCorpus.find(candidate => candidate.id === 'F.20')
    if (failureScenario === undefined || apiKey === undefined) throw new Error('missing F.20')
    const degraded = await executeCompanion(failureScenario, { dreamApiKey: apiKey })
    expect(degraded.status).toBe('executed')
    expect(degraded.trace?.degradedModes).toContain('vector-degraded')
  }, 10_000)

  it('records the real-provider two-hop graph decision without a PPR trigger', async () => {
    const scenario = companionCorpus.find(candidate => candidate.id === 'F.29')
    if (scenario === undefined || adapter === undefined || apiKey === undefined) throw new Error('missing F.29 or embedding adapter')
    const outcome = await executeCompanion(scenario, {
      denseEnabled: true,
      denseEmbedding: { endpoint: adapter.endpoint, model: 'gemini-embedding-001', credentialRef: GEMINI_KEY_ENV },
      dreamApiKey: apiKey,
    })
    expect(outcome.status).toBe('executed')
    expect(outcome.checks.inclusion).toBe(true)
    const debug = outcome.exchanges.find(exchange => exchange.path === '/recall/debug')?.body as { plan?: { graphMaxHop?: number } } | undefined
    expect(debug?.plan?.graphMaxHop).toBeGreaterThanOrEqual(1)
    expect(debug?.plan?.graphMaxHop).toBeLessThanOrEqual(2)
    console.log(`Graph decision evidence: scenario=F.29 graphMaxHop=${String(debug?.plan?.graphMaxHop)}`)
  }, 120_000)

  it('confirms the real recall path keeps weighted RRF inactive until calibration exists', async () => {
    const scenario = companionCorpus.find(candidate => candidate.id === 'F.29')
    if (scenario === undefined || adapter === undefined || apiKey === undefined) throw new Error('missing F.29 or embedding adapter')
    const outcome = await executeCompanion(scenario, {
      denseEnabled: true,
      denseEmbedding: { endpoint: adapter.endpoint, model: 'gemini-embedding-001', credentialRef: GEMINI_KEY_ENV },
      dreamApiKey: apiKey,
    })
    const debug = outcome.exchanges.find(exchange => exchange.path === '/recall/debug')?.body as { plan?: Record<string, unknown> } | undefined
    expect(outcome.status).toBe('executed')
    expect(debug?.plan).not.toHaveProperty('channelWeights')
    expect(debug?.plan).not.toHaveProperty('weightedRrf')
    console.log('Weighted RRF evidence: inactive in the real Gemini recall path; scalar fusion remains the active contract')
  }, 120_000)
})

interface FaultServer {
  readonly endpoint: string
  close(): Promise<void>
}

async function startFaultServer(
  responseForRequest: () => { status: number; body: string | undefined; hang?: boolean },
): Promise<FaultServer> {
  const server = createServer((_request, response) => {
    const result = responseForRequest()
    if (result.hang === true) return
    response.writeHead(result.status, { 'content-type': 'application/json' }).end(result.body)
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve() })
  })
  const address = server.address()
  if (address === null || typeof address === 'string') {
    await closeServer(server)
    throw new Error('fault server did not receive a loopback port')
  }
  return { endpoint: `http://127.0.0.1:${String(address.port)}/v1/embeddings`, close: () => closeServer(server) }
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => { server.close(error => error === undefined ? resolve() : reject(error)) })
}
