# Riko Memory architecture baseline

This baseline describes the canonical implementation at `packages/bundle/riko-memory` in the DeepSeek Harness worktree. The root-level `dsh-riko-memory` checkout is not a runtime target for this work.

## Runtime map

```text
Session event
  -> RikoMemoryService.observeSessionEvent()
  -> MemoryProfileStore.appendSessionEvent()
  -> storageDomain:riko_memory.sessions (L0 evidence)

Session turn/end or scheduled recovery
  -> RikoMemoryService.dreamEvidence()
  -> Dream provider FILE parser
  -> MemoryProfileStore.ingestPages()
  -> candidates (pending authority gate)

Explicit remember / candidate confirm / Wiki write
  -> MemoryProfileStore.commitPage()
  -> storageDomain:riko_memory.pages (L2 canonical Wiki)
  -> compileResidentBlocks()
  -> atomic Resident string + structured blocks
  -> profiles.resident (L3 derived projection)
  -> agent-scoped systemPrompt context

Correction / supersede / forget
  -> scoped MemoryProfileStore mutation
  -> durable page/candidate/source sync + audit
  -> Resident rebuild

Current user message with recallEnabled
  -> agent/pre-step
  -> RecallPlan
  -> canonical lexical + raw L0 lexical + optional vector-index, observation and graph channels
  -> RRF + authoritative reserve + raw-evidence cap + bounded policy
  -> durable user/message form=recall
  -> model request
```

`RikoMemoryService` constructs the configured provider through `createEmbeddingProvider` and passes it to the Agent pre-step and HTTP recall route; deterministic or OpenAI-compatible vectors use the scope-local persisted vector index, while `off` and provider failures fall back to lexical/RRF. Recall reserves seats for non-evidence authoritative candidates before considering capped raw evidence, and renders selected canonical and supporting evidence with distinct authority labels. `MemoryReranker` has no live configuration seam and remains helper-only. Dream calls `reflectObservations()` when `reflectionEnabled` is true, producing anchored observation candidates; the Agent pre-step does not create observations. The store loads, rebuilds and persists `SafeUsageProjection` and `ConflictOverlay` records, marks ambiguous reads as `contested` without changing canonical truth, and includes those derived records in purge impact and verification. Suppression policy evidence is retained in the suppression audit, excluded from ordinary raw recall and removed by restore or purge. When `purgeEnabled` is true, `POST /purge` performs a journaled transaction with dry-run, exact confirmation and verified completion; ordinary forget remains derived-only and retains raw evidence.

## Authoritative modules

| Responsibility | Current implementation |
| --- | --- |
| Public configuration, lifecycle, tools, HTTP, Dream runner | `src/index.ts` |
| Versioned storage-domain schema and scoped keys | `src/memory-domain.ts` |
| Scoped state machine, persistence, Resident projection | `src/store.ts` |
| Wiki page model, parser, derived lexical/graph view | `src/wiki.ts` |
| Evidence/Candidate/Wiki scope contracts | `src/contracts.ts` |
| Dream provider protocol and FILE parser | `src/dream-protocol.ts` and `src/index.ts` |
| Query-time recall planner, fusion, budget and rendering | `src/recall.ts` |
| Management UI | `src/ui.ts` |

## Durable schema

The plugin owns one `storageDomain` named `riko_memory`, version 5 (compatible with versions 1, 2, 3 and 4), with per-record tables:

- `profiles`: scoped Dream settings, last-valid Resident metadata/content and optional structured Resident blocks;
- `pages`: canonical Wiki pages, including status, consent, sources and version;
- `candidates`: pending/rejected/accepted Dream proposals;
- `sources`: session/manual source metadata and ingest status;
- `sessions`: bounded serialized L0 event lines;
- `jobs`: Dream cursor/status records for restart recovery;
- `audits`: scope-local lifecycle records whose detail payloads may retain content;
- `observations`: inferred patterns with explicit evidence anchors, separate from canonical Wiki pages;
- `purges`: sanitized raw-session deletion journal for idempotent restart recovery.
- `suppressions` and `activation`: derived status records for suppression and observation activation;
- `aliases`: revocable entity edges with their source references and status;
- `index_meta` and `vectors`: persisted dense-index lifecycle metadata and vector records;
- `projections`: persisted `SafeUsageProjection` records;
- `conflicts`: persisted contested or resolved `ConflictOverlay` records.

Lexical and graph views are derived in process memory and rebuilt from durable records; dense vectors persist in the storage-domain `vectors` table with `index_meta` lifecycle metadata. No parallel SQLite, vector database or fixed file path is used.

## Authoritative invariants confirmed by the baseline

- Scope requires `ownerNamespace + stableAgentPresetId`; missing preset fails closed.
- Dream output is candidate state until original evidence or explicit management action authorizes canonical promotion.
- Resident is compiled only from confirmed, consented, non-superseded, non-expired pages.
- Recall is read-side only; it cannot confirm, edit or delete canonical memory.
- Plugin-generated recall context is not retained as raw user evidence and is excluded from Dream transcript input.
- Dream/provider failure records a sanitized error and retains the last-valid Resident.
- Legacy pages without temporal fields remain readable; `validFrom` is never invented during migration.
- Temporal replacement creates a new canonical page, closes the prior interval and preserves `supersedes`/`supersededBy` audit lineage.
- Resident block compilation is deterministic, bounded per block and published only after the durable profile write succeeds; the legacy `resident` string remains available.
- Observation records require a raw/confirmed anchor and cannot self-reinforce from observations alone; invalidated/suppressed observations are excluded from normal recall.
- Raw purge is disabled by default and journaled. An enabled purge cascades in-scope durable jobs, audits and derived records, verifies that purge content is absent after the transaction and retries interrupted journals on reopen; ordinary derived-memory forget retains raw evidence.

## Baseline evidence

Historical evidence captured before the Recall v1 changes:

```text
pnpm exec tsc -p packages/bundle/riko-memory/tsconfig.json --noEmit  PASS
pnpm exec vitest run packages/bundle/riko-memory/tests                 6 files / 26 tests PASS
```

The current suite inventory is 7 test files / 41 tests and includes Recall v1 and Phase 2 temporal/Resident regression coverage. The phase ledger records current focused evidence and gates; this historical baseline block is not a current full-suite result.
