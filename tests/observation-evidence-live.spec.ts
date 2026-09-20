import { afterEach, describe, expect, it } from 'vitest'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { fetchLive } from './support/live-http.ts'
import { startLiveHarness, testAgent, type LiveHarness } from './support/live-harness.ts'

const harnesses: LiveHarness[] = []

afterEach(async () => {
  await Promise.all(harnesses.splice(0).map(harness => harness.dispose()))
})

describe('live observation evidence', () => {
  it('rejects an unauthorised profile and invalidates only an owned observation', async () => {
    const harness = await startLiveHarness([
      '    apiTokens:',
      '      alpha: alpha-token',
      '      beta: beta-token',
    ])
    harnesses.push(harness)
    const alphaHeaders = { 'content-type': 'application/json', authorization: 'Bearer alpha-token', 'x-dsh-memory-profile': 'alpha' }
    const betaHeaders = { ...alphaHeaders, authorization: 'Bearer beta-token', 'x-dsh-memory-profile': 'alpha' }
    const alphaSession = harness.context.sessions.create(SessionId('observation-alpha'), { meta: { agentPreset: 'alpha' } })
    const supportSession = harness.context.sessions.create(SessionId('observation-support'), { meta: { agentPreset: 'alpha' } })
    const thirdSupportSession = harness.context.sessions.create(SessionId('observation-third-support'), { meta: { agentPreset: 'alpha' } })
    const contradictionSessions = ['one', 'two', 'three', 'four'].map(name => harness.context.sessions.create(
      SessionId(`observation-contradiction-${name}`), { meta: { agentPreset: 'alpha' } },
    ))
    for (const session of [alphaSession, supportSession, thirdSupportSession, ...contradictionSessions]) {
      harness.context.emit('agent/created', { agent: testAgent(harness.context, session), source: 'startup' })
    }
    const append = (session: typeof alphaSession, text: string): void => {
      session.append('user/message', createUserMessage({
        content: [{ type: 'text', text }], source: { kind: 'user' },
      }), { surfaceOp: 'append' })
    }
    append(alphaSession, 'I usually plan before coding.')
    append(supportSession, 'I review tests before coding.')
    append(thirdSupportSession, 'I keep a short implementation checklist.')
    contradictionSessions.forEach((session, index) => append(session, `I contradict the coding routine in case ${String(index + 1)}.`))
    const drain = await fetchLive(`${harness.base}/sessions`, { headers: alphaHeaders })
    expect(drain.status).toBe(200)
    const create = await fetchLive(`${harness.base}/observations`, {
      method: 'POST',
      headers: alphaHeaders,
      body: JSON.stringify({
        text: 'I prefer a planned, checklist-driven coding routine.',
        sourceRefs: [
          'session:observation-alpha/event:0', 'session:observation-support/event:0', 'session:observation-third-support/event:0',
        ],
      }),
    })
    const observation = await create.json() as {
      id?: string
      status?: string
      error?: string
      contradictingRefs?: readonly string[]
    }
    expect(create.status, JSON.stringify(observation)).toBe(201)
    if (observation.id === undefined || observation.status === undefined) {
      throw new Error('observation creation did not return an observation')
    }
    expect(observation.status).toBe('active')
    const unauthorised = await fetchLive(`${harness.base}/observations/${observation.id}/evidence`, {
      method: 'POST',
      headers: betaHeaders,
      body: JSON.stringify({ contradictingRefs: ['session:observation-contradiction-one/event:0'] }),
    })
    expect(unauthorised.status).toBe(401)
    const unchanged = await fetchLive(`${harness.base}/observations`, { headers: alphaHeaders })
    expect(unchanged.status).toBe(200)
    const unchangedBody = await unchanged.json() as {
      observations: Array<{ id: string; status: string; contradictingRefs?: readonly string[] }>
    }
    expect(unchangedBody.observations.find(value => value.id === observation.id)).toMatchObject({ status: 'active' })
    expect(unchangedBody.observations.find(value => value.id === observation.id)?.contradictingRefs).toBeUndefined()
    const update = await fetchLive(`${harness.base}/observations/${observation.id}/evidence`, {
      method: 'POST',
      headers: alphaHeaders,
      body: JSON.stringify({
        contradictingRefs: [
          'session:observation-contradiction-one/event:0',
          'session:observation-contradiction-two/event:0',
          'session:observation-contradiction-three/event:0',
          'session:observation-contradiction-four/event:0',
        ],
      }),
    })
    expect(update.status).toBe(200)
    const updated = await update.json() as { status: string; evidenceCount: number; contradictingRefs: readonly string[] }
    expect(updated).toMatchObject({ status: 'invalidated', evidenceCount: 3 })
    expect(updated.contradictingRefs).toHaveLength(4)
  })
})
