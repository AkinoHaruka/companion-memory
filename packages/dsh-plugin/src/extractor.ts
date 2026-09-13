/** Model-assisted extraction that never admits a record itself. */

import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { BlockAssembler, createSystemMessage, createUserMessage } from '@deepseek-ai/dsh-llm';

import type { ExtractedCandidate, Extraction, PredicateSchema } from './protocol.js';

interface RawClaim {
  kind: 'claim';
  predicate: string;
  value: unknown;
  rawValue?: string;
  entityRef?: string;
  qualifiers?: unknown;
  quote: string;
  confidence?: number;
  openThread?: { summary: string; entityRef?: string; expiresAt?: string };
}

interface RawEpisode {
  kind: 'episode';
  narrative: string;
  quote: string;
  confidence?: number;
  participants?: Array<{ entityRef?: string; role: 'user' | 'companion' }>;
  emotionalArc?: Array<{
    atTurn: number;
    labels: string[];
    intensity?: number;
    source: 'user_expressed' | 'observed';
  }>;
  userReaction?: string;
  responseRef?: string;
}
interface RawPending { kind: 'runtime_state' | 'no_memory'; reason?: string; }
type RawExtraction = RawClaim | RawEpisode | RawPending;

export function routeForAgent(agent: Agent): { provider: string; model: string } | undefined {
  const current = agent.session.requestHeader()?.config;
  if (current !== undefined) return current;
  if (agent.options.provider !== undefined && agent.options.model !== undefined) {
    return { provider: agent.options.provider, model: agent.options.model };
  }
  return undefined;
}

/** Build a unique UTF-8 byte span; ambiguous or invented quotes are rejected. */
export function sourceSpanForUniqueQuote(text: string, quote: string): { startOffset: number; endOffset: number; quote: string } | undefined {
  const trimmed = quote.trim();
  if (trimmed.length === 0) return undefined;
  const start = text.indexOf(trimmed);
  if (start < 0 || text.indexOf(trimmed, start + trimmed.length) >= 0) return undefined;
  const prefix = Buffer.byteLength(text.slice(0, start), 'utf8');
  return { startOffset: prefix, endOffset: prefix + Buffer.byteLength(trimmed, 'utf8'), quote: trimmed };
}

function parseJson(text: string): unknown[] {
  const opened = text.indexOf('[');
  const closed = text.lastIndexOf(']');
  if (opened < 0 || closed < opened) return [];
  const candidate: unknown = JSON.parse(text.slice(opened, closed + 1));
  return Array.isArray(candidate) ? candidate : [];
}

function isRawExtraction(value: unknown): value is RawExtraction {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return record.kind === 'claim' || record.kind === 'episode' || record.kind === 'runtime_state' || record.kind === 'no_memory';
}

function validEpisodeStructure(item: RawEpisode): boolean {
  if (item.participants !== undefined && (!Array.isArray(item.participants) || item.participants.some((participant) => (
    participant === null
      || typeof participant !== 'object'
      || (participant.role !== 'user' && participant.role !== 'companion')
      || (participant.entityRef !== undefined && typeof participant.entityRef !== 'string')
  )))) return false;
  if (item.emotionalArc !== undefined && (!Array.isArray(item.emotionalArc) || item.emotionalArc.some((point) => (
    point === null
      || typeof point !== 'object'
      || !Number.isInteger(point.atTurn)
      || point.atTurn < 0
      || !Array.isArray(point.labels)
      || point.labels.length === 0
      || point.labels.some((label) => typeof label !== 'string' || label.trim().length === 0)
      || (point.intensity !== undefined
        && (typeof point.intensity !== 'number' || !Number.isFinite(point.intensity) || point.intensity < 0 || point.intensity > 1))
      || (point.source !== 'user_expressed' && point.source !== 'observed')
  )))) return false;
  return (item.userReaction === undefined || typeof item.userReaction === 'string')
    && (item.responseRef === undefined || typeof item.responseRef === 'string');
}

/** Shared extraction contract for the DSH turn path and the Oracle normal arm. */
export function extractionPrompt(
  predicateSchemas: readonly PredicateSchema[],
  envelope: 'array' | 'object' = 'array',
): string {
  const registered = predicateSchemas.map((schema) => {
    const enums = schema.enumValues.length === 0 ? '' : `; enum values: ${schema.enumValues.join(', ')}`;
    const entity = schema.requiresEntityRef ? '; entityRef required' : '';
    const qualifiers = schema.qualifierSchema === null
      ? ''
      : `; qualifiers: ${JSON.stringify(schema.qualifierSchema)}`;
    return `${schema.key} [${schema.valueKind}; ${schema.cardinality}${entity}${qualifiers}${enums}] — ${schema.description}`;
  }).join('\n');
  return [
    'You are a conservative companion-memory extractor. Read only the direct user message below.',
    envelope === 'array'
      ? 'Return a JSON array only. Each item must be one of:'
      : 'Return exactly one JSON object, {"items":[...]}; each item must be one of:',
    '{"kind":"claim","predicate":"registered.key","value":...,"rawValue":"optional source wording","entityRef":"optional","quote":"exact unique substring from the user message","confidence":0..1,"openThread":{"summary":"optional explicit unresolved event","entityRef":"optional","expiresAt":"optional ISO instant"}}',
    '{"kind":"episode","narrative":"brief factual event summary","participants":[{"role":"user|companion","entityRef":"optional"}],"emotionalArc":[{"atTurn":0,"labels":["user_stated_feeling"],"intensity":0..1,"source":"user_expressed|observed"}],"userReaction":"optional direct reaction","responseRef":"optional companion turn id","quote":"exact unique source substring","confidence":0..1}, {"kind":"runtime_state","reason":"transient only"}, or {"kind":"no_memory"}.',
    'Only extract explicit, durable claims and directly described episodes. Do not infer personality, intent, diagnosis, recurrence, emotional intensity, or facts not stated. Keep episode participants, emotionalArc, and userReaction grounded in the user message; use source="user_expressed" only when the user names the feeling, and source="observed" only for an observable turn detail. Use no_memory for greetings, weather, ordinary acknowledgements, and ambiguity.',
    'An openThread is permitted only for an explicit unresolved low-pressure event; omit it for preferences, boundaries, sensitive matters, or inferred concerns.',
    `Registered predicates (choose exactly one for claims; enum values must be copied exactly):\n${registered}`,
  ].join('\n');
}

/**
 * Validate model output against source text before it reaches Rust. This is
 * deliberately shared with Oracle so its normal arm cannot drift into a
 * separate, more permissive extractor.
 */
export function parseExtractionItems(
  items: readonly unknown[],
  text: string,
  sourceId: string,
): Extraction[] {
  const extracted: Extraction[] = [];
  let position = 0;
  for (const item of items) {
    if (!isRawExtraction(item)) continue;
    if (item.kind === 'no_memory') {
      extracted.push({ kind: 'no_memory' });
      continue;
    }
    if (item.kind === 'episode') {
      if (typeof item.narrative !== 'string' || typeof item.quote !== 'string') continue;
      if (!validEpisodeStructure(item)) continue;
      const span = sourceSpanForUniqueQuote(text, item.quote);
      if (span === undefined) continue;
      extracted.push({
        kind: 'episode',
        candidate: {
          id: `${sourceId}-episode-${position}`,
          narrative: item.narrative,
          sourceSpan: span,
          confidence: typeof item.confidence === 'number' ? item.confidence : 0.5,
          ...(Array.isArray(item.participants) ? { participants: item.participants } : {}),
          ...(Array.isArray(item.emotionalArc) ? { emotionalArc: item.emotionalArc } : {}),
          ...(typeof item.userReaction === 'string' ? { userReaction: item.userReaction } : {}),
          ...(typeof item.responseRef === 'string' ? { responseRef: item.responseRef } : {}),
        },
      });
      position += 1;
      continue;
    }
    if (item.kind === 'runtime_state') {
      extracted.push({ kind: item.kind, reason: item.reason ?? 'pending review' });
      continue;
    }
    if (item.kind !== 'claim') continue;
    if (typeof item.predicate !== 'string' || typeof item.quote !== 'string') continue;
    const span = sourceSpanForUniqueQuote(text, item.quote);
    if (span === undefined) continue;
    const candidate: ExtractedCandidate = {
      id: `${sourceId}-${position}`,
      predicate: item.predicate,
      value: item.value,
      sourceSpan: span,
      confidence: typeof item.confidence === 'number' ? item.confidence : 0.5,
      ...(typeof item.rawValue === 'string' ? { rawValue: item.rawValue } : {}),
      ...(typeof item.entityRef === 'string' ? { entityRef: item.entityRef } : {}),
      ...(item.qualifiers !== undefined ? { qualifiers: item.qualifiers } : {}),
      ...(item.openThread === undefined ? {} : {
        openThread: {
          id: `thread-${sourceId}-${position}`,
          summary: item.openThread.summary,
          ...(typeof item.openThread.entityRef === 'string' ? { entityRef: item.openThread.entityRef } : {}),
          ...(typeof item.openThread.expiresAt === 'string' ? { expiresAt: item.openThread.expiresAt } : {}),
        },
      }),
    };
    extracted.push({ kind: 'claim', candidate });
    position += 1;
  }
  return extracted.length === 0 ? [{ kind: 'no_memory' }] : extracted;
}

/** Uses the route that served the just-finished DSH turn; failures never block the turn. */
export async function extractFromUserMessage(
  ctx: Context,
  agent: Agent,
  text: string,
  sourceId: string,
  predicateSchemas: readonly PredicateSchema[],
  signal: AbortSignal,
): Promise<Extraction[]> {
  const target = routeForAgent(agent);
  if (target === undefined || text.trim().length === 0) return [{ kind: 'no_memory' }];
  const assembled = new BlockAssembler();
  for await (const chunk of ctx.llm.stream({
    ...target,
    sessionId: agent.session.id,
    signal,
    maxTokens: 700,
    messages: [
      createSystemMessage(extractionPrompt(predicateSchemas), 'companion-memory'),
      createUserMessage({
        content: [{ type: 'text', text }],
        source: { kind: 'plugin', plugin: 'companion-memory' },
      }),
    ],
  })) assembled.push(chunk);
  const output = assembled.blocks()
    .filter((block): block is Extract<typeof block, { type: 'text' }> => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
  return parseExtractionItems(parseJson(output), text, sourceId);
}
