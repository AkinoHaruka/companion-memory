/**
 * Companion memory kernel.
 *
 * Pure decision logic shared by every host adapter. No I/O, no LLM, no host
 * imports, and no ambient time — callers pass `now` in. See DESIGN.md §0.1 and
 * §8 for why this boundary is load-bearing.
 */
export * from "./domain/index.js";
