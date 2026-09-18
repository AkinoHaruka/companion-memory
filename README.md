---
description: "Native scoped memory plugin for DeepSeek Harness."
kind: "package-bundle"
---

# @deepseek-ai/dsh-riko-memory

English | [中文](README.zh.md)

## Summary

Native DSH memory with stable-preset scope isolation, durable storage-domain records, explicit confirmation, canonical Wiki pages, bounded Resident Snapshots, and a recoverable Dream pipeline. Secrets stay in credentials or process environment. The control API and acceptance script are deliberately bounded and sanitized.

This is the native DSH implementation of Riko memory. The canonical source is `packages/bundle/riko-memory` in the current Harness worktree. The older standalone bundle and root-level `src/tests` are migration references, not parallel sources of truth.

No invariant companion is published because the Loader composition and storage-domain tests are the authoritative acceptance surface for this native bundle.

## Table of Contents

- Implemented
- Install and configure
- Control API
- Acceptance and verification
- Model Experience
- Known Limitations and Deferred Work
- Dev Note

## Implemented

- DSH `storageDomain` persistence; no `node:sqlite`, fixed memory path, or public file-store API.
- Scope isolation by `ownerNamespace + stableAgentPresetId`. Missing or unstable preset identity fails closed; there is no default global profile.
- L0 session evidence with `sessionId`, event sequence, and source references.
- Model output is always a pending Candidate. Only explicit user evidence or an explicit management action can confirm it.
- Canonical Wiki pages and bounded, versioned Resident Snapshots. Resident is derived and uses the last valid snapshot when Dream or storage work fails.
- Explicit tools: `memory_remember`, `memory_get_resident`, `memory_correct`, and `memory_forget`.
- Dream credentials are resolved through DSH credentials or process environment. The management API exposes only the credential reference and configured/not-configured state; it rejects `apiKey` writes. Dream endpoints must use HTTPS and cannot embed credentials in their URL.
- Profile-serial Dream jobs, bounded transcript input, controlled FILE-block parsing, persisted job cursors, restart recovery from persisted L0 evidence even before a host Session is restored, correction/supersede audit lineage, sanitized provider errors, and profile/token checks on the HTTP control plane. Dream automatically selects OpenAI Chat Completions or Anthropic Messages from the endpoint URL, including Xiaomi MiMo.

## Install and configure

Install this package into a DSH profile that includes the host web server:

```sh
dsh plugin --profile web add /absolute/path/to/packages/bundle/riko-memory
```

For a temporary OpenRouter acceptance run, inject these variables into the process only; do not save them through the UI or commit them:

```text
DSH_MEMORY_DREAM_API_URL=https://openrouter.ai/api
DSH_MEMORY_DREAM_MODEL=stealth/union-alpha
DSH_MEMORY_DREAM_API_KEY=<runtime secret>
```

`DSH_MEMORY_DREAM_API_KEY` is referenced by the default credential ref. A non-loopback control plane also requires a bearer token mapping. Configure the owner namespace and stable agent preset in the DSH profile; long-lived memory is unavailable until the preset identity is stable.

## Control API

The built-in UI is available at `/memory/v1/ui` when the web profile is running. It never accepts or displays an API key; it can edit the endpoint, model, and credential reference only.

The main routes are:

| Method | Path | Purpose |
|---|---|---|
| GET | `/memory/v1/wiki` | Wiki, candidates, sources, graph, and state |
| GET | `/memory/v1/wiki/graph?hop=1&evidence=1` | Typed L2 Wiki graph; `includeEvidence=1` is an equivalent compatibility query |
| GET | `/memory/v1/resident` | Current bounded Resident Snapshot |
| GET | `/memory/v1/sessions/:id` | Auditable L0 evidence |
| GET | `/memory/v1/candidates` | Pending model candidates |
| GET | `/memory/v1/config` | Safe configuration summary |
| POST | `/memory/v1/dream` | Queue Dream for a session or profile and return immediately |
| POST | `/memory/v1/wiki/candidates/:id/confirm` | Explicitly confirm a candidate |
| POST | `/memory/v1/wiki/candidates/:id/reject` | Reject a candidate |
| POST/PUT | `/memory/v1/wiki/pages` | Explicit management edits |
| POST | `/memory/v1/wiki/pages/:id/supersede` | Remove a page from future Resident projections while retaining lineage |
| GET | `/memory/v1/audits` | Read scope-local correction, supersede, forget, and Dream audit records |
| DELETE | `/memory/v1/wiki/pages/:id` | Remove derived memory from new Resident |

For multiple profiles, a bearer token must match the explicit `x-dsh-memory-profile` header. A session belonging to another scope is rejected. The raw Session evidence retention policy is disclosed by the API: v1 forget removes derived memory, while raw Session purge is not implemented.

## Acceptance and verification

Run the local gates from the Harness worktree:

```sh
pnpm exec tsc -b packages/bundle/riko-memory/tsconfig.json --pretty false
pnpm exec vitest run packages/bundle/riko-memory/tests --reporter=dot
```

The dedicated provider baseline script uses a temporary directory and profile, sends the minimal protocol-specific request, performs at most one bounded 429 retry, classifies provider failures without retaining full error bodies, and writes only `acceptance-summary.json`, `acceptance-events.jsonl`, and `sanitized-provider-errors.log` to its output directory. It requires a runtime key in `DSH_MEMORY_DREAM_API_KEY`; no key is read from package files.

The `/demo/run` endpoint is disabled by default and is reserved for a future bounded acceptance harness. It is not part of the production memory path.

## Dev Note

Keep long-lived memory changes inside this bundle's storage-domain, Candidate, Wiki, and Resident state machine. Do not introduce a parallel file store or promote model output without an authoritative confirmation action.

## Model Experience

### Resident memory injection

#### What the model sees

Each live agent receives only its stable preset's bounded Resident Snapshot. The injected block is labeled as memory data, not instructions; the complete Wiki and raw Session evidence stay out of the hot prompt path.

#### Token effect

The Resident Snapshot is bounded by `maxResidentChars` and is assembled as dynamic system context for the next request. A failed Dream keeps the previous valid projection.

#### KV Cache effect

Changing a Resident Snapshot changes the dynamic context for subsequent requests and can invalidate the request prefix after that point. Reading or writing memory does not call Dream on the chat hot path.

## Known Limitations and Deferred Work

- Raw Session deletion, embedding/vector recall, multi-node storage, and public multi-tenant deployment are not implemented.
- The independent Dream model is a recoverable background pipeline; failure must not block normal chat or erase a last-valid Resident Snapshot.
