/**
 * The host-side memory kernel.
 *
 * Implements the adapter's `MemoryKernel` interface against real storage and a
 * real model, which is what makes the whole loop runnable rather than only
 * testable in pieces.
 *
 * Three things happen here.
 *
 * **Extraction** turns a turn into records. The model proposes; this code
 * decides. Every proposal is checked against the predicate registry's shape and
 * against suppression before anything is stored, because a model that can write
 * unchecked is a model that can write its own beliefs as the user's facts.
 *
 * **Recall** is deliberately lexical. The kernel's own rules would score
 * candidates by salience and relevance, and reimplementing that ranking here
 * would be the parallel-implementation mistake this project already made once.
 * Terms are matched exactly, primitives survive a scope change, and the ranking
 * stays in one place.
 *
 * **Consolidation** is the dream pass: a batch read over everything accumulated,
 * producing beliefs that no single turn could justify. It runs outside the
 * conversation, because the thing it needs — independence across sessions — is
 * only visible in aggregate.
 */

import type {
  MemoryKernel,
  MemoryQuery,
  MemoryQueryResult,
  MemoryScope,
  ObservedMessage,
  ObservedOutcome,
  TurnState,
  WarmResult,
} from '../../dsh-plugin/src/memory.js';
import type { ContextCandidate, MentionLevel } from '../../dsh-plugin/src/memory.js';
import { AgnesClient, type ChatMessage } from './agnes.js';
import { HostStore, type StoredClaim, type StoredState } from './store.js';
import { EXTRACTION_SYSTEM, consolidationPrompt, replySystemPrompt } from './prompts.js';

/** How a record's mention level follows from where it came from. */
const MENTION_BY_PREDICATE_PREFIX: [string, MentionLevel][] = [
  // A boundary is a constraint the companion obeys, not a fact it recites.
  // Saying "I remember you asked me not to mention your ex" is itself the
  // behaviour the boundary forbade.
  ['boundary.', 'background_only'],
  // How to be supported is intimate; naming it back reads as clinical.
  ['support.', 'mention_if_user_cues'],
  ['advice.', 'mention_if_user_cues'],
  ['identity.age', 'never_surface'],
  // Identity, communication preferences and goals can be said out loud.
  ['identity.', 'freely_mentionable'],
  ['communication.', 'freely_mentionable'],
  ['goal.', 'freely_mentionable'],
  ['open_loop.', 'mention_if_user_cues'],
  ['ritual.', 'freely_mentionable'],
  ['person.', 'mention_if_user_cues'],
  ['relationship.', 'mention_if_user_cues'],
  ['misc.', 'mention_if_user_cues'],
];

/** The mention level a predicate implies, defaulting to the quiet option. */
export function mentionFor(predicate: string): MentionLevel {
  for (const [prefix, level] of MENTION_BY_PREDICATE_PREFIX) {
    if (predicate.startsWith(prefix)) return level;
  }
  return 'mention_if_user_cues';
}

/**
 * Predicates that hold several values at once.
 *
 * A set accumulates; everything else replaces whatever occupied its slot. This
 * mirrors `crates/kernel`'s `Cardinality`, and the duplication is deliberate
 * rather than an oversight: the cardinality table lives in the Rust registry,
 * the host runtime is TypeScript, and there is no generated binding between
 * them yet. What matters is that the *rule* is applied here — the first version
 * of this runtime wrote every extracted claim and never superseded anything,
 * which is this project's own documented failure mode reproduced in its own
 * host.
 *
 * A predicate missing from this list is treated as single-valued, because
 * failing toward replacement keeps one current value rather than accumulating
 * contradictions.
 */
const MULTI_VALUED_PREDICATES = new Set([
  'identity.location',
  'identity.occupation',
  'identity.role',
  'identity.language',
  'boundary.prohibition',
  'boundary.topic_avoid',
  'boundary.privacy_rule',
  'communication.format',
  'goal.long_term_objective',
  'goal.current_focus',
  'support.presence_style',
  'support.when_distressed',
  'ritual.recurring_activity',
]);

/**
 * Predicates a consolidation pass may use.
 *
 * The dream pass produces judgements rather than stated facts, so it draws on a
 * separate vocabulary: a derived `work.stress_pattern` is a legitimate belief,
 * while a derived `identity.name` would be the model inventing a fact the user
 * never stated. An earlier run stored `work.stress_pattern` unchecked, and
 * nothing in the runtime could say whether that was acceptable — which is the
 * same "unvalidated model output" hole the extraction side already closes.
 */
const DERIVED_PREDICATES = new Set([
  'pattern.recurring_theme',
  'pattern.behavioural',
  'pattern.emotional',
  'disposition.trait',
  'relational.dynamic',
  'self.impression',
  'principal.interest',
]);

/** Whether a predicate may be used by the consolidation pass. */
export function isDerivedPredicate(predicate: string): boolean {
  return DERIVED_PREDICATES.has(predicate);
}

/**
 * Normalise text for the matching this runtime performs.
 *
 * Case and whitespace only. No stemming and no synonymy: approximating meaning
 * without a model produces confident wrong answers, and the real matching lives
 * in the kernel.
 */
export function normalize(text: string): string {
  return text.trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * Interesting terms in a piece of text.
 *
 * ASCII words of two or more characters, plus overlapping bigrams for runs of
 * non-ASCII, which is what lets a short Chinese subject match inside a longer
 * sentence without a segmentation dependency.
 */
export function terms(text: string): string[] {
  const found = new Set<string>();
  for (const token of normalize(text).match(/[a-z0-9]+|[\u3400-\u9fff]+/g) ?? []) {
    if (/^[a-z0-9]+$/.test(token)) {
      if (token.length >= 2) found.add(token);
      continue;
    }
    if (token.length >= 2) found.add(token);
    for (let index = 0; index < token.length - 1; index += 1) {
      found.add(token.slice(index, index + 2));
    }
  }
  return [...found];
}

/** What one turn's extraction produced, for the run report. */
export interface ExtractionReport {
  /** Claims the model proposed. */
  proposed: number;
  /** Claims actually written. */
  stored: number;
  /** Proposals refused, with why. */
  refused: { predicate: string; reason: string }[];
  /** Episodes written. */
  episodes: number;
  /** The state the turn implied, when it implied one. */
  state?: TurnState;
}

/** What one dream pass produced. */
export interface DreamReport {
  /** Episodes the pass read. */
  readEpisodes: number;
  /** Claims the pass read. */
  readClaims: number;
  /** Beliefs it proposed. */
  proposed: number;
  /** Beliefs stored, after the independence check. */
  stored: { predicate: string; value: string; sessions: number }[];
  /** Proposals refused, with why. */
  refused: { value: string; reason: string }[];
}

/** The kernel's configuration. */
export interface HostKernelOptions {
  /** A model that can write records and narrate consolidation. */
  client: AgnesClient;
  /** Where records live. */
  store: HostStore;
  /** The relationship this kernel serves. */
  scope: MemoryScope;
  /** Supplies the current instant, injectable so a run is reproducible. */
  now?: () => string;
  /** Progress lines, for a run report. */
  log?: (line: string) => void;
}

/** The host-side memory kernel. */
export class HostKernel implements MemoryKernel {
  private readonly client: AgnesClient;
  private readonly store: HostStore;
  private readonly scope: MemoryScope;
  private readonly clock: () => string;
  private readonly log: (line: string) => void;
  /** The last turn's extraction, for the run report. */
  lastExtraction?: ExtractionReport;

  constructor(options: HostKernelOptions) {
    this.client = options.client;
    this.store = options.store;
    this.scope = options.scope;
    this.clock = options.now ?? (() => new Date().toISOString());
    this.log = options.log ?? (() => {});
  }

  /** The system prompt the companion speaks from, including its memory. */
  buildSystemPrompt(warmed: WarmResult): string {
    return replySystemPrompt(warmed);
  }

  /**
   * Recall everything this turn needs.
   *
   * @param _scope - unused; the kernel is bound to one relationship, and taking
   *   the scope as a parameter too would allow the two to disagree.
   * @param currentMessage - the turn's text, used to select records.
   * @param now - the instant, used to decide whether the condition is live.
   * @returns the stable block, the matching records and the live condition.
   */
  async warm(_scope: MemoryScope, currentMessage: string, now: string): Promise<WarmResult> {
    const claims = this.store.activeClaims(this.scope);
    const wanted = new Set(terms(currentMessage));

    const candidates: ContextCandidate[] = claims
      .filter((claim) => claim.mention !== 'never_surface')
      // A boundary is always in force rather than selected: it is an obligation,
      // not a candidate that competes for attention. Selecting it by keyword
      // would mean the companion forgets a prohibition on exactly the turn it
      // matters.
      .filter(
        (claim) =>
          claim.predicate.startsWith('boundary.') ||
          terms(`${claim.predicate} ${claim.value}`).some((term) => wanted.has(term)),
      )
      .slice(0, 12)
      .map((claim) => ({
        id: claim.id,
        text: `${claim.predicate}: ${claim.value}`,
        mention: claim.mention,
      }));

    const live = this.store.liveState(this.scope, now);
    const state = live ? toTurnState(live) : undefined;

    return {
      stable: this.stableBlock(claims),
      candidates,
      ...(state ? { now: state } : {}),
      revision: this.store.revision(this.scope),
    };
  }

  /**
   * The stable profile block.
   *
   * Identity, boundaries and communication preferences only. Goals and open
   * loops are deliberately excluded: they change and they are situational, so
   * putting them in the system prompt would both stale the request prefix and
   * present a temporary objective as a standing trait.
   */
  private stableBlock(claims: readonly StoredClaim[]): string {
    const stablePrefixes = ['identity.', 'boundary.', 'communication.'];
    const lines = claims
      .filter((claim) => stablePrefixes.some((prefix) => claim.predicate.startsWith(prefix)))
      .map((claim) => `- ${claim.predicate}: ${claim.value}`);
    return lines.join('\n');
  }

  /**
   * Record what a turn contained.
   *
   * The model proposes; this method decides. A proposal is refused when its
   * predicate is not in the vocabulary, when it would reintroduce forgotten
   * content, or when the model reports it came from the companion's own words.
   *
   * @param _scope - unused; see {@link warm}.
   * @param messages - the turn, both sides.
   * @param now - the instant.
   * @returns what was written.
   */
  async observe(
    _scope: MemoryScope,
    messages: readonly ObservedMessage[],
    now: string,
  ): Promise<ObservedOutcome> {
    const userText = messages
      .filter((message) => message.role === 'user')
      .map((message) => message.text)
      .join('\n')
      .trim();
    if (!userText) return { committed: false, pending: 0 };

    const payload = await this.client.chatJson(
      [
        { role: 'system', content: EXTRACTION_SYSTEM },
        { role: 'user', content: userText },
      ],
      { maxTokens: 1_200 },
    );

    const report: ExtractionReport = {
      proposed: 0,
      stored: 0,
      refused: [],
      episodes: 0,
    };

    for (const raw of asArray(payload.claims)) {
      const item = raw as Record<string, unknown>;
      const predicate = typeof item.predicate === 'string' ? item.predicate : '';
      const value = typeof item.value === 'string' ? item.value.trim() : '';
      if (!predicate || !value) continue;
      report.proposed += 1;

      const fingerprint = normalize(value);
      if (this.store.isSuppressed(this.scope, fingerprint)) {
        // The resurrection guard. Suppression that only filters reads leaves the
        // next extraction free to write the same fact back, which is the whole
        // reason a fingerprint is stored rather than only a deletion.
        report.refused.push({ predicate, reason: 'suppressed' });
        continue;
      }

      const confidence = clamp01(item.confidence);
      const importance = importanceFor(predicate, confidence);
      const id = `claim-${slug(predicate)}-${slug(value).slice(0, 40)}`;

      // The slot decision, which the first version of this runtime did not make
      // at all. Without it a user who changes their mind accumulates two
      // contradicting records, and both reach the model on the next turn — one
      // in the stable block and one in the relevant block, disagreeing inside a
      // single prompt. A run showed exactly that.
      if (!MULTI_VALUED_PREDICATES.has(predicate)) {
        for (const existing of this.store.activeClaims(this.scope)) {
          if (existing.predicate !== predicate) continue;
          if (normalize(existing.value) === normalize(value)) continue;
          this.store.supersedeClaim(this.scope, existing.id, now);
          this.store.audit(
            this.scope,
            {
              action: 'supersede',
              recordKind: 'claim',
              recordId: existing.id,
              detail: `replaced by ${id}`,
            },
            now,
          );
        }
      }

      this.store.putClaim(
        this.scope,
        {
          id,
          predicate,
          value,
          mention: mentionFor(predicate),
          sourceType: 'model_extraction',
          confidence,
          importance,
          status: 'active',
          rawValue: value,
          validFrom: now,
        },
        now,
      );
      this.store.audit(
        this.scope,
        { action: 'create', recordKind: 'claim', recordId: id, detail: predicate },
        now,
      );
      report.stored += 1;
    }

    for (const raw of asArray(payload.episodes)) {
      const item = raw as Record<string, unknown>;
      const narrative = typeof item.narrative === 'string' ? item.narrative.trim() : '';
      if (!narrative) continue;
      const id = `episode-${slug(narrative).slice(0, 48)}`;
      this.store.putEpisode(
        this.scope,
        {
          id,
          narrative,
          occurredFrom: now,
          ...(typeof item.user_reaction === 'string' && item.user_reaction.trim()
            ? { userReaction: item.user_reaction.trim() }
            : {}),
        },
        now,
      );
      report.episodes += 1;
    }

    const state = readState(payload.state, now);
    if (state) {
      this.store.putState(this.scope, state, now);
      const turnState = toTurnState(state);
      // Assigned rather than always set: with exact optional properties, an
      // explicit `undefined` is not the same as an absent field, and a report
      // that says "no state" should have no field rather than a null one.
      if (turnState) report.state = turnState;
    }

    this.lastExtraction = report;
    return { committed: report.stored > 0 || report.episodes > 0, pending: 0 };
  }

  /**
   * Record the conversation's present condition.
   *
   * Replaces rather than merges: this is the current condition, and a merge
   * would let a feeling from three turns ago persist by never being contradicted.
   *
   * @param _scope - unused; see {@link warm}.
   * @param state - the condition to record.
   * @param now - the instant, from which the deadline is derived.
   */
  async setState(_scope: MemoryScope, state: TurnState, now: string): Promise<void> {
    const expiresAt = new Date(Date.parse(now) + 4 * 3_600_000).toISOString();
    this.store.putState(
      this.scope,
      {
        ...(state.affect ? { affect: [...state.affect] } : {}),
        ...(state.apparentNeed ? { apparentNeed: state.apparentNeed } : {}),
        ...(state.topic ? { topic: state.topic } : {}),
        expiresAt,
      },
      now,
    );
  }

  /**
   * The dream pass: consolidate what accumulated into what it implies.
   *
   * Runs outside the conversation. The property it needs is independence across
   * sessions, which no single turn can observe, and the check for it is
   * deliberately mechanical rather than another model judgement: a belief whose
   * support comes from one session is refused, because three consecutive
   * evenings spent on one deadline are one cause rather than three
   * confirmations.
   *
   * @returns what the pass read, proposed and stored.
   */
  async dream(): Promise<DreamReport> {
    const episodes = this.store.episodes(this.scope);
    const claims = this.store.activeClaims(this.scope);
    const report: DreamReport = {
      readEpisodes: episodes.length,
      readClaims: claims.length,
      proposed: 0,
      stored: [],
      refused: [],
    };
    if (episodes.length < 2) {
      this.log('dream: not enough episodes to consolidate');
      return report;
    }

    const payload = await this.client.chatJson(
      [
        {
          role: 'system',
          content:
            'You consolidate a long conversation into beliefs about the person. Return JSON only. ' +
            'Ground every belief in the material given; do not invent. ' +
            'Prefer beliefs that no single exchange could justify. ' +
            'If the material shows nothing durable, return an empty list rather than a weak guess.',
        },
        { role: 'user', content: consolidationPrompt(episodes, claims) },
      ],
      { maxTokens: 1_200 },
    );

    for (const raw of asArray(payload.beliefs)) {
      const item = raw as Record<string, unknown>;
      const value = typeof item.value === 'string' ? item.value.trim() : '';
      const predicate = typeof item.predicate === 'string' ? item.predicate.trim() : '';
      if (!value) continue;
      report.proposed += 1;

      // A derived predicate, from a closed set. An earlier run stored
      // `work.stress_pattern`, which no vocabulary declares, so nothing could
      // judge it. Refusing is the conservative direction: a belief that has no
      // place to live is not yet a belief the system can reason about.
      if (!isDerivedPredicate(predicate)) {
        report.refused.push({
          value,
          reason: `predicate not in the derived vocabulary: ${predicate || '(missing)'}`,
        });
        continue;
      }

      // Independence, checked rather than asserted. The model is asked for the
      // episode ids it grounded the belief in and this counts the distinct
      // episodes among them; a belief resting on one is refused.
      const groundedIn = asArray(item.episode_ids)
        .map((id) => String(id))
        .filter((id) => episodes.some((episode) => episode.id === id));
      if (groundedIn.length < 2) {
        report.refused.push({ value, reason: `grounded in ${groundedIn.length} episode(s)` });
        continue;
      }

      const confidence = Math.min(0.65, clamp01(item.confidence));
      const id = `belief-${slug(value).slice(0, 48)}`;
      // A belief learned through extraction rather than stated by the user stays
      // background: it is the companion's impression, and announcing an
      // impression as a fact is the failure this cap and level exist to prevent.
      this.store.putClaim(
        this.scope,
        {
          id,
          predicate,
          value,
          mention: 'background_only',
          sourceType: 'dream_consolidation',
          confidence,
          importance: 0.4,
          status: 'active',
          validFrom: this.clock(),
        },
        this.clock(),
      );
      this.store.audit(
        this.scope,
        {
          action: 'consolidate',
          recordKind: 'claim',
          recordId: id,
          detail: `grounded in ${groundedIn.length} episodes`,
        },
        this.clock(),
      );
      report.stored.push({ predicate, value, sessions: groundedIn.length });
    }

    this.log(
      `dream: read ${episodes.length} episodes, ${claims.length} claims; ` +
        `proposed ${report.proposed}, stored ${report.stored.length}, refused ${report.refused.length}`,
    );
    return report;
  }

  /** Answer a question the model asked through the tool. */
  async query(_scope: MemoryScope, request: MemoryQuery): Promise<MemoryQueryResult> {
    switch (request.kind) {
      case 'search': {
        const wanted = terms(request.terms);
        const hits = this.store
          .activeClaims(this.scope)
          .filter((claim) => terms(`${claim.predicate} ${claim.value}`).some((t) => wanted.includes(t)))
          .slice(0, request.limit ?? 8);
        return {
          text: hits.map((claim) => `${claim.predicate}: ${claim.value}`).join('\n'),
          recordIds: hits.map((claim) => claim.id),
        };
      }
      case 'forget': {
        const target = normalize(request.target);
        const match = this.store
          .activeClaims(this.scope)
          .find((claim) => normalize(claim.value).includes(target));
        if (!match) return { text: 'Nothing matched closely enough to forget.', recordIds: [] };
        this.store.supersedeClaim(this.scope, match.id, this.clock());
        // The fingerprint is what stops the next extraction from writing the
        // same fact back, so forgetting records the content rather than only
        // removing the row.
        this.store.suppressFingerprint(this.scope, normalize(match.value), match.value, this.clock());
        this.store.audit(
          this.scope,
          { action: 'forget', recordKind: 'claim', recordId: match.id, detail: match.value },
          this.clock(),
        );
        return { text: `Forgotten: ${match.value}`, recordIds: [match.id] };
      }
      case 'explain': {
        const claim = this.store
          .activeClaims(this.scope)
          .find((candidate) => candidate.id === request.recordId);
        return claim
          ? { text: `${claim.predicate}: ${claim.value} (confidence ${claim.confidence})`, recordIds: [claim.id] }
          : { text: 'No such record.', recordIds: [] };
      }
    }
  }
}

/**
 * Build a `TurnState` from a stored condition.
 *
 * The stored `apparentNeed` is a string, because a database column has no union
 * type, so it is narrowed by membership rather than cast. An unrecognised value
 * is dropped rather than passed through: the adapter's stance table is keyed by
 * the union, and a value outside it would render as a stance the companion does
 * not have.
 */
function toTurnState(stored: StoredState): TurnState | undefined {
  const affect = stored.affect?.filter((label) => label.trim().length > 0) ?? [];
  const need = APPARENT_NEEDS.find((candidate) => candidate === stored.apparentNeed);
  const topic = stored.topic?.trim();
  if (affect.length === 0 && !need && !topic) return undefined;
  return {
    ...(affect.length > 0 ? { affect } : {}),
    ...(need ? { apparentNeed: need } : {}),
    ...(topic ? { topic } : {}),
  };
}

/** The needs the adapter knows how to render a stance for. */
const APPARENT_NEEDS = [
  'listen',
  'validate',
  'clarify',
  'support',
  'problem_solve',
  'neutral',
] as const;

/** Coerce a value to an array, so a missing section reads as empty. */
function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** Clamp a confidence into `[0, 1]`, treating anything unusable as low. */
function clamp01(value: unknown): number {
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(number)) return 0.3;
  return Math.min(1, Math.max(0, number));
}

/**
 * Base importance for a predicate.
 *
 * A boundary outranks everything because it is an obligation; a stated
 * preference outranks an observation because the user said it.
 */
function importanceFor(predicate: string, confidence: number): number {
  const base = predicate.startsWith('boundary.')
    ? 1
    : predicate.startsWith('identity.') || predicate.startsWith('communication.')
      ? 0.8
      : predicate.startsWith('goal.') || predicate.startsWith('support.')
        ? 0.6
        : 0.4;
  return Math.min(1, base * (0.5 + confidence / 2));
}

/** A stable, collision-resistant id fragment from arbitrary text. */
function slug(text: string): string {
  return normalize(text).replace(/[^a-z0-9\u3400-\u9fff]+/g, '-').replace(/^-+|-+$/g, '');
}

/** Read the state section of an extraction result. */
function readState(raw: unknown, now: string): StoredState | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const item = raw as Record<string, unknown>;
  const affect = asArray(item.affect).map((label) => String(label)).filter(Boolean);
  const need = typeof item.apparent_need === 'string' ? item.apparent_need.trim() : '';
  const topic = typeof item.topic === 'string' ? item.topic.trim() : '';
  if (affect.length === 0 && !need && !topic) return undefined;
  return {
    ...(affect.length > 0 ? { affect } : {}),
    ...(need ? { apparentNeed: need } : {}),
    ...(topic ? { topic } : {}),
    expiresAt: new Date(Date.parse(now) + 4 * 3_600_000).toISOString(),
  };
}
