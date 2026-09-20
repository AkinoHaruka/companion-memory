/* oxlint-disable @stylistic/max-len */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { agentEvents } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { fetchLive } from './support/live-http.ts'
import { drainInFlight, startLiveHarness, testAgent, type LiveHarness } from './support/live-harness.ts'

const harnesses: LiveHarness[] = []

afterEach(async () => {
  await Promise.all(harnesses.splice(0).map(harness => harness.dispose()))
})

async function post(harness: LiveHarness, path: string, body: unknown): Promise<Response> {
  return fetchLive(`${harness.base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-dsh-memory-profile': 'standard' },
    body: JSON.stringify(body),
  })
}

async function json<T>(response: Response): Promise<T> {
  return await response.json() as T
}

function createAgent(harness: LiveHarness, sessionId: string): ReturnType<typeof testAgent> {
  const session = harness.context.sessions.create(SessionId(sessionId), { meta: { agentPreset: 'standard' } })
  const agent = testAgent(harness.context, session)
  harness.context.emit('agent/created', { agent, source: 'startup' })
  return agent
}

/** Capture the plugin message returned by the real Agent pre-step waterfall. */
async function injectedText(harness: LiveHarness, agent: ReturnType<typeof testAgent>, text: string): Promise<string> {
  const result = await agentEvents(harness.context, agent).waterfall('agent/pre-step', {
    messages: [createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })],
    turn: 1,
    step: 1,
    signal: new AbortController().signal,
  }, () => Promise.resolve({ kind: 'enter' as const, messages: [] }))
  if (result.kind !== 'enter') return ''
  return result.messages
    .filter(message => message.source.kind === 'plugin' && message.source.plugin === '@deepseek-ai/dsh-riko-memory')
    .flatMap(message => message.content)
    .filter((block): block is { readonly type: 'text'; readonly text: string } => block.type === 'text')
    .map(block => block.text)
    .join('\n')
}

describe('Riko memory live decision semantics', () => {
  it('SAFE-PROJECTION-LIVE-01 injects only sensitive-use projection guidance', { timeout: 60_000 }, async () => {
    const harness = await startLiveHarness([
      '    recallEnabled: true',
      '    recallRawEvidenceEnabled: false',
    ])
    harnesses.push(harness)

    const rawBody = '我的私人沟通偏好是与 Nebula Finch 只通过夜间频道联系；秘密代号 Lumen-47。'
    const sourceRef = 'session:safe-projection-live-session/event:7'
    const write = await post(harness, '/memories', {
      content: rawBody,
      sensitivity: 'sensitive',
      sourceConversation: sourceRef,
    })
    expect(write.status).toBe(201)

    const agent = createAgent(harness, 'safe-projection-live-query')
    const captured = await injectedText(harness, agent, '你还记得我的私人沟通偏好吗？')
    console.log(`[SAFE-PROJECTION-LIVE-01] ${captured.trim()}`)

    expect(captured).toContain('<internal-memory-guidance>')
    expect(captured).toContain('allowed_effects: avoid_topic')
    expect(captured).toContain('summary: A interaction rules memory may guide conversation handling without disclosing its specific content.')
    expect(captured).not.toContain(rawBody)
    expect(captured).not.toContain('Nebula Finch')
    expect(captured).not.toContain('Lumen-47')
    expect(captured).not.toContain('safe-projection-live-session')
    expect(captured).not.toContain('event:7')
    expect(captured).not.toContain(sourceRef)
    expect(captured).not.toContain('Source:')
    expect(captured).not.toMatch(/session:|event:\d/i)
  })

  it('CONFLICT-LIVE-01 keeps an ambiguous conflicting statement out of current truth', { timeout: 60_000 }, async () => {
    const nativeFetch = globalThis.fetch
    let dreamCalls = 0
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) !== 'https://api.test/api/v1/chat/completions') return nativeFetch(input, init)
      dreamCalls += 1
      const content = '<<<FILE path="wiki/concepts/favourite-colour.md">>>\n---\ntype: concept\ntitle: 我最喜欢的颜色\ndescription: 我最喜欢的颜色可能是绿色\nsources:\n  - conflict-live-statement\ntimestamp: 2026-09-19T00:00:00.000Z\nconfidence: 0.9\nstatus: candidate\nconsent: false\nlocked: false\n---\n我最喜欢的颜色可能是绿色\n<<<END>>>'
      return Promise.resolve(new Response(JSON.stringify({ choices: [{ message: { content } }] }), { headers: { 'content-type': 'application/json' } }))
    }) as typeof fetch

    try {
      const harness = await startLiveHarness([
        '    recallEnabled: true',
        '    evidenceClassificationEnabled: true',
        '    dreamApiUrl: https://api.test/api/v1/chat/completions',
      ])
      harnesses.push(harness)

      const canonical = await post(harness, '/wiki/pages', {
        path: 'wiki/concepts/favourite-colour.md',
        type: 'concept',
        title: '我最喜欢的颜色',
        content: '我最喜欢的颜色是蓝色',
      })
      expect(canonical.status).toBe(201)

      const statementAgent = createAgent(harness, 'conflict-live-statement')
      statementAgent.session.append('user/message', createUserMessage({
        content: [{ type: 'text', text: '我可能更喜欢绿色，但我也不确定。' }],
        source: { kind: 'user' },
      }), { surfaceOp: 'append' })
      await drainInFlight(harness.base, 1)

      const dream = await post(harness, '/dream', { sessionId: 'conflict-live-statement' })
      expect(dream.status).toBe(202)
      await vi.waitFor(async () => {
        expect(dreamCalls).toBe(1)
        const snapshot = await json<{ candidates: Array<{ status: string; conflictPageId?: string; page: { description: string } }>; resident: string }>(await fetchLive(`${harness.base}/wiki`, { headers: { 'x-dsh-memory-profile': 'standard' } }))
        const candidate = snapshot.candidates.find(item => item.page.description.includes('绿色'))
        expect(candidate?.status).toBe('pending_conflict')
        expect(candidate?.conflictPageId).toBeDefined()
        expect(snapshot.resident).not.toContain('蓝色')
        expect(snapshot.resident).not.toContain('绿色')
      }, { timeout: 15_000, interval: 25 })

      const queryAgent = createAgent(harness, 'conflict-live-query')
      const captured = await injectedText(harness, queryAgent, '你还记得我最喜欢的颜色吗？')
      console.log(`[CONFLICT-LIVE-01] ${captured.trim()}`)

      expect(captured).not.toContain('我最喜欢的颜色是蓝色')
      expect(captured).not.toContain('我最喜欢的颜色是绿色')
      expect(captured).toContain('我可能更喜欢绿色，但我也不确定。')
      expect(captured).toContain('可能')
      expect(captured).toContain('不确定')
    } finally {
      globalThis.fetch = nativeFetch
    }
  })
})
