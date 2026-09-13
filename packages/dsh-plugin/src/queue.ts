import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';

/** A private, cancellable, single-concurrency queue for post-turn extraction. */

export class ExtractionQueue {
  private readonly pending: Array<(signal: AbortSignal) => Promise<void>> = [];
  private readonly controller = new AbortController();
  private running = false;
  private idleWaiters: Array<() => void> = [];

  constructor(
    private readonly maxPending: number,
    private readonly onError: (error: unknown) => void,
  ) {}

  enqueue(task: (signal: AbortSignal) => Promise<void>): boolean {
    if (this.controller.signal.aborted || this.pending.length >= this.maxPending) return false;
    this.pending.push(task);
    void this.drain();
    return true;
  }

  async close(): Promise<void> {
    this.controller.abort(new Error('companion-memory plugin disposed'));
    this.pending.length = 0;
    if (!this.running) return;
    await new Promise<void>((resolve) => this.idleWaiters.push(resolve));
  }

  private async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      for (;;) {
        const task = this.pending.shift();
        if (task === undefined || this.controller.signal.aborted) return;
        try {
          await task(this.controller.signal);
        } catch (error: unknown) {
          if (!this.controller.signal.aborted) this.onError(error);
        }
      }
    } finally {
      this.running = false;
      for (const resolve of this.idleWaiters.splice(0)) resolve();
    }
  }
}

/** A job that can be reconstructed after the plugin process restarts. */
export interface DurableQueueJob {
  id: string;
}

/** Signals that a job should remain durable but wait for a later lifecycle event. */
export class QueueDeferred extends Error {
  constructor(message = 'queue job is waiting for an available execution context') {
    super(message);
    this.name = 'QueueDeferred';
  }
}

interface QueueEvent {
  version: 1;
  type: 'enqueue' | 'complete';
  job?: DurableQueueJob;
  id?: string;
}

/**
 * Durable, single-concurrency inbox used by the plugin's post-turn extractor.
 *
 * The append-only journal is intentionally separate from the memory database:
 * it is a delivery guarantee for model extraction, not another copy of an
 * admitted transcript. A job is removed only after Rust has acknowledged the
 * admission request; a crash or worker outage therefore leaves it replayable.
 */
export class DurableExtractionQueue<T extends DurableQueueJob> {
  private readonly maxInMemoryPending: number;
  private readonly pending = new Map<string, T>();
  private readonly controller = new AbortController();
  private readonly retryTimers = new Map<string, NodeJS.Timeout>();
  private running = false;
  private runningJobId: string | undefined;
  private idleWaiters: Array<() => void> = [];
  private retryDelayMs = new Map<string, number>();

  constructor(
    maxInMemoryPending: number,
    private readonly onError: (error: unknown) => void,
    private readonly execute: (job: T, signal: AbortSignal) => Promise<void>,
    private readonly journalPath?: string,
    private readonly validateJob: (job: DurableQueueJob) => boolean = () => true,
    private readonly maxJournalBytes = 64 * 1024 * 1024,
  ) {
    this.maxInMemoryPending = Math.max(1, maxInMemoryPending);
    this.loadJournal();
  }

  /**
   * Persist before scheduling. With a journal configured, overflow is retained
   * on disk instead of being silently skipped; the size limit bounds the
   * in-memory execution window while `maxJournalBytes` bounds disk growth.
   */
  enqueue(job: T): boolean {
    if (this.controller.signal.aborted) {
      return false;
    }
    if (this.pending.has(job.id)) return true;
    if (this.journalPath === undefined && this.pending.size >= this.maxInMemoryPending) return false;
    if (!this.append({ version: 1, type: 'enqueue', job })) return false;
    // A durable journal is the overflow store. Keep only a bounded execution
    // window in memory; the remainder is promoted after each completion.
    if (this.journalPath === undefined || this.pending.size < this.maxInMemoryPending) {
      this.pending.set(job.id, job);
    }
    void this.drain();
    return true;
  }

  /** Remove queued jobs matching a user-authorised predicate. */
  removeWhere(predicate: (job: T) => boolean): void {
    const removable = this.journalPath === undefined
      ? [...this.pending.values()]
      : [...(this.readJournalPending() ?? new Map()).values()];
    for (const job of removable) {
      if (job.id === this.runningJobId || !predicate(job)) continue;
      if (this.append({ version: 1, type: 'complete', id: job.id })) {
        this.pending.delete(job.id);
        this.retryDelayMs.delete(job.id);
      } else if (this.compactJournal(job.id)) {
        this.pending.delete(job.id);
        this.retryDelayMs.delete(job.id);
      }
    }
    this.compactJournal();
    this.promoteFromJournal();
  }

  /** Wake jobs that were waiting for an agent/session execution context. */
  kick(): void {
    for (const timer of this.retryTimers.values()) clearTimeout(timer);
    this.retryTimers.clear();
    void this.drain();
  }

  /** Close without deleting journaled jobs; they remain replayable next boot. */
  async close(): Promise<void> {
    this.controller.abort(new Error('companion-memory plugin disposed'));
    for (const timer of this.retryTimers.values()) clearTimeout(timer);
    this.retryTimers.clear();
    if (!this.running) return;
    await new Promise<void>((resolve) => this.idleWaiters.push(resolve));
  }

  private async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      for (;;) {
        const job = this.pending.values().next().value as T | undefined;
        if (job === undefined || this.controller.signal.aborted) return;
        this.runningJobId = job.id;
        try {
          await this.execute(job, this.controller.signal);
          if (this.controller.signal.aborted) return;
          if (!this.append({ version: 1, type: 'complete', id: job.id })) {
            // If the journal is at its byte limit, an extra completion marker
            // may not fit. A successful execution is still safe to retire by
            // atomically compacting the current job out; a crash before that
            // compaction merely replays an idempotent admission.
            if (!this.compactJournal(job.id)) {
              this.scheduleRetry(job.id);
              return;
            }
          }
          this.pending.delete(job.id);
          this.retryDelayMs.delete(job.id);
          this.compactJournal();
          this.promoteFromJournal();
        } catch (error: unknown) {
          if (this.controller.signal.aborted) return;
          if (!(error instanceof QueueDeferred)) this.onError(error);
          this.scheduleRetry(job.id);
          return;
        } finally {
          this.runningJobId = undefined;
        }
      }
    } finally {
      this.running = false;
      for (const resolve of this.idleWaiters.splice(0)) resolve();
    }
  }

  private scheduleRetry(id: string): void {
    if (this.retryTimers.has(id) || this.controller.signal.aborted) return;
    const delay = Math.min((this.retryDelayMs.get(id) ?? 250) * 2, 30_000);
    this.retryDelayMs.set(id, delay);
    const timer = setTimeout(() => {
      this.retryTimers.delete(id);
      void this.drain();
    }, delay);
    this.retryTimers.set(id, timer);
  }

  private loadJournal(): void {
    this.promoteFromJournal();
  }

  private append(event: QueueEvent): boolean {
    if (this.journalPath === undefined) return true;
    try {
      mkdirSync(dirname(this.journalPath), { recursive: true });
      const line = `${JSON.stringify(event)}\n`;
      const existingBytes = existsSync(this.journalPath) ? statSync(this.journalPath).size : 0;
      if (existingBytes + Buffer.byteLength(line, 'utf8') > this.maxJournalBytes) {
        this.onError(new Error('durable extraction journal reached its byte limit'));
        return false;
      }
      appendFileSync(this.journalPath, line, 'utf8');
      return true;
    } catch (error: unknown) {
      this.onError(error);
      return false;
    }
  }

  private promoteFromJournal(): void {
    if (this.journalPath === undefined || this.pending.size >= this.maxInMemoryPending) return;
    const journalPending = this.readJournalPending();
    if (journalPending === undefined) return;
    for (const [id, job] of journalPending) {
      if (this.pending.has(id)) continue;
      this.pending.set(id, job);
      if (this.pending.size >= this.maxInMemoryPending) break;
    }
  }

  private readJournalPending(): Map<string, T> | undefined {
    if (this.journalPath === undefined || !existsSync(this.journalPath)) return new Map();
    let lines: string[];
    try {
      lines = readFileSync(this.journalPath, 'utf8').split('\n');
    } catch (error: unknown) {
      this.onError(error);
      return undefined;
    }
    const jobs = new Map<string, T>();
    for (const line of lines) {
      if (line.trim().length === 0) continue;
      try {
        const event = JSON.parse(line) as QueueEvent;
        if (event.version !== 1 || (event.type !== 'enqueue' && event.type !== 'complete')) continue;
        if (event.type === 'enqueue' && event.job !== undefined && typeof event.job.id === 'string' && this.validateJob(event.job)) {
          jobs.set(event.job.id, event.job as T);
        } else if (event.type === 'complete' && typeof event.id === 'string') {
          jobs.delete(event.id);
        }
      } catch {
        // A torn final line is expected after a hard process kill. Earlier
        // complete lines remain authoritative; the malformed tail is ignored.
      }
    }
    return jobs;
  }

  /** Rewrite only unfinished enqueue records, removing completed payloads. */
  private compactJournal(excludeId?: string): boolean {
    if (this.journalPath === undefined) return true;
    const jobs = this.readJournalPending();
    if (jobs === undefined) return false;
    if (excludeId !== undefined) jobs.delete(excludeId);
    const temporary = `${this.journalPath}.tmp-${process.pid}-${Date.now()}`;
    try {
      mkdirSync(dirname(this.journalPath), { recursive: true });
      const contents = [...jobs.values()]
        .map((job) => `${JSON.stringify({ version: 1, type: 'enqueue', job })}\n`)
        .join('');
      if (Buffer.byteLength(contents, 'utf8') > this.maxJournalBytes) {
        this.onError(new Error('unfinished extraction journal exceeds its byte limit'));
        return false;
      }
      writeFileSync(temporary, contents, 'utf8');
      renameSync(temporary, this.journalPath);
      return true;
    } catch (error: unknown) {
      this.onError(error);
      try { unlinkSync(temporary); } catch { /* best effort cleanup */ }
      return false;
    }
  }
}
