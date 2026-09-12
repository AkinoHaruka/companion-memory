/** Restartable, line-oriented client for the companion-memory Rust worker. */

import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  WORKER_PROTOCOL_VERSION,
  type MemoryScope,
  type QueryRecord,
  type WorkerHealth,
  type WarmResult,
  type WorkerFailure,
  type WorkerScope,
} from './protocol.js';

interface Envelope {
  version: number;
  id: string;
  op: string;
  params: unknown;
}

interface Response {
  version: number;
  id: string;
  ok: boolean;
  result?: unknown;
  error?: WorkerFailure;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: WorkerClientError) => void;
  timer: NodeJS.Timeout;
}

export class WorkerClientError extends Error {
  constructor(
    readonly code: string,
    readonly retryable: boolean,
    message: string,
  ) {
    super(message);
    this.name = 'WorkerClientError';
  }
}

export interface WorkerClientConfig {
  command?: string;
  /** Optional fixed launcher arguments; production leaves these empty. */
  args?: readonly string[];
  databasePath: string;
  requestTimeoutMs: number;
  onWarning?: (message: string) => void;
}

function safeWorkerEnvironment(): NodeJS.ProcessEnv {
  const allowed = ['PATH', 'Path', 'SystemRoot', 'ComSpec', 'TEMP', 'TMP', 'HOME', 'USERPROFILE'];
  const environment: NodeJS.ProcessEnv = {};
  for (const key of allowed) {
    const value = process.env[key];
    if (value !== undefined) environment[key] = value;
  }
  return environment;
}

/** Locate the packaged worker beside the plugin, with an explicit config override for deployments. */
export function defaultWorkerCommand(moduleUrl: string = import.meta.url): string {
  const here = dirname(fileURLToPath(moduleUrl));
  const platform = process.platform === 'win32' ? 'win32-x64' : 'linux-x64';
  const executable = process.platform === 'win32' ? 'companion-memory-worker.exe' : 'companion-memory-worker';
  return join(here, '..', 'bin', platform, executable);
}

/**
 * A process is discarded on timeout, bad JSON, or an unexpected exit. A later
 * request starts a fresh one, so stale plans can never be injected after an
 * outage.
 */
export class WorkerClient {
  private child: ChildProcessWithoutNullStreams | undefined;
  private output = '';
  private readonly pending = new Map<string, Pending>();
  private closing = false;

  constructor(private readonly config: WorkerClientConfig) {}

  async health(): Promise<WorkerHealth> {
    return this.request('health', {}) as Promise<WorkerHealth>;
  }

  warm(params: {
    scope: WorkerScope;
    current_message: string;
    now: string;
    session_id: string;
    new_session: boolean;
    turn_key: string;
    force_record_ids?: string[];
  }): Promise<WarmResult> {
    return this.request('warm', params) as Promise<WarmResult>;
  }

  admit(params: unknown): Promise<{ accepted: string[]; rejected: Array<{ candidateId: string; reason: string }> }> {
    return this.request('admit', params) as Promise<{ accepted: string[]; rejected: Array<{ candidateId: string; reason: string }> }>;
  }

  async query(params: unknown): Promise<QueryRecord[]> {
    const result = await this.request('query', params) as { records?: QueryRecord[] };
    return result.records ?? [];
  }

  forget(params: unknown): Promise<{ forgotten: boolean; recordIds: string[] }> {
    return this.request('forget', params) as Promise<{ forgotten: boolean; recordIds: string[] }>;
  }

  sessionClosed(params: unknown): Promise<{ expired: number }> {
    return this.request('session_closed', params) as Promise<{ expired: number }>;
  }

  async close(): Promise<void> {
    this.closing = true;
    const child = this.child;
    this.child = undefined;
    this.rejectAll(new WorkerClientError('WORKER_CLOSED', true, 'memory worker was closed'));
    if (child === undefined || child.exitCode !== null) return;
    await new Promise<void>((resolve) => {
      child.once('exit', () => resolve());
      child.kill();
    });
  }

  private request(operation: string, params: unknown): Promise<unknown> {
    if (this.closing) {
      return Promise.reject(new WorkerClientError('WORKER_CLOSED', true, 'memory worker was closed'));
    }
    const child = this.ensureChild();
    const id = randomUUID();
    const envelope: Envelope = { version: WORKER_PROTOCOL_VERSION, id, op: operation, params };
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        const error = new WorkerClientError('WORKER_TIMEOUT', true, 'memory worker request timed out');
        reject(error);
        this.discard(error);
      }, this.config.requestTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        child.stdin.write(`${JSON.stringify(envelope)}\n`);
      } catch {
        this.pending.delete(id);
        clearTimeout(timer);
        const error = new WorkerClientError('WORKER_WRITE_FAILED', true, 'memory worker is unavailable');
        reject(error);
        this.discard(error);
      }
    });
  }

  private ensureChild(): ChildProcessWithoutNullStreams {
    if (this.child !== undefined && this.child.exitCode === null) return this.child;
    const command = this.config.command ?? defaultWorkerCommand();
    const child = spawn(command, [...(this.config.args ?? []), '--database', this.config.databasePath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
      windowsHide: true,
      env: safeWorkerEnvironment(),
    });
    this.child = child;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => this.consumeStdout(chunk));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', () => this.config.onWarning?.('companion-memory worker emitted a diagnostic'));
    child.once('error', () => this.discard(new WorkerClientError('WORKER_START_FAILED', true, 'memory worker could not start')));
    child.once('exit', (code) => {
      if (!this.closing) this.discard(new WorkerClientError('WORKER_EXITED', true, `memory worker exited (${String(code)})`));
    });
    return child;
  }

  private consumeStdout(chunk: string): void {
    this.output += chunk;
    for (;;) {
      const newline = this.output.indexOf('\n');
      if (newline < 0) return;
      const line = this.output.slice(0, newline);
      this.output = this.output.slice(newline + 1);
      let response: Response;
      try {
        response = JSON.parse(line) as Response;
      } catch {
        this.discard(new WorkerClientError('WORKER_BAD_JSON', true, 'memory worker returned invalid JSON'));
        return;
      }
      if (response.version !== WORKER_PROTOCOL_VERSION || typeof response.id !== 'string') {
        this.discard(new WorkerClientError('WORKER_PROTOCOL_ERROR', true, 'memory worker returned an incompatible protocol response'));
        return;
      }
      const pending = this.pending.get(response.id);
      if (pending === undefined) continue;
      this.pending.delete(response.id);
      clearTimeout(pending.timer);
      if (response.ok) pending.resolve(response.result);
      else {
        const failure = response.error;
        pending.reject(new WorkerClientError(
          failure?.code ?? 'WORKER_ERROR',
          failure?.retryable ?? true,
          failure?.summary ?? 'memory worker rejected the request',
        ));
      }
    }
  }

  private discard(error: WorkerClientError): void {
    const child = this.child;
    this.child = undefined;
    this.output = '';
    this.rejectAll(error);
    if (child !== undefined && child.exitCode === null) child.kill();
  }

  private rejectAll(error: WorkerClientError): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

interface PooledClient { client: WorkerClient; references: number; }
const pool = new Map<string, PooledClient>();

/** Acquire one shared worker client, released when the owning Cordis fiber disposes. */
export function acquireWorker(config: WorkerClientConfig): { client: WorkerClient; release: () => Promise<void> } {
  const key = `${config.command ?? defaultWorkerCommand()}\u0000${(config.args ?? []).join('\u0001')}\u0000${config.databasePath}`;
  let pooled = pool.get(key);
  if (pooled === undefined) {
    pooled = { client: new WorkerClient(config), references: 0 };
    pool.set(key, pooled);
  }
  pooled.references += 1;
  let released = false;
  return {
    client: pooled.client,
    async release(): Promise<void> {
      if (released) return;
      released = true;
      const current = pool.get(key);
      if (current === undefined) return;
      current.references -= 1;
      if (current.references <= 0) {
        pool.delete(key);
        await current.client.close();
      }
    },
  };
}

/** Kept public for diagnostics and tests without exposing mutable pool state. */
export function workerScope(scope: MemoryScope): WorkerScope {
  return {
    service_id: scope.serviceId,
    owner_user_id: scope.ownerUserId,
    companion_profile_id: scope.companionProfileId,
  };
}
