import { describe, expect, it } from 'vitest'
import { buildDreamRequest, extractDreamText } from '../src/dream-protocol.ts'
import { parseWikiOutput } from '../src/index.ts'

describe('Dream provider protocols', () => {
  it('builds the MiMo Anthropic Messages request from an /anthropic base URL', () => {
    const request = buildDreamRequest({ apiUrl: 'https://api.xiaomimimo.com/anthropic', model: 'mimo-v2.5', maxTokens: 64 }, 'runtime-secret', 'probe')
    expect(request.protocol).toBe('anthropic-messages')
    expect(request.endpoint).toBe('https://api.xiaomimimo.com/anthropic/v1/messages')
    expect(request.headers['api-key']).toBe('runtime-secret')
    expect(request.headers.authorization).toBeUndefined()
    expect(JSON.parse(request.body)).toMatchObject({ model: 'mimo-v2.5', max_tokens: 64, thinking: { type: 'disabled' } })
    expect(extractDreamText({ content: [{ type: 'thinking', thinking: 'hidden' }, { type: 'text', text: 'FILE output' }] }, request.protocol)).toBe('FILE output')
  })

  it('keeps the OpenAI Chat Completions contract for OpenRouter-style URLs', () => {
    const request = buildDreamRequest({ apiUrl: 'https://openrouter.ai/api', model: 'provider/model', maxTokens: 64 }, 'runtime-secret', 'probe')
    expect(request.protocol).toBe('openai-chat-completions')
    expect(request.endpoint).toBe('https://openrouter.ai/api/v1/chat/completions')
    expect(request.headers.authorization).toBe('Bearer runtime-secret')
    expect(extractDreamText({ choices: [{ message: { content: 'FILE output' } }] }, request.protocol)).toBe('FILE output')
  })

  it('binds generated pages to the current raw session only', () => {
    const session = { id: 'session-authoritative' } as never
    const pages = parseWikiOutput(`<<<FILE path="wiki/entities/example.md">>>
---
type: entity
title: Example
description: A durable preference
sources:
  - external-model-session
timestamp: 2026-09-18T00:00:00.000Z
confidence: 0.8
status: confirmed
consent: true
locked: true
---

The model cannot grant its own evidence.
<<<END>>>`, session)
    expect(pages[0]!.sources).toEqual(['session-authoritative'])
    expect(pages[0]!.status).toBe('candidate')
    expect(pages[0]!.consent).toBe(false)
    expect(pages[0]!.locked).toBe(false)
  })

  it('bounds and compacts model-generated page metadata without confirming it', () => {
    const longText = '用户喜欢简洁回答。'.repeat(100)
    const pages = parseWikiOutput(`<<<FILE path="wiki/concepts/verbose.md">>>
---
type: concept
title: 这是一个不应该直接作为页面标题的完整句子，因为标题需要保持简洁
description: ${longText}
sources:
  - forged-session
timestamp: 2026-09-18T00:00:00.000Z
confidence: 0.9
status: confirmed
consent: true
locked: true
---

${longText}
<<<END>>>`, { id: 'session-authoritative' } as never)
    expect(pages[0]!.title).toBe('沟通偏好')
    expect(pages[0]!.description.length).toBeLessThanOrEqual(120)
    expect(pages[0]!.body.length).toBeLessThanOrEqual(1_200)
    expect(pages[0]!.sources).toEqual(['session-authoritative'])
    expect(pages[0]!.status).toBe('candidate')
    expect(pages[0]!.consent).toBe(false)
  })

  it('rejects missing or malformed FILE blocks', () => {
    const session = { id: 'session-authoritative' } as never
    expect(() => parseWikiOutput('plain model prose', session)).toThrow(/invalid-file-protocol/)
    expect(() => parseWikiOutput('<<<FILE path="wiki/entities/bad.md">>>\nnot frontmatter\n<<<END>>>', session)).toThrow(/invalid-file-protocol/)
  })
})
