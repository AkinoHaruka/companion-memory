import { describe, expect, it } from 'vitest'
import { adaptBenchmarkQuestion, benchmarkMemoryIntentPrefix } from './support/benchmark-query-adapter.ts'
import { mapLoCoMoTurn, mapLongMemEvalTurn } from './support/benchmark-transcript.ts'
import { analyzeRecallQuery } from '../src/recall.ts'

describe('external benchmark query adapter', () => {
  it('keeps the scored question separate while making memory intent explicit', () => {
    const question = ' Which cafe did I say was too noisy? '
    const plan = adaptBenchmarkQuestion({ question, asOf: '2024-06-01T00:00:00Z' })

    expect(plan.originalQuestion).toBe(question)
    expect(plan.retrievalQuery).toContain(benchmarkMemoryIntentPrefix())
    expect(plan.retrievalQuery).toContain('Which cafe did I say was too noisy?')
    expect(plan.asOf).toBe('2024-06-01T00:00:00Z')
    expect(plan.retrievalQuery).not.toContain('2024-06-01T00:00:00Z')
    expect(plan.originalQuestionDigest).toMatch(/^[0-9a-f]{64}$/u)
  })

  it('uses a memory cue without forcing ordinary questions into temporal intent', () => {
    expect(benchmarkMemoryIntentPrefix()).not.toMatch(/\b(before|earlier|last time|last year|recent)\b/iu)

    const cases = [
      { question: "What is the name of my hamster?", temporal: false },
      { question: 'Where did I attend for my study abroad program?', temporal: false },
      { question: "What is Gina's favorite style of dance?", temporal: false },
      { question: 'Who was I talking about?', temporal: false },
      { question: 'What did I do last year?', temporal: true },
    ] as const

    for (const testCase of cases) {
      const planner = analyzeRecallQuery(adaptBenchmarkQuestion({ question: testCase.question }).retrievalQuery)
      expect(planner.searchEvidence, testCase.question).toBe(true)
      expect(planner.intent, testCase.question).not.toBe('none')
      expect(planner.intent === 'temporal', testCase.question).toBe(testCase.temporal)
    }
  })

  it('does not read evaluation labels even when hostile extra fields are supplied', () => {
    const poison = 'GROUND_TRUTH_MUST_NOT_LEAK'
    const input = {
      question: 'What did I prefer last summer?',
      answer: poison,
      evidence: poison,
      has_answer: poison,
      answer_session_ids: [poison],
    } as unknown as { question: string }

    const plan = adaptBenchmarkQuestion(input)
    expect(plan.retrievalQuery).not.toContain(poison)
    expect(plan.originalQuestion).not.toContain(poison)
  })

  it('normalizes only retrieval whitespace and rejects empty questions', () => {
    const plan = adaptBenchmarkQuestion({ question: '  What\n\twas my plan?  ' })
    expect(plan.originalQuestion).toBe('  What\n\twas my plan?  ')
    expect(plan.retrievalQuery).toContain('What was my plan?')
    expect(() => adaptBenchmarkQuestion({ question: '   ' })).toThrow('non-empty')
  })

  it('uses one fixed LoCoMo speaker mapping and preserves the source speaker', () => {
    expect(mapLoCoMoTurn({ sessionId: 'session-1', speaker: 'Caroline', diaId: 'D1:1', text: 'hello' }, 'Caroline', 'Melanie')).toMatchObject({ role: 'user', sourceSpeaker: 'Caroline', eventId: 'D1:1' })
    expect(mapLoCoMoTurn({ sessionId: 'session-1', speaker: 'Melanie', diaId: 'D1:2', text: 'hi' }, 'Caroline', 'Melanie')).toMatchObject({ role: 'assistant', sourceSpeaker: 'Melanie', eventId: 'D1:2' })
    expect(() => mapLoCoMoTurn({ sessionId: 'session-1', speaker: 'Unknown', diaId: 'D1:3', text: 'x' }, 'Caroline', 'Melanie')).toThrow('unknown LoCoMo speaker')
  })

  it('preserves LongMemEval user and assistant roles without reading evaluation labels', () => {
    const poison = 'GROUND_TRUTH_MUST_NOT_LEAK'
    const turn = mapLongMemEvalTurn({ sessionId: 'session-2', role: 'assistant', turnIndex: 4, text: 'A prior response.' , answer: poison } as never)
    expect(turn).toEqual({ sessionId: 'session-2', eventId: 'session-2:turn-4', role: 'assistant', text: 'A prior response.' })
    expect(JSON.stringify(turn)).not.toContain(poison)
  })

  it('rejects malformed transcript turns before they reach a live harness', () => {
    expect(() => mapLongMemEvalTurn({ sessionId: 'session-2', role: 'user', turnIndex: -1, text: 'x' })).toThrow('turnIndex')
    expect(() => mapLoCoMoTurn({ sessionId: 'session-1', speaker: 'Caroline', diaId: 'D1:1', text: '' }, 'Caroline', 'Melanie')).toThrow('text')
  })
})
