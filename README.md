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
packages/dsh-plugin/  DeepSeek Harness adapter (not yet written)
scripts/              Tooling: the Codex delegation helper, the MSVC build wrapper.
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
| Predicate vocabulary + registry (46 predicates) | done |
| Record identity: cardinality, supersede, type compatibility | done |
| Mention gate | done |
| Evidence graph and suppression | done |
| Salience, scoring and promotion thresholds | done |
| Forgetting: suppression, residue scan, derived recompute | done |
| Inference lifecycle (confidence cap, review) | done |
| Storage: schema, migrations, scope-isolated queries | done |
| DSH adapter: rendering, warm cache, tool, config | done |
| DSH adapter: composition test on live services | done |
| Kernel↔store integration: write, recall, supersede, forget | done |
| RuntimeState: storage, adapter interface, rendering, expiry | done |
| DSH adapter: loop-payload adapter and registered handler pair | done |
| Booting a real DSH agent loop to prove invocation order | not started |

Test totals: kernel 110, storage 47, DSH adapter 84.

Two integration suites exist because unit suites pass while a seam is wrong. The
DSH composition test found that a mount given an explicit kernel handed its
pre-step handler nothing, so the plugin rendered empty forever. The kernel↔store
suite found that the two crates disagreed about fingerprint orientation, so the
resurrection guard compared a fingerprint against a human-readable label and
never fired — and that the kernel's own round-trip test had been passing
vacuously, matching on the record id before the fingerprint branch was reached.

RuntimeState is the layer this design replaced a dead one to get. Its type and
table existed for several rounds with nothing reading or writing them, which is
exactly the failure it was meant to fix, so its wiring is asserted end to end: a
condition recorded, recalled, rendered into the prompt with its framing, and
withheld once expired.

The composition tests drive the registered handlers with DSH-shaped payloads, so
the extraction of the current turn from a message batch and the rendering into an
assembled prompt are both exercised. What is still unverified is narrower than
that sentence sounds: no test boots a real agent loop, so nothing here proves the
host invokes pre-step before assembly for the same step, or that a composed
profile loads this plugin at all. Both need a booted profile rather than a
hand-assembled context, and are listed as not started instead of implied.

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
