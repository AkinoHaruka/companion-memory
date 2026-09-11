/**
 * Warm cache, coalescing, and the in-memory kernel.
 *
 * The cache is where a bug would be both invisible and harmful: stale memory
 * looks exactly like correct memory, so nothing in a transcript gives it away.
 * These tests pin the two properties that make it safe — a profile that has not
 * warmed reads nothing rather than something old, and a result is published
 * whole or not at all.
 */

import { describe, expect, it, vi } from 'vitest';
import type { MemoryKernel, MemoryScope, WarmResult } from './memory.js';
import { InMemoryKernel } from './in-memory-kernel.js';
import { TurnCache, WarmCoalescer, profileKey } from './turn-cache.js';

function scope(user = 'u1', profile = 'p1'): MemoryScope {
  return { serviceId: 'svc', ownerUserId: user, companionProfileId: profile };
}

function warm(overrides: Partial<WarmResult> = {}): WarmResult {
  return { stable: '', candidates: [], revision: 1, ...overrides };
}

describe('profileKey', () => {
  it('separates every ownership dimension', () => {
    const base = profileKey(scope());
    expect(profileKey(scope('u2'))).not.toBe(base);
    expect(profileKey(scope('u1', 'p2'))).not.toBe(base);
    expect(
      profileKey({ serviceId: 'other', ownerUserId: 'u1', companionProfileId: 'p1' }),
    ).not.toBe(base);
  });

  it('cannot be spoofed by moving a component across the separator', () => {
    // A printable separator would let {user: "a\u0000b"} collide with a
    // different pair. NUL cannot appear in an identifier, so this holds.
    const left = profileKey({ serviceId: 'svc', ownerUserId: 'a', companionProfileId: 'b' });
    const right = profileKey({ serviceId: 'svc', ownerUserId: 'a\u0000b', companionProfileId: '' });
    expect(left).not.toBe(right);
  });
});

describe('TurnCache', () => {
  it('reads nothing before anything is published', () => {
    // The failure this prevents: rendering a previous turn's profile because
    // this turn has not warmed yet.
    const cache = new TurnCache();
    expect(cache.read(scope())).toBeUndefined();
  });

  it('returns exactly what was published', () => {
    const cache = new TurnCache();
    const result = warm({ stable: 'language: Chinese', revision: 9 });
    cache.publish(scope(), result);
    expect(cache.read(scope())).toEqual(result);
  });

  it('does not serve one profile from another', () => {
    const cache = new TurnCache();
    cache.publish(scope('u1'), warm({ stable: 'for u1' }));
    expect(cache.read(scope('u2'))).toBeUndefined();
  });

  it('replaces a profile entry rather than accumulating', () => {
    const cache = new TurnCache();
    cache.publish(scope(), warm({ stable: 'first', revision: 1 }));
    cache.publish(scope(), warm({ stable: 'second', revision: 2 }));
    expect(cache.size()).toBe(1);
    expect(cache.read(scope())?.stable).toBe('second');
  });

  it('releases an entry and then reads nothing', () => {
    const cache = new TurnCache();
    cache.publish(scope(), warm({ stable: 'x' }));
    cache.release(scope());
    expect(cache.read(scope())).toBeUndefined();
    expect(cache.size()).toBe(0);
  });

  it('does not leave a partial value visible if a warm throws', async () => {
    // Publishing happens after the read succeeds, so a rejected warm must leave
    // the slot untouched - and untouched here means the previous revision is
    // still what a reader sees, which is why the caller must not warm twice.
    const cache = new TurnCache();
    cache.publish(scope(), warm({ stable: 'previous', revision: 1 }));
    await expect(
      Promise.resolve().then(() => {
        throw new Error('read failed');
      }),
    ).rejects.toThrow();
    expect(cache.read(scope())?.stable).toBe('previous');
  });
});

describe('WarmCoalescer', () => {
  it('runs one read for concurrent callers', async () => {
    // Pre-step can fire more than once for a step; issuing a recall per fire
    // would multiply the cost of the most expensive operation in the turn.
    const coalescer = new WarmCoalescer();
    const warmFn = vi.fn(async () => warm({ stable: 'once' }));

    const [a, b, c] = await Promise.all([
      coalescer.run(scope(), warmFn),
      coalescer.run(scope(), warmFn),
      coalescer.run(scope(), warmFn),
    ]);

    expect(warmFn).toHaveBeenCalledTimes(1);
    expect(a).toEqual(b);
    expect(b).toEqual(c);
  });

  it('keys by profile, so two profiles do not share a read', async () => {
    const coalescer = new WarmCoalescer();
    const warmFn = vi.fn(async () => warm());
    await Promise.all([coalescer.run(scope('u1'), warmFn), coalescer.run(scope('u2'), warmFn)]);
    expect(warmFn).toHaveBeenCalledTimes(2);
  });

  it('allows a retry after a failure', async () => {
    // A transient read failure must not be cached as the profile's answer for
    // the rest of the turn.
    const coalescer = new WarmCoalescer();
    const failing = vi.fn(async () => {
      throw new Error('transient');
    });
    await expect(coalescer.run(scope(), failing)).rejects.toThrow('transient');
    expect(coalescer.size()).toBe(0);

    const succeeding = vi.fn(async () => warm({ stable: 'recovered' }));
    const result = await coalescer.run(scope(), succeeding);
    expect(result.stable).toBe('recovered');
  });

  it('clears the in-flight entry once settled', async () => {
    const coalescer = new WarmCoalescer();
    await coalescer.run(scope(), async () => warm());
    expect(coalescer.size()).toBe(0);
  });
});

describe('InMemoryKernel', () => {
  const kernel = (): MemoryKernel => new InMemoryKernel();

  it('keeps records separate per profile', async () => {
    const memory = new InMemoryKernel();
    memory.remember(scope('u1'), { id: 'r1', text: 'likes herons', mention: 'freely_mentionable', terms: ['heron'] });
    memory.remember(scope('u2'), { id: 'r2', text: 'likes trains', mention: 'freely_mentionable', terms: ['train'] });

    const first = await memory.warm(scope('u1'), 'saw a heron');
    const second = await memory.warm(scope('u2'), 'saw a heron');
    expect(first.candidates.map((c) => c.id)).toEqual(['r1']);
    expect(second.candidates).toEqual([]);
  });

  it('surfaces a record only when a term matches the turn', async () => {
    const memory = new InMemoryKernel();
    memory.remember(scope(), { id: 'r1', text: 'likes herons', mention: 'freely_mentionable', terms: ['heron'] });
    expect((await memory.warm(scope(), 'what is for dinner')).candidates).toEqual([]);
    expect((await memory.warm(scope(), 'I saw a Heron today')).candidates).toHaveLength(1);
  });

  it('never surfaces a record marked never_surface', async () => {
    const memory = new InMemoryKernel();
    memory.remember(scope(), { id: 'secret', text: 'a hospital stay', mention: 'never_surface', terms: ['hospital'] });
    expect((await memory.warm(scope(), 'about the hospital')).candidates).toEqual([]);
  });

  it('reports honestly that observing a turn commits nothing', async () => {
    // Extraction is a model call and therefore the host's job. Claiming a commit
    // here would let the adapter's tests pass against something not happening.
    const outcome = await new InMemoryKernel().observe(scope(), [], '2026-01-01T00:00:00Z');
    expect(outcome.committed).toBe(false);
  });

  it('suppresses by exact text and refuses to resurrect', async () => {
    const memory = new InMemoryKernel();
    memory.remember(scope(), { id: 'e1', text: 'the dog was sick that night', mention: 'freely_mentionable', terms: ['dog'] });

    expect(memory.wouldResurrect(scope(), 'the dog was sick that night')).toBe(false);
    expect(memory.suppress(scope(), 'e1')).toBe(true);

    expect(memory.wouldResurrect(scope(), '  The Dog Was Sick That Night ')).toBe(true);
    expect((await memory.warm(scope(), 'how is the dog')).candidates).toEqual([]);
    expect(memory.all(scope())).toEqual([]);
  });

  it('will not forget on a near match', async () => {
    // Deleting the wrong record is worse than failing to delete the right one,
    // and a similarity heuristic without a model is a guess.
    const memory = new InMemoryKernel();
    memory.remember(scope(), { id: 'e1', text: 'the dog was sick that night', mention: 'freely_mentionable', terms: ['dog'] });
    const result = await memory.query(scope(), { kind: 'forget', target: 'the dog was sick' });
    expect(result.recordIds).toEqual([]);
    expect(memory.all(scope())).toHaveLength(1);
  });

  it('answers a search with the records it matched', async () => {
    const memory = new InMemoryKernel();
    memory.remember(scope(), { id: 'g1', text: 'wants to move to Hangzhou', mention: 'freely_mentionable', terms: ['hangzhou'] });
    const result = await memory.query(scope(), { kind: 'search', terms: 'hangzhou' });
    expect(result.recordIds).toEqual(['g1']);
    expect(result.text).toContain('Hangzhou');
  });

  it('does not search another profile', async () => {
    const memory = new InMemoryKernel();
    memory.remember(scope('u1'), { id: 'g1', text: 'private', mention: 'freely_mentionable', terms: ['private'] });
    const result = await memory.query(scope('u2'), { kind: 'search', terms: 'private' });
    expect(result.recordIds).toEqual([]);
  });

  it('stamps a revision that changes when memory changes', async () => {
    const memory = new InMemoryKernel();
    const before = (await memory.warm(scope(), 'anything')).revision;
    memory.remember(scope(), { id: 'r1', text: 'x', mention: 'freely_mentionable', terms: ['x'] });
    const after = (await memory.warm(scope(), 'anything')).revision;
    expect(after).not.toBe(before);
  });
});
