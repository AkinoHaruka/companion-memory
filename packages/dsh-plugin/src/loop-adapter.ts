/**
 * Adapters between the agent loop's payloads and the memory handlers.
 *
 * `createPreStep` takes the current turn's text and an instant. The loop's
 * `agent/pre-step` payload carries an array of admitted messages, a turn number
 * and an abort signal. This module is the translation, and it exists separately
 * because the translation is where a mistake is silent: a handler given the
 * wrong message simply recalls against the wrong turn, and the memory that comes
 * back looks like memory that happens to be less relevant.
 *
 * The functions here take plain arrays rather than an imported payload type, so
 * the plugin does not depend on the loop package. The shapes they accept are
 * structural, which also means a test can hand them exactly what the loop would.
 */

import type { UserMessage } from '@deepseek-ai/dsh-llm';

/** A message as the loop presents it: role plus model-facing content blocks. */
export interface LoopMessage {
  /** Provider-neutral role. */
  readonly role: string;
  /** Exact model-facing blocks. */
  readonly content: readonly { readonly type: string; readonly text?: string }[];
}

/**
 * The text of the most recent user message, or an empty string.
 *
 * The last user message, not the last message: the loop admits a batch, and the
 * message immediately before this step may be the model's own. Recalling against
 * the companion's previous reply would surface memories about what the companion
 * said rather than about what the user just asked.
 *
 * Only `text` blocks contribute. Reasoning, tool calls and images are not what
 * the user said, and folding their contents into the recall query would let a
 * tool result or the model's own reasoning drive which memories surface.
 */
export function latestUserText(messages: readonly LoopMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || message.role !== 'user') continue;
    return message.content
      .filter((block) => block.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text as string)
      .join('\n');
  }
  return '';
}

/**
 * Build the pre-step handler the loop registers.
 *
 * Returns a function taking the payload's messages and signal and performing the
 * recall. The returned handler never throws: the host's contract is that a hook
 * failure must not stop the turn, and a memory read that failed is a turn with
 * no memory rather than a turn that does not happen.
 *
 * @param recall - the mount's `createPreStep` handler, taking text and an instant.
 * @param now - supplies the current instant, injectable so a test is reproducible.
 * @returns a handler accepting the loop's admitted messages.
 */
export function loopPreStep(
  recall: (currentMessage: string, now: string) => Promise<void>,
  now: () => string = () => new Date().toISOString(),
): (messages: readonly LoopMessage[]) => Promise<void> {
  return async (messages) => {
    const text = latestUserText(messages);
    try {
      await recall(text, now());
    } catch {
      // Swallowed deliberately, and named: a memory read that failed must not
      // stop the turn. The next step retries, and a turn without memory is the
      // documented degradation rather than an error the user sees.
    }
  };
}

/**
 * The text of the messages the observer records.
 *
 * Unlike recall, this keeps both sides of the conversation: what the user said
 * and what the companion said are both evidence, and the kernel decides what may
 * be concluded from each. Dropping the assistant side here would hide the
 * distinction from the layer that exists to police it.
 */
export function observedMessages(
  messages: readonly LoopMessage[],
): { role: 'user' | 'assistant'; text: string; id: string }[] {
  return messages.flatMap((message, index) => {
    if (message.role !== 'user' && message.role !== 'assistant') return [];
    const text = message.content
      .filter((block) => block.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text as string)
      .join('\n');
    if (!text.trim()) return [];
    return [
      {
        role: message.role,
        text,
        // Positional rather than content-derived: the loop owns message
        // identity, and inventing one from the text would make two identical
        // messages collapse into one piece of evidence.
        id: `${message.role}-${index}`,
      },
    ];
  });
}

/** A user message from the loop, for callers that import the type directly. */
export type { UserMessage };
