import { describe, expect, it } from 'vitest';

import { createOpenAiCompatibleClient } from './openai-client.js';
import { routeRefused, starvedByReasoning } from './route-report.js';

interface Recorded { url: string; body: Record<string, unknown>; }

/**
 * A stub standing in for the provider, so these cases cost nothing and can
 * reproduce failures no live route will produce on request.
 */
function stubFetch(responses: readonly (() => Response)[]): { fetchImpl: typeof fetch; calls: Recorded[] } {
  const calls: Recorded[] = [];
  let index = 0;
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    calls.push({ url: String(input), body });
    const next = responses[Math.min(index, responses.length - 1)];
    index += 1;
    if (next === undefined) throw new Error('no stubbed response');
    return next();
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

function completion(content: string, extra: Record<string, unknown> = {}): Response {
  return new Response(JSON.stringify({
    model: 'test-model',
    choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content } }],
    usage: { completion_tokens: 10, completion_tokens_details: { reasoning_tokens: 0 } },
    ...extra,
  }), { status: 200, headers: { 'content-type': 'application/json' } });
}

const message = [{ role: 'user' as const, content: '猫现在好多了。' }];

describe('OpenAI-compatible evaluation client', () => {
  it('names a reply that a reasoning budget starved, instead of reporting an empty answer', async () => {
    // Measured against a real reasoning route: 400 tokens of budget, 397 of
    // them spent on hidden reasoning, `content: ""`, `finish_reason: "length"`.
    // The evaluator used to record only the empty string, which is also what a
    // provider refusal and a silent model look like.
    const { fetchImpl } = stubFetch([() => new Response(JSON.stringify({
      model: 'reasoning-model',
      choices: [{ index: 0, finish_reason: 'length', message: { role: 'assistant', content: '', reasoning_content: 'thinking...' } }],
      usage: { completion_tokens: 400, completion_tokens_details: { reasoning_tokens: 397 } },
    }), { status: 200 })]);
    const reports: unknown[] = [];
    const client = createOpenAiCompatibleClient({
      credentials: [{ baseUrl: 'https://example.invalid/api/paas/v4', apiKey: 'k' }],
      model: 'reasoning-model',
      fetchImpl, maxAttempts: 1, onCall: (report) => reports.push(report),
    });

    const reply = await client.chat(message, { maxTokens: 400 });

    expect(reply.text).toBe('');
    expect(reply.route?.finishReason).toBe('length');
    expect(reply.route?.reasoningTokens).toBe(397);
    expect(reply.route?.textLength).toBe(0);
    expect(starvedByReasoning(reply.route)).toBe(true);
    expect(routeRefused(reply.route)).toBe(false);
    expect(reports).toHaveLength(1);
  });

  it('retries an overload refusal and reports how many attempts it took', async () => {
    const { fetchImpl, calls } = stubFetch([
      () => new Response(JSON.stringify({ error: { code: '1305', message: '该模型当前访问量过大，请您稍后再试' } }), { status: 429 }),
      () => completion('那就好，能吃东西说明缓过来了。'),
    ]);
    const client = createOpenAiCompatibleClient({
      credentials: [{ baseUrl: 'https://example.invalid/api/paas/v4', apiKey: 'k' }],
      model: 'GLM-4.7-Flash', fetchImpl, retryBaseDelayMs: 1,
    });

    const reply = await client.chat(message, { maxTokens: 400 });

    expect(reply.text).toBe('那就好，能吃东西说明缓过来了。');
    expect(reply.route?.attempts).toBe(2);
    expect(reply.route?.error).toBeUndefined();
    expect(calls).toHaveLength(2);
  });

  it('retries a transport failure instead of turning a slow answer into an empty one', async () => {
    // Observed on a contended tier: a request that queued past the client's own
    // timeout came back as `attempts: 1`, so a slow answer was recorded as no
    // answer at all. A timeout is a transport failure, not a refusal to answer.
    const { fetchImpl, calls } = stubFetch([
      () => { throw new TypeError('fetch failed'); },
      () => completion('那就好，能吃东西说明缓过来了。'),
    ]);
    const client = createOpenAiCompatibleClient({
      credentials: [
        { baseUrl: 'https://first.invalid/api/paas/v4', apiKey: 'k1' },
        { baseUrl: 'https://second.invalid/api/paas/v4', apiKey: 'k2' },
      ],
      model: 'GLM-4.7-Flash', fetchImpl, retryBaseDelayMs: 1,
    });

    const reply = await client.chat(message, { maxTokens: 400 });

    expect(reply.text).toBe('那就好，能吃东西说明缓过来了。');
    expect(reply.route?.attempts).toBe(2);
    expect(calls).toHaveLength(2);
  });

  it('moves to the next credential after a refusal, rather than asking the same one again', async () => {
    // Both `1305 访问量过大` and `1113 余额不足` arrive as 429, and the
    // productive answer to either is the next key or the next host. Re-asking
    // the credential that just refused spends the run's budget to learn nothing.
    const { fetchImpl, calls } = stubFetch([
      () => new Response(JSON.stringify({ error: { code: '1305', message: 'The service may be temporarily overloaded' } }), { status: 429 }),
      () => completion('那就好，能吃东西说明缓过来了。'),
    ]);
    const client = createOpenAiCompatibleClient({
      credentials: [
        { baseUrl: 'https://first.invalid/api/paas/v4', apiKey: 'k1' },
        { baseUrl: 'https://second.invalid/api/paas/v4', apiKey: 'k2' },
      ],
      model: 'GLM-4.7-Flash', fetchImpl, retryBaseDelayMs: 1,
    });

    const reply = await client.chat(message, { maxTokens: 400 });

    expect(calls.map((call) => call.url)).toEqual([
      'https://first.invalid/api/paas/v4/chat/completions',
      'https://second.invalid/api/paas/v4/chat/completions',
    ]);
    expect(reply.route?.credential).toBe(1);
    expect(reply.route?.endpoint).toBe('second.invalid');
    expect(reply.route?.attempts).toBe(2);
  });

  it('does not retry a rejection the provider will repeat, and keeps the answer empty but named', async () => {
    // `1113 余额不足或无可用资源包` arrives as 429 and will never succeed, so
    // retrying it only spends the run's remaining budget to learn nothing.
    const { fetchImpl, calls } = stubFetch([
      () => new Response(JSON.stringify({ error: { code: '1210', message: '该模型始终思考，不支持关闭思考；请使用 low、high 或 max。' } }), { status: 400 }),
      () => completion('should never be reached'),
    ]);
    const client = createOpenAiCompatibleClient({
      credentials: [{ baseUrl: 'https://example.invalid/api/paas/v4', apiKey: 'k' }],
      model: 'glm-5.3-flash', fetchImpl, retryBaseDelayMs: 1,
    });

    const reply = await client.chat(message, { maxTokens: 400 });

    expect(calls).toHaveLength(1);
    expect(reply.text).toBe('');
    expect(reply.route?.attempts).toBe(1);
    expect(routeRefused(reply.route)).toBe(true);
    expect(reply.route?.error).toContain('1210');
  });

  it('lets a credential carry its own body fields, because the disable-thinking field differs by host', async () => {
    // Zhipu needs `thinking: {type: "disabled"}`; OpenRouter passes `thinking`
    // through to a model that ignores it and needs `reasoning: {enabled: false}`.
    // A wrong field is ignored rather than rejected, so a run that gets this
    // wrong looks healthy while every reply is written by a model that spent its
    // budget on hidden reasoning.
    const { fetchImpl, calls } = stubFetch([() => completion('好')]);
    const client = createOpenAiCompatibleClient({
      credentials: [
        { baseUrl: 'https://zhipu.invalid/api/paas/v4', apiKey: 'k1', body: { thinking: { type: 'disabled' } } },
        { baseUrl: 'https://openrouter.invalid/api/v1', apiKey: 'k2', body: { reasoning: { enabled: false } } },
      ],
      model: 'some-model',
      body: { temperature: 0.2 },
      fetchImpl,
    });

    await client.chat(message, { maxTokens: 400 });

    expect(calls[0]?.body.thinking).toEqual({ type: 'disabled' });
    expect(calls[0]?.body.reasoning).toBeUndefined();
    expect(calls[0]?.body.temperature).toBe(0.2);
  });

  it('retries the extraction without response_format when the provider rejects the field', async () => {
    // Measured on OpenRouter: `model: inclusionai/ling-3.0-flash-sante does not
    // support feature: structured-outputs`, HTTP 400 from the upstream provider,
    // while the identical prompt without the field returned well-formed JSON. A
    // failed extraction is swallowed by the evaluator by design, so losing it
    // costs the normal arm its memory and reads downstream as "memory does not
    // help".
    const { fetchImpl, calls } = stubFetch([
      () => new Response(JSON.stringify({ error: { message: 'Provider returned error', code: 400, metadata: { raw: 'model: x does not support feature: structured-outputs' } } }), { status: 400 }),
      () => completion('{"items":[{"kind":"claim"}]}'),
    ]);
    const client = createOpenAiCompatibleClient({
      credentials: [{ baseUrl: 'https://openrouter.invalid/api/v1', apiKey: 'k', body: { reasoning: { enabled: false } } }],
      model: 'inclusionai/ling-3.0-flash-sante:free', fetchImpl, retryBaseDelayMs: 1,
    });

    const parsed = await client.chatJson(message, { maxTokens: 800 });

    expect(parsed).toEqual({ items: [{ kind: 'claim' }] });
    expect(calls).toHaveLength(2);
    expect(calls[0]?.body.response_format).toEqual({ type: 'json_object' });
    expect(calls[1]?.body.response_format).toBeUndefined();
    expect(calls[1]?.body.reasoning).toEqual({ enabled: false });
  });

  it('remembers a credential that refused response_format, so the cost is once per run', async () => {
    // Recorded over a full run: every extraction call burned four attempts and
    // about 25 seconds on a refusal that was permanent, before the fallback ran.
    // Twenty turns of that is five minutes of the run spent re-learning the same
    // fact.
    const { fetchImpl, calls } = stubFetch([
      () => new Response(JSON.stringify({ error: { message: 'Provider returned error', code: 400, metadata: { raw: 'model: x does not support feature: structured-outputs' } } }), { status: 400 }),
      () => completion('{"items":[]}'),
      () => completion('{"items":[]}'),
    ]);
    const client = createOpenAiCompatibleClient({
      credentials: [{ baseUrl: 'https://openrouter.invalid/api/v1', apiKey: 'k', body: { reasoning: { enabled: false } } }],
      model: 'inclusionai/ling-3.0-flash-sante:free', fetchImpl, retryBaseDelayMs: 1,
    });

    await client.chatJson(message, { maxTokens: 800 });
    await client.chatJson(message, { maxTokens: 800 });

    expect(calls).toHaveLength(3);
    expect(calls[1]?.body.response_format).toBeUndefined();
    expect(calls[2]?.body.response_format).toBeUndefined();
  });

  it('drops a credential whose day is over instead of asking it again', async () => {
    // Measured: `free-models-per-day` with X-RateLimit-Remaining: 0, ten attempts
    // of 25 seconds each, on a credential that could not recover until the next
    // day. The run kept rotating into it.
    const { fetchImpl, calls } = stubFetch([
      () => new Response(JSON.stringify({ error: { message: 'Rate limit exceeded: free-models-per-day', code: 429 } }), { status: 429 }),
      () => completion('那就好，能吃东西说明缓过来了。'),
    ]);
    const client = createOpenAiCompatibleClient({
      credentials: [
        { baseUrl: 'https://first.invalid/api/v1', apiKey: 'k1' },
        { baseUrl: 'https://second.invalid/api/v1', apiKey: 'k2' },
      ],
      model: 'm', fetchImpl, retryBaseDelayMs: 1,
    });

    const reply = await client.chat(message, { maxTokens: 400 });

    expect(reply.text).toBe('那就好，能吃东西说明缓过来了。');
    expect(reply.route?.credential).toBe(1);
    expect(calls.map((call) => call.url)).toEqual([
      'https://first.invalid/api/v1/chat/completions',
      'https://second.invalid/api/v1/chat/completions',
    ]);
  });

  it('sends provider body fields verbatim and reads a fenced JSON answer', async () => {
    const { fetchImpl, calls } = stubFetch([() => completion('```json\n{"items":[{"predicate":"identity.name"}]}\n```')]);
    const client = createOpenAiCompatibleClient({
      credentials: [{ baseUrl: 'https://example.invalid/api/paas/v4/', apiKey: 'k' }],
      model: 'GLM-4.7-Flash',
      body: { thinking: { type: 'disabled' } }, fetchImpl,
    });

    const parsed = await client.chatJson(message, { maxTokens: 800 });

    expect(parsed).toEqual({ items: [{ predicate: 'identity.name' }] });
    expect(calls[0]?.url).toBe('https://example.invalid/api/paas/v4/chat/completions');
    expect(calls[0]?.body.thinking).toEqual({ type: 'disabled' });
    expect(calls[0]?.body.response_format).toEqual({ type: 'json_object' });
  });
});
