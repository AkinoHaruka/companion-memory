/**
 * What extraction proposes, and what the runtime decides to do about it.
 *
 * Pure. No model, no database, no clock. That matters because this is the part
 * of the host that must be correct, and every alternative to making it pure was
 * worse: the first version decided all of this inline inside a method that also
 * called a model, so nothing could test the decisions without paying for a call
 * and accepting whatever the model happened to return that time.
 *
 * A run showed why that was a problem. The contradiction turn extracted no
 * claims at all on one attempt, so the supersede path never executed, and a
 * scorer that looked for evidence of superseding found none and could not tell
 * whether the rule worked or was simply never reached.
 */

import { fallbackPredicate, isDeclared, specFor, type Cardinality } from './predicates.js';

/** One claim the model proposed. */
export interface Proposal {
  /** The predicate key it suggested. */
  predicate: string;
  /** The value. */
  value: string;
}

/** Where a proposal ended up. */
export interface Admission {
  /** The predicate it is stored under. */
  predicate: string;
  /** Its cardinality, so the caller knows whether to displace anything. */
  cardinality: Cardinality;
  /**
   * Active records in the same slot that this admission replaces.
   *
   * Empty for a set predicate, for the first value in a slot, and for a value
   * that merely restates one already held.
   */
  displaces: readonly string[];
  /** Whether the caller should write anything at all. */
  store: boolean;
  /** Why it was filed elsewhere or refused, when either happened. */
  note?: 'filed_as_misc' | 'duplicate' | 'empty';
}

/** An existing active record, as the decision needs to see it. */
export interface ExistingClaim {
  /** Its id. */
  id: string;
  /** Its predicate. */
  predicate: string;
  /** Its value. */
  value: string;
}

/**
 * Normalise a value for the equality check.
 *
 * Case and whitespace only, matching what the kernel's own comparison does. No
 * stemming and no synonymy: treating "designer" and "design" as the same thing
 * is how two facts get merged into one wrong one.
 */
function normalize(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * Decide what to do with one proposal.
 *
 * Three decisions in order, and the order matters.
 *
 * 1. **An undeclared predicate is filed under `misc.unclassified`.** Refusing it
 *    outright would discard a real statement because the model chose a word the
 *    vocabulary lacks; accepting it as written would let the model extend the
 *    vocabulary, so `communication.format` could hold "不用一直问我感受" and
 *    nothing could judge it. Filing under `misc` keeps the statement and keeps
 *    the vocabulary closed.
 * 2. **An empty value is refused.** There is nothing to remember.
 * 3. **A slot decides displacement.** A `single` predicate displaces whatever
 *    occupied its slot; a `set` accumulates. A proposal that restates a value
 *    already held displaces nothing, because superseding a record with its own
 *    duplicate would churn the audit trail and lose the original's provenance.
 *
 * @param proposal - what the model proposed.
 * @param existing - the active records in this relationship.
 * @returns what the caller should do.
 */
export function admit(proposal: Proposal, existing: readonly ExistingClaim[]): Admission {
  const value = proposal.value.trim();
  const declared = isDeclared(proposal.predicate);
  const predicate = declared ? proposal.predicate : fallbackPredicate();
  const spec = specFor(predicate);

  // The fallback is always declared, so this is a guard against the vocabulary
  // itself being misconfigured rather than against model output.
  const cardinality: Cardinality = spec?.cardinality ?? 'set';

  if (!value) {
    return { predicate, cardinality, displaces: [], store: false, note: 'empty' };
  }

  const sameSlot = existing.filter((claim) => claim.predicate === predicate);
  const restates = sameSlot.some((claim) => normalize(claim.value) === normalize(value));

  const admission: Admission = {
    predicate,
    cardinality,
    displaces: [],
    store: true,
    ...(declared ? {} : { note: 'filed_as_misc' as const }),
  };

  if (restates) {
    // Already held. Writing again would be a no-op with a new id, which loses
    // the provenance of the record that is actually there.
    return { ...admission, store: false, note: 'duplicate' };
  }

  if (cardinality === 'single') {
    return { ...admission, displaces: sameSlot.map((claim) => claim.id) };
  }
  return admission;
}

/**
 * Apply the admission rules to a batch.
 *
 * Sequenced rather than mapped, because a batch can contain two proposals for
 * one single-valued slot and the second must displace the first. Treating each
 * against the same starting state would let both be written.
 *
 * @param proposals - what the model proposed, in order.
 * @param existing - the active records in this relationship.
 * @returns one admission per proposal, in order.
 */
export function admitAll(
  proposals: readonly Proposal[],
  existing: readonly ExistingClaim[],
): Admission[] {
  const working = [...existing];
  const admissions: Admission[] = [];

  for (const proposal of proposals) {
    const admission = admit(proposal, working);
    admissions.push(admission);
    if (!admission.store) continue;
    for (const displaced of admission.displaces) {
      const index = working.findIndex((claim) => claim.id === displaced);
      if (index >= 0) working.splice(index, 1);
    }
    // The batch's own earlier writes compete with its later ones, so a proposal
    // is added to the working set under the id the caller will assign.
    working.push({
      id: `pending-${admissions.length}`,
      predicate: admission.predicate,
      value: proposal.value,
    });
  }

  return admissions;
}
