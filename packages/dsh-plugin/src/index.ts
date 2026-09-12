/** Real DeepSeek Harness bundle integration backed only by the Rust worker. */

import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent';
import { createUserMessage, type ContentBlock, type Message, type UserMessage } from '@deepseek-ai/dsh-llm';
import type { Session } from '@deepseek-ai/dsh-session';
import type {} from '@deepseek-ai/dsh-session-projection';
import type {} from '@deepseek-ai/dsh-tools';
import { defineTool } from '@deepseek-ai/dsh-tools';

import { extractFromUserMessage } from './extractor.js';
import { ExtractionQueue } from './queue.js';
import type { ExtractedCandidate, Extraction, MemoryScope } from './protocol.js';
import { toWorkerScope } from './protocol.js';
import { renderMemoryUsagePlan, renderQueryResult, renderedRecordIds } from './render.js';
import { acquireWorker, type WorkerClient } from './worker-client.js';

export const name = 'companion-memory';
export const inject = ['agents', 'llm', 'sessionProjections', 'tools'];

export interface Config {
  serviceId: string;
  ownerUserId: string;
  /** Used only when DSH has no Agent Preset; never an Agent or Session id. */
  defaultProfileId: string;
  databasePath: string;
  workerCommand?: string;
  workerArgs?: string[];
  workerRequestTimeoutMs?: number;
  maxQueuedExtractions?: number;
  toolName?: string;
}

export const Config: z<Config> = z.object({
  serviceId: z.string().required(),
  ownerUserId: z.string().required(),
  defaultProfileId: z.string().required(),
  databasePath: z.string().required(),
  workerCommand: z.string(),
  workerArgs: z.array(z.string()),
  workerRequestTimeoutMs: z.natural().default(4_000),
  maxQueuedExtractions: z.natural().default(32),
  toolName: z.string().default('companion_memory'),
});

interface DirectUserInput { id: string; sessionId: string; text: string; }

function textContent(content: readonly ContentBlock[]): string {
  return content
    .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
    .map((block) => block.text).join('\n').trim();
}

/** Excludes plugin snapshots, tool results, and model content. */
function isDirectUserMessage(message: Message): message is UserMessage {
  return message.role === 'user' && message.source.kind === 'user';
}

function lastDirectUserText(messages: readonly Message[]): string {
  for (const message of messages.toReversed()) {
    if (isDirectUserMessage(message)) return textContent(message.content);
  }
  return '';
}

function scopeFor(agent: Agent, config: Config): MemoryScope {
  const preset = agent.session.header.agentPreset;
  return {
    serviceId: config.serviceId,
    ownerUserId: config.ownerUserId,
    companionProfileId: typeof preset === 'string' && preset.trim().length > 0 ? preset : config.defaultProfileId,
  };
}

function now(): string { return new Date().toISOString(); }

function workerCandidates(candidates: readonly ExtractedCandidate[]): unknown[] {
  return candidates.map((candidate) => ({
    id: candidate.id,
    predicate: candidate.predicate,
    value: candidate.value,
    ...(candidate.rawValue === undefined ? {} : { raw_value: candidate.rawValue }),
    ...(candidate.entityRef === undefined ? {} : { entity_ref: candidate.entityRef }),
    ...(candidate.qualifiers === undefined ? {} : { qualifiers: candidate.qualifiers }),
    start_offset: candidate.sourceSpan.startOffset,
    end_offset: candidate.sourceSpan.endOffset,
    quote: candidate.sourceSpan.quote,
    confidence: candidate.confidence,
    ...(candidate.openThread === undefined ? {} : {
      open_thread: {
        id: candidate.openThread.id,
        summary: candidate.openThread.summary,
        ...(candidate.openThread.entityRef === undefined ? {} : { entity_ref: candidate.openThread.entityRef }),
        ...(candidate.openThread.expiresAt === undefined ? {} : { expires_at: candidate.openThread.expiresAt }),
      },
    }),
  }));
}

function workerEpisodes(episodes: readonly Extract<Extraction, { kind: 'episode' }>[]): unknown[] {
  return episodes.map((item) => ({
    id: item.candidate.id,
    narrative: item.candidate.narrative,
    start_offset: item.candidate.sourceSpan.startOffset,
    end_offset: item.candidate.sourceSpan.endOffset,
    quote: item.candidate.sourceSpan.quote,
    confidence: item.candidate.confidence,
  }));
}

async function extractAndAdmit(
  ctx: Context,
  worker: WorkerClient,
  agent: Agent,
  scope: MemoryScope,
  input: DirectUserInput,
  signal: AbortSignal,
): Promise<void> {
  const health = await worker.health();
  const extracted = await extractFromUserMessage(ctx, agent, input.text, input.id, health.predicateSchemas, signal);
  const candidates = extracted
    .filter((item): item is Extract<typeof item, { kind: 'claim' }> => item.kind === 'claim')
    .map((item) => item.candidate);
  const episodes = extracted.filter((item): item is Extract<typeof item, { kind: 'episode' }> => item.kind === 'episode');
  const pending = extracted.flatMap((item, index) => item.kind === 'runtime_state'
    ? [{ id: `${input.id}-pending-${index}`, kind: item.kind, reason: item.reason }]
    : []);
  // Empty admission telemetry measures an extractor that correctly retained no
  // text; Rust retains source evidence only when a candidate is accepted.
  await worker.admit({
    scope: toWorkerScope(scope), now: now(),
    source: { id: input.id, session_id: input.sessionId, text: input.text },
    candidates: workerCandidates(candidates),
    episodes: workerEpisodes(episodes),
    pending,
  });
}

/** Mount one shared reconnecting worker client and the actual DSH lifecycle. */
export function apply(ctx: Context, config: Config): void {
  const acquired = acquireWorker({
    ...(config.workerCommand === undefined ? {} : { command: config.workerCommand }),
    ...(config.workerArgs === undefined ? {} : { args: config.workerArgs }),
    databasePath: config.databasePath,
    requestTimeoutMs: config.workerRequestTimeoutMs ?? 4_000,
    onWarning: (message) => ctx.logger.warn(`companion-memory: ${message}`),
  });
  const queue = new ExtractionQueue(
    config.maxQueuedExtractions ?? 32,
    (error) => ctx.logger.warn(`companion-memory: asynchronous extraction failed: ${error instanceof Error ? error.message : 'unknown error'}`),
  );
  const firstWarm = new WeakSet<Session>();
  const agents = new WeakMap<Session, Agent>();
  const scopes = new WeakMap<Session, MemoryScope>();
  const pending = new WeakMap<Session, DirectUserInput[]>();

  ctx.effect(() => async () => {
    await queue.close();
    await acquired.release();
  }, 'companion-memory worker lifecycle');

  ctx.on('agent/pre-step', async ({ agent, messages, turn, step, signal }, next): Promise<PreStepDecision> => {
    const decision = await next();
    if (decision.kind === 'reject' || signal.aborted || step !== 1) return decision;
    const scope = scopeFor(agent, config);
    agents.set(agent.session, agent);
    scopes.set(agent.session, scope);
    try {
      const warmed = await acquired.client.warm({
        scope: toWorkerScope(scope),
        current_message: lastDirectUserText(messages),
        now: now(), session_id: agent.session.id,
        new_session: !firstWarm.has(agent.session), turn_key: `${agent.session.id}:${turn}`,
      });
      firstWarm.add(agent.session);
      const text = renderMemoryUsagePlan(warmed);
      return {
        ...decision,
        messages: [...decision.messages, createUserMessage({
          content: [{ type: 'text', text }],
          source: { kind: 'plugin', plugin: name, form: 'snapshot', sections: [{ name, text }] },
        })],
      };
    } catch (error: unknown) {
      // Fail closed for memory, but never fail the normal DSH reply.
      ctx.logger.warn(`companion-memory: warm unavailable; continuing without memory (${error instanceof Error ? error.message : 'unknown error'})`);
      return decision;
    }
  }, { prepend: true });

  ctx.on('session/event', (session, event) => {
    if (event.type === 'user/message' && isDirectUserMessage(event.data)) {
      const text = textContent(event.data.content);
      if (text.length > 0) {
        const messages = pending.get(session) ?? [];
        messages.push({ id: event.data.id, sessionId: session.id, text });
        pending.set(session, messages);
      }
      return;
    }
    if (event.type !== 'turn/end') return;
    const messages = pending.get(session);
    pending.delete(session);
    const agent = agents.get(session);
    const scope = scopes.get(session);
    if (messages === undefined || agent === undefined || scope === undefined) return;
    for (const input of messages) {
      if (!queue.enqueue((signal) => extractAndAdmit(ctx, acquired.client, agent, scope, input, signal))) {
        ctx.logger.warn('companion-memory: extraction queue is full; skipped a non-blocking extraction');
      }
    }
  });

  ctx.on('session/disposed', (session) => {
    const scope = scopes.get(session);
    pending.delete(session);
    if (scope === undefined) return;
    void acquired.client.sessionClosed({ scope: toWorkerScope(scope), session_id: session.id, now: now() })
      .catch(() => ctx.logger.warn('companion-memory: could not close continuity state'));
  });

  ctx.effect(() => ctx.tools.register(defineTool({
    name: config.toolName ?? 'companion_memory',
    description: 'Search permitted companion memory by user-cued terms, or forget one exact record id when the user asks to delete it.',
    parameters: {
      action: { type: 'string', required: true, enum: ['search', 'forget'], description: 'search or forget' },
      query: { type: 'string', required: true, description: 'Search terms, or the exact record id for forget.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: {
        text: { type: 'string', required: true },
        recordIds: { type: 'array', required: true, items: { type: 'string' } },
      } },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(args, context) {
      const query = typeof args.query === 'string' ? args.query.trim() : '';
      if (query.length === 0) return { text: 'No memory query was provided.', recordIds: [] };
      if (context.agent === undefined) {
        return { text: 'Companion memory is unavailable outside an agent session.', recordIds: [] };
      }
      const scope = scopeFor(context.agent, config);
      if (args.action === 'forget') {
        const result = await acquired.client.forget({
          scope: toWorkerScope(scope), action: 'forget', record_id: query, now: now(),
        });
        return { text: result.forgotten ? `Forgot record ${query}.` : 'No matching record was found.', recordIds: result.recordIds };
      }
      const records = await acquired.client.query({
        scope: toWorkerScope(scope), action: 'search', terms: query, now: now(),
      });
      return { text: renderQueryResult(records), recordIds: records.map((record) => record.id) };
    },
  })));
}

export { renderMemoryUsagePlan, renderedRecordIds } from './render.js';
export type { MemoryScope, MemoryUsagePlan, WarmResult } from './protocol.js';
export { WorkerClient, WorkerClientError } from './worker-client.js';
export { createDshRouteEvaluationClient } from './route-client.js';
export type { DshRouteEvaluationClient, RoutedEvaluationMessage } from './route-client.js';
