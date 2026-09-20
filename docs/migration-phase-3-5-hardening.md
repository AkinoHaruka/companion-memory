# Migration note: Phase 3–5 Observation, Graph and Purge Hardening

## Observation and Mention Gate

Inferred patterns use a separate `observations` storage-domain table and are stamped `epistemicStatus: inferred_observation`. Candidate creation requires at least one raw session or confirmed-page anchor; observation-only proofs are rejected. When `reflectionEnabled` is true, Dream calls `reflectObservations()` and can create anchored observation candidates, and candidate creation or evidence updates can auto-activate a normal, non-contradicted candidate once the configured evidence, distinct-session and confidence thresholds pass. Authenticated HTTP management routes create candidates or explicitly activate, invalidate and suppress observations; explicit activation uses the store's minimum-evidence check, and the live Agent path does not create or activate them. Either activation path keeps the record an observation and never promotes it to a canonical Wiki page or grants explicit mention permission. Invalidation and suppression remove it from normal recall.

The deterministic gate returns `explicit`, `silent_use` or `suppress`, records gate reason codes in the recall trace, and renders silent-use policy inside the bounded memory-data context. Observation recall is disabled by default with `recallObservationEnabled: false`.

## Derived graph recall

The existing Wiki wikilink graph is reused as a derived index. `recallGraphEnabled` is disabled by default. Multi-hop/detail queries may expand one or two hops from lexical roots; graph nodes never become a new source of truth and strict candidate/context budgets still apply.

## Purge

`purgeEnabled` is disabled by default. When explicitly enabled, `POST /memory/v1/purge` with a session ID supports dry-run, requires the exact confirmation from the plan for execution, writes a journal, removes raw session lines and reconciles page/candidate/source/observation state, cascades affected jobs, audits and derived indexes, rebuilds Resident, verifies completion and then marks the journal complete. Recovery retries started/failed journals on the next store open. Ordinary `forget` remains derived-only and continues to retain raw evidence.

## Rollback and validation

Disable `recallObservationEnabled`, `recallGraphEnabled` and `purgeEnabled` independently. The storage-domain reader remains compatible with v1 records, and vector, graph, alias, projection and conflict state is rebuilt from canonical tables. Validation covers observation anchoring/self-reinforcement rejection, gate decisions, graph multi-hop recall, vector degradation, projection/conflict persistence and the purge journal/recovery behavior; the Appendix F corpus runner, Appendix G aggregate metrics and load/chaos coverage remain unstarted release gates.
