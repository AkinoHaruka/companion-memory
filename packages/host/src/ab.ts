/**
 * A/B: does the memory change what the companion says?
 *
 * Every other check in this repository verifies that a record was stored, that
 * it reached the injected context, or that a gate held. None of them verify the
 * claim the product is actually making — that the companion behaves differently
 * because it remembers. A memory system whose injection changes nothing is
 * elaborate decoration, and no amount of green unit tests would say so.
 *
 * ## The design
 *
 * For each turn, two replies are produced from the same model at the same
 * instant with the same user text. The only difference is the system prompt:
 * one carries the memory the pipeline assembled, the other carries the same
 * instructions with no records.
 *
 * Extraction runs once per turn, before the replies, so both variants are in
 * state B of the A/B/B/A sense: identical inputs, one variable. Extraction is
 * shared rather than run twice because it is not what is under test, and
 * running it twice would introduce the extractor's own non-determinism into the
 * comparison.
 *
 * ## What the result can and cannot show
 *
 * It shows whether an injected record changed the words. It does not show that
 * the change was *better* — that judgement needs a reader, and the report
 * therefore prints the pairs rather than scoring them.
 *
 *   node dist/src/ab.js
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { MemoryScope, WarmResult } from '../../dsh-plugin/src/memory.js';
import { renderOverlay, renderStable } from '../../dsh-plugin/src/render.js';
import { AgnesClient, fromEnv, type ChatMessage } from './agnes.js';
import { HostKernel } from './kernel.js';
import { SESSIONS } from './script.js';
import { HostStore } from './store.js';

const NOW = '2026-06-01T20:00:00Z';

/** One turn's two replies and everything needed to judge the difference. */
interface Comparison {
  session: string;
  day: number;
  intent: string;
  user: string;
  /**
   * The stable block the memory-aware side was given.
   *
   * Recorded because the first version of the A/B only kept the candidates, and
   * the attribution script then looked for the user's name among them and
   * reported zero — while the replies plainly used it. The name lives in the
   * stable block, so a measurement that omitted it measured nothing.
   */
  stableBlock: string;
  /** Records the memory-aware companion was given. */
  visibleRecords: { id: string; mention: string; text: string }[];
  /** The memory-aware reply. */
  withMemory: string;
  /** The same reply request with the memory blocks emptied. */
  withoutMemory: string;
  /** Whether the two differ as text. */
  differs: boolean;
  /** Character length of each, as a crude proxy for how much was said. */
  withMemoryLength: number;
  withoutMemoryLength: number;
}

/** Add whole days to an ISO instant. */
function addDays(iso: string, days: number): string {
  return new Date(Date.parse(iso) + days * 86_400_000).toISOString();
}

/** The system prompt with the memory blocks removed but the instructions intact. */
function withoutMemoryPrompt(kernel: HostKernel, warmed: WarmResult): string {
  // The same prompt with empty content, not a different prompt. Dropping the
  // instructions too would confound "has memory" with "was told how to use
  // memory", and every difference would then be attributable to the wrong cause.
  //
  // `now` is destructured out rather than set to undefined: with exact optional
  // properties an explicit undefined is not the same as an absent field, and the
  // renderer decides whether to emit the state block by its presence.
  const { now, ...rest } = warmed;
  void now;
  return kernel.buildSystemPrompt({ ...rest, stable: '', candidates: [] });
}

async function main(): Promise<void> {
  const client = new AgnesClient(fromEnv());
  const runsDir = join(process.cwd(), 'runs', 'ab');
  mkdirSync(runsDir, { recursive: true });
  const store = new HostStore(join(runsDir, 'ab.db'));

  const scope: MemoryScope = {
    serviceId: 'ab',
    ownerUserId: 'linyue',
    companionProfileId: 'default',
  };

  const kernel = new HostKernel({ client, store, scope, now: () => NOW });
  const comparisons: Comparison[] = [];

  for (const session of SESSIONS) {
    const at = addDays(NOW, session.dayOffset);
    for (const [index, turn] of session.turns.entries()) {
      // Recall once, so both replies are built from the same state.
      const warmed = await kernel.warm(scope, turn.text, at);
      const withPrompt = kernel.buildSystemPrompt(warmed);
      const withoutPrompt = withoutMemoryPrompt(kernel, warmed);

      const ask = (system: string): Promise<string> =>
        client
          .chat(
            [
              { role: 'system', content: system },
              { role: 'user', content: turn.text },
            ] satisfies ChatMessage[],
            { maxTokens: 400 },
          )
          .then((result) => result.text.trim());

      const withMemory = await ask(withPrompt);
      const withoutMemory = await ask(withoutPrompt);

      comparisons.push({
        session: session.id,
        day: session.dayOffset,
        intent: turn.intent,
        user: turn.text,
        stableBlock: renderStable(warmed),
        visibleRecords: warmed.candidates.map((candidate) => ({
          id: candidate.id,
          mention: candidate.mention,
          text: candidate.text,
        })),
        withMemory,
        withoutMemory,
        differs: withMemory !== withoutMemory,
        withMemoryLength: withMemory.length,
        withoutMemoryLength: withoutMemory.length,
      });

      process.stdout.write(
        `[${session.id}:${index}] ${turn.intent}\n` +
          `  records visible: ${warmed.candidates.length}\n` +
          `  differs: ${withMemory !== withoutMemory}\n`,
      );

      // Extraction runs after the replies, so the turn's own content cannot
      // reach the replies that are meant to be compared on equal footing.
      await kernel.observe(
        scope,
        [{ role: 'user', text: turn.text, id: `${session.id}-${index}` }],
        at,
      );
    }
  }

  const differ = comparisons.filter((comparison) => comparison.differs).length;
  const informed = comparisons.filter((comparison) => comparison.visibleRecords.length > 0).length;

  const summary = {
    turns: comparisons.length,
    turnsWhereMemoryWasVisible: informed,
    repliesThatDiffered: differ,
    repliesThatDifferedWhereMemoryWasVisible: comparisons.filter(
      (comparison) => comparison.differs && comparison.visibleRecords.length > 0,
    ).length,
    calls: client.callCount,
    tokens: client.totalTokens,
  };

  writeFileSync(
    join(runsDir, 'comparisons.json'),
    JSON.stringify(comparisons, null, 2),
    'utf8',
  );
  writeFileSync(join(runsDir, 'summary.json'), JSON.stringify(summary, null, 2), 'utf8');

  process.stdout.write(`\n${'='.repeat(72)}\n`);
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  process.stdout.write(`${'='.repeat(72)}\n`);
  process.stdout.write(`artifacts: ${runsDir}\n`);

  store.close();
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
