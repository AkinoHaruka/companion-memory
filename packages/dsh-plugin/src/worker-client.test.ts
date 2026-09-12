import { describe, expect, it } from 'vitest';

import { acquireWorker, defaultWorkerCommand, WorkerClient, WorkerClientError } from './worker-client.js';

function responder(body: string): string {
  return [
    "const readline=require('node:readline');",
    "const input=readline.createInterface({input:process.stdin});",
    "input.on('line',(line)=>{const request=JSON.parse(line);",
    body,
    '});',
  ].join('');
}

function client(program: string, requestTimeoutMs = 1_000): WorkerClient {
  return new WorkerClient({
    command: process.execPath,
    args: ['-e', program, '--'],
    databasePath: ':memory:',
    requestTimeoutMs,
  });
}

const healthy = responder("console.log(JSON.stringify({version:1,id:request.id,ok:true,result:{protocolVersion:1,schemaVersion:3,predicateKeys:['identity.name'],predicateSchemas:[{key:'identity.name',valueKind:'text',enumValues:[]}]}}));");

describe('WorkerClient fail-closed protocol boundary', () => {
  it('locates a packaged worker from a Windows-safe file URL', () => {
    const command = defaultWorkerCommand('file:///C:/Companion%20Memory/dist/worker-client.js');
    expect(command).toContain('Companion Memory');
    expect(command).toContain('bin');
    expect(command).toMatch(/companion-memory-worker(?:\.exe)?$/);
  });

  it('drops malformed worker output instead of reusing a plan', async () => {
    const worker = client(responder("process.stdout.write('not json\\n');"));
    try {
      await expect(worker.health()).rejects.toMatchObject({ code: 'WORKER_BAD_JSON', retryable: true } satisfies Partial<WorkerClientError>);
    } finally {
      await worker.close();
    }
  });

  it('times out, discards the process, and reports a retryable failure', async () => {
    const worker = client(responder(''), 25);
    try {
      await expect(worker.health()).rejects.toMatchObject({ code: 'WORKER_TIMEOUT', retryable: true } satisfies Partial<WorkerClientError>);
    } finally {
      await worker.close();
    }
  });

  it('preserves a stable worker error code and retryability', async () => {
    const worker = client(responder("console.log(JSON.stringify({version:1,id:request.id,ok:false,error:{code:'INVALID_REQUEST',retryable:false,summary:'safe'}}));"));
    try {
      await expect(worker.health()).rejects.toMatchObject({ code: 'INVALID_REQUEST', retryable: false } satisfies Partial<WorkerClientError>);
    } finally {
      await worker.close();
    }
  });

  it('shares one worker only for the same process configuration and closes it at the final release', async () => {
    const config = {
      command: process.execPath,
      args: ['-e', healthy, '--'],
      databasePath: ':memory:-pooled',
      requestTimeoutMs: 1_000,
    };
    const first = acquireWorker(config);
    const second = acquireWorker(config);
    expect(first.client).toBe(second.client);
    try {
      await first.client.health();
      await first.release();
      await expect(second.client.health()).resolves.toMatchObject({ predicateKeys: ['identity.name'] });
    } finally {
      await second.release();
    }
    await expect(second.client.health()).rejects.toMatchObject({ code: 'WORKER_CLOSED' } satisfies Partial<WorkerClientError>);
  });
});
