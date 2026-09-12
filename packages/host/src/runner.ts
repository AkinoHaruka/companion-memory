/**
 * The conversation runner.
 *
 * Drives a real exchange across several sessions, extracts after every turn, and
 * then runs the dream pass. This is the only place the whole loop executes
 * together, so it is where the wiring is actually exercised rather than
 * assembled by hand in a test.
 *
 * ## Why the turn is built directly rather than through the plugin
 *
 * The pipeline a live profile runs is `agent/pre-step` → warm → the adapter
 * renders → assembly → the model replies → `observe`. Every one of those steps
 * exists in this file in the same order, calling the same functions the plugin
 * registers. What it does not have is a booted DSH agent loop, which needs a
 * composed profile, a session store and a provider route. So this proves the
 * memory pipeline end to end and does not prove that the harness invokes it —
 * the distinction the README already draws.
 */

import type { MemoryScope } from '../../dsh-plugin/src/memory.js';
import { renderOverlay, renderStable } from '../../dsh-plugin/src/render.js';
import type { WarmResult } from '../../dsh-plugin/src/memory.js';
import { AgnesClient, type ChatMessage } from './agnes.js';
import { HostKernel } from './kernel.js';
import { HostStore } from './store.js';

/** One thing the simulated user says. */
export interface UserTurn {
  /** The text. */
  text: string;
  /**
   * A short label for what this turn is testing.
   *
   * Written by hand rather than derived, so the report can say why a turn is
   * there instead of only what was said.
   */
  intent: string;
}

/** One session: a dated sequence of turns. */
export interface SessionScript {
  /** Stable identifier, used to group episodes and count independence. */
  id: string;
  /** How many days after the run's start this session happens. */
  dayOffset: number;
  /** The turns, in order. */
  turns: UserTurn[];
}

/** One recorded turn, for the transcript and the report. */
export interface TurnRecord {
  sessionId: string;
  index: number;
  at: string;
  intent: string;
  user: string;
  /** What the memory system put in front of the companion. */
  injectedContext: string;
  /** The stable block, when it changed. */
  stableBlock: string;
  /** Every record the companion could see this turn, by id. */
  visibleRecordIds: string[];
  /** The companion's reply. */
  companion: string;
  /** What extraction wrote. */
  storedClaims: number;
  storedEpisodes: number;
  refused: { predicate: string; reason: string }[];
}

/** Configuration for a run. */
export interface RunOptions {
  /** The model, used for both sides. */
  client: AgnesClient;
  /** Where records live. */
  store: HostStore;
  /** The relationship. */
  scope: MemoryScope;
  /** The sessions to play. */
  sessions: readonly SessionScript[];
  /** The instant the run starts, so a run is reproducible. */
  startedAt: string;
  /** Progress lines. */
  log?: (line: string) => void;
}

/** Everything a run produced. */
export interface RunResult {
  /** One entry per turn, in order. */
  turns: TurnRecord[];
  /** Records at the end of the conversation, before the dream pass. */
  claimsBeforeDream: number;
  /** Episodes at the end. */
  episodes: number;
  /** What the dream pass did. */
  dream: Awaited<ReturnType<HostKernel['dream']>>;
  /** Records after the dream pass. */
  claimsAfterDream: number;
  /** Calls made across the run. */
  calls: number;
  /** Tokens consumed. */
  tokens: number;
}

/** Add whole days to an ISO instant. */
function addDays(iso: string, days: number): string {
  return new Date(Date.parse(iso) + days * 86_400_000).toISOString();
}

/**
 * Play the sessions, then dream.
 *
 * @param options - the model, the store, the relationship and the script.
 * @returns the transcript and the reports.
 */
export async function runConversation(options: RunOptions): Promise<RunResult> {
  const { client, store, scope, sessions, startedAt } = options;
  const log = options.log ?? (() => {});
  const kernel = new HostKernel({ client, store, scope, now: () => startedAt, log });

  const turns: TurnRecord[] = [];
  let sessionIndex = 0;

  for (const session of sessions) {
    sessionIndex += 1;
    const at = addDays(startedAt, session.dayOffset);
    log(`\n--- session ${sessionIndex}: ${session.id} (day +${session.dayOffset}) ---`);

    for (const [index, turn] of session.turns.entries()) {
      // The memory pipeline, in the order a live profile runs it.
      const warmed = await kernel.warm(scope, turn.text, at);
      const injected = [renderStable(warmed), renderOverlay(warmed)]
        .filter((part) => part.length > 0)
        .join('\n');

      const reply = await client.chat(
        [
          { role: 'system', content: kernel.buildSystemPrompt(warmed) },
          { role: 'user', content: turn.text },
        ],
        { maxTokens: 400 },
      );

      const outcome = await kernel.observe(
        scope,
        [{ role: 'user', text: turn.text, id: `${session.id}-${index}` }],
        at,
      );
      const extraction = kernel.lastExtraction;

      turns.push({
        sessionId: session.id,
        index,
        at,
        intent: turn.intent,
        user: turn.text,
        injectedContext: injected,
        stableBlock: renderStable(warmed),
        visibleRecordIds: warmed.candidates.map((candidate) => candidate.id),
        companion: reply.text.trim(),
        storedClaims: extraction?.stored ?? 0,
        storedEpisodes: extraction?.episodes ?? 0,
        refused: extraction?.refused ?? [],
      });
      void outcome;

      log(
        `  [${turn.intent}] stored ${extraction?.stored ?? 0} claim(s), ` +
          `${extraction?.episodes ?? 0} episode(s); companion saw ${warmed.candidates.length} record(s)`,
      );
    }
  }

  const claimsBeforeDream = store.activeClaims(scope).length;
  const episodes = store.episodes(scope).length;

  log('\n--- dream pass ---');
  const dream = await kernel.dream();

  return {
    turns,
    claimsBeforeDream,
    episodes,
    dream,
    claimsAfterDream: store.activeClaims(scope).length,
    calls: client.callCount,
    tokens: client.totalTokens,
  };
}

/** A warm result rebuilt from a turn record, for a report that re-renders context. */
export function renderTurnContext(record: TurnRecord): string {
  const rebuilt: WarmResult = {
    stable: '',
    candidates: [],
    revision: 0,
  };
  void rebuilt;
  return record.injectedContext;
}

/** The message list a caller would send for one turn, for inspection. */
export function messagesFor(record: TurnRecord, systemPrompt: string): ChatMessage[] {
  return [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: record.user },
  ];
}
