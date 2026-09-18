---
description: "Native scoped memory plugin for DeepSeek Harness."
kind: "package-bundle"
---

# @deepseek-ai/dsh-riko-memory

English | [中文](README.zh.md)

## Summary

Native DSH memory with stable-preset scope isolation, durable storage-domain records, explicit confirmation, canonical Wiki pages, bounded Resident Snapshots and a recoverable Dream pipeline. Secrets stay in credentials or process environment; the UI, control API and acceptance script are bounded and sanitized.

## What this package is

`@deepseek-ai/dsh-riko-memory` is the native DeepSeek Harness implementation of Riko-style scoped long-term memory. It connects directly to DSH lifecycle and storage seams: Cordis plugin loading, session events, stable Agent presets, `storageDomain`, system-prompt injection, explicit tools, credentials and background jobs. It is not an MCP memory server, not a second SQLite service and not a generic file-store adapter.

The governing promise is simple: a memory may influence a later reply only after it has a traceable source, passed the scope boundary, reached the canonical Wiki state machine and been selected for the bounded Resident Snapshot. Model output alone never becomes authority.

The canonical source is `packages/bundle/riko-memory` in the DSH Harness worktree. The GitHub repository [AkinoHaruka/companion-memory](https://github.com/AkinoHaruka/companion-memory) is the user-facing source mirror of this bundle. Older standalone implementations and historical root-level copies are migration references, not parallel runtimes.

## Architecture at a glance

```text
User conversation
  -> DSH session/event listener
  -> L0 evidence: sessionId + event sequence + source span
  -> explicit tool or background Dream
  -> L1 Candidate: proposal with provenance and consent state
  -> original user evidence or explicit management action
  -> L2 canonical Wiki page: durable, versioned authority
  -> Resident compiler
  -> L3 Resident Snapshot: bounded prompt projection
  -> next request for the same stable Agent preset
```

| Layer | Name | Purpose | Direct prompt input |
|---|---|---|---|
| L0 | Session evidence | What was actually said, with event provenance | No |
| L1 | Candidate | What the extractor proposed, awaiting review | No |
| L2 | Wiki | Canonical pages, versions, links, sources, expiry and audit lineage | Indirectly |
| L3 | Resident Snapshot | Rebuildable bounded projection for the next request | Yes |

The layers answer different questions: L0 is “what happened”, L1 is “what was proposed”, L2 is “what was accepted as durable memory”, and L3 is “what is safe and useful to inject now”. The Resident is derived and replaceable; the Wiki is the long-term authority.

## Goals and non-goals

### Goals

- Share durable memory across sessions belonging to one stable Agent preset.
- Isolate owners and presets in both runtime tools and the HTTP control plane.
- Preserve session, event and source provenance so a page can be audited.
- Require explicit evidence or explicit management action before Dream output becomes canonical.
- Keep the chat hot path bounded: reading Resident does not call Dream, scan the full Wiki or wait for a background lock.
- Make provider, parser, storage, Resident compilation and host restart failures recoverable.
- Keep credentials outside source files, settings JSON and ordinary management payloads.
- Expose Wiki, candidate, source and graph information for human review.

### Deliberate v1 non-goals

- Embeddings, vector search, semantic nearest-neighbor retrieval or a second retrieval database.
- Multi-node coordination, public multi-tenant hosting or distributed job ownership.
- Full raw Session deletion or cryptographic erasure of every evidence record.
- Treating every conversational sentence as a memory.
- Letting a model-generated “please remember this” sentence authorize itself.
- Replacing DSH storage/lifecycle with Fastify, a fixed filesystem path, `node:sqlite`, MCP or a Rust sidecar.

## Scope and isolation

Long-lived memory is keyed by:

```text
MemoryScope = ownerNamespace + stableAgentPresetId
```

`ownerNamespace` identifies the owning installation or tenant boundary. `stableAgentPresetId` identifies the DSH Agent preset whose behavior and memory are meant to be shared. Session ID is evidence provenance, not the long-term sharing key.

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

### 5. Commit to the canonical Wiki

Confirmation creates or updates a versioned Wiki page, records source lineage and removes its pending Candidate. Corrections retain prior version information in the audit lineage. Superseding a page removes it from future Residents while retaining the page and provenance for review.

### 6. Compile and inject Resident

Only confirmed, consented, non-superseded and non-expired pages are compiled. Source pages, pending candidates and raw transcripts stay outside the hot prompt. The result is ordered, bounded by `maxResidentChars`, assigned a content-derived version and persisted with source page IDs. DSH injects only the current stable preset's Resident as labeled memory data, not as instructions.

## Explicit tools

### `memory_get_resident`

Reads the current stable preset's Resident and version. Missing preset identity fails closed. This is a read-only hot-path operation and does not invoke Dream.

### `memory_remember`

Stores one explicit preference or fact as managed, confirmed memory. The content must be non-empty and appear in the latest raw user message of the current session. It cannot save a model inference or a claim copied from another session.

### `memory_correct`

Replaces the selected Wiki page's user-visible content after checking that the replacement occurs in the latest raw user message. The page remains confirmed, its lineage is retained and Resident is rebuilt immediately.

### `memory_forget`

Requires an explicit deletion cue such as “forget”, “remove” or `忘记`, plus the exact memory ID in the latest user message. It removes derived memory from future Residents and records the operation. v1 does not purge the original raw Session evidence.

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

Dream secrets are resolved from DSH credentials or process environment at execution time. UI and HTTP configuration accept endpoint, model, token limit and credential reference, but reject raw `apiKey` writes. Endpoints must use HTTPS and cannot contain embedded credentials.

### Control plane

Loopback development can use the host boundary. Remote control requires a bearer token and matching `x-dsh-memory-profile`. A token for profile A cannot read or mutate profile B; cross-scope sessions are rejected.

### Sensitive material

Dream does not automatically promote sensitive content. Sensitive candidates remain pending until explicit review. The extraction prompt forbids inferring secrets, diagnoses and instructions, but this is a guardrail rather than a substitute for deployment policy.

### Deletion semantics

In v1, “forget” means removing derived memory from the canonical Wiki projection and newly compiled Residents. It does not mean purging every raw Session event. The API discloses this boundary. Full raw-session purge is a separate future capability.

## Control API and UI

The UI is a management/audit surface, not a bypass around the state machine. It shows Resident content, Wiki pages, candidates, source sessions, graph edges, versions, confidence, consent, expiry and status.

| Method | Path | Purpose |
|---|---|---|
| GET | `/memory/v1/ui` | Human-facing control and audit UI |
| GET | `/memory/v1/wiki` | Wiki, candidates, sources, graph and state |
| GET | `/memory/v1/wiki/graph?hop=1&evidence=1` | Typed L2 graph plus evidence edges; `includeEvidence=1` is an alias |
| GET | `/memory/v1/resident` | Current bounded Resident and retention disclosure |
| GET | `/memory/v1/sessions/:id` | Auditable L0 evidence |
| GET | `/memory/v1/candidates` | Pending Dream Candidates |
| GET | `/memory/v1/config` | Safe endpoint/model/credential status |
| POST | `/memory/v1/dream` | Queue a session/profile Dream and return `202` |
| POST | `/memory/v1/wiki/candidates/:id/confirm` | Explicitly confirm a Candidate |
| POST | `/memory/v1/wiki/candidates/:id/reject` | Reject a Candidate |
| POST/PUT | `/memory/v1/wiki/pages` | Explicitly create or edit canonical pages |
| POST | `/memory/v1/wiki/pages/:id/supersede` | Supersede while retaining lineage |
| GET | `/memory/v1/audits` | Scope-local corrections, supersedes, forgets and Dream audits |
| DELETE | `/memory/v1/wiki/pages/:id` | Remove derived memory from future Residents |

## Installation and configuration

Install into a DSH profile that includes the Web host:

```sh
dsh plugin --profile web add /absolute/path/to/packages/bundle/riko-memory
```

The bundle uses DSH workspace dependencies and the `0.1.6-alpha.2` baseline. The GitHub mirror is a source/package mirror; the runtime must be installed into a compatible DSH Harness worktree.

Configure an owner namespace and stable Agent preset. Without both, durable reads and writes fail closed. For a temporary OpenRouter acceptance run, inject secrets only into the process:

```text
DSH_MEMORY_DREAM_API_URL=https://openrouter.ai/api
DSH_MEMORY_DREAM_MODEL=stealth/union-alpha
DSH_MEMORY_DREAM_API_KEY=<runtime secret>
```

Do not save the key through the UI, write it to `dream-settings.json`, commit it, put it in a URL or paste it into logs. MiMo-compatible validation uses an Anthropic-compatible endpoint such as `https://api.xiaomimimo.com/anthropic` with `mimo-v2.5`.

## Acceptance and verification

Run the focused gates from the DSH Harness worktree:

```sh
pnpm exec tsc -b packages/bundle/riko-memory/tsconfig.json --pretty false
pnpm exec vitest run packages/bundle/riko-memory/tests --reporter=dot
```

The native matrix covers contracts, provider protocol extraction, strict FILE parsing, Loader composition, scope isolation, explicit remember/correct/forget, Candidate confirmation, fingerprint merging, expiry, evidence graph aliases, Dream fallback and restart recovery.

The provider baseline uses a temporary directory/profile, sends a minimal request, checks response shape, retries 429 at most once and classifies 401/403/404/429/5xx/timeout/empty/non-JSON failures. It retains only:

```text
acceptance-summary.json
acceptance-events.jsonl
sanitized-provider-errors.log
```

No API key, Authorization header or complete provider response is retained. Provider reachability is not proof of memory effectiveness: acceptance must distinguish correct injection, missed injection, correct silence, wrong injection and natural model variance. `/demo/run` is disabled by default and the old 200-turn dual-Agent demo is not a production path.

## Advantages

- Native DSH integration: real profile, Loader, storage and lifecycle behavior are exercised.
- Strong provenance: a reviewer can follow Session evidence to Candidate, Wiki page, Resident version and prompt injection.
- Strong isolation: owner/preset/token checks apply before reads and writes.
- Predictable failure behavior: normal chat continues and the last valid Resident survives Dream/provider failures.
- Human control: candidates can be reviewed, rejected, confirmed, corrected, superseded or forgotten.
- Bounded prompt cost: raw transcripts, full Wiki and pending queues stay outside the hot path.

## Trade-offs and disadvantages

- DSH coupling means this is not a drop-in library for arbitrary Node, Rust or MCP hosts.
- Stable preset identity is mandatory; that prevents accidental global sharing but produces fail-closed behavior when configuration is incomplete.
- Candidate review delays automatic memories; explicit tools provide the fast path for clear user requests.
- There is no embedding/vector recall yet, so very large Wikis will eventually need a separately governed retrieval design.
- Forget removes derived memory but not raw evidence in v1.
- `storageDomain` is a host boundary, not distributed consensus; public multi-node deployment needs additional design.
- Provider quality still varies. Strict parsing protects the state machine but cannot guarantee relevance or recall quality.

## Status and release boundary

Implemented: scoped L0 evidence, L1 Candidates, L2 Wiki and L3 Resident contracts; DSH persistence and restart recovery; explicit tools; profile/token checks; safe credential handling; OpenAI-compatible and Anthropic-compatible Dream protocols; controlled FILE parsing; metadata bounds; wikilink normalization; Candidate fingerprint merging; source preservation; last-valid Resident fallback; persisted jobs/cursors; UI; evidence graph; review and audit routes.

Deferred: raw Session purge, complete data erasure, embeddings, vector recall, multi-node storage, public multi-tenant operations, a production-grade autonomous confirmation policy for sensitive content, and a standalone runtime independent of a compatible DSH workspace.

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

## Development note

Keep long-lived memory changes inside the storage-domain, Candidate, Wiki and Resident state machine. Do not add a parallel file store, broaden scope silently, persist raw secrets or promote model output without authoritative confirmation. After behavior changes, run static checks, focused tests, Loader tests, the relevant provider probe only when protocol code changed, raw attribution checks and documentation gates before publishing.

## Model Experience

### Resident memory injection

#### What the model sees

Each live Agent receives only its stable preset's bounded Resident Snapshot. The injected block is labeled memory data rather than instructions; the complete Wiki, raw Session evidence and pending Candidates stay out of the hot prompt.

#### Token effect

Resident content is bounded by `maxResidentChars` and assembled as dynamic system context for the next request. A failed Dream keeps the previous valid projection, so a provider outage does not suddenly remove established context.

#### KV Cache effect

Changing Resident modifies the dynamic system context for later requests and may invalidate the request prefix cache after the injection point. Reading or writing memory does not invoke Dream on the chat hot path.

## Known Limitations and Deferred Work

- The package is tightly coupled to DSH workspace APIs and is not a drop-in library for arbitrary Node, Rust or MCP hosts.
- Stable preset identity is mandatory. Missing configuration deliberately produces fail-closed behavior instead of accidental global sharing.
- Candidate review can delay automatic memory; explicit tools provide the fast path for clear user requests.
- Embeddings, vector recall, multi-node storage and public multi-tenant operations are not implemented.
- Forget removes derived memory from future Residents but does not purge raw Session evidence in v1.
- `storageDomain` is a host persistence boundary, not distributed consensus; public multi-node deployment needs additional design.
- Provider quality still varies. Strict parsing protects the state machine but cannot guarantee relevance or recall completeness.
- Full raw Session purge, complete data erasure, autonomous sensitive-content confirmation and a standalone runtime independent of DSH remain deferred.
