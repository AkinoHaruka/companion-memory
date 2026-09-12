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
