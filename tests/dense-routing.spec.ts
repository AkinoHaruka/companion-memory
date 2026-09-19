import { describe, expect, it } from 'vitest'
import { analyzeRecallQuery, fuseRecallChannels, shouldRunDense } from '../src/recall.ts'
import { documentFromEvidence } from '../src/recall.ts'

describe('dense recall routing', () => {
  it('turns dense retrieval off for utility and non-personal queries', () => {
    const plan = analyzeRecallQuery('What is a cafe?', { vectorEnabled: true })
    expect(plan.densePolicy).toBe('off')
    expect(plan.searchVector).toBe(false)
  })

  it('turns dense retrieval on for explicit paraphrastic historical recall', () => {
    const plan = analyzeRecallQuery('Do you remember what happened last time?', { vectorEnabled: true })
    expect(plan.densePolicy).toBe('on')
    expect(plan.searchVector).toBe(true)
    expect(shouldRunDense(plan, 'strong')).toBe(false)
    expect(shouldRunDense(plan, 'weak')).toBe(true)
  })

  it('gates conditional dense retrieval on lexical confidence', () => {
    const plan = analyzeRecallQuery('What do I prefer?', { vectorEnabled: true })
    expect(plan.densePolicy).toBe('conditional')
    expect(shouldRunDense(plan, 'strong')).toBe(false)
    expect(shouldRunDense(plan, 'weak')).toBe(true)
    expect(shouldRunDense(plan, 'none')).toBe(true)
  })

  it('enforces the dense candidate cap during fusion', () => {
    const documents = Array.from({ length: 4 }, (_, index) => documentFromEvidence('dense-session', index + 1, `dense candidate ${index + 1}`, undefined, 'normal'))
    const results = fuseRecallChannels({ dense: documents }, 'unrelated query', { maxCandidates: 4, denseCandidateCap: 2 })

    expect(results).toHaveLength(2)
    expect(results.map(result => result.id)).toEqual(['evidence:dense-session:1', 'evidence:dense-session:2'])
  })
})
