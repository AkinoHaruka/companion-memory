/** A one-shot Oracle client bound to the route of a real DSH agent turn. */

import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { BlockAssembler, createSystemMessage, createUserMessage } from '@deepseek-ai/dsh-llm';

export interface RoutedEvaluationMessage {
  role: 'system' | 'user';
  content: string;
}

/** Structural match for the host evaluator; it keeps host free of provider credentials. */
export interface DshRouteEvaluationClient {
  chat(messages: readonly RoutedEvaluationMessage[], options: { maxTokens: number }): Promise<{ text: string }>;
  chatJson(messages: readonly RoutedEvaluationMessage[], options: { maxTokens: number }): Promise<Record<string, unknown>>;
}

function currentRoute(agent: Agent): { provider: string; model: string } | undefined {
  const configured = agent.session.requestHeader()?.config;
  if (configured !== undefined) return configured;
  if (agent.options.provider !== undefined && agent.options.model !== undefined) {
    return { provider: agent.options.provider, model: agent.options.model };
  }
  return undefined;
}

function parseObject(text: string): Record<string, unknown> {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('DSH route returned no JSON object');
  const parsed: unknown = JSON.parse(trimmed.slice(start, end + 1));
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('DSH route returned a non-object JSON payload');
  }
  return parsed as Record<string, unknown>;
}

/**
 * Construct this inside an active DSH process with the agent that owns the
 * configured route. It intentionally cannot accept a provider URL or key.
 */
export function createDshRouteEvaluationClient(
  ctx: Context,
  agent: Agent,
  signal?: AbortSignal,
): DshRouteEvaluationClient {
  const invoke = async (messages: readonly RoutedEvaluationMessage[], maxTokens: number): Promise<{ text: string }> => {
    const route = currentRoute(agent);
    if (route === undefined) throw new Error('No configured DSH route is available for Oracle evaluation');
    const assembled = new BlockAssembler();
    for await (const chunk of ctx.llm.stream({
      ...route,
      sessionId: agent.session.id,
      ...(signal === undefined ? {} : { signal }),
      maxTokens,
      messages: messages.map((message) => message.role === 'system'
        ? createSystemMessage(message.content, 'companion-memory-oracle')
        : createUserMessage({
          content: [{ type: 'text', text: message.content }],
          source: { kind: 'plugin', plugin: 'companion-memory-oracle' },
        })),
    })) assembled.push(chunk);
    return {
      text: assembled.blocks()
        .filter((block): block is Extract<typeof block, { type: 'text' }> => block.type === 'text')
        .map((block) => block.text)
        .join('\n'),
    };
  };
  return {
    chat: (messages, options) => invoke(messages, options.maxTokens),
    async chatJson(messages, options) { return parseObject((await invoke(messages, options.maxTokens)).text); },
  };
}
