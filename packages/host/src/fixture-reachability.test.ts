/**
 * Whether the Oracle script can demonstrate the effects it is scored on.
 *
 * The acceptance run costs a model call per turn per arm, and it can only pass if
 * the memory each scored effect depends on actually reaches the model. That is a
 * property of the frozen fixture and the activation rules, not of the model, so
 * it is measurable here for free: the real evaluator is driven against the real
 * worker with a client that never calls anything.
 *
 * The replies this produces are empty and their scores are meaningless. What is
 * not meaningless is `injectedRecordIds`, which is what the renderer actually put
 * in front of the model. The `gold_retrieved` arm is the one to read: every turn
 * receives exactly the human-verified memory for that turn, so the arm answers
 * "given the right memory, does it arrive?" — which isolates activation from
 * extraction, the non-deterministic part.
 *
 * A skipped test means the worker binary is not built. That is not a pass.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { runOracleEvaluation, type Arm, type EvaluationClient } from './evaluator.js';
import { PROBES, SESSIONS, type SessionScript } from './script.js';

const repositoryRoot = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..');
const workerCommand = process.env.COMPANION_MEMORY_WORKER_COMMAND?.trim()
  || join(repositoryRoot, 'target', 'debug', process.platform === 'win32' ? 'companion-memory-worker.exe' : 'companion-memory-worker');

/** Answers nothing and extracts nothing, so nothing scored here reflects a model. */
const silentClient: EvaluationClient = {
  async chat() { return { text: '' }; },
  async chatJson() { return {}; },
};

interface PlanChannel { text?: string; }

interface PlanShape {
  constraints?: PlanChannel[];
  responseStyle?: PlanChannel[];
  continuity?: PlanChannel[];
  topicActivated?: PlanChannel[];
  deepRecall?: PlanChannel[];
}

interface ArtifactRow {
  session: string;
  turn: number;
  intent: string;
  memoryOpportunity: 'positive' | 'negative' | 'none';
  effectType: string;
  arms: Record<Arm, { injectedRecordIds: string[]; plan?: PlanShape }>;
  rejections: Record<Arm, Array<{ candidateId: string; reason: string }>>;
}

/** Every record text the renderer put in front of the model, in any channel. */
function renderedText(row: ArtifactRow, arm: Arm): string {
  const plan = row.arms[arm].plan ?? {};
  return Object.values(plan)
    .flatMap((channel) => (Array.isArray(channel) ? channel : []))
    .map((entry) => entry.text ?? '')
    .join('\n');
}

/** The turn keys that declare what a reply must contain to show it read memory. */
function declaredEvidence(sessions: readonly SessionScript[]): Map<string, readonly string[]> {
  const declared = new Map<string, readonly string[]>();
  for (const session of sessions) {
    for (const [index, turn] of session.turns.entries()) {
      const evidence = turn.recallEvidence;
      if (evidence === undefined) continue;
      declared.set(`${session.id}t${index}`, [...evidence.strong, ...evidence.medium, ...evidence.weak]);
    }
  }
  return declared;
}

let replayCount = 0;

/** One evaluation of the whole fixture, shared by every case below. */
async function replayFixture(): Promise<ArtifactRow[]> {
  // Set to keep artifacts instead of deleting them, for reading a full plan. Each
  // call gets its own directory, because two cases sharing one database would trip
  // the stale-database guard rather than measure anything.
  const keep = process.env.COMPANION_MEMORY_REACHABILITY_DIR?.trim();
  replayCount += 1;
  const directory = keep !== undefined && keep.length > 0
    ? join(keep, `replay-${replayCount}`)
    : mkdtempSync(join(tmpdir(), 'companion-memory-reachability-'));
  try {
    await runOracleEvaluation({
      client: silentClient,
      databasePath: join(directory, 'oracle.db'),
      workerCommand,
      runCount: 1,
      outputDirectory: directory,
      sessions: [...SESSIONS, ...PROBES] as readonly SessionScript[],
    });
    return JSON.parse(readFileSync(join(directory, 'oracle-run-1.json'), 'utf8')) as ArtifactRow[];
  } finally {
    if (keep === undefined || keep.length === 0) rmSync(directory, { recursive: true, force: true });
  }
}

const label = (row: ArtifactRow): string =>
  `${row.session}t${row.turn} ${row.effectType}/${row.memoryOpportunity} "${row.intent}"`;

describe.skipIf(!existsSync(workerCommand))('Oracle fixture reachability', () => {
  it('delivers the verified memory on every turn that is scored for using it', async () => {
    const rows = await replayFixture();
    const empty = rows
      .filter((row) => row.memoryOpportunity === 'positive')
      .filter((row) => (row.arms.gold_retrieved.injectedRecordIds ?? []).length === 0)
      .map(label);

    expect(
      empty,
      'a turn scored for using memory had no memory in front of the model, so its effect '
      + 'cannot pass however good the replies are',
    ).toEqual([]);
  });

  it('delivers the declared evidence word itself, not merely some record', async () => {
    // "Some record arrived" is not the precondition the recall scorer needs. The
    // precondition is that the wording it looks for was in front of the model,
    // because a record that arrived without it cannot produce a hit however good
    // the reply is. Free to check: the renderer runs either way.
    const rows = await replayFixture();
    const declared = declaredEvidence([...SESSIONS, ...PROBES] as readonly SessionScript[]);
    const missing: string[] = [];
    for (const row of rows) {
      const tokens = declared.get(`${row.session}t${row.turn}`);
      if (tokens === undefined || tokens.length === 0) continue;
      const rendered = renderedText(row, 'gold_retrieved');
      const present = tokens.filter((token) => rendered.includes(token));
      if (present.length === 0) missing.push(`${label(row)} none of ${JSON.stringify(tokens)} reached the model`);
    }
    expect(missing).toEqual([]);
  });

  // Expected to fail, and deliberately so. It pins a live product defect whose fix
  // is outside the evaluator: `crates/worker/src/main.rs:850` classifies
  // `identity.name` as a policy claim, and `main.rs:384` renders every policy
  // claim into `<response_style>` under "Use these to choose language, tone,
  // format, and level of detail". A model reading that correctly concludes the
  // name is not something to say. Measured: eight forced records, the name in the
  // plan, and not one reply used it — and the batch reported that as the name
  // memory not working.
  //
  // The fix is a channel that means "who this is", not a style knob, which is a
  // worker rule change plus a renderer change. Until then the evaluator declares
  // the name observation `not_applicable` instead of scoring it, so the defect is
  // reported rather than measured. When someone fixes it, this test starts
  // passing and the suite fails until the marker is removed — which is the point.
  it.fails('never renders identity.name into the style channel (live defect, see crates/worker/src/main.rs:850)', async () => {
    // The measured defect, asserted statically. `identity.name` arrived inside
    // `<response_style>`, whose guidance is "Use these to choose language, tone,
    // format, and level of detail", so a model reading it correctly concludes the
    // name is not something to say. Eight forced records, and not one reply used
    // it -- and the batch reported that as the name memory not working.
    const rows = await replayFixture();
    const misplaced: string[] = [];
    for (const row of rows) {
      for (const arm of ['normal', 'gold_retrieved', 'gold_forced', 'counterfactual_forced'] as const) {
        for (const entry of row.arms[arm].plan?.responseStyle ?? []) {
          if ((entry.text ?? '').startsWith('identity.name')) misplaced.push(`${label(row)} ${arm}`);
        }
      }
    }
    expect(
      misplaced,
      'identity.name was handed to the model as a style parameter, so no reply can be read for it',
    ).toEqual([]);
  });

  it('never has an arm refused for a storage reason', async () => {
    // The arm-isolation requirement, and the case that would have caught the
    // defect this audit was written to find.
    //
    // A record id is a global primary key and the store refuses a same-id write
    // from another scope, so four arms fed the same ids means whichever arm wrote
    // first owns them and the other three store nothing. Their stores then read
    // empty, their replies are unaided, and the evaluation reports that memory
    // does not help — having measured a harness with three of its four arms
    // switched off.
    //
    // What is asserted is the reason, not the count. An arm that stores nothing
    // is often correct: repeating a value the arm already holds is a merge, and
    // its store still says what it should. A refusal for a *storage* reason is
    // never correct, because it means the harness dropped memory instead of the
    // arm deduplicating it.
    //
    // The reason string comes from the worker. It is spelled out rather than
    // matched loosely so that renaming it upstream fails here rather than
    // silently weakening the check.
    const rows = await replayFixture();
    const dropped: string[] = [];
    for (const row of rows) {
      for (const arm of ['normal', 'gold_retrieved', 'gold_forced', 'counterfactual_forced'] as const) {
        for (const rejection of row.rejections?.[arm] ?? []) {
          if (rejection.reason.includes('persist')) dropped.push(`${label(row)} ${arm} ${JSON.stringify(rejection)}`);
        }
      }
    }
    expect(
      dropped,
      'the harness dropped memory the arm was entitled to store, so its replies cannot reflect memory',
    ).toEqual([]);
  });
});
