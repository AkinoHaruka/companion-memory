export type DreamProtocol = 'openai-chat-completions' | 'anthropic-messages'

export interface DreamRequestSettings {
  readonly apiUrl: string
  readonly model: string
  readonly maxTokens: number
}

export interface DreamRequest {
  readonly protocol: DreamProtocol
  readonly endpoint: string
  readonly headers: Readonly<Record<string, string>>
  readonly body: string
}

/** Infer the wire protocol from the provider base URL without adding another persisted setting. */
export function dreamProtocolForUrl(value: string): DreamProtocol {
  return /\/anthropic(?:\/|$)/i.test(value) ? 'anthropic-messages' : 'openai-chat-completions'
}

export function buildDreamRequest(settings: DreamRequestSettings, credential: string, prompt: string): DreamRequest {
  const protocol = dreamProtocolForUrl(settings.apiUrl)
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

/** Extract only assistant text; thinking/tool blocks are not accepted as Wiki protocol output. */
export function extractDreamText(body: unknown, protocol: DreamProtocol): string | undefined {
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

function resolveAnthropicEndpoint(value: string): string {
  const normalized = value.replace(/\/$/, '')
  if (normalized.endsWith('/v1/messages')) return normalized
  return normalized.endsWith('/v1') ? `${normalized}/messages` : `${normalized}/v1/messages`
}
