# companion-memory

Long-term memory for an AI companion: it should remember you, and know when to
say so.

Not a RAG stack. A retrieval pipeline answers "what is relevant"; this project's
harder problems are **what deserves to be kept**, **whether this is the moment to
say it**, and **how a picture of a person should grow rather than accumulate**.

Design rationale lives in [DESIGN.md](./DESIGN.md). Read §1–§2 first: the six
argument errors recorded there explain why the schema looks the way it does.

---

## Layout

```
crates/kernel/        Rust — the decision logic
                      No I/O, no model, no host dependency, no ambient time.
crates/storage/       Rust — SQLite persistence. The only crate that touches a
                      database; records what the kernel decided and reads it back.
crates/worker/        Versioned JSONL subprocess: the only runtime access to
                      Rust rules, SQLite, retrieval and admission.
packages/dsh-plugin/  External DSH 0.1.5-rc.2 Bundle. It renders Rust's usage
                      plan and owns no memory policy of its own.
packages/host/        Oracle evaluator; it calls the same worker and records
                      causal-chain artifacts rather than answer differences.
scripts/              Tooling: the worker packager, evaluation inspection and
                      the MSVC build wrapper.
```

The kernel performs no I/O and calls no model, which is what makes it
exhaustively testable. Extraction, narration, consolidation and host wiring stay
in the adapter, because those need a model and a session.

A TypeScript prototype of the same domain and rules was developed first and then
deleted. The reason is worth recording, because "keep the prototype as a
reference" is usually good advice: it had its own test suite, the suite passed,
and the code was still **behaviourally wrong where the tests did not look** — it
accepted any string as a `Date`, so the rule that prose must never overwrite a
resolved instant was not actually enforced. A reference that disagrees with the
implementation on exactly the invariant you care about is worse than none.

## Status

| Area | State |
|---|---|
| Predicate vocabulary + registry (47 predicates) | done |
| Record identity: cardinality, supersede, type compatibility | done |
| Mention gate | done |
| Evidence graph and suppression | done |
| Salience, scoring and promotion thresholds | done |
| Forgetting: suppression, residue scan, derived recompute | done |
| Inference lifecycle (confidence cap, review) | done |
| Storage: schema, migrations, scope-isolated queries | done |
| JSONL worker: health, warm, admit, query, forget, session closure | done |
| SQLite v3: accepted evidence, spans, open threads, telemetry, pending review pointers | done |
| DSH external Bundle: actual `agent/pre-step` snapshot injection | done |
| Async direct-user extraction and deterministic worker admission | done |
| Oracle evaluator: normal, Gold retrieval, forced Gold, counterfactual | done |
| Kernel↔store integration: write, recall, supersede, forget | done |
| RuntimeState / inference promotion | pending extraction-quality threshold |
| Platform release binaries | CI package workflow (Windows x64, Linux x64) |

The old TypeScript predicate, cardinality, admission, store and `HostKernel`
implementations were intentionally retired. A TypeScript caller may serialize a
candidate but cannot decide that it is valid, visible, superseding, or durable.

The lifecycle test dispatches a real DSH `agent/pre-step` waterfall through the
formal Bundle mount and asserts one durable `plugin/snapshot` injection only on
the first step. The worker's stdio test covers bad JSON recovery, accepted source
retention and evidence deletion after forgetting.

## DSH Bundle installation

Build a release worker for the host platform, stage it in the package, then add
the package as an external DSH Bundle. Release CI runs the same staging command
for Windows x64 and Linux x64.

```powershell
pnpm build:worker:windows
pnpm --filter @companion-memory/dsh-plugin build
dsh plugin --profile <profile> add <path-to-companion-memory/packages/dsh-plugin>
```

`packages/dsh-plugin/cordis.patch.yml` reads the deployment-scoped service,
owner, default profile, database location and worker command from
`COMPANION_MEMORY_*` environment variables. The profile id is the DSH Agent
Preset; if absent, only `COMPANION_MEMORY_DEFAULT_PROFILE` is used. It never
falls back to Agent ID or Session ID.

Each first `agent/pre-step` reads a fresh `MemoryUsagePlan` from the worker and
appends it as a durable `plugin/snapshot` user message. Worker failure, timeout
or protocol damage produces a normal DSH reply with no memory; a prior snapshot
is never reused. Direct user messages are extracted only after `turn/end` on a
private, bounded, cancellable queue.

## Evaluation

`packages/host` labels each turn as a positive opportunity, a protected
negative case, or a no-opportunity silence case. It writes plans, selected ids,
admission outcomes and replies for frozen arms: the normal chain, Gold with
normal retrieval, forced Gold injection, and a **zero-memory control** whose
scope is never written to. The normal arm shares the production extractor
grammar and span validation; only the direct user text and Rust-approved records
can enter it.

A fifth arm, forced wrong memory, runs on the turn that declares a
counterfactual and on the turns after it while the wrong fact is still in its
store. It is a pressure test -- does the model repeat a fact it was handed, does
the gate suppress a topic the user asked it to avoid. It used to run on every
turn, admitting the gold proposals wherever no counterfactual was declared,
which made it gold under another label and its distance from the ceiling a
sampling artifact read as a causal floor.

Every conclusion here is a difference between having memory and not having it,
and `oracle-summary.json` reports that difference as `lift`, ceiling minus
control, per effect. A rate against an absolute floor cannot separate "memory
worked" from "the model does this anyway".

Before the first model call, `validateFixture` refuses a fixture that
contradicts itself -- an evidence token no earlier record contains, a token the
user said themselves, a counterfactual that restates gold, a session that does
not advance. A turn that declares a recall effect without declaring what a reply
would have to contain is not a contradiction: its observation is
`not_applicable`, and the summary says so rather than scoring a failure.

```powershell
# The bridge runs inside DSH and binds the current Agent route. It must export
# createEvaluationClient(), implemented with createDshRouteEvaluationClient(ctx, agent).
$env:COMPANION_MEMORY_DSH_EVALUATION_BRIDGE = 'C:\path\to\dsh-oracle-bridge.mjs'
# Uses five repetitions by default; set acceptance for ten and enforce gates.
$env:COMPANION_MEMORY_EVAL_MODE = 'acceptance'
pnpm --filter @companion-memory/host run
```

A route can also be configured directly, which needs no DSH session, no mounted
profile and no agent, and reports what the provider did per call. That last part
is not a convenience: on a reasoning route the hidden reasoning is billed out of
the same budget as the visible answer, and a 400-token reply budget was measured
to be spent 397 tokens deep on reasoning, returning `content: ""` with
`finish_reason: "length"`. Without the report that is indistinguishable from a
provider refusal and from a model that chose to say nothing, and a scoring rule
built on it will read as a product finding.

```sh
export COMPANION_MEMORY_EVAL_BASE_URLS='https://open.bigmodel.cn/api/paas/v4,https://api.z.ai/api/paas/v4'
export COMPANION_MEMORY_EVAL_MODEL='GLM-4.7-Flash'
export COMPANION_MEMORY_EVAL_API_KEYS='key-one,key-two'          # environment only, never a file
export COMPANION_MEMORY_EVAL_BODY_JSON='{"thinking":{"type":"disabled"}}'
node scripts/run-acceptance-http.mjs --runs 10 --label glm
```

Every host is crossed with every key and the client rotates on a retryable
refusal, which is the normal case rather than an exception on these tiers: both
`1305 访问量过大` and `1113 余额不足或无可用资源包` arrive as HTTP 429, and the
useful answer to either is the next credential instead of the same one again.
The report says which host and which credential index served a call, never the
key.

`run-acceptance-http.mjs` runs one repetition per child process, because ten
inside one launcher process aborted with `0xC0000409` partway through the first
and a crash there loses every repetition after it. `oracle-summary.json` and the
run line report `routeRefusals` (the provider refused, so the turn measured
nothing) and `starvedReplies` (the budget ran out before the answer started)
separately from `unreplied`, so a run that failed for a route reason can be told
apart from one that failed for a memory reason.

The evaluator keeps “reply differs” out of its score. Its artifact records the
entire candidate → admission → activation → injection → visible-effect chain and
uses effect-specific checks for name, language, preference, boundary,
continuity and correct silence. `oracle-summary.json` reports rates by arm and
effect; acceptance exits non-zero unless forced Gold reaches 80% for every core
positive effect, normal reaches 70%, and all protected cases remain 100% safe.

## Conventions

**Timestamps** are ISO 8601 strings. The kernel compares them lexicographically,
which is the only time operation it performs; parsing and formatting are the
host's job.

**Scope** is `{service_id, owner_user_id, companion_profile_id}` and deliberately
excludes the agent or model id. A user who switches models must not find that
their companion has forgotten them, so the producing agent is recorded as
`Provenance::agent_id` — metadata, never identity.

**Invariants** are numbered I1–I13 in DESIGN.md §5 and each is pinned by a test
that names it. If a rule is worth writing down it is worth failing a build over.

## Verifying

The kernel has no C dependency and builds anywhere Rust does:

```sh
cargo test -p companion-memory-kernel
cargo clippy -p companion-memory-kernel --all-targets -- -D warnings
```

The storage crate vendors SQLite through `rusqlite`'s `bundled` feature, which
compiles C source. On Windows that needs the MSVC toolchain on `PATH`, and
Visual Studio being *installed* is not enough — `cl.exe` is only visible after
`vcvars64.bat` has run. `scripts/cargo-msvc.ps1` does that in one process and
forwards the cargo arguments:

```sh
.\scripts\cargo-msvc.ps1 -- test -p companion-memory-storage
.\scripts\cargo-msvc.ps1 -- clippy --all-targets -- -D warnings
```

The `--` is required: without it PowerShell tries to bind `-p` to one of its own
parameters.

## Delegating work to Codex

`scripts/codex-task.ps1` drives the Codex CLI directly, because the agent's own
subagent tool cannot select a model or provider, and a DSH subagent provider row
fixes its model per instance behind a profile restart.

```sh
# defaults: gpt-5.6-luna with max reasoning effort
.\scripts\codex-task.ps1 -PromptFile .\scripts\tasks\<task>.md
"a short self-contained task" | .\scripts\codex-task.ps1 -ReadOnly
```

Task briefs written for it live in `scripts/tasks/`.
