import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DurableExtractionQueue, ExtractionQueue, QueueDeferred } from './queue.js';

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

  it('keeps durable overflow and replays an unfinished job after restart', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'companion-queue-'));
    const path = join(dir, 'inbox.jsonl');
    try {
      const first = new DurableExtractionQueue<{ id: string; payload: string }>(1, () => {}, async () => {
        throw new QueueDeferred();
      }, path);
      expect(first.enqueue({ id: 'job-1', payload: 'hello' })).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 10));
      await first.close();

      let runs = 0;
      const second = new DurableExtractionQueue<{ id: string; payload: string }>(1, () => {}, async () => { runs += 1; }, path);
      second.kick();
      await new Promise((resolve) => setTimeout(resolve, 20));
      await second.close();
      expect(runs).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('persists overflow instead of returning full when a journal is configured', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'companion-queue-'));
    const path = join(dir, 'inbox.jsonl');
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    try {
      const queue = new DurableExtractionQueue(1, () => {}, async (job) => {
        if (job.id === 'job-1') await gate;
      }, path);
      expect(queue.enqueue({ id: 'job-1' })).toBe(true);
      expect(queue.enqueue({ id: 'job-2' })).toBe(true);
      release();
      await new Promise((resolve) => setTimeout(resolve, 20));
      await queue.close();
      expect(readFileSync(path, 'utf8')).not.toContain('job-1');
      expect(readFileSync(path, 'utf8')).not.toContain('job-2');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
