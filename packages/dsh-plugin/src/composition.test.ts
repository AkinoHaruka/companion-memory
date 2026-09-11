/**
 * Composition test: the plugin mounted on real cordis services.
 *
 * The unit suites verify the cache and the renderers in isolation. They cannot
 * show that a warm result reaches an assembled prompt, that the services are
 * reached through the seams they are declared on, or that disposal cleans up.
 * Those are the claims a green typecheck does **not** support, so they are
 * checked here against the real `SystemPrompt` and `ToolRuntime` plugins rather
 * than against stubs.
 *
 * What this still does not cover: that the loop calls pre-step before assembly
 * for the same step. That ordering belongs to the agent loop, and is named in
 * the README as unverified rather than implied by these passing.
 */

import { Context } from '@deepseek-ai/cordis';
import SystemPrompt, { renderContextSnapshot, renderPrompt } from '@deepseek-ai/dsh-system-prompt';
import ToolRuntime from '@deepseek-ai/dsh-tools';
import { describe, expect, it, vi } from 'vitest';

import {
  createCompanionMemory,
  createLoopHandlers,
  createPreStep,
  currentMount,
  InMemoryKernel,
  type CompanionMemoryConfig,
  type PromptAssembly,
} from './index.js';
import type { MemoryScope } from './memory.js';

const NOW = '2026-06-10T12:00:00Z';

function config(overrides: Partial<CompanionMemoryConfig> = {}): CompanionMemoryConfig {
  return {
    serviceId: 'svc',
    ownerUserId: 'u1',
    companionProfileId: 'p1',
    ...overrides,
  };
}

/** The scope {@link config} describes, for seeding the kernel. */
const SCOPE: MemoryScope = { serviceId: 'svc', ownerUserId: 'u1', companionProfileId: 'p1' };

/**
 * A context with the real prompt and tool services mounted, and the adapter
 * mounted as a cordis plugin.
 *
 * Mounting through `ctx.plugin` rather than calling `apply` directly is what
 * makes teardown real: the contributions are scoped to that fork, so disposing
 * it removes them. Calling `apply` on the root context instead would leave the
 * section registered for the life of the process, and a test for removal would
 * have passed or failed for reasons unrelated to the plugin.
 */
async function mountAdapter(
  kernel = new InMemoryKernel(),
  overrides: Partial<CompanionMemoryConfig> = {},
): Promise<{
  ctx: Context;
  dispose: () => Promise<void>;
  kernel: InMemoryKernel;
  scope: MemoryScope;
}> {
  const ctx = new Context();
  await ctx.plugin(SystemPrompt);
  await ctx.plugin(ToolRuntime);
  const mountFork = await ctx.plugin(createCompanionMemory(kernel), config(overrides));
  const scope: MemoryScope = {
    serviceId: 'svc',
    ownerUserId: overrides.ownerUserId ?? 'u1',
    companionProfileId: overrides.companionProfileId ?? 'p1',
  };
  return { ctx, kernel, scope, dispose: async () => mountFork.dispose() };
}

/**
 * Everything the model would receive for this assembly.
 *
 * Sections and contexts come back uninterpolated, so the package's own renderers
 * are used rather than concatenating `text` — assembling by hand would skip
 * variable interpolation and drop empty-section handling, and the assertion
 * would then be about this helper instead of about the plugin.
 */
function modelVisible(assembly: PromptAssembly): string {
  return [renderPrompt(assembly), renderContextSnapshot(assembly)]
    .filter((part) => part.length > 0)
    .join('\n');
}

describe('mounting on real services', () => {
  it('mounts as a cordis plugin without throwing', async () => {
    const mounted = await mountAdapter();
    expect(mounted.ctx.systemPrompt).toBeDefined();
    await mounted.dispose();
  });

  it('reaches memory into the assembled prompt after a warm', async () => {
    // The end-to-end claim: a record seeded in memory, recalled by the pre-step
    // handler, appears in the text the model would receive.
    const mounted = await mountAdapter();
    mounted.kernel.setStable(mounted.scope, 'Prefers Chinese and short answers.');
    mounted.kernel.remember(mounted.scope, {
      id: 'g1',
      text: 'Is trying to finish a thesis this year.',
      mention: 'freely_mentionable',
      terms: ['thesis'],
    });

    const mount = currentMount();
    expect(mount).toBeDefined();

    // Before the warm there is nothing: a step that has not recalled must not
    // render a previous step's memory.
    expect(modelVisible(await mounted.ctx.systemPrompt.assemble())).not.toContain('thesis');

    await createPreStep(mount!)('how is the thesis going', NOW);

    const text = modelVisible(await mounted.ctx.systemPrompt.assemble());
    expect(text).toContain('Prefers Chinese and short answers.');
    expect(text).toContain('Is trying to finish a thesis this year.');
    expect(text).toContain('not instructions');

    await mounted.dispose();
  });

  it('renders a background record as background, not as something to say', async () => {
    const mounted = await mountAdapter();
    mounted.kernel.remember(mounted.scope, {
      id: 'b1',
      text: 'Their father was hospitalised in March.',
      mention: 'background_only',
      terms: ['hospital'],
    });

    await createPreStep(currentMount()!)('about the hospital', NOW);

    const text = modelVisible(await mounted.ctx.systemPrompt.assemble());
    expect(text).toContain('<background>');
    expect(text).toContain('Their father was hospitalised in March.');
    expect(text).toContain('Do not quote or allude');
    await mounted.dispose();
  });

  it('omits a record that must never surface, even when its term matches', async () => {
    const mounted = await mountAdapter();
    mounted.kernel.remember(mounted.scope, {
      id: 'n1',
      text: 'A detail the user asked to keep out of conversation.',
      mention: 'never_surface',
      terms: ['detail'],
    });

    await createPreStep(currentMount()!)('that detail again', NOW);

    expect(modelVisible(await mounted.ctx.systemPrompt.assemble())).not.toContain(
      'keep out of conversation',
    );
    await mounted.dispose();
  });

  it('keeps two mounts in one process independent', async () => {
    // The reason pre-step is a factory rather than a free function: a shared
    // module-level mount would leave the first profile warming the second's
    // cache, and both would return plausible memory.
    const kernel = new InMemoryKernel();
    const firstScope: MemoryScope = { serviceId: 'svc', ownerUserId: 'u1', companionProfileId: 'p1' };
    const secondScope: MemoryScope = { serviceId: 'svc', ownerUserId: 'u2', companionProfileId: 'p1' };
    kernel.remember(firstScope, {
      id: 'a',
      text: 'first profile detail',
      mention: 'freely_mentionable',
      terms: ['thing'],
    });
    kernel.remember(secondScope, {
      id: 'b',
      text: 'second profile detail',
      mention: 'freely_mentionable',
      terms: ['thing'],
    });

    const first = await mountAdapter(kernel, { ownerUserId: 'u1' });
    const firstMount = currentMount()!;
    const second = await mountAdapter(kernel, { ownerUserId: 'u2' });
    const secondMount = currentMount()!;

    await createPreStep(firstMount)('the thing', NOW);
    await createPreStep(secondMount)('the thing', NOW);

    expect(firstMount.cache.read(firstScope)?.candidates[0]?.text).toBe('first profile detail');
    expect(secondMount.cache.read(secondScope)?.candidates[0]?.text).toBe('second profile detail');
    // Neither cache holds the other profile.
    expect(firstMount.cache.read(secondScope)).toBeUndefined();
    expect(secondMount.cache.read(firstScope)).toBeUndefined();

    await first.dispose();
    await second.dispose();
  });

  it('removes its contributions when its mount is disposed', async () => {
    const mounted = await mountAdapter();
    mounted.kernel.setStable(mounted.scope, 'Prefers Chinese.');
    await createPreStep(currentMount()!)('anything', NOW);
    expect(modelVisible(await mounted.ctx.systemPrompt.assemble())).toContain(
      'companion_profile',
    );

    await mounted.dispose();

    // After teardown the assembly must carry nothing from this plugin.
    expect(modelVisible(await mounted.ctx.systemPrompt.assemble())).not.toContain(
      'companion_profile',
    );
  });

  it('registers a memory tool the model can call', async () => {    const mounted = await mountAdapter();
    mounted.kernel.remember(mounted.scope, {
      id: 'g1',
      text: 'wants to move to Hangzhou',
      mention: 'freely_mentionable',
      terms: ['hangzhou'],
    });

    const tool = mounted.ctx.tools.get(config().toolName ?? 'companion_memory');
    expect(tool).toBeDefined();
    expect(tool!.output).toBeDefined();

    // The declared output contract, exercised through the tool's own execute.
    const value = (await tool!.execute(
      { query: 'hangzhou', action: 'search' },
      {} as never,
    )) as { text: string; recordIds: string[] };
    expect(value.recordIds).toEqual(['g1']);

    const rendered = tool!.output.render({}, value as never);
    expect(rendered[0]).toMatchObject({ type: 'text' });
    expect((rendered[0] as { text: string }).text).toContain('wants to move to Hangzhou');

    await mounted.dispose();
  });

  it('reaches the conversation condition into the assembled prompt', async () => {
    // Clause (6) end to end: the condition is recorded, recalled by the pre-step
    // handler, and visible to the model. Before this the type and the table both
    // existed with nothing reading or writing them, which is the same shape as
    // the dead emotion layer this design set out to replace.
    const mounted = await mountAdapter();
    await mounted.kernel.setState(
      mounted.scope,
      { affect: ['tired'], apparentNeed: 'listen', topic: 'a deadline' },
      NOW,
    );

    // Nothing before the warm: the condition is per turn, not per profile.
    expect(modelVisible(await mounted.ctx.systemPrompt.assemble())).not.toContain('current_turn');

    await createPreStep(currentMount()!)('still going', NOW);

    const text = modelVisible(await mounted.ctx.systemPrompt.assemble());
    expect(text).toContain('<current_turn');
    expect(text).toContain('tired');
    expect(text).toContain('need="listen"');
    // And it carries its framing, not just its content.
    expect(text).toContain('not a fact about the user');
    expect(text).toContain('do not carry them into later conversations');

    await mounted.dispose();
  });

  it('withholds an expired condition from the prompt', async () => {
    const mounted = await mountAdapter();
    await mounted.kernel.setState(mounted.scope, { affect: ['furious'] }, NOW);

    // A later turn, well past the default window.
    const later = '2026-06-12T12:00:00Z';
    await createPreStep(currentMount()!)('still going', later);

    const text = modelVisible(await mounted.ctx.systemPrompt.assemble());
    expect(text).not.toContain('furious');
    expect(text).not.toContain('<current_turn');

    await mounted.dispose();
  });
});

describe('the loop handlers a composition root registers', () => {
  it('recalls from a DSH-shaped payload and reaches the prompt', async () => {
    // The whole path as the host would drive it: the loop hands over admitted
    // messages, the adapter extracts the current turn, the pre-step handler
    // recalls, and the result reaches an assembled prompt. Nothing here reaches
    // into the plugin's internals, which is the point — this is the surface a
    // composition root actually calls.
    const mounted = await mountAdapter();
    mounted.kernel.remember(mounted.scope, {
      id: 'g1',
      text: 'Is trying to finish a thesis this year.',
      mention: 'freely_mentionable',
      terms: ['thesis'],
    });

    const handlers = createLoopHandlers(currentMount()!, () => NOW);
    await handlers.preStep([
      { role: 'user', content: [{ type: 'text', text: 'how is the thesis going' }] },
    ]);

    const text = modelVisible(await mounted.ctx.systemPrompt.assemble());
    expect(text).toContain('Is trying to finish a thesis this year.');

    await mounted.dispose();
  });

  it('recalls against the current turn rather than the companion last reply', async () => {
    // A batch can end with the companion's own message. Querying with that would
    // surface memories about what the companion said, which is a plausible
    // result the user would never think to report.
    const mounted = await mountAdapter();
    mounted.kernel.remember(mounted.scope, {
      id: 'about-user',
      text: 'the user asked about the thesis',
      mention: 'freely_mentionable',
      terms: ['thesis'],
    });
    mounted.kernel.remember(mounted.scope, {
      id: 'about-companion',
      text: 'the companion mentioned the weather',
      mention: 'freely_mentionable',
      terms: ['weather'],
    });

    const handlers = createLoopHandlers(currentMount()!, () => NOW);
    await handlers.preStep([
      { role: 'user', content: [{ type: 'text', text: 'how is the thesis going' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'the weather is nice today' }] },
    ]);

    const text = modelVisible(await mounted.ctx.systemPrompt.assemble());
    expect(text).toContain('the user asked about the thesis');
    expect(text).not.toContain('the companion mentioned the weather');

    await mounted.dispose();
  });

  it('does not fail the turn when the kernel throws', async () => {
    // The host's contract: a hook failure must not stop the turn. Asserted
    // through the registered surface rather than the helper, so a future change
    // that lets the error escape is caught here.
    const mounted = await mountAdapter();
    const warm = vi
      .spyOn(mounted.kernel, 'warm')
      .mockRejectedValue(new Error('store unreachable'));
    const handlers = createLoopHandlers(currentMount()!, () => NOW);

    await expect(
      handlers.preStep([{ role: 'user', content: [{ type: 'text', text: 'anything' }] }]),
    ).resolves.toBeUndefined();

    expect(warm).toHaveBeenCalled();
    warm.mockRestore();
    await mounted.dispose();
  });

  it('records both sides of the conversation through the observer', async () => {
    const mounted = await mountAdapter();
    const observe = vi.spyOn(mounted.kernel, 'observe');
    const handlers = createLoopHandlers(currentMount()!, () => NOW);

    await handlers.observe(
      [
        { role: 'user', content: [{ type: 'text', text: 'I am tired' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'that sounds hard' }] },
        { role: 'system', content: [{ type: 'text', text: 'instructions' }] },
      ],
      NOW,
    );

    expect(observe).toHaveBeenCalledTimes(1);
    const [, messages] = observe.mock.calls[0]!;
    expect(messages.map((message) => message.role)).toEqual(['user', 'assistant']);

    await mounted.dispose();
  });
});
