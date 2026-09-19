import { request } from 'node:http'
import type { IncomingMessage } from 'node:http'

/** Default stall detector for one fixture HTTP round trip. @default 15_000 */
const DEFAULT_TIMEOUT_MS = 15_000

/**
 * Options the Fetch-compatible `init` cannot express.
 */
export interface FetchLiveOptions {
  /**
   * Stall detector for this one round trip. A route that awaits the service's in-flight
   * write chain (see `drainInFlight`) legitimately outlives a plain round trip, so its
   * caller passes a budget derived from that work instead of the default.
   */
  readonly timeoutMs?: number
}

/**
 * Read a fixture response completely without Fetch's browser port blocklist.
 * OS-assigned loopback ports can include blocked ports on Windows, so the transport is
 * node:http rather than fetch. Each request still opens its own non-pooled connection.
 *
 * Completion is taken from the response stream, not from the request's `close`: Node may
 * observe the socket's close in the same I/O turn that delivers the final body chunk, so a
 * `close`-first settlement would classify a complete response as a truncated one whenever
 * the server answers with `Connection: close` — which every one of these non-pooled
 * requests triggers. `close` is therefore the success path only for an already-complete
 * message, and otherwise the failure path that reports a truncated response.
 * @param input - The fixture's loopback HTTP URL.
 * @param init - Request method, headers, body, and optional cancellation signal.
 * @param options - Stall-detector override for routes that await service-side work.
 * @returns A buffered response whose body remains available to assertions.
 */
export async function fetchLive(input: string | URL, init: RequestInit = {}, options: FetchLiveOptions = {}): Promise<Response> {
  const url = new URL(input)
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1') throw new Error('live HTTP requests require a loopback fixture URL')
  const outgoing = new Request(url, init)
  const body = outgoing.body === null ? undefined : Buffer.from(await outgoing.arrayBuffer())
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(new Error(`fixture HTTP request timed out: ${url.href}`)), options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  try {
    return await new Promise<Response>((resolve, reject) => {
      let response: IncomingMessage | undefined
      const chunks: Buffer[] = []
      const build = (): Response => {
        const headers = new Headers()
        for (let index = 0; index < response!.rawHeaders.length; index += 2) {
          headers.append(response!.rawHeaders[index]!, response!.rawHeaders[index + 1]!)
        }
        const status = response!.statusCode!
        return new Response(outgoing.method === 'HEAD' || [204, 205, 304].includes(status) ? null : Buffer.concat(chunks), { status, headers })
      }
      const req = request(url, {
        method: outgoing.method,
        headers: Object.fromEntries(outgoing.headers),
        agent: false,
        signal: AbortSignal.any([outgoing.signal, controller.signal]),
      }, (res) => {
        response = res
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('error', reject)
        res.on('end', () => { resolve(build()) })
      })
      req.on('error', reject)
      req.on('close', () => {
        // A complete message has already been resolved by `res`'s `end`; a complete
        // message whose `end` is still queued is settled here from the same buffers.
        if (response !== undefined && response.complete) { resolve(build()); return }
        reject(new Error(`fixture HTTP connection closed before its response: ${url.href}`))
      })
      req.end(body)
    })
  } finally {
    clearTimeout(timeout)
  }
}
