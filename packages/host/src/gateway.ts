/**
 * DeepSeek Harness entry point for the Oracle acceptance run.
 *
 * This exists because the evaluation can only be run from inside a DSH process.
 * `createDshRouteEvaluationClient` needs a live `ctx` and the agent whose route
 * the replies should use, and neither can be reconstructed from outside: the
 * route, the session id, and the provider credentials all belong to a running
 * turn. So the acceptance is a tool, invoked in a session, rather than a script
 * that reaches into one.
 *
 * It lives in the host package rather than the memory plugin because the
 * dependency runs one way. The evaluator imports the plugin's protocol,
 * rendering, and extraction parser; the plugin must not import the evaluator
 * back, or the mounted plugin would carry the whole evaluation harness, its
 * fixture, and its scoring rules into every session that only wanted memory.
 */

import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import { defineTool } from '@deepseek-ai/dsh-tools';

import { createDshRouteEvaluationClient } from '@companion-memory/dsh-plugin';
import { runOracleEvaluation } from './evaluator.js';

export const name = 'companion-memory-oracle';

/** `llm` for the route, `agents` for the agent a tool call belongs to. */
export const inject = ['agents', 'llm', 'tools'];

export interface Config {
  /** Where the evaluation database and its per-repetition artifacts are written. */
  outputDirectory: string;
  /** The worker executable to drive. */
  workerCommand: string;
  /** Fixed launcher arguments for the worker; deployments leave this empty. */
  workerArgs?: string[];
  /** Repetitions of the whole fixture. The acceptance criterion is written for ten. */
  runCount?: number;
  /** Include the probe session, which carries the name and language effects. */
  includeProbes?: boolean;
  toolName?: string;
}

export const Config: z<Config> = z.object({
  outputDirectory: z.string().required(),
  workerCommand: z.string().required(),
  workerArgs: z.array(z.string()),
  runCount: z.natural().default(10),
  includeProbes: z.boolean().default(true),
  toolName: z.string().default('companion_memory_acceptance'),
});

/**
 * Mount the acceptance tool.
 *
 * @param ctx - The harness context, used to build the evaluation route.
 * @param config - Deployment paths; see {@link Config}.
 */
export function apply(ctx: Context, config: Config): void {
  ctx.effect(() => ctx.tools.register(defineTool({
    name: config.toolName ?? 'companion_memory_acceptance',
    description: 'Run the Companion Memory Oracle acceptance: reply to the frozen conversation under four memory arms and score the observable effects. Slow and expensive; it makes one model call per turn per arm.',
    parameters: {
      note: { type: 'string', required: true, description: 'Why this run is being made. Recorded in the reply.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: { type: 'string', required: true },
          passed: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(args, context) {
      if (context.agent === undefined) {
        return { text: 'The Oracle acceptance needs an agent session to route model calls.', passed: false };
      }
      const note = typeof args.note === 'string' ? args.note.trim() : '';
      // One directory per invocation, holding both the database and the artifacts
      // it produced. The evaluator refuses a database that already holds records,
      // because scope names repeat between invocations and a shared file would let
      // this run read the previous run's memories while presenting itself as
      // independent repetitions.
      const startedAt = new Date().toISOString().replace(/[:.]/g, '-');
      const outputDirectory = `${config.outputDirectory}/${startedAt}`;
      const summary = await runOracleEvaluation({
        client: createDshRouteEvaluationClient(ctx, context.agent),
        databasePath: `${outputDirectory}/oracle.db`,
        outputDirectory,
        workerCommand: config.workerCommand,
        ...(config.workerArgs === undefined ? {} : { workerArgs: config.workerArgs }),
        runCount: config.runCount ?? 10,
        includeProbes: config.includeProbes ?? true,
      });
      return {
        text: `${note.length === 0 ? 'Oracle acceptance' : note}\nartifacts: ${outputDirectory}\n${JSON.stringify(summary.acceptance)}`,
        passed: summary.acceptance.passed,
      };
    },
  })));
}
