/**
 * Run the memory system against a live model.
 *
 * Reads the credential from `AGNES_API_KEY`, writes the transcript and the
 * report to `runs/`, and prints a summary. The database persists to a file so a
 * second run reuses the same memory — which is also how a run can be inspected
 * afterwards rather than only while it happens.
 *
 *   AGNES_API_KEY=... node --experimental-strip-types packages/host/src/run.ts
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { MemoryScope } from '../../dsh-plugin/src/memory.js';
import { AgnesClient, fromEnv } from './agnes.js';
import { HostKernel } from './kernel.js';
import { runConversation } from './runner.js';
import { NOW, SESSIONS } from './script.js';
import { HostStore } from './store.js';




async function main(): Promise<void> {
  const client = new AgnesClient(fromEnv());
  const runsDir = join(process.cwd(), 'runs');
  mkdirSync(runsDir, { recursive: true });
  const dbPath = join(runsDir, 'companion.db');
  const store = new HostStore(dbPath);

  const scope: MemoryScope = {
    serviceId: 'local',
    ownerUserId: 'linyue',
    companionProfileId: 'default',
  };

  const lines: string[] = [];
  const log = (line: string) => {
    lines.push(line);
    process.stdout.write(`${line}\n`);
  };

  log(`database: ${dbPath}`);
  log(`endpoint: ${process.env.AGNES_BASE_URL ?? 'https://apihub.agnes-ai.com/v1'}`);
  log(`model:    ${process.env.AGNES_MODEL ?? 'agnes-3.0-flash'}`);

  const result = await runConversation({
    client,
    store,
    scope,
    sessions: SESSIONS,
    startedAt: NOW,
    log,
  });

  // The dream pass, reported.
  log('\n=== dream report ===');
  for (const belief of result.dream.stored) {
    log(`  stored  [${belief.sessions} episodes] ${belief.predicate}: ${belief.value}`);
  }
  for (const refusal of result.dream.refused) {
    log(`  refused ${refusal.reason}: ${refusal.value}`);
  }
  if (result.dream.stored.length === 0 && result.dream.refused.length === 0) {
    log('  (the pass proposed nothing)');
  }

  const claims = store.activeClaims(scope);
  log('\n=== what is remembered ===');
  for (const claim of claims) {
    log(`  ${claim.predicate} [${claim.mention}] = ${claim.value}`);
  }

  const transcripts = result.turns.map((turn) => ({
    session: turn.sessionId,
    at: turn.at,
    intent: turn.intent,
    user: turn.user,
    companion: turn.companion,
    injectedContext: turn.injectedContext,
    visibleRecordIds: turn.visibleRecordIds,
    storedClaims: turn.storedClaims,
    storedEpisodes: turn.storedEpisodes,
    refused: turn.refused,
  }));

  writeFileSync(
    join(runsDir, 'transcript.json'),
    JSON.stringify(transcripts, null, 2),
    'utf8',
  );
  writeFileSync(
    join(runsDir, 'report.json'),
    JSON.stringify(
      {
        turns: result.turns.length,
        claimsBeforeDream: result.claimsBeforeDream,
        episodes: result.episodes,
        dream: result.dream,
        claimsAfterDream: result.claimsAfterDream,
        calls: result.calls,
        tokens: result.tokens,
      },
      null,
      2,
    ),
    'utf8',
  );
  writeFileSync(join(runsDir, 'log.txt'), lines.join('\n'), 'utf8');

  log(`\nturns ${result.turns.length} | claims ${result.claimsBeforeDream} -> ${result.claimsAfterDream} | episodes ${result.episodes}`);
  log(`model calls ${result.calls} | tokens ${result.tokens}`);
  log(`artifacts: ${runsDir}`);

  store.close();
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
