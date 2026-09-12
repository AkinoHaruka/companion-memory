/**
 * The acceptance tool mounts, and running it runs an evaluation.
 *
 * The failure this guards against is the one that already happened once in this
 * project: a plugin that mounts without error, registers its lifecycle hooks, and
 * then does nothing at all — no throw, no log, no output, and a plan that stays
 * empty forever. A clean type check and a successful `apply` proved nothing about
 * whether the thing worked.
 *
 * So this drives the mounted tool through a real evaluation against a fake worker
 * and a fake route, and asserts on the artifacts that came out. The replies and
 * their scores are meaningless — the route returns one fixed string — but the run
 * reaching the point of writing `oracle-summary.json` is the whole claim.
 */

import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { Context } from '@deepseek-ai/cordis';
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent';
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session';
import { describe, expect, it } from 'vitest';

import * as Gateway from './gateway.js';

/** A worker that accepts everything and renders whatever it holds. */
const workerProgram = [
  "const r=require('node:readline').createInterface({input:process.stdin});",
  "const memories=new Map();",
  "r.on('line',line=>{const q=JSON.parse(line);const p=q.params||{};",
  "const profile=p.scope&&p.scope.companion_profile_id||'';let result={};",
  "if(q.op==='health')result={protocolVersion:1,schemaVersion:3,predicateKeys:['identity.name'],predicateSchemas:[{key:'identity.name',valueKind:'text',enumValues:[]}]};",
  "if(q.op==='admit'){const rows=memories.get(profile)||[];for(const c of p.candidates||[])rows.push({id:'claim-'+c.id,text:c.predicate+': '+(c.raw_value||c.value)});memories.set(profile,rows);result={accepted:(p.candidates||[]).map(c=>'claim-'+c.id),rejected:[],pending:0};}",
  "if(q.op==='warm'){const rows=memories.get(profile)||[];result={revision:rows.length,plan:{constraints:[],responseStyle:rows.map(r=>({recordId:r.id,text:r.text,surface:'freely_mentionable',reason:'test'})),continuity:[],topicActivated:[],deepRecall:[],doNotSurface:[]}};}",
  "if(q.op==='query')result={records:[]};if(q.op==='forget')result={forgotten:false,recordIds:[]};if(q.op==='session_closed')result={expired:0};",
  "console.log(JSON.stringify({version:1,id:q.id,ok:true,result}));});",
].join('');

interface RegisteredTool {
  name: string;
  execute: (args: unknown, context: unknown) => Promise<{ text: string; passed: boolean }>;
}

interface Mounted {
  ctx: Context;
  tools: RegisteredTool[];
  /** How many times the route was asked for a reply. */
  routeCalls: () => number;
}

/**
 * Mount the gateway on a context whose route answers with one fixed string.
 *
 * `BlockAssembler` consumes raw stream chunks, so the fake speaks that protocol
 * rather than returning text: a route that handed back a plain string would pass
 * a naive test and fail against the real runtime.
 */
async function mount(outputDirectory: string): Promise<Mounted> {
  const ctx = new Context();
  await ctx.plugin(SessionStore);
  await ctx.plugin(AgentRegistry);
  const tools: RegisteredTool[] = [];
  let routeCalls = 0;
  ctx.provide('tools', {
    register: (tool: RegisteredTool) => {
      tools.push(tool);
      return () => {};
    },
  } as never);
  ctx.provide('llm', {
    async *stream() {
      routeCalls += 1;
      const text = '林越，我在。';
      yield { type: 'block-start', index: 0, blockType: 'text' };
      yield { type: 'text-delta', index: 0, text };
      yield { type: 'block-end', index: 0, block: { type: 'text', text } };
      yield { type: 'finish', reason: 'stop' };
    },
  } as never);
  await ctx.plugin(Gateway, {
    outputDirectory,
    workerCommand: process.execPath,
    workerArgs: ['-e', workerProgram, '--'],
    runCount: 1,
  });
  return { ctx, tools, routeCalls: () => routeCalls };
}

/** The agent whose configured route the evaluation borrows. */
function fakeAgent(ctx: Context): Agent {
  const session = ctx.sessions.create(SessionId('companion-memory-oracle-test'));
  return { id: session.id, session, options: { provider: 'fake', model: 'fake' } } as unknown as Agent;
}

/** The tool the gateway registered, or a failure that says so. */
function onlyTool(mounted: Mounted): RegisteredTool {
  const tool = mounted.tools[0];
  if (tool === undefined) throw new Error('the gateway registered no tool');
  if (mounted.tools.length !== 1) throw new Error(`the gateway registered ${mounted.tools.length} tools`);
  return tool;
}

describe('Oracle acceptance gateway', () => {
  it('registers one tool and runs a whole evaluation when it is called', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'companion-memory-gateway-'));
    try {
      const mounted = await mount(directory);
      const tool = onlyTool(mounted);
      expect(tool.name).toBe('companion_memory_acceptance');

      const result = await tool.execute({ note: 'mount check' }, { agent: fakeAgent(mounted.ctx) });

      // The route was actually used: one extraction and four arm replies per turn.
      expect(mounted.routeCalls()).toBeGreaterThan(0);
      expect(result.text).toContain('mount check');
      expect(typeof result.passed).toBe('boolean');

      // The run reached the end, which is the part a mount-only check misses.
      const invocations = readdirSync(directory);
      expect(invocations).toHaveLength(1);
      const summary = JSON.parse(
        readFileSync(join(directory, invocations[0] ?? '', 'oracle-summary.json'), 'utf8'),
      ) as { runCount: number };
      expect(summary.runCount).toBe(1);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('refuses to run without an agent instead of failing somewhere deeper', async () => {
    // The tool borrows a route from a live agent. Called outside one there is no
    // route at all, and the useful answer is a sentence rather than an exception
    // from inside the evaluation.
    const directory = mkdtempSync(join(tmpdir(), 'companion-memory-gateway-bare-'));
    try {
      const mounted = await mount(directory);
      const result = await onlyTool(mounted).execute({ note: 'no agent' }, {});
      expect(result.passed).toBe(false);
      expect(result.text).toContain('agent');
      expect(readdirSync(directory)).toHaveLength(0);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
