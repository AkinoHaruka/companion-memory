import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { agentEvents } from '@deepseek-ai/dsh-agent'
import { createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { fetchLive } from './support/live-http.ts'
import { drainInFlight, startLiveHarness, testAgent, type LiveHarness } from './support/live-harness.ts'

const harnesses: LiveHarness[] = []

afterEach(async () => {
  await Promise.all(harnesses.splice(0).map(harness => harness.dispose()))
})

type TestAgent = ReturnType<typeof testAgent>

interface WikiPageResponse {
  readonly id: string
  readonly title?: string
  readonly body?: string
  readonly usagePolicy?: string
}

interface WikiSnapshot {
  readonly pages: readonly WikiPageResponse[]
  readonly aliases: readonly {
    readonly alias: string
    readonly entityId: string
    readonly status?: string
    readonly invalidatedReason?: string
  }[]
}

async function requestJson<T>(
  harness: LiveHarness,
  path: string,
  body?: unknown,
  method = body === undefined ? 'GET' : 'POST',
): Promise<T> {
  const response = await fetchLive(`${harness.base}${path}`, {
    method,
    headers: { 'content-type': 'application/json', 'x-dsh-memory-profile': 'standard' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const value: unknown = await response.json()
  if (!response.ok) throw new Error(`${method} ${path} failed with ${String(response.status)}: ${JSON.stringify(value)}`)
  return value as T
}

function createAgent(harness: LiveHarness, sessionId: string): TestAgent {
  const session = harness.context.sessions.create(SessionId(sessionId), { meta: { agentPreset: 'standard' } })
  const agent = testAgent(harness.context, session)
  harness.context.emit('agent/created', { agent, source: 'startup' })
  return agent
}

function appendUser(agent: TestAgent, text: string): void {
  agent.session.append('user/message', createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
}

async function appendAndDrain(harness: LiveHarness, agent: TestAgent, text: string): Promise<void> {
  appendUser(agent, text)
  await drainInFlight(harness.base, 1)
}

/** Drive the real memory pre-step listener for one numbered Agent turn. */
async function preStepText(harness: LiveHarness, agent: TestAgent, text: string, turn: number): Promise<string> {
  const result = await agentEvents(harness.context, agent).waterfall('agent/pre-step', {
    messages: [createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })],
    turn,
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

async function executeTool(harness: LiveHarness, agent: TestAgent, name: string, args: Record<string, unknown>) {
  const result = await harness.context.tools.execute({
    signal: new AbortController().signal,
    callId: ToolCallId(`${name}-${String(Date.now())}`),
    name,
    arguments: args,
    agent,
  })
  if (result.isError) throw new Error(`${name} returned a tool error: ${JSON.stringify(result)}`)
  return result
}

function systemMemoryText(harness: LiveHarness): Promise<string> {
  return harness.context.systemPrompt.assemble().then(assembly => (
    assembly.contexts.find(context => context.name === 'riko-memory')?.text ?? ''
  ))
}

describe('Riko memory multi-turn conversation shape', () => {
  it('MT-01 corrects the same predicate twice and recalls after each turn', async () => {
    const harness = await startLiveHarness(['    recallEnabled: true'])
    harnesses.push(harness)
    const created = await requestJson<{ readonly id: string }>(harness, '/memories', { content: '我的工作地点是上海' })
    const agent = createAgent(harness, 'multi-turn-correction')

    await appendAndDrain(harness, agent, '我的工作地点是杭州')
    await executeTool(harness, agent, 'memory_correct', { id: created.id, content: '我的工作地点是杭州' })
    const firstRecall = await preStepText(harness, agent, '你还记得我的工作地点是杭州吗？', 1)
    expect(firstRecall).toContain('我的工作地点是杭州')

    await appendAndDrain(harness, agent, '我的工作地点是京都')
    await executeTool(harness, agent, 'memory_correct', { id: created.id, content: '我的工作地点是京都' })
    const secondRecall = await preStepText(harness, agent, '你还记得我的工作地点是京都吗？', 2)
    expect(secondRecall).toContain('我的工作地点是京都')
  })

  it('MT-02 keeps a suppressed topic absent through unrelated and explicit later turns', async () => {
    const harness = await startLiveHarness(['    recallEnabled: true'])
    harnesses.push(harness)
    const created = await requestJson<{ readonly id: string }>(harness, '/memories', { content: 'orchid private hobby' })
    const agent = createAgent(harness, 'multi-turn-suppression')

    await appendAndDrain(harness, agent, '不要再主动提 orchid private hobby')
    await executeTool(harness, agent, 'memory_suppress', { target: 'orchid private hobby' })
    const suppressed = await requestJson<WikiPageResponse>(harness, `/wiki/pages/${encodeURIComponent(created.id)}`)
    expect(suppressed.usagePolicy).toBe('suppressed')

    const unrelated = await preStepText(harness, agent, '请解释量子计算是什么？', 2)
    expect(unrelated).not.toContain('orchid private hobby')
    const explicit = await preStepText(harness, agent, '你还记得 orchid private hobby 吗？', 3)
    expect(explicit).not.toContain('orchid private hobby')
  })

  it('MT-03 recalls the current and historical values after a temporal transition', async () => {
    const harness = await startLiveHarness(['    recallEnabled: true', '    temporalEnabled: true'])
    harnesses.push(harness)
    const original = await requestJson<WikiPageResponse>(harness, '/wiki/pages', {
      path: 'wiki/concepts/multi-turn-location.md',
      type: 'concept',
      title: '当前居住地',
      content: '我现在住上海',
    })
    await requestJson<WikiPageResponse>(harness, `/wiki/pages/${encodeURIComponent(original.id)}/temporal`, {
      validFrom: '2024-01-01T00:00:00.000Z',
      title: '当前居住地',
      content: '我现在住杭州',
    }, 'POST')
    const agent = createAgent(harness, 'multi-turn-temporal')

    const current = await preStepText(harness, agent, '你还记得我现在住哪里吗？', 1)
    expect(current).toContain('我现在住杭州')
    expect(current).not.toContain('我现在住上海')
    const historical = await preStepText(harness, agent, '你还记得我以前住上海吗？', 2)
    expect(historical).toContain('我现在住上海')
    expect(historical).not.toContain('我现在住杭州')
  })

  it('MT-04 applies a persisted non-normal projection only when its topic is explicit', async () => {
    const harness = await startLiveHarness(['    recallEnabled: true', '    recallRawEvidenceEnabled: false'])
    harnesses.push(harness)
    const body = '我的私人沟通偏好是只在夜间联系 Nebula Finch'
    await requestJson(harness, '/memories', { content: body, sensitivity: 'sensitive' })
    const agent = createAgent(harness, 'multi-turn-projection')

    const unrelated = await preStepText(harness, agent, '请解释量子计算是什么？', 1)
    expect(unrelated).not.toContain(body)
    const explicitQuery = '你还记得我只在夜间联系 Nebula Finch 的私人沟通偏好吗？'
    const explicit = await preStepText(harness, agent, explicitQuery, 2)
    expect(explicit).toContain('<internal-memory-guidance>')
    expect(explicit).not.toContain(body)
    const recalled = await requestJson<{
      readonly results: readonly { readonly projection?: { readonly disclosure: string } }[]
    }>(harness, '/recall', { query: explicitQuery })
    expect(recalled.results.some(result => result.projection?.disclosure !== 'normal')).toBe(true)
  })

  it('MT-05 reassigns an alias across turns and suppresses the reassigned entity by alias', async () => {
    const harness = await startLiveHarness(['    recallEnabled: true'])
    harnesses.push(harness)
    const alice = await requestJson<WikiPageResponse>(harness, '/wiki/pages', {
      path: 'wiki/entities/alice.md',
      type: 'entity',
      title: 'Alice',
      content: 'Alice is entity A',
    })
    const bob = await requestJson<WikiPageResponse>(harness, '/wiki/pages', {
      path: 'wiki/entities/bob.md',
      type: 'entity',
      title: 'Bob',
      content: 'Bob is entity B',
    })
    const agent = createAgent(harness, 'multi-turn-alias')

    await appendAndDrain(harness, agent, 'Commander Alice')
    await preStepText(harness, agent, '请记住 Commander Alice', 1)
    const first = await requestJson<WikiSnapshot>(harness, '/wiki')
    expect(first.aliases.find(alias => alias.alias === 'Commander' && alias.entityId === alice.id)?.status).toBe('active')

    await appendAndDrain(harness, agent, 'Commander Bob')
    await preStepText(harness, agent, '请记住 Commander Bob', 2)
    const second = await requestJson<WikiSnapshot>(harness, '/wiki')
    const reassigned = second.aliases.find(alias => alias.entityId === alice.id && alias.alias === 'Commander')
    expect(reassigned?.invalidatedReason).toBe('alias reassigned')
    expect(second.aliases.find(alias => alias.entityId === bob.id && alias.alias === 'Commander')?.status).toBe('active')

    await appendAndDrain(harness, agent, '不要再主动提 Commander')
    await executeTool(harness, agent, 'memory_suppress', { target: 'Commander' })
    const afterManagement = await requestJson<WikiPageResponse>(harness, `/wiki/pages/${encodeURIComponent(bob.id)}`)
    expect(afterManagement.usagePolicy).toBe('suppressed')
  })

  it('MT-06 invalidates an observation after live supporting and contradicting evidence', async () => {
    const harness = await startLiveHarness([
      '    recallEnabled: true',
      '    recallObservationEnabled: true',
    ])
    harnesses.push(harness)
    const supportAgents = ['one', 'two', 'three'].map(name => createAgent(harness, `multi-turn-observation-support-${name}`))
    supportAgents.forEach((agent, index) => appendUser(agent, `supporting routine evidence ${String(index + 1)}`))
    await drainInFlight(harness.base, supportAgents.length)
    const observation = await requestJson<{ readonly id: string; readonly status: string }>(harness, '/observations', {
      text: 'I prefer a planned checklist-driven coding routine',
      sourceRefs: supportAgents.map(agent => `session:${String(agent.session.id)}/event:0`),
    })
    expect(observation.status).toBe('active')

    const contradictionAgents = ['one', 'two', 'three', 'four'].map(name => (
      createAgent(harness, `multi-turn-observation-contradiction-${name}`)
    ))
    contradictionAgents.forEach((agent, index) => appendUser(agent, `contradicting routine evidence ${String(index + 1)}`))
    await drainInFlight(harness.base, contradictionAgents.length)
    const updated = await requestJson<{ readonly status: string; readonly contradictingRefs?: readonly string[] }>(
      harness,
      `/observations/${encodeURIComponent(observation.id)}/evidence`,
      { contradictingRefs: contradictionAgents.map(agent => `session:${String(agent.session.id)}/event:0`) },
    )
    expect(updated.status).toBe('invalidated')
    expect(updated.contradictingRefs).toHaveLength(contradictionAgents.length)

    const query = '你还记得之前推断出的 planned checklist-driven coding routine observation 吗？'
    const recalled = await requestJson<{
      readonly results: readonly { readonly id: string; readonly text: string }[]
    }>(harness, '/recall', { query })
    const debug = await requestJson<{ readonly trace: { readonly gateReasons: readonly string[] } }>(harness, '/recall/debug', { query })
    expect(recalled.results.some(result => result.text.includes('planned checklist-driven coding routine'))).toBe(false)
    expect(debug.trace.gateReasons).toContain('observation-invalidated')
  })

  it('MT-07 rebuilds the model system context after mutation between two Agent turns', async () => {
    const harness = await startLiveHarness()
    harnesses.push(harness)
    const created = await requestJson<{ readonly id: string }>(harness, '/memories', { content: 'Resident value before mutation' })
    const agent = createAgent(harness, 'multi-turn-system-context')

    await preStepText(harness, agent, '第一轮普通问题', 1)
    const firstAssembly = await systemMemoryText(harness)
    expect(firstAssembly).toContain('Resident value before mutation')

    await requestJson<WikiPageResponse>(harness, `/wiki/pages/${encodeURIComponent(created.id)}`, {
      content: 'Resident value after mutation',
    }, 'PUT')
    await preStepText(harness, agent, '第二轮普通问题', 2)
    const secondAssembly = await systemMemoryText(harness)
    expect(secondAssembly).toContain('Resident value after mutation')
    expect(secondAssembly).not.toContain('Resident value before mutation')
  })

  it('MT-08 recalls and corrects the same session after Loader dispose and reopen', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-riko-memory-multi-turn-'))
    let activeHarness: LiveHarness | undefined
    try {
      activeHarness = await startLiveHarness(['    recallEnabled: true'], root)
      const firstHarness = activeHarness
      const created = await requestJson<{ readonly id: string }>(firstHarness, '/memories', { content: 'restart predicate alpha' })
      const firstAgent = createAgent(firstHarness, 'multi-turn-restart-session')
      await appendAndDrain(firstHarness, firstAgent, 'restart predicate alpha')
      await firstHarness.dispose()
      activeHarness = undefined

      activeHarness = await startLiveHarness(['    recallEnabled: true'], root)
      const reopened = activeHarness
      const reopenedAgent = createAgent(reopened, 'multi-turn-restart-session')
      const beforeCorrection = await preStepText(reopened, reopenedAgent, '你还记得 restart predicate alpha 吗？', 2)
      expect(beforeCorrection).toContain('restart predicate alpha')

      await appendAndDrain(reopened, reopenedAgent, 'restart predicate beta')
      await executeTool(reopened, reopenedAgent, 'memory_correct', { id: created.id, content: 'restart predicate beta' })
      const afterCorrection = await preStepText(reopened, reopenedAgent, '你还记得 restart predicate beta 吗？', 3)
      expect(afterCorrection).toContain('restart predicate beta')
    } finally {
      if (activeHarness !== undefined) await activeHarness.dispose()
      await rm(root, { recursive: true, force: true })
    }
  }, 15_000)

  it('D1 aligns a corrected manual-memory title with its replacement body', async () => {
    const harness = await startLiveHarness(['    recallEnabled: true'])
    harnesses.push(harness)
    const oldContent = '我的工作地点是上海'
    const newContent = '我的工作地点是杭州'
    const created = await requestJson<{ readonly id: string }>(harness, '/memories', { content: oldContent })
    const agent = createAgent(harness, 'correction-title-alignment')

    await appendAndDrain(harness, agent, newContent)
    await executeTool(harness, agent, 'memory_correct', { id: created.id, content: newContent })
    const corrected = await requestJson<WikiPageResponse>(harness, `/wiki/pages/${encodeURIComponent(created.id)}`)

    expect(corrected.title).toBe(newContent)
    expect(corrected.title).not.toContain(oldContent)
    expect(corrected.body).toContain(newContent)
  })

  it('D1 aligns a managed Wiki body correction when its title was content-derived', async () => {
    const harness = await startLiveHarness()
    harnesses.push(harness)
    const oldContent = 'managed content before correction'
    const newContent = 'managed content after correction'
    const created = await requestJson<{ readonly id: string }>(harness, '/wiki/pages', {
      path: 'wiki/concepts/managed-content-correction.md',
      type: 'concept',
      title: oldContent,
      description: oldContent,
      body: oldContent,
    })

    await requestJson(harness, `/wiki/pages/${encodeURIComponent(created.id)}`, { body: newContent }, 'PUT')
    const corrected = await requestJson<WikiPageResponse>(harness, `/wiki/pages/${encodeURIComponent(created.id)}`)

    expect(corrected.title).toBe(newContent)
    expect(corrected.body).toBe(newContent)
  })

  it('D2 invalidates only the superseded manual claim from raw evidence', async () => {
    const harness = await startLiveHarness(['    recallEnabled: true', '    recallRawEvidenceEnabled: true'])
    harnesses.push(harness)
    const oldContent = '我的工作地点是上海'
    const unrelatedContent = '我的宠物叫 Mochi'
    const newContent = '我的工作地点是杭州'
    const created = await requestJson<{ readonly id: string }>(harness, '/memories', { content: oldContent })
    await requestJson(harness, `/wiki/pages/${encodeURIComponent(created.id)}`, { title: '当前居住地' }, 'PUT')
    const agent = createAgent(harness, 'correction-raw-evidence')

    await appendAndDrain(harness, agent, oldContent)
    await appendAndDrain(harness, agent, unrelatedContent)
    await appendAndDrain(harness, agent, newContent)
    await executeTool(harness, agent, 'memory_correct', { id: created.id, content: newContent })

    const staleQuery = await requestJson<{ readonly results: readonly { readonly text: string; readonly sourceType: string }[] }>(
      harness,
      '/recall',
      { query: `你还记得${oldContent}吗？` },
    )
    expect(staleQuery.results.some(result => result.sourceType === 'evidence' && result.text.includes(oldContent))).toBe(false)
    const unrelatedQuery = await requestJson<{ readonly results: readonly { readonly text: string }[] }>(
      harness,
      '/recall',
      { query: `你还记得${unrelatedContent}吗？` },
    )
    expect(unrelatedQuery.results.some(result => result.text.includes(unrelatedContent))).toBe(true)
    const debug = await requestJson<{ readonly trace: { readonly gateReasons: readonly string[] } }>(harness, '/recall/debug', {
      query: `你还记得${oldContent}吗？`,
    })
    expect(debug.trace.gateReasons).toContain('correction-invalidated')
  })
})
