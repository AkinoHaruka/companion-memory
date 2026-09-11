/**
 * Per-turn warm cache.
 *
 * The host evaluates prompt providers synchronously while assembling a request,
 * but memory recall needs I/O. This cache is the bridge: the asynchronous
 * pre-step hook fills it, and the synchronous providers read from it.
 *
 * ## Why the key is a profile and not a turn
 *
 * The obvious design keys entries by turn, so a turn that never warmed cannot
 * read a previous turn's value. The host does not allow that: a prompt provider
 * receives `AssembleContext`, which carries only `scope` and `signal`. There is
 * no turn or trace identifier to key on, so a turn-keyed cache is not
 * expressible against this API.
 *
 * What is left, and what this class implements, is a single slot per profile
 * plus a published revision. Freshness then rests on `agent/pre-step` running
 * before prompt assembly for the same step — which is what the pre-step seam
 * exists for, and is verified by the integration test rather than assumed here.
 *
 * The residual risk is narrow and named: if pre-step and assembly ever interleave
 * for one profile, a provider could read the neighbouring turn's value. Two
 * things make that visible rather than silent — every warm result carries its
 * revision, and both rendered blocks expose it, so a mismatch is detectable in a
 * transcript. Guessing a turn boundary here would have hidden the same bug
 * instead.
 *
 * ## Why publishing is atomic
 *
 * `publish` takes a whole result. Publishing fields individually would let a
 * reader observe a half-warmed turn: a stable block from this turn beside
 * candidates from the last one, which is worse than reading nothing, because it
 * looks coherent.
 */

import type { MemoryScope, WarmResult } from './memory.js';

/**
 * The key a warm result is stored under.
 *
 * The relationship profile, serialised the same way the kernel serialises it, so
 * that "same profile" has one definition across the boundary.
 */
export function profileKey(scope: MemoryScope): string {
  // NUL-separated: every component is a free-form identifier, so any printable
  // separator would eventually appear inside one and collide two profiles.
  return [scope.serviceId, scope.ownerUserId, scope.companionProfileId].join('\u0000');
}

/**
 * The warm values currently held.
 *
 * `publish` is the only way in, it takes the whole result, and `read` returns
 * exactly what was published or nothing.
 */
export class TurnCache {
  private readonly entries = new Map<string, WarmResult>();

  /**
   * Publish a completed warm result for a profile.
   *
   * Called after the memory read succeeded, and only then. A failed warm leaves
   * the slot untouched, so the turn has no memory rather than stale memory.
   */
  publish(scope: MemoryScope, result: WarmResult): void {
    this.entries.set(profileKey(scope), result);
  }

  /**
   * Read the warm result for a profile, synchronously.
   *
   * Returns `undefined` when nothing has been warmed, which every caller must
   * treat as "no memory" rather than reaching for a default.
   */
  read(scope: MemoryScope): WarmResult | undefined {
    return this.entries.get(profileKey(scope));
  }

  /** Drop a profile's entry, for teardown. */
  release(scope: MemoryScope): void {
    this.entries.delete(profileKey(scope));
  }

  /** How many profiles are held, for tests and diagnostics. */
  size(): number {
    return this.entries.size;
  }
}

/**
 * Coalesce concurrent warms for the same profile.
 *
 * Pre-step can run more than once for one logical step, and each run would
 * otherwise issue its own recall. The first caller's promise is shared so the
 * read happens once. A rejection is deliberately **not** retained: a transient
 * read failure must be retryable on the next step rather than fatal for the
 * profile's whole turn.
 */
export class WarmCoalescer {
  private readonly inFlight = new Map<string, Promise<WarmResult>>();

  /** Run `warm`, or join the run already in flight for this profile. */
  run(scope: MemoryScope, warm: () => Promise<WarmResult>): Promise<WarmResult> {
    const key = profileKey(scope);
    const existing = this.inFlight.get(key);
    if (existing) return existing;

    const started = warm().finally(() => {
      this.inFlight.delete(key);
    });
    this.inFlight.set(key, started);
    return started;
  }

  /** How many warms are running, for tests. */
  size(): number {
    return this.inFlight.size;
  }
}
