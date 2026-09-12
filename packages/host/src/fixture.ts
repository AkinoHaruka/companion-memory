/**
 * Whether the frozen fixture can demonstrate the effects it is scored on.
 *
 * Every defect this acceptance has found in itself was, at bottom, a fixture or
 * harness precondition that did not hold while the run proceeded anyway: three
 * arms that could not store their records, a `counterfactual` that fell back to
 * gold and was read as a floor, an anchor word that only the user had said, a
 * turn scored for recall whose memory was never recorded. The run produced a
 * complete table each time.
 *
 * These checks all run before the first model call, because the cost of finding
 * them afterwards is a batch of replies that cannot be interpreted. They come in
 * two kinds. A fatal one means the fixture contradicts itself and the run is
 * refused. A non-fatal one means this turn cannot support the effect it declares
 * -- the run may proceed, that turn's observation is `not_applicable`, and the
 * summary refuses to read it.
 */

import type { EffectType, SessionScript, UserTurn } from './script.js';

export interface FixtureViolation {
  /** `s4t0`, so a violation names the turn it is about. */
  turn: string;
  /** Short stable identifier, so a case can assert on it without matching prose. */
  rule: string;
  detail: string;
  /**
   * Fatal means the fixture is internally inconsistent and no run over it can
   * mean anything. Non-fatal means a declared effect is unmeasurable here.
   */
  fatal: boolean;
}

/**
 * The effects whose definition is "the reply used a record".
 *
 * Not every effect needs a record to exist: the silence effects are about
 * restraint, and `language` is about what language the user asked for. An
 * effect in this set is scored for reading memory, so a turn that scores it must
 * declare what it would take to see that.
 */
const EVIDENCE_REQUIRED_EFFECTS: readonly EffectType[] = ['continuity'];
const PROTECTION_EFFECTS: readonly EffectType[] = ['boundary_silence', 'background_silence'];

/** Every piece of human-verified text a turn contributes to memory. */
function goldTextOf(turn: UserTurn): string[] {
  const claims = (turn.gold ?? []).flatMap((candidate) => [
    candidate.quote,
    candidate.rawValue,
    typeof candidate.value === 'string' ? candidate.value : '',
  ]);
  const episodes = (turn.goldEpisodes ?? []).flatMap((episode) => [episode.quote, episode.narrative]);
  return [...claims, ...episodes].filter((text) => text.length > 0);
}

const tiersOf = (turn: UserTurn): Array<{ grade: string; token: string }> => {
  const evidence = turn.recallEvidence;
  if (evidence === undefined) return [];
  return [
    ...evidence.strong.map((token) => ({ grade: 'strong', token })),
    ...evidence.medium.map((token) => ({ grade: 'medium', token })),
    ...evidence.weak.map((token) => ({ grade: 'weak', token })),
  ];
};

/**
 * Validate one frozen script.
 *
 * The provenance rule is deliberately about what memory existed *by then* rather
 * than about the fixture as a whole: a token has to come from a record that was
 * admitted before the turn that recalls it, or the recall it is measuring is not
 * of anything that happened yet.
 */
export function validateFixture(sessions: readonly SessionScript[]): FixtureViolation[] {
  const violations: FixtureViolation[] = [];

  const seenIds = new Set<string>();
  let previousDay = Number.NEGATIVE_INFINITY;
  for (const session of sessions) {
    if (seenIds.has(session.id)) {
      violations.push({ turn: session.id, rule: 'session-id-unique', detail: `session id ${session.id} appears more than once`, fatal: true });
    }
    seenIds.add(session.id);
    if (session.dayOffset <= previousDay) {
      violations.push({ turn: session.id, rule: 'session-order', detail: `dayOffset ${session.dayOffset} does not advance past the previous session's ${previousDay}; a record admitted "later" would be recallable before it exists`, fatal: true });
    }
    previousDay = session.dayOffset;
  }

  // Human-verified memory accumulated strictly before the current turn.
  const memorySoFar: string[] = [];
  for (const session of sessions) {
    for (const [index, turn] of session.turns.entries()) {
      const label = `${session.id}t${index}`;
      const tiers = tiersOf(turn);
      const recordsThisTurn = (turn.gold?.length ?? 0) + (turn.goldEpisodes?.length ?? 0) > 0;

      const graded = new Set<string>();
      for (const { grade, token } of tiers) {
        if (graded.has(token)) {
          violations.push({ turn: label, rule: 'evidence-graded-twice', detail: `"${token}" is declared in more than one tier (the later one is ${grade})`, fatal: true });
        }
        graded.add(token);
        if (turn.text.includes(token)) {
          violations.push({ turn: label, rule: 'evidence-in-user-text', detail: `"${token}" occurs in this turn's own user text, so a reply containing it proves nothing about memory`, fatal: true });
        }
        if (!memorySoFar.some((text) => text.includes(token))) {
          violations.push({ turn: label, rule: 'evidence-not-in-prior-gold', detail: `"${token}" does not occur in any human-verified record admitted before this turn, so the recall it measures is not recall of anything`, fatal: true });
        }
      }

      if (EVIDENCE_REQUIRED_EFFECTS.includes(turn.effectType) && turn.recallEvidence === undefined) {
        const hasGold = (turn.gold?.length ?? 0) + (turn.goldEpisodes?.length ?? 0) > 0;
        violations.push({
          turn: label,
          rule: 'effect-without-evidence',
          detail: `effectType "${turn.effectType}" is scored for using memory, but this turn declares no recallEvidence, so no reply to it can be read as a recall ${hasGold ? 'even though it records gold' : 'and it records none of its own either'}`,
          fatal: false,
        });
      }
      if (tiers.length > 0 && turn.memoryOpportunity !== 'positive') {
        violations.push({ turn: label, rule: 'evidence-without-opportunity', detail: `recallEvidence is declared on a turn marked ${turn.memoryOpportunity}, so the effect it supports is not being asked for`, fatal: false });
      }

      if (PROTECTION_EFFECTS.includes(turn.effectType)) {
        const protection = turn.protectionEvidence;
        if (protection !== undefined) {
          const { tokens, surfaces } = protection;
          if (tokens.length === 0) {
            violations.push({ turn: label, rule: 'protection-tokens-empty', detail: 'a protection observation needs at least one token whose appearance would surface the record', fatal: true });
          }
          if (surfaces.length === 0) {
            violations.push({ turn: label, rule: 'protection-surfaces-empty', detail: 'a protection observation needs a background_only or never_surface visibility class', fatal: true });
          }
          for (const token of tokens) {
            if (turn.text.includes(token)) {
              violations.push({ turn: label, rule: 'protection-token-in-user-text', detail: `"${token}" occurs in this turn's own user text, so a reply containing it could be an echo rather than a surfaced memory`, fatal: true });
            }
          }
        }
        // A declaration or admission can only echo the user. It is valuable as
        // setup, but cannot show whether a previously rendered protection holds.
        if (recordsThisTurn) {
          violations.push({ turn: label, rule: 'protection-on-recording-turn', detail: 'this turn declares or records memory, so its reply can only acknowledge the current text; protection is measurable only on a later turn', fatal: false });
        } else if (protection === undefined) {
          violations.push({ turn: label, rule: 'protection-without-evidence', detail: `effectType "${turn.effectType}" declares no protected token and visibility class, so no reply can be attributed to a rendered protection record`, fatal: false });
        } else {
          for (const token of protection.tokens) {
            if (!memorySoFar.some((text) => text.includes(token))) {
              violations.push({ turn: label, rule: 'protection-token-not-in-prior-gold', detail: `"${token}" does not occur in a human-verified record admitted before this turn, so the fixture has no protected memory to render`, fatal: true });
            }
          }
        }
      }

      if (turn.counterfactual !== undefined) {
        const gold = turn.gold ?? [];
        const contradicts = turn.counterfactual.some((candidate) => gold.every((real) => real.predicate !== candidate.predicate || JSON.stringify(real.value) !== JSON.stringify(candidate.value)));
        if (turn.counterfactual.length === 0) {
          violations.push({ turn: label, rule: 'counterfactual-empty', detail: 'counterfactual is declared but empty, which falls back to gold', fatal: true });
        } else if (!contradicts) {
          violations.push({ turn: label, rule: 'counterfactual-equals-gold', detail: 'every counterfactual proposal restates a gold value, so this arm is not an intervention -- it is gold with another label', fatal: true });
        }
      }

      memorySoFar.push(...goldTextOf(turn));
    }
  }
  return violations;
}

/** The turns whose declared effect cannot be measured, with the reason to report. */
export function unmeasurableTurns(sessions: readonly SessionScript[]): Map<string, string> {
  const unmeasurable = new Map<string, string>();
  for (const violation of validateFixture(sessions)) {
    if (violation.fatal) continue;
    unmeasurable.set(violation.turn, `${violation.rule}: ${violation.detail}`);
  }
  return unmeasurable;
}

export function fatalViolations(sessions: readonly SessionScript[]): FixtureViolation[] {
  return validateFixture(sessions).filter((violation) => violation.fatal);
}
