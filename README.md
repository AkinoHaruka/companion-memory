---
description: "Native scoped memory plugin for DeepSeek Harness."
kind: "package-bundle"
---

# @deepseek-ai/dsh-riko-memory

English | [中文](README.zh.md)

## Summary

Native DSH memory with stable-preset scope isolation, durable storage-domain records, explicit confirmation, canonical Wiki pages, bounded Resident Snapshots and a recoverable Dream pipeline. Secrets stay in credentials or process environment; the UI, control API and acceptance-only paths are explicitly scoped.

## Table of Contents

- [What this package is](#what-this-package-is)
- [Architecture at a glance](#architecture-at-a-glance)
- [Installation and configuration](#installation-and-configuration)
- [Acceptance and verification](#acceptance-and-verification)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

<a id="what-this-package-is"></a>
## What this package is

`@deepseek-ai/dsh-riko-memory` is the native DeepSeek Harness implementation of Riko-style scoped long-term memory. It connects directly to DSH lifecycle and storage seams: Cordis plugin loading, session events, stable Agent presets, `storageDomain`, system-prompt injection, explicit tools, credentials and background jobs. It is not an MCP memory server, not a second SQLite service and not a generic file-store adapter.

The governing promise is simple: a memory may influence a later reply only after it has a traceable source, passed the scope boundary, reached the canonical Wiki state machine and been selected for the bounded Resident Snapshot. Model output alone never becomes authority.

The canonical source is `packages/bundle/riko-memory` in the DSH Harness worktree. The GitHub repository [AkinoHaruka/companion-memory](https://github.com/AkinoHaruka/companion-memory) is the user-facing source mirror of this bundle. Older standalone implementations and historical root-level copies are migration references, not parallel runtimes.

The normative V3.1 decision addendum is [docs/v3.1-decision-semantics.md](docs/v3.1-decision-semantics.md); its implementation status is tracked in [docs/memory-v3-progress.md](docs/memory-v3-progress.md).

<a id="architecture-at-a-glance"></a>
## Architecture at a glance

```text
User conversation
  -> DSH session/event listener
  -> L0 evidence: sessionId + event sequence + source span
  -> explicit tool or background Dream
   -> L1 Candidate: proposal with source record and consent state
  -> original user evidence or explicit management action
  -> L2 canonical Wiki page: durable, versioned authority
  -> Resident compiler
  -> L3 Resident Snapshot: bounded prompt projection
  -> next request for the same stable Agent preset
```

| Layer | Name | Purpose | Direct prompt input |
|---|---|---|---|
| L0 | Session evidence | What was actually said, with event source record | No |
| L1 | Candidate | What the extractor proposed, awaiting review | No |
| L2 | Wiki | Canonical pages, versions, links, sources, expiry and audit lineage | Indirectly |
| L3 | Resident Snapshot | Rebuildable bounded projection for the next request | Yes |

The layers answer different questions: L0 is “what happened”, L1 is “what was proposed”, L2 is “what was accepted as durable memory”, and L3 is “what is safe and useful to inject now”. The Resident is derived and replaceable; the Wiki is the long-term authority.

## Goals and non-goals

### Goals

- Share durable memory across sessions belonging to one stable Agent preset.
- Isolate owners and presets in both runtime tools and the HTTP control plane.
- Preserve session, event and source records so a page can be audited.
- Require explicit evidence or explicit management action before Dream output becomes canonical.
- Keep the chat hot path bounded: reading Resident does not call Dream, scan the full Wiki or wait for a background lock.
- Make provider, parser, storage, Resident compilation and host restart failures recoverable.
- Keep credentials outside source files, settings JSON and ordinary management payloads.
- Expose Wiki, candidate, source and graph information for human review.

### Deliberate v1 non-goals

- Production-scale background vector-index compaction and multi-node index ownership beyond the optional bounded dense-recall provider and index seams.
- Multi-node coordination, public multi-tenant hosting or distributed job ownership.
- Complete cryptographic erasure of every evidence, audit and external backup copy.
- Treating every conversational sentence as a memory.
- Letting a model-generated “please remember this” sentence authorize itself.
- Replacing DSH storage/lifecycle with Fastify, a fixed filesystem path, `node:sqlite`, MCP or a Rust sidecar.

## Scope and isolation

Long-lived memory is keyed by:

```text
MemoryScope = ownerNamespace + stableAgentPresetId
```

`ownerNamespace` identifies the owning installation or tenant boundary. `stableAgentPresetId` identifies the DSH Agent preset whose behavior and memory are meant to be shared. Session ID is an evidence record, not the long-term sharing key.

The rules are:

1. Sessions under the same owner and stable preset share the same Wiki and Resident.
2. Different stable presets remain isolated even when the owner is the same.
3. Missing or unstable preset identity fails closed; there is no default global fallback.
4. Session, bearer token, HTTP profile and storage record must resolve to the same scope.
5. A model cannot enlarge scope by inventing a session ID, profile name or source reference.

“Global memory” therefore means global across sessions and projects within one stable Agent preset, not global across all Agents.

## Versioned contracts

The core contracts are versioned and scope-aware:

- `MemoryScope`: `schemaVersion`, owner namespace, stable preset and deterministic scope key.
- `storageDomain`: `riko_memory`, per-record version `5`, compatible with versions `[1, 2, 3, 4]`.
- `EvidenceRef`: `schemaVersion`, session ID, event sequence and optional source span.
- `MemoryCandidate`: scope, content, status, consent, evidence, source (`dream` or `manual`), timestamps, expiry and supersession data.
- `WikiPage`: versioned canonical body, status, consent, evidence, source candidates, update time and optional expiry.
- `ResidentSnapshot`: bounded content, version, generated time, scope and source page IDs.
- `DreamJob`: scope, session, event cursor, status, attempts, timestamps and sanitized last error.

Provider output cannot manufacture an authoritative `EvidenceRef`. The current DSH event stream remains the source of truth.

## End-to-end lifecycle

### 1. Capture L0 evidence

The plugin observes DSH session events and writes bounded serialized evidence into the configured `storageDomain`. Session identity, event sequence and source information are retained. Scope is decided at capture time and is never reassigned from model text.

### 2. Choose an ingestion path

There are two paths:

- Explicit path: the user directly asks the Agent to remember, correct or forget something. The tool validates the latest raw user message and applies the requested state transition immediately.
- Dream path: after session activity, a debounced background job consumes the session cursor and asks the configured provider for structured Wiki files. Dream is asynchronous and does not block the normal reply path.

### 3. Produce a Candidate

Dream uses a controlled FILE protocol. Only approved `wiki/` folders are accepted. The parser rejects malformed or empty blocks, ignores model-authored source authority, normalizes titles and wikilinks, bounds descriptions and bodies, and forces every extracted page to `candidate` with pending consent.

Repeated proposals are fingerprinted and merged. Matching candidates preserve the union of source conversations and the strongest available confidence instead of creating unbounded duplicates.

### 4. Confirm or reject

Confirmation has exactly two valid authorities:

- Original user evidence: explicit tools require the claim or replacement text to appear in the latest raw user message.
- Explicit management action: an operator can confirm, reject, edit or create a canonical page through the control API.

The Dream model's own `status: confirmed`, `consent: true`, `locked: true`, or a sentence saying “the user asked me to remember this” has no authority.

The `candidateAutoConfirm` policy can admit an extracted page without a manual confirmation step, and it is `off` by default. `user_grounded` admits a candidate only when its description appears verbatim in a user-authored L0 event of the same scope, so the admitting authority stays the user's own statement and never model output; `all` admits every non-sensitive, non-conflicting candidate regardless of grounding, which is a deliberate deviation from the no-auto-promotion invariant and is intended only for controlled dogfooding. Every automatic admission is audited as `candidate-auto-confirmed` with its mode and grounding reference.

### 5. Commit to the canonical Wiki

Confirmation creates or updates a versioned Wiki page, records source lineage and removes its pending Candidate. Corrections retain prior version information in the audit lineage. Superseding a page removes it from future Residents while retaining the page and evidence trail for review.

### 6. Compile and inject Resident

Only confirmed, consented, non-superseded, non-expired and Resident-eligible pages are compiled. The current runtime excludes `sensitive` pages by default; V3.1 additionally requires `provisional_sensitive` to be denied Resident use until an explicit policy permits it. Sensitive canonical pages remain auditable and available to explicitly gated recall, but do not enter ordinary Resident injection. Source pages, pending candidates and raw transcripts stay outside the hot prompt. The result is ordered, bounded by `maxResidentChars`, assigned a content-derived version and persisted with exactly the source page IDs represented by the selected blocks. DSH injects only the current stable preset's Resident as labeled memory data, not as instructions.

## Explicit tools

### `memory_get_resident`

Reads the current stable preset's Resident and version. Missing preset identity fails closed. This is a read-only hot-path operation and does not invoke Dream.

### `memory_remember`

Stores one explicit preference or fact as managed, confirmed memory. The content must be non-empty and appear in the latest raw user message of the current session. It cannot save a model inference or a claim copied from another session.

### `memory_correct`

Replaces the selected Wiki page's user-visible content after checking that the replacement occurs in the latest raw user message. The page remains confirmed, its lineage is retained and Resident is rebuilt immediately.

### `memory_forget`

Requires an explicit deletion cue such as “forget”, “remove” or `忘记`, plus the exact memory ID in the latest user message. It removes derived memory from future Residents and records the operation. v1 does not purge the original raw Session evidence.

## Query-time Recall v1

The optional `recallEnabled` flag retrieves long-tail details that do not fit in Resident. Lexical ranking uses BM25 with IDF derived from the candidate corpus, so ubiquitous tokens such as a fixed adapter prefix or generic chatter cannot outrank rare discriminative terms. The budget first reserves up to `min(recallMaxCandidates, recallAuthoritativeReserve)` seats for non-evidence authoritative results, then considers the fused remainder with raw evidence capped by `recallRawEvidenceMaxCandidates`; canonical text is rendered as `[authoritative]` and selected supporting evidence as `[supplement]`, while raw detail that repeats all selected non-evidence terms is suppressed. The rendered context remains bounded by `recallMaxContextChars`. `embeddingProvider` can add deterministic-local or OpenAI-compatible dense recall; provider failures degrade to lexical/RRF and never block chat. The keyless deterministic ablation measured 0/16 unique recall gain, 2/9 dense noise and 0/9 gate rejection in its companion comparison; the larger 12-scenario, 20-pages-per-scenario keyless chaos probe printed 0/12 unique gain, 60/60 noise and 36/96 gate rejection in this run. These are keyless routing and selection measurements, not BGE quality results. The BGE-gated semantic corpus (`tests/dense-semantic-gain.spec.ts`) measures paraphrase recall that lexical ranking structurally cannot reach: recorded against a local BGE-small-zh-v1.5 server, lexical-only reaches 0/5 targets, the deterministic hash provider 2/5, and BGE vectors 5/5. That run requires `DSH_MEMORY_BGE_ENDPOINT`, so a default package run reports no BGE quality measurement. The live hook also never supplies a `MemoryReranker`; reranking is reachable only through direct helper/store callers and tests. Recall accepts an explicit `atTime` or `history` mode for retained temporal lineage. A suppression cue is retained as policy evidence, drives suppression, and is excluded from ordinary raw recall while that suppression is active. See [docs/recall-v1.md](docs/recall-v1.md) and [docs/migration-phase-2-temporal-resident.md](docs/migration-phase-2-temporal-resident.md).

Observation management, graph expansion and raw-session purge are separately flagged with `recallObservationEnabled`, `recallGraphEnabled` and `purgeEnabled`, all defaulting to `false`. Opt-in Dream reflection can create anchored observation candidates, and candidate creation or evidence updates can auto-activate a still-candidate observation when it has normal sensitivity, no strong contradiction, at least the configured evidence and distinct-session minimums, and the configured confidence minimum. Separately, `POST /memory/v1/observations/:id/activate` is an authenticated management operation; it can explicitly activate a record after the store's minimum-evidence check, while the matching routes invalidate or suppress it. Neither activation path confirms a fact or grants explicit mention permission. Observation records require raw/confirmed anchors and remain epistemically distinct from Wiki facts. Ordinary `memory_forget` retains raw Session evidence.

Safe-use projections are rebuilt from canonical pages and observations, persisted in the `projections` table and read by the query-time recall path. The renderer applies their disclosure policy without per-turn sanitizing model calls; V3.1 forbids those calls.

## Temporal validity and structured Resident

Canonical pages support `observedAt`, `recordedAt`, `validFrom`, `validTo`, supersession lineage and historical `atTime`/`history` recall. A temporal update closes the previous page interval and publishes a new page identity; a correction edits the existing page identity and retains audit lineage. Current Resident compilation excludes superseded, expired, source-only, unconsented and sensitive pages.

Resident content is compiled into bounded blocks (`identity`, `preferences`, `relationships`, `currentState`, `communicationStyle`, `activePeople` and `openThreads`). The persisted snapshot is the bounded value that is injected, with a deterministic version and selected source page IDs. Legacy unstructured Resident records remain readable during migration.

## Dream pipeline and provider behavior

Dream is a recoverable background organizer, not the source of truth.

1. `turn/end` and manual triggers enqueue after the evidence write barrier.
2. Jobs are serialized within a scope; different scopes may progress independently.
3. Persisted cursors prevent repeat ingestion and persisted jobs enable restart recovery.
4. Transcripts are bounded and the provider is asked for only a small number of concise pages.
5. OpenAI-compatible endpoints such as OpenRouter use Chat Completions. Anthropic-compatible endpoints such as Xiaomi MiMo use Anthropic Messages. The protocol is inferred from endpoint shape.
6. Requests use bounded standard fields, never put credentials in the URL, time out after 120 seconds and retry HTTP 429 at most once in the native pipeline.
7. Responses pass strict FILE parsing before persistence. Invalid blocks, empty content, unexpected JSON and provider errors fail the job without replacing the old Wiki or Resident.
8. System-generated extraction sessions do not recursively trigger another Dream pass.

Provider failures are classified and sanitized. The control plane exposes only configured/not-configured state and a credential reference, never a secret, Authorization header or complete external error body.

## Persistence and recovery

The plugin uses DSH `storageDomain` as its persistence boundary. It does not expose a fixed path, `node:sqlite` database or public file-store API. Durable state includes scoped profile state, L0 sources, Wiki pages, Candidates, Resident metadata, audits and Dream cursors/jobs.

- Storage initialization failure disables long-lived memory rather than silently using a global or local fallback.
- Dream failure records a sanitized error and keeps the previous valid Resident readable.
- Resident compilation failure keeps the previous valid projection.
- Host restart can replay persisted evidence and jobs after the bundle loads again.
- A provider-forged session ID is ignored; the job's session and cursor remain authoritative.

## Security and privacy

### Credentials

Dream and embedding secrets are resolved from DSH credentials or process environment at execution time. UI and HTTP configuration accept endpoint, model, token limit and credential reference, but reject raw `apiKey` or secret-like credential writes. Provider endpoints must use HTTPS and cannot contain embedded credentials.

### Control plane

Loopback development can use the host boundary. Remote control requires a bearer token and matching `x-dsh-memory-profile`. `apiTokens` bind each token to one profile. In single-token mode, `apiTokenProfile` binds the token to one profile when set; when empty, the token is owner-wide admin and the control response reports `scopeBinding: owner-admin`. Cross-scope sessions are rejected.

### Sensitive material

Dream-derived sensitive candidates remain pending until explicit review. Explicit user or trusted management actions have separate authority, but V3.1 treats sensitivity as a usage permission rather than a truth claim and requires the three-state policy to tighten conservatively. The extraction prompt forbids inferring secrets, diagnoses and instructions, but this is a guardrail rather than a substitute for deployment policy.

### Deletion semantics

Ordinary “forget” means removing derived memory from the canonical Wiki projection and newly compiled Residents; it intentionally retains raw Session evidence. When `purgeEnabled` is explicitly enabled, `POST /memory/v1/purge` starts a journaled raw-session purge and reconciles session, source, page, candidate, observation, derived-index and Resident state. It requires a dry-run or the exact plan confirmation and reports verified completion. Interrupted journals can be retried on store reopen. Complete cryptographic erasure outside the configured storage domain remains a separate deployment responsibility.

## Control API and UI

The UI is a management/audit surface, not a bypass around the state machine. It shows Resident content, Wiki pages, candidates, source sessions, graph edges, versions, confidence, consent, expiry and status. Replace `/memory/v1` below with the configured `apiPath` when it differs from the default.

| Method | Path | Purpose | Access / flags | Surface |
|---|---|---|---|---|
| OPTIONS | `/memory/v1/*` | CORS preflight | No auth; no flag | Protocol |
| GET | `/memory/v1`, `/memory/v1/` or `/memory/v1/ui` | Human-facing control and audit UI | No auth for HTML; data API is auth-gated | Admin-only |
| GET | `/memory/v1/config` | Safe endpoint/model/credential status | Profile auth; no flag | Admin-only |
| POST | `/memory/v1/config` | Update non-secret Dream settings | Profile auth; no flag | Admin-only |
| GET | `/memory/v1/wiki` | Wiki snapshot, candidates, sources, graph and state | Profile auth; no flag | Admin-only |
| GET | `/memory/v1/wiki/pages/:id` | Read one Wiki page; sensitive/unknown bodies are redacted unless `reveal=sensitive` | Profile auth; no flag | Admin-only |
| GET | `/memory/v1/wiki/graph` | Read bounded Wiki graph; `hop`, `evidence` and `includeEvidence` are query options | Profile auth; no flag | Admin inspection; graph recall is separately flag-gated |
| GET | `/memory/v1/wiki/search` | Lexical Wiki inspection; this is not live Agent recall | Profile auth; no flag | Admin-only |
| GET | `/memory/v1/wiki/sources` | List scope-local source metadata | Profile auth; no flag | Admin-only |
| GET | `/memory/v1/resident` | Read current bounded Resident and raw-retention disclosure | Profile auth; no flag | Admin inspection |
| GET | `/memory/v1/sessions` or `/memory/v1/sessions/:id` | List sessions or read redacted L0 metadata; `reveal=sensitive` is audited | Profile auth; no flag | Admin-only |
| GET | `/memory/v1/candidates` | List pending Dream Candidates | Profile auth; no flag | Admin-only |
| GET | `/memory/v1/observations` | List inferred observations and statuses | Profile auth; no flag | Admin/acceptance-only |
| GET | `/memory/v1/purges` | Read scope-local purge journal metadata | Profile auth; no flag | Admin/acceptance-only |
| GET | `/memory/v1/conflicts` | List contested and resolved conflict overlays | Profile auth; no flag | Admin-only |
| GET | `/memory/v1/audits` | Read scope-local lifecycle audits | Profile auth; no flag | Admin-only |
| POST | `/memory/v1/recall` | Run bounded query-time recall | Profile auth; `recallEnabled` | Admin inspection; live Agent recall uses the separate pre-step hook |
| POST | `/memory/v1/recall/debug` | Read recall plan, channels, gates and degraded modes | Profile auth; `recallEnabled` | Admin/diagnostic-only |
| POST | `/memory/v1/observations` | Create an anchored observation candidate | Profile auth; no flag | Admin/acceptance-only; not Dream/Agent creation |
| POST | `/memory/v1/observations/:id/activate`, `/invalidate` or `/suppress` | Change one observation status | Profile auth; no flag | Admin/acceptance-only |
| POST | `/memory/v1/conflicts/:id/resolve` | Resolve a contested overlay with JSON `{ "resolution": "correction" | "temporal_transition" | "management" }`; returns `400` for another value and `404` when no state changes | Profile auth; no flag | Admin-only |
| POST | `/memory/v1/purge` | Purge one raw session when the flag is enabled | Profile auth; `purgeEnabled` | Admin/acceptance-only |
| POST | `/memory/v1/wiki/candidates/:id/confirm` or `/reject` | Confirm or reject a Candidate | Profile auth; no flag | Admin-only |
| POST | `/memory/v1/candidates/:id/confirm` or `/reject` | Compatibility alias for Candidate actions | Profile auth; no flag | Admin-only |
| POST | `/memory/v1/wiki/pages` | Create a locked canonical page | Profile auth; no flag | Admin-only |
| PUT | `/memory/v1/wiki/pages/:id` | Edit one canonical page; an explicit `sensitivity` field applies a management-authority sensitivity change and is audited | Profile auth; no flag | Admin-only |
| POST | `/memory/v1/wiki/pages/:id/supersede` | Supersede while retaining lineage | Profile auth; no flag | Admin-only |
| POST | `/memory/v1/wiki/pages/:id/temporal` | Publish a temporal replacement | Profile auth; no flag | Admin-only |
| POST | `/memory/v1/memories` | Create a confirmed manual memory convenience record | Profile auth; no flag | Admin-only |
| DELETE | `/memory/v1/memories/:id` | Remove one derived memory while retaining raw evidence | Profile auth; no flag | Admin-only |
| DELETE | `/memory/v1/wiki/pages/:id` | Remove one derived Wiki memory while retaining raw evidence | Profile auth; no flag | Admin-only |
| POST | `/memory/v1/dream` | Queue a session/profile Dream and return `202` | Profile auth; no flag | Admin/acceptance-only |

<a id="installation-and-configuration"></a>
## Installation and configuration

Install into a DSH profile that includes the Web host:

```sh
dsh plugin --profile web add /absolute/path/to/packages/bundle/riko-memory
```

The bundle uses DSH workspace dependencies and the `0.1.6-alpha.2` baseline. The GitHub mirror is a source/package mirror; the runtime must be installed into a compatible DSH Harness worktree.

Configure an owner namespace and stable Agent preset. Without both, durable reads and writes fail closed. The table declares all 42 live `Config` fields. `configResponse()` reports safe operational fields; `ownerNamespace`, `apiToken`, and `apiTokens` are deliberately omitted because they reveal scope or credentials. OpenAI-compatible embeddings require a non-empty model, credential reference and an HTTPS endpoint (plain HTTP is accepted only for loopback hosts); deterministic embeddings use the configured dimension. For a temporary OpenRouter acceptance run, inject secrets only into the process:

| Configuration field | Default | Description | `configResponse()` |
|---|---:|---|---|
| `ownerNamespace` | `local` | Owner namespace used to derive the isolated memory scope. | Omitted: scope-private. |
| `apiPath` | `/memory/v1` | HTTP prefix for the management API and UI. | Included. |
| `apiToken` | `''` | Single bearer token for the default profile. | Omitted: secret. |
| `apiTokens` | `{}` | Bearer-token map that binds profiles to separate scopes. | Omitted: secret and scope-private. |
| `apiTokenProfile` | `''` | Profile selected by the single-token authentication mode. | Included only when non-empty. |
| `ownerAdminToken` | `''` | Owner-admin bearer token that grants management access across profiles. | Included as `ownerAdminConfigured` only; the token value is never returned. |
| `dreamApiUrl` | `https://api.deepseek.com/api/v1/chat/completions` | Dream provider endpoint used for Wiki extraction. | Included through the persisted Dream settings. |
| `dreamCredentialRef` | `DSH_MEMORY_DREAM_API_KEY` | Credential reference resolved when Dream calls the provider. | Included; secret value is never returned. |
| `dreamModel` | `deepseek-chat` | Model name sent to the Dream provider. | Included through the persisted Dream settings. |
| `dreamMaxTokens` | `1200` | Maximum Dream completion tokens. | Included through the persisted Dream settings. |
| `dreamIntervalMs` | `3600000` | Interval for scheduled Dream recovery and sweep work. | Included. |
| `debounceMs` | `5000` | Delay before session activity schedules Dream. | Included. |
| `maxResidentChars` | `12000` | Maximum serialized Resident prompt length. | Included. |
| `maxSessionChars` | `40000` | Maximum transcript length used for Dream input and recovery. | Included. |
| `recallEnabled` | `false` | Enables query-time recall in the Agent hook and HTTP route. | Included. |
| `recallVectorEnabled` | `false` | Enables planner-gated dense vector recall. | Included. |
| `recallRawEvidenceEnabled` | `true` | Allows bounded raw L0 evidence as a recall channel. | Included. |
| `recallObservationEnabled` | `false` | Allows active observations as a recall channel. | Included. |
| `recallGraphEnabled` | `false` | Enables bounded Wiki graph expansion during recall. | Included. |
| `purgeEnabled` | `false` | Enables authenticated raw-session purge transactions. | Included. |
| `recallMaxCandidates` | `8` | Maximum recall results before rendering. | Included. |
| `recallMaxContextChars` | `3000` | Maximum rendered recall context length. | Included. |
| `recallAuthoritativeReserve` | `4` | Minimum reserved seats for non-evidence authoritative recall candidates. | Included. |
| `recallRawEvidenceMaxCandidates` | `4` | Maximum raw L0 evidence candidates considered per recall. | Included. |
| `candidateAutoConfirm` | `off` | Candidate auto-confirmation policy. `user_grounded` admits only claims the user stated verbatim; `all` is an explicit deviation from the no-auto-promotion invariant for controlled dogfooding. | Included. |
| `residentV2Enabled` | `true` | Enables the structured Resident projection path. | Included. |
| `residentBlocksEnabled` | `true` | Enables bounded structured Resident blocks. | Included. |
| `sensitiveResidentEnabled` | `false` | Allows eligible sensitive pages in Resident output. | Included. |
| `temporalEnabled` | `true` | Enables temporal validity and historical recall semantics. | Included. |
| `evidenceClassificationEnabled` | `false` | Classifies user-origin L0 evidence at capture; off leaves unmarked evidence unclassified and treats capture-rule markers as fail-closed sensitive. | Included. |
| `unclassifiedEvidenceDisclosure` | `user_explicit_only` | Fallback only for genuinely unclassified L0 evidence: `user_explicit_only` or `never_explicit`. Stored `sensitive` evidence and capture-rule evidence treated as sensitive while classification is off remain `never_explicit`. | Included. |
| `minObservationEvidence` | `2` | Minimum distinct valid anchors for an observation candidate. | Included. |
| `observationActivationMinEvidence` | `3` | Minimum distinct evidence anchors for automatic observation activation. | Included. |
| `observationActivationMinSessions` | `2` | Minimum distinct sessions for automatic observation activation. | Included. |
| `observationActivationMinConfidence` | `0.8` | Minimum confidence for automatic observation activation. | Included. |
| `reflectionEnabled` | `false` | Enables Dream reflection that proposes anchored observations. | Included. |
| `reflectionMaxObservations` | `3` | Maximum observation proposals accepted from one reflection. | Included. |
| `temporalReconcileEnabled` | `false` | Enables temporal reconciliation during Dream processing. | Included. |
| `embeddingProvider` | `off` | Selects no, deterministic, or OpenAI-compatible embeddings. | Included. |
| `embeddingEndpoint` | `''` | Endpoint for the OpenAI-compatible embedding provider; HTTPS required, plain HTTP only for loopback hosts. | Included. |
| `embeddingCredentialRef` | `DSH_MEMORY_EMBEDDING_API_KEY` | Credential reference for the embedding provider. | Included; secret value is never returned. |
| `embeddingModel` | `''` | Model name sent to the OpenAI-compatible embedding provider. | Included. |
| `embeddingDimension` | `256` | Vector dimension used by deterministic and compatible providers. | Included. |

Provider proposals can tighten sensitivity but cannot downgrade an existing page. `memory_remember` uses deterministic conservative promotion. A management `PUT /memory/v1/wiki/pages/:id` may explicitly set `sensitivity` to `normal`, `provisional_sensitive` or `sensitive`; the transition is audited.

L0 evidence carries a usage permission of its own, and with `evidenceClassificationEnabled` it is decided at capture instead of at read time. Recall first reads `evidenceSensitivityState`: a missing marker is `unclassified` and uses `unclassifiedEvidenceDisclosure`; an explicit stored `normal` or `provisional_sensitive` marker uses its own disclosure policy; an explicit `sensitive` marker uses `never_explicit`; and a `deterministic_rule` marker is treated as `sensitive` while capture classification is off. This means the global default applies only to evidence the system genuinely never classified and cannot loosen stored sensitive evidence or fail-closed suspended capture markers. Setting `unclassifiedEvidenceDisclosure: never_explicit` keeps genuinely unclassified raw text silent even for a matching request. A value a capture rule wrote is suspended rather than deleted while the capability is off, so a restart with it back on restores it from the same record. The states, the authority matrix and the rollback semantics are normative in [docs/v3.1-decision-semantics.md](docs/v3.1-decision-semantics.md).

`SafeUsageProjection.disclosure` is the single raw-text policy field: `normal` permits raw text, `user_explicit_only` permits raw text and recorded source references only when the user initiates the turn, explicitly recalls the topic, and the topic matches, and `never_explicit` never returns raw text. The recall eligibility check and the mention renderer enforce this field; a `never_explicit` projection remains silent even when the query matches. An ordinary turn receives raw text only when the projection also sets `ordinaryRawText` and the query's terms all appear in the stored text, which is what keeps a preference page or an interaction rule guidance-only; `allowedEffects` describes how the memory may be used and never decides whether raw text is returned.

```text
DSH_MEMORY_DREAM_API_URL=https://openrouter.ai/api
DSH_MEMORY_DREAM_MODEL=stealth/union-alpha
DSH_MEMORY_DREAM_API_KEY=<runtime secret>
```

Do not save the key through the UI, write it to `dream-settings.json`, commit it, put it in a URL or paste it into logs. MiMo-compatible validation uses an Anthropic-compatible endpoint such as `https://api.xiaomimimo.com/anthropic` with `mimo-v2.5`.

<a id="acceptance-and-verification"></a>
## Acceptance and verification

Run the focused gates from the DSH Harness worktree:

```sh
pnpm exec tsc -p packages/bundle/riko-memory/tsconfig.json --noEmit --pretty false
pnpm exec vitest run packages/bundle/riko-memory/tests --reporter=dot
```

The native matrix covers contracts, provider protocol extraction, strict FILE parsing, Loader composition, scope isolation, explicit remember/correct/forget, Candidate confirmation, fingerprint merging, expiry, evidence graph aliases, Dream fallback and restart recovery.

The provider baseline uses a temporary directory/profile, sends a minimal request, checks response shape, retries 429 at most once and classifies 401/403/404/429/5xx/timeout/empty/non-JSON failures. It retains only:

```text
acceptance-summary.json
acceptance-events.jsonl
sanitized-provider-errors.log
```

No API key, Authorization header or complete provider response is retained. Provider reachability is not proof of memory effectiveness: acceptance must distinguish correct injection, missed injection, correct silence, wrong injection and natural model variance. The standalone acceptance script remains separate from the production plugin path.

## Advantages

- Native DSH integration: real profile, Loader, storage and lifecycle behavior are exercised.
- Strong traceability: a reviewer can follow Session evidence to Candidate, Wiki page, Resident version and prompt injection.
- Strong isolation: owner/preset/token checks apply before reads and writes.
- Predictable failure behavior: normal chat continues and the last valid Resident survives Dream/provider failures.
- Human control: candidates can be reviewed, rejected, confirmed, corrected, superseded or forgotten.
- Bounded prompt cost: raw transcripts, full Wiki and pending queues stay outside the hot path.

## Trade-offs and disadvantages

- DSH coupling means this is not a drop-in library for arbitrary Node, Rust or MCP hosts.
- Stable preset identity is mandatory; that prevents accidental global sharing but produces fail-closed behavior when configuration is incomplete.
- Candidate review delays automatic memories; explicit tools provide the fast path for clear user requests.
- Embedding providers are optional and bounded; deterministic or OpenAI-compatible provider failures degrade to lexical/RRF. The runtime persists bounded vector-index generations in `index_meta` and `vectors`, restores matching generations after restart, and records degradation for mismatches or failed rebuilds; production-scale background compaction and multi-node index ownership remain separate capabilities.
- No live reranker is wired: `MemoryReranker` is reachable only through direct helper/store callers.
- Forget removes derived memory but not raw evidence in v1.
- Observation candidates may be produced by opt-in Dream reflection. Candidate creation or evidence updates can auto-activate a normal, non-contradicted candidate when the configured evidence, distinct-session and confidence thresholds pass. An authenticated management route can also explicitly activate, invalidate or suppress an observation; explicit activation uses the store's minimum-evidence check. Neither activation path confirms a fact or grants explicit mention permission.
- `storageDomain` is a host boundary, not distributed consensus; public multi-node deployment needs additional design.
- Provider quality still varies. Strict parsing protects the state machine but cannot guarantee relevance or recall quality.

## Status and release boundary

Implemented: scoped L0 evidence, L1 Candidates, L2 Wiki and L3 Resident contracts; DSH persistence and restart recovery; explicit tools; profile/token checks; safe Dream and embedding credential handling; OpenAI-compatible and Anthropic-compatible Dream protocols; deterministic/OpenAI-compatible embedding wiring with lexical fallback; controlled FILE parsing; metadata bounds; wikilink normalization; Candidate fingerprint merging; source preservation; last-valid Resident fallback; persisted jobs/cursors; bounded structured Resident blocks; bounded persisted vector-index generations with `index_meta`/`vectors` metadata, restore-after-restart, mismatch invalidation, candidate build followed by atomic swap and degraded retention of the previous index; live Agent query-time lexical/RRF recall with optional dense, raw-evidence and graph channels, canonical-first budgeting and policy-evidence suppression; temporal validity and historical recall; a conservative current Mention Gate; contested conflict overlays with persistence/rebuild, authenticated listing and resolution, and live Agent suppression; anchored observation candidates with optional Dream reflection and HTTP management; authority-checked three-state sensitivity transitions; revocable aliases with invalidation, historical resolution and canonical-preserving rebuild; explicit same-context alias coreference; journaled raw-session/page/candidate/source/observation purge with dry-run, confirmation and verification; UI, review and audit routes; real-Loader SafeUsageProjection and conflict-injection assertions; the Appendix F companion corpus with its live Loader runner; and the Appendix G aggregate metrics computed from raw observations as described in [docs/companion-eval.md](docs/companion-eval.md).

Deferred: production-scale background vector-index compaction and multi-node index ownership; live reranker wiring; sensitivity false-negative and false-positive rates; complete projection and answer-side outcome metrics; the complete conflict evaluation matrix; validated hedged silent use; full Reflection/consolidation beyond anchored Observation candidates; the full live HTTP/Agent alias authority matrix; entity resolution beyond bounded wikilink graph expansion; complete data erasure outside the storage domain; multi-node storage; public multi-tenant operations; production-grade autonomous confirmation policy for sensitive content; the 200–500-scenario production benchmark beyond the thirty-scenario companion corpus; production-scale load/chaos evaluation beyond the focused package probes; and a standalone runtime independent of a compatible DSH workspace.

Current verification snapshot (2026-09-22): 334 of 335 normative requirements have usable evidence, with one evidence gap, [REQ-EVAL-035](docs/traceability-gap-register.json). The execution report records 47 spec files and 355 tests, with 344 passed and 11 skipped; the default no-credential run records 43 files, 340 passed and 15 skipped. Skipped cases are opt-in provider/data campaigns, not failures. A v2 fixed cohort completed real answer and scoring runs for 50 LoCoMo and 50 LongMemEval-S items: LoCoMo completed 49/50 with one empty recall and mean F1 0.0149; LongMemEval-S completed 50/50 with 9/50 judged correct. The records are published in [the fixed-cohort result index](docs/benchmark-results/riko-memory-v2-fixed-cohort-2026-09-22/result-index.json). These results keep REQ-EVAL-035 open because non-empty recall was not reliably relevant and do not upgrade any capability to verified.

The current implementation is a governed Phase 1–5 substrate, not a claim that every production evaluation gate is complete. The package suite covers the implemented state transitions and runs the Appendix F corpus and the Appendix G aggregation; four answer-side corpus metrics remain explicitly unsupported without an answer generator, while focused restart, purge-interruption, load and keyless chaos probes exist. Production benchmark, coverage and production-scale load/chaos evidence must still be collected before enabling the opt-in flags in production.

## FAQ

### Does a Dream response immediately become memory?

No. It becomes a Candidate and reaches Resident only after original user evidence or explicit management confirmation creates a canonical Wiki page.

### Can two presets share one memory pool?

No. The stable preset is part of the durable key. Sharing requires deliberately configuring the same stable preset boundary.

### What happens when the provider is down?

Normal chat continues, a sanitized job failure is recorded and the previous valid Resident remains available. A later recovery pass can consume the persisted cursor.

### Where is the API key stored?

It is resolved from DSH credentials or a process environment variable at Dream time. The management API never writes or returns the raw value.

### What does deletion remove?

It removes derived Wiki memory from future Resident projections and records the operation. Raw Session evidence remains in v1.

### Is this repository the whole DSH Harness?

No. It is the source mirror of the native memory bundle. Install it from the compatible DSH Harness workspace or use the bundle path shown above.

<a id="dev-note"></a>
## Dev Note

Keep long-lived memory changes inside the storage-domain, Candidate, Wiki and Resident state machine. Do not add a parallel file store, broaden scope silently, persist raw secrets or promote model output without authoritative confirmation. After behavior changes, run static checks, focused tests, Loader tests, the relevant provider probe only when protocol code changed, raw attribution checks and documentation gates before publishing.

**Runtime invariant:** No companion is published. The shared storage domain owns every durable projection this package writes, and its runtime relations are asserted by the Loader-driven contract tests, so it reserves no separate runtime ownership.

<a id="model-experience"></a>
## Model Experience

### Resident memory injection

#### What the model sees

Each live Agent receives only its stable preset's bounded Resident Snapshot. The injected block is labeled memory data rather than instructions; the complete Wiki, raw Session evidence and pending Candidates stay out of the hot prompt.

#### Token effect

Resident content is bounded by `maxResidentChars` and assembled as dynamic system context for the next request. A failed Dream keeps the previous valid projection, so a provider outage does not suddenly remove established context.

#### KV Cache effect

Changing Resident modifies the dynamic system context for later requests and may invalidate the request prefix cache after the injection point. Reading or writing memory does not invoke Dream on the chat hot path.

### Query-time recall injection

#### What the model sees

When enabled, recall is injected as bounded memory data. Canonical and other non-evidence results are authoritative candidates; a raw evidence line is labeled `[supplement]` when it supports a selected authoritative result, while canonical text is labeled `[authoritative]`. Policy evidence from a suppression cue is retained for control but is excluded from ordinary raw recall.

#### Token effect

`recallAuthoritativeReserve`, `recallRawEvidenceMaxCandidates` and `recallMaxContextChars` bound the candidate mix and serialized context. Repeated raw detail is omitted when selected non-evidence text already covers its terms.

#### KV Cache effect

Changing recalled context changes the dynamic request context after the injection point and may reduce prefix-cache reuse for later requests. Recall does not invoke Dream on the chat hot path.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- The package is tightly coupled to DSH workspace APIs and is not a drop-in library for arbitrary Node, Rust or MCP hosts.
- Stable preset identity is mandatory. Missing configuration deliberately produces fail-closed behavior instead of accidental global sharing.
- Candidate review can delay automatic memory; explicit tools provide the fast path for clear user requests.
- Deterministic and OpenAI-compatible embedding providers are live-wired with lexical fallback; bounded vector-index generations persist in `index_meta` and `vectors`, restore matching state after restart and retain the previous index with degraded metadata when a rebuild fails. Production-scale background compaction, multi-node index ownership and reranking remain separate capabilities.
- The real Loader Agent path covers SafeUsageProjection-only injection without raw body or source identifiers, conflict quarantine and authenticated release; two projection metrics are measured directly, while answer-side outcome metrics, the complete conflict evaluation matrix and the full live HTTP/Agent alias authority matrix remain open.
- Ordinary forget removes derived memory from future Residents but does not purge raw Session evidence; explicit purge is separately gated, journaled, dry-run capable, confirmation-protected and verified.
- Observation candidates may come from opt-in Dream reflection. Candidate creation and evidence updates may auto-activate a normal, non-contradicted candidate at the configured evidence, distinct-session and confidence thresholds; authenticated management routes can also explicitly activate, invalidate or suppress observations, with explicit activation using the store's minimum-evidence check. Neither activation path confirms a fact or grants explicit mention permission.
- `storageDomain` is a host persistence boundary, not distributed consensus; public multi-node deployment needs additional design.
- Provider quality still varies. Strict parsing protects the state machine but cannot guarantee relevance or recall completeness.
- The Appendix F corpus covers thirty representative scenarios, with four answer-side metrics unsupported without an answer generator, and Appendix G reports 21 fields; `safeUsageProjectionRate` and `rawTextWithheldRate` are direct projection measurements, while answer-side outcome fields remain unsupported without generated answers. The keyless dense ablation is a routing and selection probe, not a BGE quality result. Sensitivity false-negative and false-positive rates, validated hedged silent-use evaluation, full Reflection/consolidation, entity resolution beyond bounded wikilink graph expansion, complete data erasure outside the configured storage domain, public multi-tenant operations, autonomous sensitive-content confirmation, the 200–500-scenario production benchmark, production-scale load/chaos evaluation and a standalone runtime independent of DSH remain deferred.
- External benchmark closure remains open: REQ-EVAL-035 now has a published v2 fixed-cohort run with resumable LoCoMo and LongMemEval answer/scorer artifacts, but the measured result is not a capability pass. LoCoMo completed 49/50 with mean F1 0.0149, LongMemEval-S scored 9/50 correct, and one LoCoMo item had empty recall; the [published result index](docs/benchmark-results/riko-memory-v2-fixed-cohort-2026-09-22/result-index.json) is the review entry point. Non-empty recall alone is not treated as relevant recall, and no verified capability claim is made.
