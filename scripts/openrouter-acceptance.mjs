import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const apiUrl = process.env.DSH_MEMORY_DREAM_API_URL || 'https://openrouter.ai/api'
const model = process.env.DSH_MEMORY_DREAM_MODEL || 'stealth/union-alpha'
const apiKey = process.env.DSH_MEMORY_DREAM_API_KEY || process.env.OPENROUTER_API_KEY || ''
const timeoutMs = 20_000
const maxTokens = 32
const startedAt = new Date().toISOString()

const outputDir = process.env.DSH_MEMORY_ACCEPTANCE_OUTPUT_DIR
  ? join(process.env.DSH_MEMORY_ACCEPTANCE_OUTPUT_DIR)
  : await mkdtemp(join(tmpdir(), 'dsh-riko-memory-acceptance-'))
const tempProfileDir = await mkdtemp(join(tmpdir(), 'dsh-riko-memory-profile-'))
await mkdir(outputDir, { recursive: true })

const events = []
const providerErrors = []
const protocol = /\/anthropic(?:\/|$)/i.test(apiUrl) ? 'anthropic-messages' : 'openai-chat-completions'
const endpoint = resolveEndpoint(apiUrl)

function resolveEndpoint(value) {
  const normalized = value.replace(/\/+$/, '')
  if (/\/anthropic(?:\/|$)/i.test(value)) {
    if (/\/v1\/messages$/i.test(normalized)) return normalized
    return normalized.endsWith('/v1') ? `${normalized}/messages` : `${normalized}/v1/messages`
  }
  if (/\/chat\/completions$/i.test(normalized)) return normalized
  if (/\/api$/i.test(normalized)) return `${normalized}/v1/chat/completions`
  if (/\/v1$/i.test(normalized)) return `${normalized}/chat/completions`
  return `${normalized}/v1/chat/completions`
}

function classifyStatus(status) {
  if (status === 401) return 'unauthorized'
  if (status === 403) return 'forbidden'
  if (status === 404) return 'not_found'
  if (status === 429) return 'rate_limited'
  if (status >= 500 && status <= 599) return 'provider_5xx'
  return `http_${status}`
}

function safeError(error) {
  if (error?.name === 'AbortError') return 'timeout'
  if (error instanceof TypeError) return 'network_error'
  return 'request_error'
}

function event(kind, details = {}) {
  events.push({ schemaVersion: 1, at: new Date().toISOString(), kind, ...details })
}

async function waitMs(milliseconds) {
  if (milliseconds <= 0) return
  await new Promise(resolve => setTimeout(resolve, milliseconds))
}

function retryDelay(response) {
  const value = Number(response.headers.get('retry-after'))
  if (!Number.isFinite(value) || value < 0) return 250
  return Math.min(500, Math.round(value * 1000))
}

async function request({ reasoning = false } = {}) {
  const body = protocol === 'anthropic-messages'
    ? {
        model,
        messages: [{ role: 'user', content: 'Return a one-word acknowledgement for this acceptance probe.' }],
        temperature: 0,
        max_tokens: reasoning ? 128 : maxTokens,
        stream: false,
        thinking: reasoning ? { type: 'enabled', budget_tokens: 64 } : { type: 'disabled' },
      }
    : {
        model,
        messages: [{ role: 'user', content: 'Return a one-word acknowledgement for this acceptance probe.' }],
        temperature: 0,
        max_tokens: maxTokens,
        ...(reasoning ? { reasoning: { effort: 'low' } } : {}),
      }

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: protocol === 'anthropic-messages'
          ? { accept: 'application/json', 'api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }
          : { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      })
      clearTimeout(timer)
      const category = classifyStatus(response.status)
      event(reasoning ? 'reasoning_response' : 'baseline_response', { attempt, status: response.status, category })
      if (response.status === 429 && attempt === 1) {
        providerErrors.push({ category, status: response.status, attempt })
        await waitMs(retryDelay(response))
        continue
      }
      if (!response.ok) {
        providerErrors.push({ category, status: response.status, attempt })
        return { ok: false, category, status: response.status, attempts: attempt }
      }
      const text = await response.text()
      if (!text.trim()) {
        providerErrors.push({ category: 'empty_response', status: response.status, attempt })
        return { ok: false, category: 'empty_response', status: response.status, attempts: attempt }
      }
      let json
      try {
        json = JSON.parse(text)
      } catch {
        providerErrors.push({ category: 'invalid_json', status: response.status, attempt })
        return { ok: false, category: 'invalid_json', status: response.status, attempts: attempt }
      }
      const content = protocol === 'anthropic-messages'
        ? (Array.isArray(json?.content) ? json.content.filter(item => item?.type === 'text' && typeof item.text === 'string').map(item => item.text).join('') : '')
        : json?.choices?.[0]?.message?.content
      if (typeof content !== 'string' || content.trim().length === 0) {
        providerErrors.push({ category: 'invalid_content', status: response.status, attempt })
        return { ok: false, category: 'invalid_content', status: response.status, attempts: attempt }
      }
      return { ok: true, category: 'ok', status: response.status, attempts: attempt, contentLength: content.length }
    } catch (error) {
      clearTimeout(timer)
      const category = safeError(error)
      event(reasoning ? 'reasoning_error' : 'baseline_error', { attempt, category })
      providerErrors.push({ category, attempt })
      return { ok: false, category, attempts: attempt }
    }
  }
  return { ok: false, category: 'rate_limited', attempts: 2 }
}

const summary = {
  schemaVersion: 1,
  startedAt,
  completedAt: new Date().toISOString(),
  endpoint,
  protocol,
  model,
  keyConfigured: Boolean(apiKey),
  temporaryProfile: true,
  temporaryProfileDir: tempProfileDir,
  baseline: { status: 'skipped', reason: 'runtime key is not configured' },
  reasoning: { status: 'not_run', reason: 'optional probe is disabled' },
}

event('acceptance_started', { endpoint, model, keyConfigured: Boolean(apiKey), temporaryProfile: true })
if (apiKey) {
  summary.baseline = await request()
  if (process.env.DSH_MEMORY_ACCEPT_REASONING === 'true') summary.reasoning = await request({ reasoning: true })
  else event('reasoning_skipped', { reason: 'DSH_MEMORY_ACCEPT_REASONING is not true' })
} else {
  event('acceptance_skipped', { reason: 'DSH_MEMORY_DREAM_API_KEY or OPENROUTER_API_KEY is not configured' })
}
summary.completedAt = new Date().toISOString()

await writeFile(join(outputDir, 'acceptance-summary.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8')
await writeFile(join(outputDir, 'acceptance-events.jsonl'), events.map(item => JSON.stringify(item)).join('\n') + (events.length ? '\n' : ''), 'utf8')
await writeFile(join(outputDir, 'sanitized-provider-errors.log'), providerErrors.map(item => JSON.stringify(item)).join('\n') + (providerErrors.length ? '\n' : ''), 'utf8')

if (!apiKey) process.exitCode = 2
else if (!summary.baseline.ok) process.exitCode = 1
