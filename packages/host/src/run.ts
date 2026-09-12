/** Run Oracle through a caller-supplied bridge bound to a current DSH route. */

import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { runOracleEvaluation, type EvaluationClient } from './evaluator.js';

interface EvaluationBridgeModule {
  createEvaluationClient?: () => EvaluationClient | Promise<EvaluationClient>;
}

async function loadDshRouteClient(): Promise<EvaluationClient> {
  const bridgePath = process.env.COMPANION_MEMORY_DSH_EVALUATION_BRIDGE?.trim();
  if (bridgePath === undefined || bridgePath.length === 0) {
    throw new Error('COMPANION_MEMORY_DSH_EVALUATION_BRIDGE must point to a module that creates a client from createDshRouteEvaluationClient(ctx, agent) inside DSH');
  }
  const bridge = await import(pathToFileURL(resolve(bridgePath)).href) as EvaluationBridgeModule;
  if (typeof bridge.createEvaluationClient !== 'function') {
    throw new Error('DSH evaluation bridge must export createEvaluationClient()');
  }
  return bridge.createEvaluationClient();
}

async function main(): Promise<void> {
  const workerCommand = process.env.COMPANION_MEMORY_WORKER_COMMAND
    ?? join(process.cwd(), 'target', 'debug', process.platform === 'win32' ? 'companion-memory-worker.exe' : 'companion-memory-worker');
  const mode = process.env.COMPANION_MEMORY_EVAL_MODE === 'acceptance' ? 'acceptance' : 'development';
  const summary = await runOracleEvaluation({
    client: await loadDshRouteClient(),
    databasePath: join(process.cwd(), 'runs', 'oracle', 'oracle.db'),
    workerCommand,
    runCount: mode === 'acceptance' ? 10 : 5,
    outputDirectory: join(process.cwd(), 'runs', 'oracle'),
    includeProbes: true,
  });
  process.stdout.write(`${JSON.stringify(summary.acceptance)}\n`);
  if (mode === 'acceptance' && !summary.acceptance.passed) process.exitCode = 1;
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
