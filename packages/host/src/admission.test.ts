/**
 * The admission rules.
 *
 * These are the decisions the host makes about model output, and they are the
 * part that must be right regardless of how the model behaves. An earlier run
 * made them untestable by inlining them beside a model call; the contradiction
 * turn happened to extract nothing, so the supersede path never ran and no test
 * could tell a working rule from a rule that was never reached.
 */

import { describe, expect, it } from 'vitest';
import { admit, admitAll, type ExistingClaim } from './admission.js';

function existing(...pairs: [string, string][]): ExistingClaim[] {
  return pairs.map(([predicate, value], index) => ({ id: `c${index}`, predicate, value }));
}

describe('an undeclared predicate', () => {
  it('is filed under misc rather than stored as written', () => {
    // Accepting it would let the model extend the vocabulary; refusing it would
    // discard a real statement over a word choice. A run produced
    // `communication.format = 不用一直问我感受`, which is exactly this case.
    const admission = admit({ predicate: 'communication.formatting', value: '想简短点' }, []);
    expect(admission.predicate).toBe('misc.unclassified');
    expect(admission.store).toBe(true);
    expect(admission.note).toBe('filed_as_misc');
  });

  it('is filed under misc without displacing anything', () => {
    // misc is a set, so an unrecognised statement must not evict a classified
    // fact that happens to share nothing with it.
    const admission = admit(
      { predicate: 'work.stress_pattern', value: 'x' },
      existing(['communication.verbosity', '简短']),
    );
    expect(admission.displaces).toEqual([]);
  });
});

describe('an empty value', () => {
  it('is refused', () => {
    expect(admit({ predicate: 'identity.name', value: '   ' }, []).store).toBe(false);
  });
});

describe('a single-valued predicate', () => {
  it('displaces the value already in its slot', () => {
    // The whole reason the runtime needs this: a user changing their mind must
    // not leave two contradicting records that both reach the model.
    const admission = admit(
      { predicate: 'communication.verbosity', value: '聊正事时多讲细节' },
      existing(['communication.verbosity', '喜欢简短直接的回答']),
    );
    expect(admission.cardinality).toBe('single');
    expect(admission.displaces).toEqual(['c0']);
    expect(admission.store).toBe(true);
  });

  it('displaces nothing when the slot is empty', () => {
    expect(admit({ predicate: 'communication.verbosity', value: 'x' }, []).displaces).toEqual([]);
  });

  it('does not displace a value it merely restates', () => {
    // Superseding a record with its own duplicate churns the audit trail and
    // loses the provenance of the record that is already there.
    const admission = admit(
      { predicate: 'communication.verbosity', value: ' 喜欢简短直接的回答 ' },
      existing(['communication.verbosity', '喜欢简短直接的回答']),
    );
    expect(admission.store).toBe(false);
    expect(admission.note).toBe('duplicate');
    expect(admission.displaces).toEqual([]);
  });

  it('leaves another predicate alone', () => {
    const admission = admit(
      { predicate: 'communication.verbosity', value: 'x' },
      existing(['communication.language', '中文']),
    );
    expect(admission.displaces).toEqual([]);
  });
});

describe('a set-valued predicate', () => {
  it('accumulates rather than replacing', () => {
    // "I design, and I also teach painting" must not lose either half.
    const admission = admit(
      { predicate: 'identity.occupation', value: '美术老师' },
      existing(['identity.occupation', '设计师']),
    );
    expect(admission.cardinality).toBe('set');
    expect(admission.displaces).toEqual([]);
    expect(admission.store).toBe(true);
  });

  it('still refuses an exact duplicate', () => {
    const admission = admit(
      { predicate: 'identity.occupation', value: '设计师' },
      existing(['identity.occupation', '设计师']),
    );
    expect(admission.store).toBe(false);
  });
});

describe('a batch', () => {
  it('lets a later proposal displace an earlier one in the same batch', () => {
    // Sequenced rather than mapped. Two proposals for one single-valued slot
    // judged against the same starting state would both be written, which is
    // the accumulation the rule exists to prevent.
    const admissions = admitAll(
      [
        { predicate: 'communication.verbosity', value: '先说的' },
        { predicate: 'communication.verbosity', value: '后说的' },
      ],
      [],
    );
    expect(admissions[0]?.store).toBe(true);
    expect(admissions[1]?.store).toBe(true);
    // The second displaces the first's pending id, so only one survives.
    expect(admissions[1]?.displaces).toHaveLength(1);
  });

  it('does not let a batch defeat the duplicate check', () => {
    const admissions = admitAll(
      [
        { predicate: 'identity.name', value: '林越' },
        { predicate: 'identity.name', value: '林越' },
      ],
      [],
    );
    expect(admissions[0]?.store).toBe(true);
    expect(admissions[1]?.store).toBe(false);
    expect(admissions[1]?.note).toBe('duplicate');
  });

  it('keeps a set accumulation across a batch', () => {
    const admissions = admitAll(
      [
        { predicate: 'identity.occupation', value: '设计师' },
        { predicate: 'identity.occupation', value: '美术老师' },
      ],
      [],
    );
    expect(admissions.every((admission) => admission.store)).toBe(true);
    expect(admissions[1]?.displaces).toEqual([]);
  });

  it('reports one admission per proposal, in order', () => {
    const admissions = admitAll(
      [
        { predicate: 'identity.name', value: 'a' },
        { predicate: 'identity.name', value: 'b' },
        { predicate: 'identity.name', value: 'c' },
      ],
      [],
    );
    expect(admissions).toHaveLength(3);
    for (const admission of admissions) expect(admission.store).toBe(true);
  });
});

describe('the vocabulary mirror', () => {
  it('declares the predicates the extraction prompt lists', async () => {
    // The prompt tells the model which keys to use and admission decides which
    // keys exist. If those two lists drift, the prompt starts recommending keys
    // that get silently filed under misc, and nothing would say so.
    const { STATED_PREDICATES, DERIVED_PREDICATES, isDeclared } = await import('./predicates.js');
    expect(STATED_PREDICATES.length).toBeGreaterThan(30);
    for (const key of STATED_PREDICATES) expect(isDeclared(key), key).toBe(true);
    for (const key of DERIVED_PREDICATES) expect(isDeclared(key), key).toBe(true);
  });

  it('keeps stated and derived vocabularies apart', async () => {
    // A derived `identity.name` would be the model inventing a fact the user
    // never stated, which the consolidation pass must not be able to do.
    const { specFor } = await import('./predicates.js');
    expect(specFor('identity.name')?.source).toBe('stated');
    expect(specFor('pattern.recurring_theme')?.source).toBe('derived');
    expect(specFor('pattern.recurring_theme')?.cardinality).toBe('set');
  });
});
