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

  it('builds the Google native generateContent request for Gemini and Gemma', () => {
    const request = buildDreamRequest({ apiUrl: 'https://generativelanguage.googleapis.com/v1beta', model: 'gemma-4-26b-a4b-it', maxTokens: 64 }, 'runtime-secret', 'probe')
    expect(request.protocol).toBe('google-generate-content')
    expect(request.endpoint).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemma-4-26b-a4b-it:generateContent')
    expect(request.headers['x-goog-api-key']).toBe('runtime-secret')
    const body = JSON.parse(request.body)
    expect(body).toMatchObject({ generationConfig: { maxOutputTokens: 64, thinkingConfig: { thinkingLevel: 'minimal' } } })
    expect(body.contents[0].parts[0].text).toBe('probe')
    expect(extractDreamText({ candidates: [{ content: { parts: [{ thought: true, text: 'hidden' }, { text: 'FILE output' }] } }] }, request.protocol)).toBe('FILE output')
  })

  it('binds a full native Google URL to the configured model and rejects URL secrets', () => {
    const rebound = buildDreamRequest({
      apiUrl: 'https://generativelanguage.googleapis.com/v1beta/models/gemma-4-26b-a4b-it:generateContent',
      model: 'gemini-3.5-flash-lite',
      maxTokens: 64,
    }, 'runtime-secret', 'probe')
    expect(rebound.endpoint).toContain('/models/gemini-3.5-flash-lite:generateContent')
    expect(() => buildDreamRequest({
      apiUrl: 'https://generativelanguage.googleapis.com/v1beta?key=runtime-secret',
      model: 'gemma-4-26b-a4b-it',
      maxTokens: 64,
    }, 'runtime-secret', 'probe')).toThrow('must not include a query or fragment')
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

  it('rejects the full response when any FILE block is malformed', () => {
    const valid = '<<<FILE path="wiki/concepts/partial.md">>>\n---\ntype: concept\ntitle: Partial\ndescription: Partial page\n---\nBody.\n<<<END>>>'
    const invalid = '<<<FILE path="wiki/concepts/bad.md">>>\nnot frontmatter\n<<<END>>>'
    expect(() => parseWikiOutput(`${valid}\n${invalid}`, 'session-authoritative')).toThrow(/invalid-file-protocol/)
  })

  it('normalizes safe provider folder aliases before typed Wiki validation', () => {
    const pages = parseWikiOutput(`<<<FILE path="wiki/preferences/weekend.md">>>
---
type: concept
title: Weekend preference
description: A durable preference
sources:
  - session-authoritative
timestamp: 2026-09-18T00:00:00.000Z
confidence: 0.8
status: candidate
consent: false
locked: false
---

A durable preference.
<<<END>>>`, 'session-authoritative')
    expect(pages[0]?.type).toBe('concept')
    expect(pages[0]?.path).toContain('wiki/concepts/')
    const entityPages = parseWikiOutput(`<<<FILE path="wiki/preferences/person.md">>>
---
type: entity
title: Person
description: A durable entity
sources:
  - session-authoritative
timestamp: 2026-09-18T00:00:00.000Z
confidence: 0.8
status: candidate
consent: false
locked: false
---

A durable entity.
<<<END>>>`, 'session-authoritative')
    expect(entityPages[0]?.type).toBe('entity')
    expect(entityPages[0]?.path).toContain('wiki/entities/')
  })

})
