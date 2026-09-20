import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { fetchLive } from './support/live-http.ts'
import { startLiveHarness, type LiveHarness } from './support/live-harness.ts'

const CONFIG = [
  '    apiToken: standard-token',
  '    apiTokenProfile: standard',
  '    ownerAdminToken: owner-admin-token',
  '    recallEnabled: true',
  '    evidenceClassificationEnabled: true',
]
const USER_HEADERS = { authorization: 'Bearer standard-token', 'content-type': 'application/json', 'x-dsh-memory-profile': 'standard' }
const OWNER_HEADERS = { authorization: 'Bearer owner-admin-token', 'content-type': 'application/json', 'x-dsh-memory-profile': 'standard' }
const SENSITIVE_TEXT = 'My private medical record is code S-200.'
const NORMAL_TEXT = 'I prefer concise answers in the morning.'

interface EvidenceCounts {
  readonly normal: number
  readonly provisional_sensitive: number
  readonly sensitive: number
  readonly unclassified: number
}

interface RecallBody {
  readonly results: readonly { readonly text: string }[]
}

interface CorrectionBody {
  readonly authority: string
  readonly changed: boolean
  readonly eventIndex: number
  readonly sensitivity: string
}

interface AuditRecord {
  readonly event: string
  readonly detail?: { readonly authority?: string; readonly eventIndex?: number; readonly sessionId?: string }
}

let harness: LiveHarness | undefined
let root: string | undefined

afterEach(async () => {
  await harness?.dispose()
  harness = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

async function json<T>(response: Response): Promise<T> { return await response.json() as T }

async function drain(base: string): Promise<void> {
  const response = await fetchLive(`${base}/sessions`, {
    headers: { authorization: USER_HEADERS.authorization, 'x-dsh-memory-profile': 'standard' },
  })
  expect(response.status).toBe(200)
  await response.arrayBuffer()
}

function appendUserTurn(value: LiveHarness, sessionId: string, text: string): void {
  const session = value.context.sessions.create(SessionId(sessionId), { meta: { agentPreset: 'standard' } })
  const message = createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
  session.append('user/message', message, { surfaceOp: 'append' })
}

async function recall(base: string, query: string): Promise<RecallBody> {
  const response = await fetchLive(`${base}/recall`, {
    method: 'POST',
    headers: USER_HEADERS,
    body: JSON.stringify({ query }),
  })
  expect(response.status).toBe(200)
  return await json<RecallBody>(response)
}

async function correct(base: string, sessionId: string, sensitivity: string, headers: Record<string, string>): Promise<CorrectionBody> {
  const response = await fetchLive(`${base}/sessions/${sessionId}/evidence/0/sensitivity`, {
    method: 'PUT',
    headers,
    body: JSON.stringify({ sensitivity }),
  })
  expect(response.status).toBe(200)
  return await json<CorrectionBody>(response)
}

describe('live evidence sensitivity correction', () => {
  it('authorizes, audits, changes disclosure, and reloads corrected markers', async () => {
    root = await mkdtemp(join(tmpdir(), 'riko-evidence-correction-'))
    harness = await startLiveHarness(CONFIG, root)
    appendUserTurn(harness, 'sensitive-session', SENSITIVE_TEXT)
    appendUserTurn(harness, 'normal-session', NORMAL_TEXT)
    await drain(harness.base)

    const initial = await fetchLive(`${harness.base}/sessions/sensitive-session`, { headers: USER_HEADERS })
    expect(initial.status).toBe(200)
    const initialBody = await json<{ readonly evidence: { readonly classificationCounts: EvidenceCounts } }>(initial)
    expect(initialBody.evidence.classificationCounts).toEqual({
      normal: 0,
      provisional_sensitive: 0,
      sensitive: 1,
      unclassified: 0,
    })
    const initialRecall = await recall(harness.base, 'Do you remember my private medical record S-200?')
    expect(initialRecall.results.some(result => result.text.includes(SENSITIVE_TEXT))).toBe(false)

    const wrongProfile = await fetchLive(`${harness.base}/sessions/sensitive-session/evidence/0/sensitivity`, {
      method: 'PUT',
      headers: {
        authorization: USER_HEADERS.authorization,
        'content-type': 'application/json',
        'x-dsh-memory-profile': 'other',
      },
      body: JSON.stringify({ sensitivity: 'normal' }),
    })
    expect(wrongProfile.status).toBe(401)

    const userLoosened = await correct(harness.base, 'sensitive-session', 'normal', USER_HEADERS)
    expect(userLoosened).toEqual({
      authority: 'user', changed: true, eventIndex: 0, profileId: 'standard', sessionId: 'sensitive-session', sensitivity: 'normal',
    })
    const loosenedRecall = await recall(harness.base, 'Do you remember my private medical record S-200?')
    expect(loosenedRecall.results.some(result => result.text.includes(SENSITIVE_TEXT))).toBe(true)

    const userTightened = await correct(harness.base, 'normal-session', 'sensitive', USER_HEADERS)
    expect(userTightened).toEqual({
      authority: 'user', changed: true, eventIndex: 0, profileId: 'standard', sessionId: 'normal-session', sensitivity: 'sensitive',
    })
    const tightenedRecall = await recall(harness.base, 'Do you remember that I prefer concise answers in the morning?')
    expect(tightenedRecall.results.some(result => result.text.includes(NORMAL_TEXT))).toBe(false)

    const managementLoosened = await correct(harness.base, 'normal-session', 'normal', OWNER_HEADERS)
    expect(managementLoosened).toEqual({
      authority: 'management', changed: true, eventIndex: 0, profileId: 'standard', sessionId: 'normal-session', sensitivity: 'normal',
    })
    const managementRecall = await recall(harness.base, 'Do you remember that I prefer concise answers in the morning?')
    expect(managementRecall.results.some(result => result.text.includes(NORMAL_TEXT))).toBe(true)

    const auditsResponse = await fetchLive(`${harness.base}/audits`, { headers: USER_HEADERS })
    expect(auditsResponse.status).toBe(200)
    const audits = await json<{ readonly audits: readonly AuditRecord[] }>(auditsResponse)
    expect(audits.audits).toEqual(expect.arrayContaining([
      expect.objectContaining({
        event: 'evidence-sensitivity-marked',
        detail: expect.objectContaining({ sessionId: 'sensitive-session', eventIndex: 0, authority: 'user' }),
      }),
      expect.objectContaining({
        event: 'evidence-sensitivity-marked',
        detail: expect.objectContaining({ sessionId: 'normal-session', eventIndex: 0, authority: 'user' }),
      }),
      expect.objectContaining({
        event: 'evidence-sensitivity-marked',
        detail: expect.objectContaining({ sessionId: 'normal-session', eventIndex: 0, authority: 'management' }),
      }),
    ]))

    await harness.dispose()
    harness = await startLiveHarness(CONFIG, root)
    const restoredSensitiveRecall = await recall(harness.base, 'Do you remember my private medical record S-200?')
    expect(restoredSensitiveRecall.results.some(result => result.text.includes(SENSITIVE_TEXT))).toBe(true)
    const restoredNormalRecall = await recall(harness.base, 'Do you remember that I prefer concise answers in the morning?')
    expect(restoredNormalRecall.results.some(result => result.text.includes(NORMAL_TEXT))).toBe(true)
    const restored = await fetchLive(`${harness.base}/sessions/normal-session`, { headers: USER_HEADERS })
    const restoredBody = await json<{ readonly evidence: { readonly classificationCounts: EvidenceCounts } }>(restored)
    expect(restoredBody.evidence.classificationCounts).toEqual({
      normal: 1,
      provisional_sensitive: 0,
      sensitive: 0,
      unclassified: 0,
    })
  })
})
