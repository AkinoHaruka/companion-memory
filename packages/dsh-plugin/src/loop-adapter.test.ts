/**
 * The loop-payload adapters.
 *
 * These are small functions with a large blast radius: the text extracted here
 * becomes the query memory is recalled against. Getting it wrong does not throw,
 * it surfaces less relevant memory, which reads as memory being imperfect rather
 * than as a bug in three lines of extraction.
 */

import { describe, expect, it, vi } from 'vitest';
import { latestUserText, loopPreStep, observedMessages, type LoopMessage } from './loop-adapter.js';

function user(...texts: string[]): LoopMessage {
  return { role: 'user', content: texts.map((text) => ({ type: 'text', text })) };
}

function assistant(text: string): LoopMessage {
  return { role: 'assistant', content: [{ type: 'text', text }] };
}

describe('latestUserText', () => {
  it('returns an empty string when there is no user message', () => {
    expect(latestUserText([])).toBe('');
    expect(latestUserText([assistant('hello')])).toBe('');
  });

  it('takes the last user message rather than the last message', () => {
    // The message immediately before a step may be the companion's own reply.
    // Recalling against that would surface memories about what the companion
    // said instead of what the user just asked.
    const messages = [user('first question'), assistant('an answer'), user('the real question')];
    expect(latestUserText(messages)).toBe('the real question');
  });

  it('ignores a trailing assistant message', () => {
    const messages = [user('what I asked'), assistant('what I said back')];
    expect(latestUserText(messages)).toBe('what I asked');
  });

  it('joins several text blocks in order', () => {
    expect(latestUserText([user('one', 'two')])).toBe('one\ntwo');
  });

  it('excludes non-text blocks', () => {
    // A tool result or the model's own reasoning is not what the user said, and
    // folding it into the query would let it drive which memories surface.
    const messages: LoopMessage[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'what I said' },
          { type: 'tool-result', text: 'a tool returned this' },
          { type: 'image', text: 'not really text' },
        ],
      },
    ];
    expect(latestUserText(messages)).toBe('what I said');
  });

  it('tolerates a text block with no text field', () => {
    const messages: LoopMessage[] = [{ role: 'user', content: [{ type: 'text' }] }];
    expect(latestUserText(messages)).toBe('');
  });
});

describe('loopPreStep', () => {
  it('passes the current turn text and an instant to the recall handler', async () => {
    const recall = vi.fn(async () => {});
    const handler = loopPreStep(recall, () => '2026-06-10T12:00:00Z');

    await handler([user('how is the thesis'), assistant('earlier reply')]);

    expect(recall).toHaveBeenCalledTimes(1);
    expect(recall).toHaveBeenCalledWith('how is the thesis', '2026-06-10T12:00:00Z');
  });

  it('does not fail the turn when the recall throws', async () => {
    // The host's contract is that a hook failure must not stop the turn. A
    // memory read that failed is a turn with no memory, not an error the user
    // sees.
    const recall = vi.fn(async () => {
      throw new Error('the store is unreachable');
    });
    const handler = loopPreStep(recall);

    await expect(handler([user('anything')])).resolves.toBeUndefined();
  });

  it('still recalls with an empty message rather than skipping', async () => {
    // Recall decides what an empty query means. Skipping here would make the
    // condition and any turn-independent context silently unavailable on a step
    // whose text failed to extract.
    const recall = vi.fn(async () => {});
    await loopPreStep(recall, () => 'now')([]);
    expect(recall).toHaveBeenCalledWith('', 'now');
  });
});

describe('observedMessages', () => {
  it('keeps both sides of the conversation', () => {
    // The kernel polices what may be concluded from each side. Dropping the
    // assistant half here would hide the distinction from the layer that exists
    // to enforce it.
    const messages = observedMessages([user('I am tired'), assistant('that sounds hard')]);
    expect(messages.map((message) => message.role)).toEqual(['user', 'assistant']);
  });

  it('drops system messages and empty content', () => {
    const messages = observedMessages([
      { role: 'system', content: [{ type: 'text', text: 'instructions' }] },
      user('   '),
      user('real content'),
    ]);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.text).toBe('real content');
  });

  it('gives two identical messages distinct ids', () => {
    // Identity comes from position, not content. Deriving it from the text would
    // collapse a repeated statement into one piece of evidence, which is exactly
    // the repetition the inference thresholds are supposed to count.
    const messages = observedMessages([user('I am tired'), user('I am tired')]);
    expect(messages).toHaveLength(2);
    expect(messages[0]?.id).not.toBe(messages[1]?.id);
  });

  it('preserves order', () => {
    const messages = observedMessages([user('first'), assistant('second'), user('third')]);
    expect(messages.map((message) => message.text)).toEqual(['first', 'second', 'third']);
  });
});
