/**
 * What the DeepSeek Harness adapter needs from a memory implementation.
 *
 * This is the seam that keeps the host adapter independent of where the
 * decisions are actually made. The Rust kernel implements these rules today; a
 * future in-process TypeScript kernel, or a JSON-RPC client over the compiled
 * Rust binary, would implement the same surface without the adapter changing.
 *
 * Deliberately narrow. Every method returns already-rendered text or an opaque
 * handle, so the adapter never learns the record model and the kernel never
 * learns about prompts, sessions or tools.
 *
 * The synchronous read methods are a hard constraint, not a style choice: the
 * host evaluates prompt providers synchronously while assembling a request, so
 * anything they call must be served from memory. `warm` is where the I/O
 * happens.
 */

/** The relationship a memory belongs to. */
export interface MemoryScope {
  /** Tenant or deployment. */
  serviceId: string;
  /** The person the companion is remembering. */
  ownerUserId: string;
  /** Which companion persona. */
  companionProfileId: string;
}

/** One candidate to place in this turn's context. */
export interface ContextCandidate {
  /** Stable record id, for diagnostics and cache metadata. */
  id: string;
  /** How the record must be handled if used. */
  mention: MentionLevel;
  /** The text to place in context, already escaped by the implementation. */
  text: string;
}

/**
 * How a record may be surfaced.
 *
 * Mirrors the kernel's `MentionMode`. `backgroundOnly` is the one that matters
 * in practice: the record may shape tone and word choice but must not be
 * recited, which is what keeps memory useful without producing the uncanny
 * "I remember you said" effect.
 */
export type MentionLevel =
  | 'never_surface'
  | 'background_only'
  | 'mention_if_user_cues'
  | 'freely_mentionable';

/** What one turn needs, prepared ahead of prompt assembly. */
export interface WarmResult {
  /**
   * The stable profile block: identity, boundaries, communication preferences.
   *
   * Changes rarely, so it is safe to place in the system prompt where it does
   * not invalidate the request prefix on every turn.
   */
  stable: string;
  /** Records to place in this turn's context, already filtered and ranked. */
  candidates: ContextCandidate[];
  /**
   * The conversation's present condition: affect, need, topic.
   *
   * Not memory. It has a lifetime measured in turns or hours and must not become
   * durable, which is why it travels separately from `candidates` — a caller
   * that treated these as records would promote today's mood into a fact about
   * the person.
   */
  now?: TurnState;
  /** The ledger revision these results were built from. */
  revision: number;
}

/**
 * The conversation's present condition.
 *
 * Mirrors the kernel's `RuntimeState`, narrowed to what changes a reply.
 */
export interface TurnState {
  /** Affect labels for the moment. */
  affect?: readonly string[];
  /** What the user appears to need right now. */
  apparentNeed?: ApparentNeed;
  /** What is being discussed. */
  topic?: string;
}

/**
 * What the user appears to need, as the kernel classifies it.
 *
 * A suggestion for the companion's stance rather than an instruction. The reply
 * states it as a possibility because a misread need, asserted confidently, is
 * worse than no reading at all.
 */
export type ApparentNeed =
  | 'listen'
  | 'validate'
  | 'clarify'
  | 'support'
  | 'problem_solve'
  | 'neutral';

/**
 * The memory operations the adapter performs.
 *
 * Every method takes the scope explicitly. There is no ambient "current user",
 * because a memory system that can guess whose memory it is reading is a memory
 * system that can guess wrong.
 */
export interface MemoryKernel {
  /**
   * Prepare everything this turn will need.
   *
   * Called from the asynchronous pre-step hook. All reading happens here so the
   * synchronous prompt providers can be served from memory.
   */
  warm(scope: MemoryScope, currentMessage: string, now: string): Promise<WarmResult>;

  /**
   * Record what the user said.
   *
   * Returns whether anything was committed. Extraction and confirmation are the
   * implementation's business; the adapter only reports that a turn happened.
   */
  observe(scope: MemoryScope, messages: readonly ObservedMessage[], now: string): Promise<ObservedOutcome>;

  /**
   * Record the conversation's present condition.
   *
   * Separate from `observe` because it is a different kind of statement: what
   * the user seems to be feeling now, rather than what is true about them.
   * Merging the two is how a transient mood becomes a durable fact.
   */
  setState(scope: MemoryScope, state: TurnState, now: string): Promise<void>;

  /**
   * Answer a direct question the model asked through a tool.
   *
   * Separate from `warm` because a tool call is a deliberate act by the model
   * rather than part of building the turn.
   */
  query(scope: MemoryScope, request: MemoryQuery): Promise<MemoryQueryResult>;
}

/** A message as the adapter saw it. */
export interface ObservedMessage {
  /** Who produced it. */
  role: 'user' | 'assistant';
  /** The text. */
  text: string;
  /** A stable id, for provenance. */
  id: string;
}

/** What observing a turn produced. */
export interface ObservedOutcome {
  /** Whether anything durable was written. */
  committed: boolean;
  /** How many candidates await a decision. */
  pending: number;
}

/** A question the model asked. */
export type MemoryQuery =
  | { kind: 'search'; terms: string; limit?: number }
  | { kind: 'forget'; target: string }
  | { kind: 'explain'; recordId: string };

/** What a query answered. */
export interface MemoryQueryResult {
  /** Text to hand back to the model. */
  text: string;
  /** Ids the answer refers to, for the transcript. */
  recordIds: string[];
}
