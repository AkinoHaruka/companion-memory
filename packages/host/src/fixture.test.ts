/**
 * The fixture rules, tested the way the model-facing rules are not.
 *
 * Every defect this acceptance found in itself was a precondition that did not
 * hold while the run proceeded: three arms that could not store, a
 * counterfactual that fell back to gold, an anchor only the user had said, a
 * turn scored for recall whose memory was never recorded. Each produced a
 * complete table. These cases are those defects, and each must be refused
 * before the first model call rather than discovered in a batch of replies.
 */

import { describe, expect, it } from 'vitest';

import { validateFixture } from './fixture.js';
import { PROBES, SESSIONS, type SessionScript } from './script.js';

const script = (turns: SessionScript['turns']): SessionScript[] => [{ id: 'x', dayOffset: 0, turns }];

describe('fixture validation', () => {
  it('finds exactly the one turn in the shipped fixture that cannot be measured', () => {
    // s5t0 is scored for continuity and records no gold at all, so no reply to it
    // can be read as a recall. Ten of the eighteen continuity turns are this
    // turn, which is why its 0/16 in the recorded batch was structural rather
    // than a model result.
    const violations = validateFixture([...SESSIONS, ...PROBES]);
    expect(violations.map((violation) => [violation.turn, violation.rule, violation.fatal]))
      .toEqual([['s5t0', 'effect-without-evidence', false]]);
  });

  it('refuses an evidence token that no record admitted before the turn contains', () => {
    // The intervention has to exist by the time of the turn it is measured at.
    const violations = validateFixture(script([
      {
        intent: 'recall', text: '猫现在好多了。', memoryOpportunity: 'positive', effectType: 'continuity',
        recallEvidence: { strong: ['三点'], medium: [], weak: [] },
      },
    ]));
    expect(violations.map((violation) => [violation.rule, violation.fatal]))
      .toContainEqual(['evidence-not-in-prior-gold', true]);
  });

  it('refuses an evidence token the user themself said in that turn', () => {
    // A token the turn contains proves the reply echoed the user, not that it read memory.
    const violations = validateFixture(script([
      {
        intent: 'records it', text: '猫半夜吐了，折腾到三点。', memoryOpportunity: 'none', effectType: 'correct_silence',
        goldEpisodes: [{ narrative: '猫半夜吐了，折腾到三点。', quote: '猫半夜吐了，折腾到三点' }],
      },
      {
        intent: 'recall', text: '猫半夜还是折腾到三点。', memoryOpportunity: 'positive', effectType: 'continuity',
        recallEvidence: { strong: ['三点'], medium: [], weak: [] },
      },
    ]));
    expect(violations.map((violation) => [violation.rule, violation.fatal]))
      .toContainEqual(['evidence-in-user-text', true]);
  });

  it('refuses a counterfactual that restates gold, because that arm is not an intervention', () => {
    // Recorded: eighteen of twenty turns fell back to gold, so the "floor" was
    // gold under another name and its difference from the ceiling was sampling
    // noise. It was read as a causal control.
    const violations = validateFixture(script([
      {
        intent: 'contradiction', text: '关于简短我改主意了。', memoryOpportunity: 'positive', effectType: 'preference',
        gold: [{ predicate: 'communication.verbosity', value: 'long', rawValue: '多讲一点', quote: '关于简短' }],
        counterfactual: [{ predicate: 'communication.verbosity', value: 'long', rawValue: '多讲一点', quote: '关于简短' }],
      },
    ]));
    expect(violations.map((violation) => violation.rule)).toContain('counterfactual-equals-gold');
  });

  it('refuses a record that appears twice in one tier list, and a session that does not advance', () => {
    const twice = validateFixture(script([
      {
        intent: 'records', text: '猫半夜吐了。', memoryOpportunity: 'none', effectType: 'correct_silence',
        goldEpisodes: [{ narrative: '猫半夜吐了，折腾到三点。', quote: '猫半夜吐了' }],
      },
      {
        intent: 'recall', text: '它好多了。', memoryOpportunity: 'positive', effectType: 'continuity',
        recallEvidence: { strong: ['三点'], medium: ['三点'], weak: [] },
      },
    ]));
    expect(twice.map((violation) => violation.rule)).toContain('evidence-graded-twice');

    const backwards: SessionScript[] = [
      { id: 'a', dayOffset: 10, turns: [] },
      { id: 'b', dayOffset: 3, turns: [] },
    ];
    expect(validateFixture(backwards).map((violation) => violation.rule)).toContain('session-order');
  });
});
