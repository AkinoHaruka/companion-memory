/**
 * A minimal in-memory `MemoryKernel`.
 *
 * Its purpose is to make the adapter testable and to be a working default before
 * the Rust kernel is wired in over JSON-RPC. It is **not** a reimplementation of
 * the kernel's rules and must not become one: cardinality dispatch, supersede,
 * the mention gate's cue logic, suppression closure and the inference lifecycle
 * all live in `crates/kernel`, tested there. Duplicating them here would
 * recreate exactly the parallel-implementation problem that made the TypeScript
 * prototype worth deleting.
 *
 * What it does implement is the smallest thing that is still honest:
 *
 *   - records are held per profile, so scope isolation is real
 *   - a record's mention level is honoured, including `never_surface`
 *   - `forget` suppresses by exact fingerprint and refuses to resurrect
 *   - `observe` reports honestly that it committed nothing
 *
 * The last point is deliberate. Automatic extraction is a model call, which is
 * the host's job, so this kernel has nothing to commit. Reporting `committed:
 * true` would make the adapter's tests pass against a claim that is not true.
 */

import type {
  ContextCandidate,
  MemoryKernel,
  MemoryQuery,
  MemoryQueryResult,
  MemoryScope,
  MentionLevel,
  ObservedMessage,
  ObservedOutcome,
  TurnState,
  WarmResult,
} from './memory.js';
import { profileKey } from './turn-cache.js';

/** One remembered record. */
export interface MemoryRecord {
  /** Stable id. */
  id: string;
  /** The text the model would see. */
  text: string;
  /** How loudly it may appear. */
  mention: MentionLevel;
  /**
   * Terms that make it relevant to a turn.
   *
   * A stand-in for the kernel's scoring. Kept explicit so a test can predict
   * which candidate wins without reimplementing a ranking function.
   */
  terms: readonly string[];
}

/**
 * Normalise text for the deliberately exact comparisons used here.
 *
 * Case and surrounding whitespace only. No stemming and no synonymy, because
 * approximating meaning without a model produces confident wrong answers, and
 * the real matching lives in the kernel.
 */
function normalize(text: string): string {
  return text.trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * Whether a condition stamped `expiresAt` is still in force at `now`.
 *
 * An unparseable instant on either side counts as expired. That is the safe
 * direction: a malformed deadline makes the reading vanish rather than persist,
 * and a missing reading is a reply shaped only by what the user just said.
 */
function isLive(expiresAt: string, now: string): boolean {
  const expiry = Date.parse(expiresAt);
  const instant = Date.parse(now);
  if (Number.isNaN(expiry) || Number.isNaN(instant)) return false;
  return expiry > instant;
}

/** How many candidates one turn may carry, matching the kernel's surfacing pool. */
const DEFAULT_CEILING = 8;

/** How long a condition stays live, when the caller does not say. */
const DEFAULT_STATE_HOURS = 4;

/**
 * The instant a condition recorded at `now` stops applying.
 *
 * Parsed from the ISO 8601 instant rather than read from a clock, so a test can
 * drive expiry with a fixed timestamp and the result is reproducible. A `now`
 * that cannot be parsed yields the same instant, which makes the state expire
 * immediately instead of silently living forever — the failure that would let a
 * stale reading persist.
 */
function defaultStateExpiry(now: string): string {
  const parsed = Date.parse(now);
  if (Number.isNaN(parsed)) return now;
  return new Date(parsed + DEFAULT_STATE_HOURS * 3_600_000).toISOString();
}

/** An in-memory memory implementation, for tests and as a working default. */
export class InMemoryKernel implements MemoryKernel {
  private readonly records = new Map<string, MemoryRecord[]>();
  private readonly suppressed = new Map<string, Set<string>>();
  private readonly stable = new Map<string, string>();
  /**
   * The present condition per profile, with the instant it expires.
   *
   * Held alongside its deadline so a stale reading is withheld rather than
   * served. That is the whole reason this layer is separate from records: a
   * condition that outlives its moment becomes a claim about the person.
   */
  private readonly state = new Map<string, { state: TurnState; expiresAt: string }>();
  private revision = 0;

  /** Add or replace a record for a profile. */
  remember(scope: MemoryScope, record: MemoryRecord): void {
    const key = profileKey(scope);
    const existing = this.records.get(key) ?? [];
    const without = existing.filter((candidate) => candidate.id !== record.id);
    this.records.set(key, [...without, record]);
    this.revision += 1;
  }

  /** Set the stable profile block for a profile. */
  setStable(scope: MemoryScope, text: string): void {
    this.stable.set(profileKey(scope), text);
    this.revision += 1;
  }

  /** Suppress a record by id, as a forget request would. */
  suppress(scope: MemoryScope, recordId: string): boolean {
    const key = profileKey(scope);
    const records = this.records.get(key) ?? [];
    const record = records.find((candidate) => candidate.id === recordId);
    if (!record) return false;
    const set = this.suppressed.get(key) ?? new Set<string>();
    set.add(normalize(record.text));
    this.suppressed.set(key, set);
    this.records.set(
      key,
      records.filter((candidate) => candidate.id !== recordId),
    );
    this.revision += 1;
    return true;
  }

  /** Whether a value would reintroduce suppressed content. */
  wouldResurrect(scope: MemoryScope, text: string): boolean {
    return this.suppressed.get(profileKey(scope))?.has(normalize(text)) ?? false;
  }

  /** Everything currently held for a profile, for assertions. */
  all(scope: MemoryScope): readonly MemoryRecord[] {
    return this.records.get(profileKey(scope)) ?? [];
  }

  async warm(scope: MemoryScope, currentMessage: string, now: string): Promise<WarmResult> {
    const key = profileKey(scope);
    const message = normalize(currentMessage);
    const records = this.records.get(key) ?? [];

    const candidates: ContextCandidate[] = records
      .filter((record) => record.mention !== 'never_surface')
      .filter((record) => record.terms.some((term) => message.includes(normalize(term))))
      .slice(0, DEFAULT_CEILING)
      .map((record) => ({ id: record.id, text: record.text, mention: record.mention }));

    // A condition past its deadline is withheld rather than served. Serving it
    // would let last week's mood shape this week's reply, and nothing in the
    // output would look wrong.
    //
    // Compared as instants, not as strings. Lexicographic ordering cannot tell a
    // malformed expiry from a valid one, so a bad timestamp would compare as
    // "still live" and the reading would persist indefinitely.
    const held = this.state.get(key);
    const live = held && isLive(held.expiresAt, now) ? held.state : undefined;

    return {
      stable: this.stable.get(key) ?? '',
      candidates,
      ...(live ? { now: live } : {}),
      revision: this.revision,
    };
  }

  async setState(scope: MemoryScope, state: TurnState, now: string): Promise<void> {
    // Default lifetime is the session, expressed as an absolute instant so a
    // later read can decide freshness without consulting a clock of its own.
    const expiresAt = defaultStateExpiry(now);
    this.state.set(profileKey(scope), { state, expiresAt });
    this.revision += 1;
  }

  /** The live condition for a profile, for assertions. */
  currentState(scope: MemoryScope, now: string): TurnState | undefined {
    const held = this.state.get(profileKey(scope));
    return held && isLive(held.expiresAt, now) ? held.state : undefined;
  }

  /** Clear the condition, as a profile reset would. */
  clearState(scope: MemoryScope): void {
    this.state.delete(profileKey(scope));
  }

  async observe(
    _scope: MemoryScope,
    _messages: readonly ObservedMessage[],
    _now: string,
  ): Promise<ObservedOutcome> {
    // Extraction is a model call and therefore the host's job; this kernel has
    // nothing of its own to commit. Saying otherwise would let the adapter's
    // tests pass against something that is not happening.
    return { committed: false, pending: 0 };
  }

  async query(scope: MemoryScope, request: MemoryQuery): Promise<MemoryQueryResult> {
    switch (request.kind) {
      case 'search': {
        const terms = normalize(request.terms);
        const limit = request.limit ?? DEFAULT_CEILING;
        const hits = this.all(scope)
          .filter((record) => record.terms.some((term) => normalize(term).includes(terms)))
          .slice(0, limit);
        return {
          text: hits.map((record) => record.text).join('\n'),
          recordIds: hits.map((record) => record.id),
        };
      }
      case 'forget': {
        const records = this.all(scope);
        // Exact text match rather than a similarity guess: deleting the wrong
        // record is worse than failing to delete the right one, and a
        // near-match heuristic without a model is a guess.
        const target = records.find((record) => normalize(record.text) === normalize(request.target));
        if (!target) return { text: 'No record matched that exactly.', recordIds: [] };
        this.suppress(scope, target.id);
        return { text: `Forgotten: ${target.text}`, recordIds: [target.id] };
      }
      case 'explain': {
        const record = this.all(scope).find((candidate) => candidate.id === request.recordId);
        return record
          ? { text: `${record.id}: ${record.text}`, recordIds: [record.id] }
          : { text: 'No such record.', recordIds: [] };
      }
    }
  }
}
