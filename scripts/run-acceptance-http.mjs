#!/usr/bin/env node
/**
 * Run the Oracle acceptance over an OpenAI-compatible route, one repetition per
 * process.
 *
 * Ten repetitions inside one launcher process aborted twice with `0xC0000409`
 * partway through the first repetition, and a crash there loses every repetition
 * after it. This runs each repetition in its own child process, so a repetition
 * that dies costs one repetition rather than the whole run, and then aggregates
 * the artifacts that completed with the evaluator's own criterion.
 *
 * The route and its keys come from the environment and are never written down:
 *
 *   COMPANION_MEMORY_EVAL_BASE_URLS  comma-separated hosts, e.g.
 *                                    https://open.bigmodel.cn/api/paas/v4,https://api.z.ai/api/paas/v4
 *   COMPANION_MEMORY_EVAL_MODEL      e.g. GLM-4.7-Flash
 *   COMPANION_MEMORY_EVAL_API_KEYS   comma-separated keys
 *   COMPANION_MEMORY_EVAL_BODY_JSON  optional provider fields, e.g.
 *                                    {"thinking":{"type":"disabled"}}
 *
 * The singular `_BASE_URL` and `_API_KEY` are accepted too. Several credentials
 * are the normal case: a contention refusal arrives as HTTP 429, so a run that
 * holds only one credential simply stops when that credential is refused.
 *
 * `COMPANION_MEMORY_EVAL_BODY_JSON` is not cosmetic on a reasoning route. With
 * the thinking left on, a 400-token reply budget was measured to be spent 397
 * tokens deep on hidden reasoning, returning no visible answer at all — 400
 * tokens, zero text, `finish_reason: "length"`. That failure looks exactly like
 * a provider refusal and exactly like a model that said nothing, which is why
 * the run reports `routeRefusals` and `starvedReplies` separately.
 *
 *   node scripts/run-acceptance-http.mjs --runs 10
 *   node scripts/run-acceptance-http.mjs --runs 1 --label glm-smoke
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');

function flag(name, fallback) {
  const index = process.argv.indexOf(name);
  return index < 0 ? fallback : process.argv[index + 1];
}

const runs = Number(flag('--runs', '10'));
if (!Number.isInteger(runs) || runs < 1) throw new Error('--runs must be a positive integer');
const label = flag('--label', 'http');

const list = (value) => (value ?? '').split(',').map((part) => part.trim()).filter((part) => part.length > 0);

const baseUrls = [...list(process.env.COMPANION_MEMORY_EVAL_BASE_URLS), ...list(process.env.COMPANION_MEMORY_EVAL_BASE_URL)];
const apiKeys = [...list(process.env.COMPANION_MEMORY_EVAL_API_KEYS), ...list(process.env.COMPANION_MEMORY_EVAL_API_KEY)];
const model = process.env.COMPANION_MEMORY_EVAL_MODEL?.trim();
const paired = process.env.COMPANION_MEMORY_EVAL_CREDENTIALS?.trim();
if (paired === undefined || paired.length === 0) {
  if (baseUrls.length === 0) throw new Error('COMPANION_MEMORY_EVAL_CREDENTIALS, or COMPANION_MEMORY_EVAL_BASE_URLS (or _BASE_URL), must be set');
  if (apiKeys.length === 0) throw new Error('COMPANION_MEMORY_EVAL_API_KEYS (or _API_KEY) must be set');
}
if (model === undefined || model.length === 0) throw new Error('COMPANION_MEMORY_EVAL_MODEL must be set');
process.stdout.write(paired !== undefined && paired.length > 0
  ? `route: model=${model} credentials=paired\n`
  : `route: model=${model} credentials=${baseUrls.length * apiKeys.length} hosts=${new Set(baseUrls).size}\n`);;

const runner = join(repositoryRoot, 'packages', 'host', 'dist', 'src', 'run.js');
if (!existsSync(runner)) throw new Error(`build the host first: (cd packages/host && pnpm build) -- missing ${runner}`);

/** The first `label-N` run directory that does not exist, so a rerun never reuses a database. */
function unusedLabel() {
  const root = join(repositoryRoot, 'runs', 'oracle');
  let index = 0;
  while (existsSync(join(root, `${label}-${index}`))) index += 1;
  return `${label}-${index}`;
}

const failures = [];
for (let repetition = 0; repetition < runs; repetition += 1) {
  const runId = unusedLabel();
  const started = Date.now();
  process.stdout.write(`\n[${repetition + 1}/${runs}] ${runId}\n`);
  const child = spawnSync(process.execPath, [runner], {
    cwd: repositoryRoot,
    stdio: ['ignore', 'inherit', 'inherit'],
    env: { ...process.env, COMPANION_MEMORY_EVAL_REPETITIONS: '1', COMPANION_MEMORY_EVAL_RUN_ID: runId, COMPANION_MEMORY_EVAL_MODE: 'acceptance' },
  });
  const seconds = ((Date.now() - started) / 1000).toFixed(0);
  if (child.status !== 0) failures.push(`${runId} exited ${child.status} (${seconds}s)`);
  else process.stdout.write(`  repetition finished in ${seconds}s\n`);
}

process.stdout.write('\n=== aggregate ===\n');
spawnSync(process.execPath, [join(repositoryRoot, 'scripts', 'aggregate-acceptance.mjs'), join(repositoryRoot, 'runs', 'oracle'), '--runs', String(runs)], { cwd: repositoryRoot, stdio: 'inherit' });

if (failures.length > 0) {
  process.stdout.write(`\nrepetitions that exited non-zero (a failing acceptance exits 1 by design):\n  ${failures.join('\n  ')}\n`);
}
