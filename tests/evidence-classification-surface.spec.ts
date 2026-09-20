/*
 * The surface contracts of L0 evidence classification: what the HTTP routes expose, what disposal has to
 * do before closing the domain, and how the corpus reports a case whose capability the run switched off.
 *
 * The HTTP legs need a real Loader composition, because the switch is only observable through `/config`,
 * the counts only through `/sessions/:id`, and the drain-before-close ordering only through records that
 * outlive the process that wrote them. The classification rules themselves are covered by the store-level
 * specs; this file never re-asserts them.
 */
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { companionCorpus } from './support/companion-corpus.ts'
import { evidenceClassificationUnsupportedReason, executeCompanion } from './support/companion-runner.ts'
import { drainInFlight, startLiveHarness, type LiveHarness } from './support/live-harness.ts'
import { fetchLive } from './support/live-http.ts'

const SESSION_ID = 'evidence-classification-live'
const RAW_TURN = '我的储物柜编号是 B-417'
const QUERY = '你还记得我的储物柜 B-417 吗？'
const HEADERS = { 'content-type': 'application/json', 'x-dsh-memory-profile': 'standard' }
/** The switch on, so the L0 channel this file observes actually exists. */
const CONFIG = ['    recallEnabled: true', '    evidenceClassificationEnabled: true', '    unclassifiedEvidenceDisclosure: never_explicit']

/** Ask one fixture route and return its parsed JSON body. */
async function call<T>(base: string, path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetchLive(`${base}${path}`, { headers: HEADERS, ...init })
  expect(response.status, path).toBeLessThan(300)
  return await response.json() as T
}

/** Append one real user turn to the live session and await the L0 write chain behind it. */
async function appendUserTurn(harness: LiveHarness, text: string): Promise<void> {
  const session = harness.context.sessions.create(SessionId(SESSION_ID), { meta: { agentPreset: 'standard' } })
  session.append('user/message', createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }), { surfaceOp: 'append' })
  await drainInFlight(harness.base)
}

describe('L0 evidence classification over the live surface', () => {
  it('echoes the switch, counts the session without raw text, and keeps the original out of debug, config and session reads', async () => {
    const root = await mkdtemp(join(tmpdir(), 'riko-evidence-live-'))
    let harness: LiveHarness | undefined
    try {
      harness = await startLiveHarness(CONFIG, root)
      const base = harness.base
      await appendUserTurn(harness, RAW_TURN)

      const config = await call<Record<string, unknown>>(base, '/config')
      expect(config.evidenceClassificationEnabled).toBe(true)
      expect(config.unclassifiedEvidenceDisclosure).toBe('never_explicit')

      const session = await call<{ readonly redacted: boolean; readonly evidence: { readonly lineCount: number; readonly classificationCounts: unknown } }>(base, `/sessions/${SESSION_ID}`)
      expect(session.redacted).toBe(true)
      expect(session.evidence.lineCount).toBe(1)
      expect(session.evidence.classificationCounts).toEqual({ normal: 1, provisional_sensitive: 0, sensitive: 0, unclassified: 0 })

      // The management recall route does return the original, which is what makes the three routes below
      // a real absence rather than an unobservable channel.
      const recall = await call<{ readonly context: string }>(base, '/recall', { method: 'POST', body: JSON.stringify({ query: QUERY }) })
      expect(recall.context).toContain('B-417')
      const debug = await call<unknown>(base, '/recall/debug', { method: 'POST', body: JSON.stringify({ query: QUERY }) })
      for (const body of [JSON.stringify(config), JSON.stringify(session), JSON.stringify(debug)]) expect(body).not.toContain('B-417')
    } finally {
      await harness?.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('accepts the lower unclassified disclosure policy from profile configuration', async () => {
    const root = await mkdtemp(join(tmpdir(), 'riko-evidence-disclosure-'))
    let harness: LiveHarness | undefined
    try {
      harness = await startLiveHarness(['    recallEnabled: true', '    unclassifiedEvidenceDisclosure: user_explicit_only'], root)
      await appendUserTurn(harness, RAW_TURN)
      const config = await call<Record<string, unknown>>(harness.base, '/config')
      expect(config.unclassifiedEvidenceDisclosure).toBe('user_explicit_only')
      const ordinary = await call<{ readonly context: string }>(harness.base, '/recall', { method: 'POST', body: JSON.stringify({ query: '我的储物柜 B-417' }) })
      expect(ordinary.context).not.toContain('B-417')
      const explicit = await call<{ readonly context: string }>(harness.base, '/recall', { method: 'POST', body: JSON.stringify({ query: QUERY }) })
      expect(explicit.context).toContain('B-417')
    } finally {
      await harness?.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('lands the derived source record before the domain closes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'riko-evidence-drain-'))
    let harness: LiveHarness | undefined
    try {
      harness = await startLiveHarness(CONFIG, root)
      await appendUserTurn(harness, RAW_TURN)
      // Disposal is what ends the fixture's control over this root, so the check has to come after it.
      await harness.dispose(); harness = undefined
      const sources = join(root, 'storages', 'riko_memory', 'sources')
      const files = await readdir(sources).catch(() => [] as string[])
      const records = await Promise.all(files.map(file => readFile(join(sources, file), 'utf8')))
      expect(files.length).toBeGreaterThan(0)
      expect(records.some(record => record.includes(SESSION_ID))).toBe(true)
    } finally {
      await harness?.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('corpus capability contract', () => {
  it('reports a case that needs capture classification as unsupported, with its own reason, when the run has it off', async () => {
    const flagged = companionCorpus.filter(scenario => scenario.requiresEvidenceClassification === true)
    expect(flagged.map(scenario => scenario.id)).toEqual(['F.05', 'F.09', 'F.10'])
    for (const scenario of flagged) {
      const outcome = await executeCompanion(scenario, { evidenceClassification: false })
      expect(outcome.status, scenario.id).toBe('unsupported')
      expect(outcome.observedLabel, scenario.id).toBe('unsupported')
      expect(outcome.reason, scenario.id).toBe(evidenceClassificationUnsupportedReason(scenario))
      // Nothing ran: the refusal happens before a storage root or a Loader composition exists.
      expect(outcome.exchanges, scenario.id).toEqual([])
      expect(outcome.results, scenario.id).toEqual([])
    }
  })
})
