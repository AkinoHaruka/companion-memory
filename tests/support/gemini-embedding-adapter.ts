import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'

const GEMINI_EMBEDDING_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:batchEmbedContents'

export interface GeminiEmbeddingAdapter {
  readonly endpoint: string
  close(): Promise<void>
}

/**
 * Expose Gemini's native embedding method through the OpenAI embeddings shape expected by the runtime.
 * The bearer credential is accepted only for the local caller; the upstream key stays in memory and is
 * sent as a request header, never written to a fixture or result artifact.
 */
export async function startGeminiEmbeddingAdapter(apiKey: string): Promise<GeminiEmbeddingAdapter> {
  const server = createServer((request, response) => { void handleRequest(request, response, apiKey) })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve() })
  })
  const address = server.address()
  if (address === null || typeof address === 'string') {
    await closeServer(server)
    throw new Error('Gemini embedding adapter did not receive a loopback port')
  }
  return { endpoint: `http://127.0.0.1:${String(address.port)}/v1/embeddings`, close: () => closeServer(server) }
}

async function handleRequest(request: IncomingMessage, response: ServerResponse, apiKey: string): Promise<void> {
  if (request.method !== 'POST' || request.url !== '/v1/embeddings') {
    response.writeHead(404).end()
    return
  }
  try {
    const body = JSON.parse(await readBody(request)) as { model?: unknown; input?: unknown }
    const inputs = Array.isArray(body.input) ? body.input : [body.input]
    if (inputs.length === 0 || inputs.some(value => typeof value !== 'string')) throw new Error('invalid embedding input')
    const upstream = await fetch(GEMINI_EMBEDDING_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({
        requests: inputs.map(text => ({ model: 'models/gemini-embedding-001', content: { parts: [{ text }] }, outputDimensionality: 768 })),
      }),
    })
    if (!upstream.ok) {
      response.writeHead(upstream.status).end()
      return
    }
    const payload = await upstream.json() as { embeddings?: Array<{ values?: unknown }> }
    const data = payload.embeddings?.map((embedding, index) => ({ object: 'embedding', index, embedding: embedding.values })) ?? []
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ object: 'list', data, model: body.model ?? 'gemini-embedding-001' }))
  } catch {
    response.writeHead(502).end()
  }
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    request.on('data', chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)))
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    request.on('error', reject)
  })
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => { server.close(error => error === undefined ? resolve() : reject(error)) })
}
