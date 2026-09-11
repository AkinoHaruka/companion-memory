/**
 * Companion memory for DeepSeek Harness.
 *
 * Wires a memory implementation into the host's seams:
 *
 *   - `agent/pre-step` — asynchronous, where recall happens
 *   - `systemPrompt.section` — a stable block in the system prompt, which does
 *     not invalidate the request prefix between turns
 *   - `systemPrompt.context` — this turn's relevant records, materialised as a
 *     user-role snapshot so a per-turn change does not rewrite the prefix
 *   - `tools.register` — the model asking a direct question
 *
 * The first is separate from the other three because the host requires it to be:
 * prompt providers are evaluated synchronously during assembly and so cannot
 * perform I/O. `TurnCache` carries the result across that seam, and this module
 * only ever publishes after a read succeeded.
 *
 * Nothing here reaches into the kernel. The adapter talks to the `MemoryKernel`
 * interface, so where decisions are made — in-process, or over JSON-RPC to the
 * compiled Rust binary — is not this file's concern.
 *
 * @module @companion-memory/dsh-plugin
 */

import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';

// Imported for their declaration merging, not their values.
//
// Cordis composes its `Context` interface through module augmentation, so
// `ctx.systemPrompt` and `ctx.tools` exist on the type only once the package
// declaring them has been imported. Without these the plugin typechecks as if
// those services did not exist, which is how the mistake presents: a plugin that
// looks correct and cannot mount.
import type {} from '@deepseek-ai/dsh-system-prompt';
import type {} from '@deepseek-ai/dsh-tools';
import { defineTool } from '@deepseek-ai/dsh-tools';

import type { MemoryKernel, MemoryScope } from './memory.js';
import { renderOverlay, renderQueryResult, renderStable } from './render.js';
import { TurnCache, WarmCoalescer } from './turn-cache.js';

export const name = 'companion-memory';

/**
 * Services this plugin reads.
 *
 * Declared rather than reached for. The property proxy is topology-sensitive,
 * while `ctx.get` reads the global store, so an undeclared access can resolve to
 * nothing depending on where the plugin is mounted.
 */
export const inject = ['systemPrompt', 'tools'];

/** Deployment settings. */
export interface CompanionMemoryConfig {
  /** Tenant the memories belong to. */
  serviceId: string;
  /** The person being remembered. */
  ownerUserId: string;
  /** Which companion persona. */
  companionProfileId: string;
  /** Section order for the stable block in the system prompt. */
  stableOrder?: number;
  /** Context order for this turn's records. */
  overlayOrder?: number;
  /** Name the model calls to ask memory a direct question. */
  toolName?: string;
}

/**
 * Schema for the configuration.
 *
 * Validated at load so a missing tenant or owner fails immediately rather than
 * producing a plugin that silently remembers nothing.
 */
export const Config = z.object({
  serviceId: z.string().required(),
  ownerUserId: z.string().required(),
  companionProfileId: z.string().required(),
  stableOrder: z.natural().default(700),
  overlayOrder: z.natural().default(700),
  toolName: z.string().default('companion_memory'),
});

/** Section order: after the tool schemas, so memory reads as background. */
const DEFAULT_STABLE_ORDER = 700;
const DEFAULT_OVERLAY_ORDER = 700;
const DEFAULT_TOOL_NAME = 'companion_memory';

/**
 * The kernel this deployment uses.
 *
 * Set once before the plugin mounts, because the host constructs plugins from
 * configuration alone and the implementation is a composition-root decision.
 * Kept as module state rather than a hidden default so that "no kernel" is a
 * loud failure at mount time instead of a plugin that quietly does nothing.
 */
let configured: MemoryKernel | undefined;

/**
 * Choose the memory implementation.
 *
 * Call before mounting. The kernel owns the rules and the storage; this package
 * owns only the adapter, so it cannot pick one for you.
 */
export function configureMemory(kernel: MemoryKernel): void {
  configured = kernel;
}

/** The caches, owned per mount. */
export interface MemoryMount {
  /** The warm cache the prompt providers read. */
  readonly cache: TurnCache;
  /** The coalescer the pre-step hook uses. */
  readonly coalescer: WarmCoalescer;
  /** The scope this mount serves. */
  readonly scope: MemoryScope;
}

/** The mount from the most recent `apply`, for the pre-step hook to use. */
let mounted: MemoryMount | undefined;

/** The mount produced by the last `apply`, for tests and diagnostics. */
export function currentMount(): MemoryMount | undefined {
  return mounted;
}

/**
 * Mount the adapter.
 *
 * Registers the three synchronous-facing contributions. The pre-step hook is
 * registered separately by {@link preStep} because its payload type lives in the
 * agent package and this function is otherwise independent of the loop.
 */
export function apply(ctx: Context, config: CompanionMemoryConfig): void {
  const kernel = configured;
  if (!kernel) {
    throw new Error(
      'companion-memory: no kernel configured; call configureMemory() before mounting',
    );
  }

  const scope: MemoryScope = {
    serviceId: config.serviceId,
    ownerUserId: config.ownerUserId,
    companionProfileId: config.companionProfileId,
  };

  const cache = new TurnCache();
  const coalescer = new WarmCoalescer();
  mounted = { cache, coalescer, scope };

  // Every registration goes through ctx.effect so disposal removes it. The
  // registries return their own disposers; wrapping them here means fiber
  // teardown unregisters everything without this plugin tracking it separately.
  ctx.effect(() =>
    ctx.systemPrompt.section({
      name: 'companion-memory-stable',
      order: config.stableOrder ?? DEFAULT_STABLE_ORDER,
      // Synchronous by necessity: this runs while the request is assembled. A
      // profile that has not warmed renders nothing rather than a previous
      // turn's profile.
      text: () => {
        const warmed = cache.read(scope);
        return warmed ? renderStable(warmed) : '';
      },
    }),
  );

  ctx.effect(() =>
    ctx.systemPrompt.context({
      name: 'companion-memory-overlay',
      order: config.overlayOrder ?? DEFAULT_OVERLAY_ORDER,
      text: () => {
        const warmed = cache.read(scope);
        return warmed ? renderOverlay(warmed) : '';
      },
    }),
  );

  ctx.effect(() =>
    ctx.tools.register(
      defineTool({
        name: config.toolName ?? DEFAULT_TOOL_NAME,
        description:
          'Ask what the companion remembers about the user, or ask for something to be '
          + 'forgotten. Use `search` when the user refers to something you may have '
          + 'discussed before and you need the detail. Use `forget` when the user asks '
          + 'you not to bring something up again. Do not use this to recite memories at '
          + 'the user unprompted.',
        parameters: {
          query: {
            type: 'string',
            required: true,
            description: 'What to look up, or the text to forget.',
          },
          action: {
            type: 'string',
            // No `required: false`: the parameter schema treats `required: true`
            // as the only marker, and omission is what makes it optional.
            enum: ['search', 'forget'],
            description: 'Whether to search memory or request a deletion. Defaults to search.',
          },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              text: { type: 'string', required: true },
              recordIds: {
                type: 'array',
                required: true,
                items: { type: 'string' },
              },
            },
          },
          render: (_args, value) => [
            { type: 'text', text: renderQueryResult(value.text, value.recordIds) },
          ],
        },
        async execute(args) {
          // Narrowed rather than asserted: the inferred schema type keeps every
          // parameter optional at the type level even when the JSON Schema marks
          // it required, so a missing value has to be handled rather than cast.
          const query = typeof args.query === 'string' ? args.query : '';
          if (!query) return { text: 'No query was provided.', recordIds: [] };
          const action = args.action === 'forget' ? 'forget' : 'search';
          const result = await kernel.query(
            scope,
            action === 'forget'
              ? { kind: 'forget', target: query }
              : { kind: 'search', terms: query },
          );
          // The return value is the canonical output value declared above; the
          // registry renders it through `output.render` exactly once.
          return { text: result.text, recordIds: result.recordIds };
        },
      }),
    ),
  );
}

/**
 * Recall memory for a step about to be admitted.
 *
 * Separate from {@link apply} so the loop's payload type stays out of the
 * registration code, and so a test can drive it without constructing an agent.
 *
 * The result is published only on success. A failed read leaves the cache
 * untouched, which makes the turn render no memory rather than the previous
 * turn's — the failure mode that would otherwise be invisible, because stale
 * memory looks exactly like correct memory.
 */
export async function recallForStep(
  mount: MemoryMount,
  currentMessage: string,
  now: string,
): Promise<void> {
  const kernel = configured;
  if (!kernel) return;

  const warmed = await mount.coalescer.run(mount.scope, () =>
    kernel.warm(mount.scope, currentMessage, now),
  );
  mount.cache.publish(mount.scope, warmed);
}

/** Record a step's messages, if the mount exists. */
export async function observeStep(
  mount: MemoryMount,
  messages: readonly { role: 'user' | 'assistant'; text: string; id: string }[],
  now: string,
): Promise<void> {
  const kernel = configured;
  if (!kernel) return;
  await kernel.observe(mount.scope, messages, now);
}

export { InMemoryKernel, type MemoryRecord } from './in-memory-kernel.js';
export { TurnCache, WarmCoalescer, profileKey } from './turn-cache.js';
export * from './memory.js';
export {
  escapeText,
  renderOverlay,
  renderQueryResult,
  renderStable,
  renderedIds,
} from './render.js';
