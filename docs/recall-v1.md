# Query-time Recall v1

Recall v1 is an additive, opt-in read path for memories that are not present in the bounded Resident Snapshot.

## Configuration

The feature is disabled by default:

```yaml
recallEnabled: false
recallVectorEnabled: false
recallRawEvidenceEnabled: true
recallObservationEnabled: false
recallGraphEnabled: false
purgeEnabled: false
recallMaxCandidates: 8
recallMaxContextChars: 3000
```

Set `recallEnabled: true` only after the deployment has accepted the regression matrix. `RikoMemoryService` constructs an embedding provider with `createEmbeddingProvider` from the configured `embeddingProvider` settings and passes it to both the live Agent pre-step and the authenticated HTTP recall routes. `off` or a provider failure degrades to lexical/RRF recall and records the degraded mode. The live Agent caller still supplies no `MemoryReranker`; reranking is helper-only and falls back to RRF order on failure when a direct caller uses it.

## Read path

1. `agent/pre-step` extracts only direct user messages from the claimed batch.
2. Rule-first analysis classifies explicit historical, profile, detail and unrelated queries.
3. Confirmed current Wiki pages are searched lexically. Query-time raw L0 search is a secondary channel for explicit/episodic/detail queries. An authenticated caller may provide `atTime` for an explicit historical cut-off or `history: true` for retained lineage.
4. Live Agent recall uses lexical/RRF channels. Optional dense results are fused with channel rank using Reciprocal Rank Fusion (`k=60` by default) only when a direct caller supplies an embedding provider.
5. Results are bounded by candidate count and context characters.
6. Recall is serialized as a durable `user/message` with `source.form = "recall"` and explicit memory-data delimiters. Stored text is escaped and cannot provide system authority.
7. Graph-expanded neighbors are an opt-in channel on the live Agent path. When `reflectionEnabled` is true, the Dream path calls `reflectObservations()` and can create anchored observation candidates; candidate creation or evidence updates may auto-activate a still-candidate observation only when normal sensitivity, no strong contradiction, and the configured evidence, distinct-session and confidence thresholds pass. The live Agent pre-step does not create observations. Authenticated management routes can explicitly activate an observation using the store's minimum-evidence check, invalidate it or suppress it. The deterministic Mention Gate applies the projection `disclosure` policy: `normal` may return raw text normally, `user_explicit_only` returns raw text and source references only for an explicit topic-matched request, and `never_explicit` remains silent even for a matching request.

The read path never writes candidates, pages, Resident content or authority metadata. Recall results carry source references such as `session:<id>/event:<seq>`.

## HTTP inspection

Authenticated management clients may call:

- `POST /memory/v1/recall` with `{ "query": "...", "atTime": "2025-06-01T00:00:00.000Z" }` for bounded results and rendered context;
- `POST /memory/v1/recall/debug` with the same body for plan, temporal mode, channel counts, fused count, gate counts and degraded modes.
- `GET /memory/v1/observations` and the authenticated observation management routes expose inferred state separately from Wiki facts. Dream reflection can produce anchored candidates when `reflectionEnabled` is true, and the store may auto-activate qualifying candidates; the management routes provide the separate explicit status changes. These routes remain admin/acceptance-only and the Agent pre-step is not an observation producer.

The response does not include provider credentials or the raw query in the trace. The route returns 404 while the feature flag is off.

## Rollback

Set `recallEnabled: false` and restart/reload the profile. No durable schema downgrade or data deletion is required. Existing L0, Candidate, Wiki, Resident and Dream behavior remains available. Derived recall indexes are process-local and are discarded on restart.

## Deliberate Phase 1 boundaries

The implementation includes the bounded Observation/Mention Gate and derived graph channels behind flags, Dream reflection with anchored candidates, and live embedding-provider wiring; reranking remains helper-only. Raw purge is an explicit, separately authorized transaction: it supports dry-run, exact confirmation and verified completion, cascades the in-scope derived records and retries interrupted journals. Ordinary forget remains derived-only and retains raw evidence. Recall still does not promote raw evidence or model output to canonical truth.
