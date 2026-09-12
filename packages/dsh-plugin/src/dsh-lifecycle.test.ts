import { Context } from '@deepseek-ai/cordis';
import AgentRegistry, { agentEvents, type Agent } from '@deepseek-ai/dsh-agent';
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm';
import SessionStore, { SessionId, type Session } from '@deepseek-ai/dsh-session';
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection';
import { describe, expect, it } from 'vitest';

import * as CompanionMemory from './index.js';
import { WorkerClient } from './worker-client.js';

const workerProgram = [
  "const r=require('node:readline').createInterface({input:process.stdin});",
  "r.on('line',line=>{const q=JSON.parse(line);let result={};",
  "if(q.op==='health')result={protocolVersion:1,schemaVersion:3,predicateKeys:[],predicateSchemas:[]};",
  "if(q.op==='warm')result={revision:0,plan:{constraints:[],identity:[],responseStyle:[],continuity:[],topicActivated:[],deepRecall:[],doNotSurface:[]}};",
  "if(q.op==='admit')result={accepted:[],rejected:[],pending:0};",
  "if(q.op==='query')result={records:[]}; if(q.op==='forget')result={forgotten:false,recordIds:[]};",
  "if(q.op==='session_closed')result={expired:0}; console.log(JSON.stringify({version:1,id:q.id,ok:true,result}));});",
].join('');

const extractionWorkerProgram = [
  'let admitted=0;',
  "const r=require('node:readline').createInterface({input:process.stdin});",
  "r.on('line',line=>{const q=JSON.parse(line);let result={};",
  "if(q.op==='health')result={protocolVersion:1,schemaVersion:3,predicateKeys:[],predicateSchemas:[]};",
  "if(q.op==='warm')result={revision:admitted,plan:{constraints:[],identity:[],responseStyle:admitted?[{recordId:'admit-observed',text:'extraction_observed',surface:'freely_mentionable',reason:'test'}]:[],continuity:[],topicActivated:[],deepRecall:[],doNotSurface:[]}};",
  "if(q.op==='admit'){admitted+=1;result={accepted:[],rejected:[],pending:0};}",
  "if(q.op==='query')result={records:[]};if(q.op==='forget')result={forgotten:false,recordIds:[]};",
  "if(q.op==='session_closed')result={expired:0};console.log(JSON.stringify({version:1,id:q.id,ok:true,result}));});",
].join('');

function fakeAgent(session: Session): Agent {
  return { id: session.id, session, options: {} } as unknown as Agent;
}

describe('real DSH pre-step lifecycle', () => {
  it('injects exactly one durable plugin snapshot on the first pre-step', async () => {
    const ctx = new Context();
    try {
      await ctx.plugin(SessionStore);
      await ctx.plugin(SessionProjectionRegistry);
      await ctx.plugin(AgentRegistry);
      await ctx.plugin(LlmRuntime);
      ctx.provide('tools', { register: () => () => {} } as never);
      const probe = new WorkerClient({ command: process.execPath, args: ['-e', workerProgram, '--'], databasePath: ':memory:', requestTimeoutMs: 1_000 });
      await expect(probe.health()).resolves.toMatchObject({ predicateKeys: [] });
      await probe.close();
      await ctx.plugin(CompanionMemory, {
        serviceId: 'svc', ownerUserId: 'owner', defaultProfileId: 'fallback', databasePath: ':memory:',
        workerCommand: process.execPath, workerArgs: ['-e', workerProgram, '--'], workerRequestTimeoutMs: 1_000,
      });
      const session = ctx.sessions.create(SessionId('companion-memory-test'));
      const agent = fakeAgent(session);
      const direct = createUserMessage({ content: [{ type: 'text', text: '你好' }], source: { kind: 'user' } });
      const first = await agentEvents(ctx, agent).waterfall('agent/pre-step', {
        messages: [direct], turn: 1, step: 1, signal: new AbortController().signal,
      }, () => Promise.resolve({ kind: 'enter' as const, messages: [direct] }));
      expect(first.kind).toBe('enter');
      if (first.kind !== 'enter') throw new Error('expected accepted pre-step');
      expect(first.messages).toHaveLength(2);
      expect(first.messages[1]?.source).toMatchObject({ kind: 'plugin', plugin: 'companion-memory', form: 'snapshot' });

      const later = await agentEvents(ctx, agent).waterfall('agent/pre-step', {
        messages: [direct], turn: 1, step: 2, signal: new AbortController().signal,
      }, () => Promise.resolve({ kind: 'enter' as const, messages: [direct] }));
      expect(later).toMatchObject({ kind: 'enter', messages: [direct] });
    } finally {
      await ctx.fiber.dispose();
    }
  });

  it('observes only a direct user event and admits it after turn/end without blocking the turn', async () => {
    const ctx = new Context();
    try {
      await ctx.plugin(SessionStore);
      await ctx.plugin(SessionProjectionRegistry);
      await ctx.plugin(AgentRegistry);
      await ctx.plugin(LlmRuntime);
      ctx.provide('tools', { register: () => () => {} } as never);
      await ctx.plugin(CompanionMemory, {
        serviceId: 'svc', ownerUserId: 'owner', defaultProfileId: 'fallback', databasePath: ':memory:',
        workerCommand: process.execPath, workerArgs: ['-e', extractionWorkerProgram, '--'], workerRequestTimeoutMs: 1_000,
      });
      const session = ctx.sessions.create(SessionId('companion-memory-extraction-test'));
      const agent = fakeAgent(session);
      const firstDirect = createUserMessage({ content: [{ type: 'text', text: '你好' }], source: { kind: 'user' } });
      await agentEvents(ctx, agent).waterfall('agent/pre-step', {
        messages: [firstDirect], turn: 1, step: 1, signal: new AbortController().signal,
      }, () => Promise.resolve({ kind: 'enter' as const, messages: [firstDirect] }));

      session.append('user/message', firstDirect, { surfaceOp: 'append' });
      session.append('turn/end', { turn: 1, reason: { kind: 'completed' } });
      await new Promise((resolve) => setTimeout(resolve, 40));

      const secondDirect = createUserMessage({ content: [{ type: 'text', text: '继续' }], source: { kind: 'user' } });
      const second = await agentEvents(ctx, agent).waterfall('agent/pre-step', {
        messages: [secondDirect], turn: 2, step: 1, signal: new AbortController().signal,
      }, () => Promise.resolve({ kind: 'enter' as const, messages: [secondDirect] }));
      expect(second.kind).toBe('enter');
      if (second.kind !== 'enter') throw new Error('expected accepted pre-step');
      const snapshot = second.messages[1]?.content[0];
      expect(snapshot).toMatchObject({ type: 'text', text: expect.stringContaining('extraction_observed') });
    } finally {
      await ctx.fiber.dispose();
    }
  });
});
