import { describe, expect, it } from 'vitest'
import {
  canConfirmCandidate,
  memoryScopeForPreset,
  type EvidenceRef,
  type MemoryCandidate,
} from '../src/contracts.ts'
import { validateConfig } from '../src/index.ts'

describe('native memory contracts', () => {
  it('rejects Dream endpoints that could disclose a credential in transit or in the URL', () => {
    const base = {
      ownerNamespace: 'riko', apiPath: '/memory/v1', apiToken: '', apiTokens: {}, apiTokenProfile: '', ownerAdminToken: '', dreamCredentialRef: 'DSH_MEMORY_DREAM_API_KEY', dreamModel: 'mimo-v2.5', dreamMaxTokens: 1200, dreamIntervalMs: 60_000, debounceMs: 0, maxResidentChars: 12_000, maxSessionChars: 40_000, recallEnabled: false, recallVectorEnabled: false, recallRawEvidenceEnabled: true, recallObservationEnabled: false, recallGraphEnabled: false, purgeEnabled: false, recallMaxCandidates: 8, recallMaxContextChars: 3_000, residentV2Enabled: true, residentBlocksEnabled: true, sensitiveResidentEnabled: false, temporalEnabled: true, evidenceClassificationEnabled: false, minObservationEvidence: 2, observationActivationMinEvidence: 3, observationActivationMinSessions: 2, observationActivationMinConfidence: 0.8, reflectionEnabled: false, reflectionMaxObservations: 3, temporalReconcileEnabled: false, embeddingProvider: 'off' as const, embeddingEndpoint: '', embeddingCredentialRef: 'DSH_MEMORY_EMBEDDING_API_KEY', embeddingModel: '', embeddingDimension: 256, unclassifiedEvidenceDisclosure: 'user_explicit_only' as const,
    }
    expect(() => validateConfig({ ...base, dreamApiUrl: 'http://provider.example/anthropic' })).toThrow(/https/i)
    expect(() => validateConfig({ ...base, dreamApiUrl: 'https://key@provider.example/anthropic' })).toThrow(/embedded credential/i)
  })

  it('fails closed when a stable agent preset is absent', () => {
    expect(() => memoryScopeForPreset('riko', undefined)).toThrow(/stable agent preset/i)
    expect(() => memoryScopeForPreset('riko', null)).toThrow(/stable agent preset/i)
    expect(() => memoryScopeForPreset('', 'preset-a')).toThrow(/owner namespace/i)
  })

  it('derives a stable scope from owner namespace and preset id only', () => {
    expect(memoryScopeForPreset('owner-a', 'preset-a')).toEqual({
      schemaVersion: 1,
      ownerNamespace: 'owner-a',
      stableAgentPresetId: 'preset-a',
      key: 'owner-a:preset-a',
    })
  })

  it('does not confirm a candidate from model-authored text', () => {
    const evidence: EvidenceRef = {
      schemaVersion: 1,
      sessionId: 'session-a',
      eventSeq: 4,
      sourceSpan: { start: 0, end: 18 },
    }
    const candidate: MemoryCandidate = {
      schemaVersion: 1,
      id: 'candidate-a',
      scope: memoryScopeForPreset('owner-a', 'preset-a'),
      title: '回答偏好',
      content: '用户喜欢简洁的回答',
      status: 'candidate',
      consent: 'pending',
      evidence: [evidence],
      source: 'dream',
      createdAt: '2026-09-17T00:00:00.000Z',
    }

    expect(canConfirmCandidate(candidate, '我喜欢简洁的回答')).toBe(false)
    expect(canConfirmCandidate(candidate, '请记住：用户喜欢简洁的回答')).toBe(true)
  })
})
