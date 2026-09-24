/** Wire protocol variants understood by the dream request builder. */
export type DreamProtocol = 'openai-chat-completions' | 'anthropic-messages' | 'google-generate-content'

/** Connection settings needed to build one dream request. */
export interface DreamRequestSettings {
  readonly apiUrl: string
  readonly model: string
  readonly maxTokens: number
}

/** Fully-formed dream request ready to send over the wire. */
export interface DreamRequest {
  readonly protocol: DreamProtocol
  readonly endpoint: string
  readonly headers: Readonly<Record<string, string>>
  readonly body: string
}

/**
 * Infer the wire protocol from the provider base URL without adding another persisted setting.
 * @param value - the provider base URL to classify.
 * @returns the inferred wire protocol.
 */
export function dreamProtocolForUrl(value: string): DreamProtocol {
  if (/\/anthropic(?:\/|$)/i.test(value)) return 'anthropic-messages'
  if (/generativelanguage\.googleapis\.com/i.test(value) && !/\/openai(?:\/|$)/i.test(value)) return 'google-generate-content'
  return 'openai-chat-completions'
}

/**
 * Build a fully-formed dream request for the given settings, credential, and prompt.
 * @param settings - connection settings selecting the protocol and endpoint.
 * @param credential - the provider credential used in the request headers.
 * @param prompt - the user prompt to send.
 * @returns the assembled dream request.
 */
export function buildDreamRequest(settings: DreamRequestSettings, credential: string, prompt: string): DreamRequest {
  const protocol = dreamProtocolForUrl(settings.apiUrl)
  if (protocol === 'google-generate-content') {
    return {
      protocol,
      endpoint: resolveGoogleEndpoint(settings.apiUrl, settings.model),
      headers: { accept: 'application/json', 'content-type': 'application/json', 'x-goog-api-key': credential },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { maxOutputTokens: settings.maxTokens, thinkingConfig: { thinkingLevel: 'minimal' } },
      }),
    }
  }
  if (protocol === 'anthropic-messages') {
    return {
      protocol,
      endpoint: resolveAnthropicEndpoint(settings.apiUrl),
      headers: { accept: 'application/json', 'api-key': credential, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: settings.model, messages: [{ role: 'user', content: prompt }], temperature: 0.1, max_tokens: settings.maxTokens, stream: false, thinking: { type: 'disabled' } }),
    }
  }
  return {
    protocol,
    endpoint: resolveChatEndpoint(settings.apiUrl),
    headers: { accept: 'application/json', authorization: `Bearer ${credential}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: settings.model, messages: [{ role: 'user', content: prompt }], temperature: 0.1, max_tokens: settings.maxTokens }),
  }
}

/**
 * Extract only assistant text; thinking/tool blocks are not accepted as Wiki protocol output.
 * @param body - the parsed provider response body.
 * @param protocol - the wire protocol that produced the body.
 * @returns the extracted assistant text, or undefined when none is present.
 */
export function extractDreamText(body: unknown, protocol: DreamProtocol): string | undefined {
  if (protocol === 'google-generate-content') {
    const candidates = body && typeof body === 'object' && Array.isArray((body as { candidates?: unknown }).candidates)
      ? (body as { candidates: Array<{ content?: { parts?: unknown } }> }).candidates
      : []
    const parts = candidates[0]?.content?.parts
    const text = Array.isArray(parts)
      ? parts.filter(part => part && typeof part === 'object' && (part as { thought?: unknown }).thought !== true && typeof (part as { text?: unknown }).text === 'string').map(part => (part as { text: string }).text).join('')
      : ''
    return text.trim() || undefined
  }
  if (protocol === 'anthropic-messages') {
    const blocks = body && typeof body === 'object' && Array.isArray((body as { content?: unknown }).content) ? (body as { content: Array<{ type?: unknown; text?: unknown }> }).content : []
    const text = blocks.filter(block => block.type === 'text' && typeof block.text === 'string').map(block => block.text as string).join('')
    return text.trim() || undefined
  }
  const content = body && typeof body === 'object' && Array.isArray((body as { choices?: unknown }).choices) ? (body as { choices: Array<{ message?: { content?: unknown } }> }).choices[0]?.message?.content : undefined
  return typeof content === 'string' && content.trim() ? content.trim() : undefined
}

function resolveChatEndpoint(value: string): string {
  const normalized = value.replace(/\/$/, '')
  return normalized.endsWith('/chat/completions') ? normalized : `${normalized}/v1/chat/completions`
}

function resolveGoogleEndpoint(value: string, model: string): string {
  const normalized = value.replace(/\/$/, '')
  if (/[?#]/.test(normalized)) throw new Error('Google native Dream endpoint must not include a query or fragment')
  if (/:generateContent$/i.test(normalized)) {
    const match = normalized.match(/\/models\/([^/:]+):generateContent$/i)
    const configuredModel = match?.[1]
    if (configuredModel !== undefined && decodeURIComponent(configuredModel) !== model) {
      return normalized.replace(/\/models\/[^/:]+:generateContent$/i, `/models/${encodeURIComponent(model)}:generateContent`)
    }
    return normalized
  }
  if (/\/models$/i.test(normalized)) return `${normalized}/${encodeURIComponent(model)}:generateContent`
  if (/\/v1beta$/i.test(normalized)) return `${normalized}/models/${encodeURIComponent(model)}:generateContent`
  return `${normalized}/models/${encodeURIComponent(model)}:generateContent`
}

function resolveAnthropicEndpoint(value: string): string {
  const normalized = value.replace(/\/$/, '')
  if (normalized.endsWith('/v1/messages')) return normalized
  return normalized.endsWith('/v1') ? `${normalized}/messages` : `${normalized}/v1/messages`
}
