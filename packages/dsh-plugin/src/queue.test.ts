import { describe, expect, it, vi } from 'vitest';

import { ExtractionQueue } from './queue.js';

describe('ExtractionQueue', () => {
  it('serializes work and contains a failed extraction', async () => {
    const errors = vi.fn();
    const queue = new ExtractionQueue(3, errors);
    const order: string[] = [];
    queue.enqueue(async () => { order.push('first'); throw new Error('bad extraction'); });
    queue.enqueue(async () => { order.push('second'); });
    await new Promise((resolve) => setTimeout(resolve, 20));
    await queue.close();
    expect(order).toEqual(['first', 'second']);
    expect(errors).toHaveBeenCalledTimes(1);
  });

  it('bounds the queue rather than delaying a reply indefinitely', async () => {
    const queue = new ExtractionQueue(0, () => {});
    expect(queue.enqueue(async () => {})).toBe(false);
    await queue.close();
  });
});
