# Migration note: Phase 2 Temporal + Structured Resident

## Change

The current `riko_memory` storage-domain version is 5 with `compatibleVersions: [1, 2, 3, 4]`. Existing v1–v4 records remain readable; current writes use record schema version 5. Wiki pages accept additive `observedAt`, `recordedAt`, `validFrom`, `validTo`, and supersession lineage fields. Legacy `timestamp`/`validUntil` remain readable.

Temporal replacement is explicit through `MemoryProfileStore.updatePageTemporal()` and `POST /memory/v1/wiki/pages/:id/temporal`. The old page is retained as `superseded` with a closed validity interval; the new page receives a new identity and points back through `supersedes`. A correction continues to use `editPage()` and keeps one page identity with a `page-corrected` audit.

## Resident compiler

Resident is compiled from current confirmed, consented pages into deterministic blocks:

`identity`, `preferences`, `relationships`, `currentState`, `communicationStyle`, `activePeople`, `openThreads`.

Every block is first guaranteed an equal minimum share of the resident body; the pool that empty or small blocks leave unused is then handed to blocks that still have entries, in block order, so one heavy category no longer strands the budget. `ResidentBlock.charBudget` reports that guaranteed minimum share. The public `resident` string and `ResidentSnapshot.content` remain compatible, while `ResidentSnapshot.blocks` exposes the derived internal structure. The last-valid resident remains in memory until the durable profile write succeeds.

## Compatibility and rollback

- Old profiles with only a legacy `resident` string continue serving that exact string until the next successful write.
- Missing `validFrom` stays unknown; migration does not infer dates from model text.
- To roll back Phase 2 behavior, disable temporal-update callers and continue using `editPage()`; v1–v4 records remain readable by this build and no raw evidence is deleted.

## Validation

- Shanghai → Hangzhou current versus historical selection;
- Linda → Lisa correction without temporal lineage;
- bounded deterministic Resident blocks and legacy snapshot reading;
- temporal Markdown round-trip, package typecheck, package tests and host build gate.
