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
import { runConversation, type SessionScript } from './runner.js';
import { HostStore } from './store.js';

/**
 * The person the companion is remembering.
 *
 * Deliberately not a flat character. The material is chosen so that the
 * assertions downstream have something to fail on:
 *
 * - a stated constraint in one session and a contradiction of it later, so
 *   supersede has work to do;
 * - one intense evening and a good week, so a transient mood has a chance to be
 *   mistaken for a durable fact;
 * - a detail mentioned once early and returned to much later, so recall has to
 *   survive a large vocabulary gap;
 * - one turn with nothing durable in it at all, so an empty extraction is
 *   exercised rather than assumed.
 */
const SESSIONS: SessionScript[] = [
  {
    id: 's1',
    dayOffset: 0,
    turns: [
      {
        intent: 'identity + language preference',
        text: '你好，我叫林越。以后我们用中文聊吧，我英文不太行。',
      },
      {
        intent: 'communication preference',
        text: '我比较喜欢简短直接的回答，别绕弯子，也不用一直问我感受。',
      },
      {
        intent: 'boundary',
        text: '有个事想说一下：别跟我提前任，那个话题我现在还不想碰。',
      },
    ],
  },
  {
    id: 's2',
    dayOffset: 3,
    turns: [
      {
        intent: 'transient state — must NOT become a fact',
        text: '今天特别累，开了一天会，脑子都是糊的。',
      },
      {
        intent: 'durable goal',
        text: '我最近在准备考一个证，十一月的考试，压力挺大的。',
      },
      {
        intent: 'nothing durable — must extract nothing',
        text: '嗯，今天天气还不错。',
      },
    ],
  },
  {
    id: 's3',
    dayOffset: 9,
    turns: [
      {
        intent: 'episode with emotion',
        text: '我家猫昨天吐了，半夜带它去了宠物医院，折腾到三点。今天上班完全是梦游状态。',
      },
      {
        intent: 'support preference',
        text: '我难受的时候你别急着给建议，先听我说完就好。',
      },
    ],
  },
  {
    id: 's4',
    dayOffset: 21,
    turns: [
      {
        intent: 'recall a detail from three weeks ago',
        text: '猫现在好多了，能吃东西了。',
      },
      {
        intent: 'recurring theme',
        text: '又加班到十点。这个项目好像永远做不完。',
      },
      {
        intent: 'contradiction — supersede territory',
        text: '关于简短这点我改主意了，聊正事的时候你多讲一点，我需要细节。',
      },
      {
        intent: 'contradiction restated more plainly',
        text: '我说的简短那个偏好不算数了。以后回答长一点没关系，尤其是我问工作的事。',
      },
    ],
  },
  {
    id: 's5',
    dayOffset: 30,
    turns: [
      {
        intent: 'recurring theme again, different session',
        text: '项目又延期了。我这两个月好像一直在赶同一个东西。',
      },
      {
        intent: 'a good day — must not be read as a personality change',
        text: '今天挺开心的，下午把方案过了，晚上去看了场演出。',
      },
      {
        intent: 'contradiction, third session',
        text: '再确认一次：回答的长度上我不需要简短了，详细一点更好。',
      },
    ],
  },
];

/** Days between the run's start and the dream pass. */
const NOW = '2026-06-01T20:00:00Z';

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
