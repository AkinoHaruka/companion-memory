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
crates/kernel/        Rust — the decision logic, and the implementation
                      No I/O, no model, no host dependency, no ambient time.
packages/dsh-plugin/  DeepSeek Harness adapter (not yet written)
scripts/              Tooling, including the Codex delegation helper.
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
| Inference lifecycle (confidence cap, review) | in progress |
| RuntimeState wiring | not started |
| Storage and migration | not started |
| DSH plugin | not started |

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

```sh
cargo test -p companion-memory-kernel
cargo clippy -p companion-memory-kernel --all-targets -- -D warnings

pnpm install
pnpm -r test
```

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
