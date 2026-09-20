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

async function post(harness: LiveHarness, path: string, body: unknown, extraHeaders: Record<string, string> = {}): Promise<Response> {
  return fetchLive(`${harness.base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-dsh-memory-profile': 'standard', ...extraHeaders },
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

/** Capture all plugin message text returned by the real Agent pre-step waterfall. */
async function injectedText(harness: LiveHarness, agent: ReturnType<typeof testAgent>, text: string): Promise<string> {
  const result = await agentEvents(harness.context, agent).waterfall('agent/pre-step', {
    messages: [createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })],
    turn: 1,
    step: 1,
    signal: new AbortController().signal,
  }, () => Promise.resolve({ kind: 'enter' as const, messages: [] }))
  if (result.kind !== 'enter') return ''
  const pluginMessages = result.messages.filter(message => message.source.kind === 'plugin' && message.source.plugin === '@deepseek-ai/dsh-riko-memory')
  return pluginMessages
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
    const created = await json<{ id: string }>(write)

    const agent = createAgent(harness, 'safe-projection-live-query')
    const query = '你还记得我的私人沟通偏好吗？'
    const captured = await injectedText(harness, agent, query)
    console.log(`[SAFE-PROJECTION-LIVE-01] ${captured.trim()}`)

    expect(captured).toContain('<internal-memory-guidance>')
    const guidanceBlocks = captured.match(/<internal-memory-guidance>[\s\S]*?<\/internal-memory-guidance>/g) ?? []
    expect(guidanceBlocks).toHaveLength(1)
    const guidanceBlock = guidanceBlocks[0] ?? ''
    const guidanceFields = guidanceBlock.split('\n').slice(1, -1).map(line => line.slice(0, line.indexOf(':')))
    expect(guidanceFields).toEqual([
      'tone',
      'topic_sensitivity',
      'avoid_unsolicited_reference',
      'avoid_probing',
      'user_initiated_topic',
      'allowed_effects',
      'summary',
    ])
    expect(guidanceBlock).toBe([
      '<internal-memory-guidance>',
      'tone: neutral',
      'topic_sensitivity: high',
      'avoid_unsolicited_reference: true',
      'avoid_probing: true',
      'user_initiated_topic: true',
      'allowed_effects: avoid_topic',
      'summary: A interaction rules memory may guide conversation handling without disclosing its specific content.',
      '</internal-memory-guidance>',
    ].join('\n'))

    const recalledResponse = await post(harness, '/recall', { query })
    expect(recalledResponse.status).toBe(200)
    const recalled = await json<{
      results: Array<{ text: string; sourceRefs: string[]; channels: string[]; projection?: { memoryId: string; disclosure: string } }>
      context: string
    }>(recalledResponse)
    const protectedResult = recalled.results.find(result => result.projection?.memoryId === created.id)
    expect(protectedResult).toBeDefined()
    expect(protectedResult?.projection?.disclosure).not.toBe('normal')
    expect(protectedResult?.text).toBe('')
    expect(protectedResult?.sourceRefs).toEqual([])
    expect(protectedResult?.channels).not.toEqual(expect.arrayContaining(['rawEvidence', 'dense', 'graph']))
    expect(recalled.context).not.toContain(rawBody)
    expect(recalled.context).not.toContain('Nebula Finch')
    expect(recalled.context).not.toContain('Lumen-47')
    expect(captured).not.toContain(rawBody)
    expect(captured).not.toContain('Nebula Finch')
    expect(captured).not.toContain('Lumen-47')
    expect(captured).not.toContain('safe-projection-live-session')
    expect(captured).not.toContain('event:7')
    expect(captured).not.toContain(sourceRef)
    expect(captured).not.toContain('Source:')
    expect(captured).not.toMatch(/session:|event:\d/i)
  })

  it('UNCLASSIFIED-DISCLOSURE-LIVE-01 gates raw evidence by the configured policy', { timeout: 60_000 }, async () => {
    const rawBody = '我的储物柜密码是 Nebula Finch-4821。'
    const explicitQuestion = '你还记得我的储物柜密码吗？'

    const neverExplicitHarness = await startLiveHarness([
      '    recallEnabled: true',
      '    evidenceClassificationEnabled: false',
      '    unclassifiedEvidenceDisclosure: never_explicit',
    ])
    harnesses.push(neverExplicitHarness)
    const neverExplicitAgent = createAgent(neverExplicitHarness, 'unclassified-never-explicit')
    neverExplicitAgent.session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: rawBody }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    await drainInFlight(neverExplicitHarness.base, 1)
    const neverExplicitCaptured = await injectedText(neverExplicitHarness, neverExplicitAgent, explicitQuestion)
    console.log(`[UNCLASSIFIED-DISCLOSURE-LIVE-01 never_explicit] ${neverExplicitCaptured.trim()}`)
    expect(neverExplicitCaptured).toContain('<internal-memory-guidance>')
    expect(neverExplicitCaptured).not.toContain(rawBody)

    const userExplicitHarness = await startLiveHarness([
      '    recallEnabled: true',
      '    evidenceClassificationEnabled: false',
      '    unclassifiedEvidenceDisclosure: user_explicit_only',
    ])
    harnesses.push(userExplicitHarness)
    const userExplicitAgent = createAgent(userExplicitHarness, 'unclassified-user-explicit')
    userExplicitAgent.session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: rawBody }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    await drainInFlight(userExplicitHarness.base, 1)
    const userExplicitCaptured = await injectedText(userExplicitHarness, userExplicitAgent, explicitQuestion)
    console.log(`[UNCLASSIFIED-DISCLOSURE-LIVE-01 user_explicit_only explicit] ${userExplicitCaptured.trim()}`)
    expect(userExplicitCaptured).toContain(rawBody)

    const unsolicitedCaptured = await injectedText(userExplicitHarness, userExplicitAgent, '请解释一下量子计算是什么？')
    console.log(`[UNCLASSIFIED-DISCLOSURE-LIVE-01 user_explicit_only unsolicited] ${unsolicitedCaptured.trim()}`)
    expect(userExplicitCaptured).toContain(rawBody)
    expect(unsolicitedCaptured).not.toContain(rawBody)
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

  it('CONFLICT-RESOLUTION-LIVE-01 releases a contested page through the authenticated management route', { timeout: 60_000 }, async () => {
    const nativeFetch = globalThis.fetch
    let dreamCalls = 0
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) !== 'https://api.test/api/v1/chat/completions') return nativeFetch(input, init)
      dreamCalls += 1
      const content = '<<<FILE path="wiki/concepts/favourite-colour.md">>>\n---\ntype: concept\ntitle: 我最喜欢的颜色\ndescription: 我最喜欢的颜色可能是绿色\nsources:\n  - conflict-resolution-live-statement\ntimestamp: 2026-09-19T00:00:00.000Z\nconfidence: 0.9\nstatus: candidate\nconsent: false\nlocked: false\n---\n我最喜欢的颜色可能是绿色\n<<<END>>>'
      return Promise.resolve(new Response(JSON.stringify({ choices: [{ message: { content } }] }), { headers: { 'content-type': 'application/json' } }))
    }) as typeof fetch

    try {
      const harness = await startLiveHarness([
        '    apiTokens:',
        '      standard: standard-token',
        '      other: other-token',
        '    recallEnabled: true',
        '    evidenceClassificationEnabled: true',
        '    dreamApiUrl: https://api.test/api/v1/chat/completions',
      ])
      harnesses.push(harness)
      const authorizedHeaders = { authorization: 'Bearer standard-token', 'x-dsh-memory-profile': 'standard' }

      const canonical = await post(harness, '/wiki/pages', {
        path: 'wiki/concepts/favourite-colour.md',
        type: 'concept',
        title: '我最喜欢的颜色',
        content: '我最喜欢的颜色是蓝色',
      }, authorizedHeaders)
      expect(canonical.status).toBe(201)
      const canonicalBody = await json<{ id: string }>(canonical)

      const statementAgent = createAgent(harness, 'conflict-resolution-live-statement')
      statementAgent.session.append('user/message', createUserMessage({
        content: [{ type: 'text', text: '我可能更喜欢绿色，但我也不确定。' }],
        source: { kind: 'user' },
      }), { surfaceOp: 'append' })
      const drained = await fetchLive(`${harness.base}/sessions`, { headers: authorizedHeaders })
      expect(drained.status).toBe(200)
      await drained.arrayBuffer()

      const dream = await post(harness, '/dream', { sessionId: 'conflict-resolution-live-statement' }, authorizedHeaders)
      expect(dream.status).toBe(202)
      let conflictId = ''
      await vi.waitFor(async () => {
        expect(dreamCalls).toBe(1)
        const snapshot = await json<{ candidates: Array<{ id: string; status: string; conflictPageId?: string; page: { description: string } }>; resident: string }>(await fetchLive(`${harness.base}/wiki`, { headers: authorizedHeaders }))
        const candidate = snapshot.candidates.find(item => item.page.description.includes('绿色'))
        expect(candidate?.status).toBe('pending_conflict')
        expect(candidate?.conflictPageId).toBe(canonicalBody.id)
        expect(snapshot.resident).not.toContain('蓝色')
        expect(snapshot.resident).not.toContain('绿色')
        const conflicts = await fetchLive(`${harness.base}/conflicts`, { headers: authorizedHeaders })
        expect(conflicts.status).toBe(200)
        const body = await json<{ profileId: string; conflicts: Array<{ id: string; state: string; oldCanonicalId: string; newCandidateId: string }> }>(conflicts)
        expect(body.profileId).toBe('standard')
        const overlay = body.conflicts.find(item => item.oldCanonicalId === canonicalBody.id)
        expect(overlay?.state).toBe('contested')
        expect(overlay?.newCandidateId).toBe(candidate?.id)
        conflictId = overlay?.id ?? ''
        expect(conflictId).not.toBe('')
      }, { timeout: 15_000, interval: 25 })

      const queryAgent = createAgent(harness, 'conflict-resolution-live-query')
      const quarantined = await injectedText(harness, queryAgent, '你还记得我最喜欢的颜色吗？')
      expect(quarantined).not.toContain('我最喜欢的颜色是蓝色')

      const invalid = await post(harness, `/conflicts/${encodeURIComponent(conflictId)}/resolve`, { resolution: 'invalid' }, authorizedHeaders)
      expect(invalid.status).toBe(400)
      expect(await json<{ error: string }>(invalid)).toEqual({ error: 'resolution must be one of correction, temporal_transition or management' })

      const unauthorized = await post(harness, `/conflicts/${encodeURIComponent(conflictId)}/resolve`, { resolution: 'management' }, { authorization: 'Bearer standard-token', 'x-dsh-memory-profile': 'other' })
      expect(unauthorized.status).toBe(401)

      const resolved = await post(harness, `/conflicts/${encodeURIComponent(conflictId)}/resolve`, { resolution: 'management' }, authorizedHeaders)
      expect(resolved.status).toBe(200)
      expect(await json<{ changed: boolean }>(resolved)).toEqual({ changed: true })

      const released = await injectedText(harness, queryAgent, '你还记得我最喜欢的颜色吗？')
      expect(released).toContain('我最喜欢的颜色可能是绿色')

      const conflictsAfter = await fetchLive(`${harness.base}/conflicts`, { headers: authorizedHeaders })
      expect(conflictsAfter.status).toBe(200)
      const afterBody = await json<{ conflicts: Array<{ id: string; state: string; resolution?: string }> }>(conflictsAfter)
      expect(afterBody.conflicts.find(item => item.id === conflictId)).toMatchObject({ state: 'resolved', resolution: 'management' })
      const noChange = await post(harness, `/conflicts/${encodeURIComponent(conflictId)}/resolve`, { resolution: 'management' }, authorizedHeaders)
      expect(noChange.status).toBe(404)
      expect(await json<{ changed: boolean }>(noChange)).toEqual({ changed: false })
    } finally {
      globalThis.fetch = nativeFetch
    }
  })
})
