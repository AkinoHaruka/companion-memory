# Migration note: Phase 1 Recall v1

## Change

Added an opt-in query-time read path in `src/recall.ts`, `MemoryProfileStore.recall()` and the service `agent/pre-step` hook. The live path searches confirmed canonical Wiki documents and scope-local raw user evidence, fuses lexical channels with RRF, applies a character/candidate budget, emits a sanitized trace and injects escaped `form: "recall"` context. `src/index.ts` builds the configured embedding provider with `createEmbeddingProvider` and passes it to both the live Agent hook and the authenticated HTTP recall routes; dense recall uses the persisted vector index and degrades to lexical/RRF when unavailable. `MemoryReranker` still has no live configuration seam and remains a direct helper/store capability.

## Compatibility

- Phase 1 introduced no storage migration; the current Phase 2 reader upgrades the domain to version 2 with `compatibleVersions: [1]`.
- Existing records are read without backfill.
- Existing tools and HTTP routes keep their prior semantics.
- Recall defaults to disabled.
- Plugin-generated recall user messages are excluded from L0 Dream input.

## Validation

- Query analyzer, CJK/Latin lexical scoring, RRF, escaping and deterministic dense-provider helper tests.
- Long-tail canonical recall and L0 numeric-detail recall.
- Unrelated query suppression and profile isolation.
- Loader composition and authenticated HTTP recall route.
- Existing plugin tests, package typecheck and Harness host build gate are required before release.

## Rollback

Set `recallEnabled: false`. The code path is then unreachable from agent turns and the HTTP inspection endpoint is disabled; no persisted migration rollback is necessary.
