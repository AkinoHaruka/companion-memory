# Task: port the evidence rules to Rust

You are porting one already-designed module from a verified TypeScript prototype
to Rust, inside the `companion-memory` repository at
`C:\TRAE\Riko-dsh-TencentDB\companion-memory`.

Work only in this repository. Do not touch anything outside it.

## Why this module exists (read this, it is the whole point)

An inference is a model's belief about the user. Three hard rules protect the
user from the model's own output, and all three are enforced here rather than by
convention:

- **I1** — Evidence whose `speaker` is `Assistant` can establish that the
  companion said something, and can support relationship history, but it can
  **never** support an inference about the user. There is no exemption and no
  confidence level that unlocks it. Without this, a model's guess recorded in an
  episode becomes an "observation", which becomes an inference, which is injected
  back into the model, which grows more certain — the model writes its own memory
  through the back door.
- **I8** — A predicate with `inference_allowed: false` cannot contribute evidence
  to an inference. `misc.unclassified` is always disallowed. A `boundary.*` claim
  is a constraint the companion must obey, never evidence about who the user is.
- **I5** — An inference whose support evidence has been entirely suppressed
  becomes invalid automatically; no caller needs to delete it. This is what makes
  forgetting work: the kernel suppresses an evidence set and every derived record
  collapses on read, instead of a cascade delete that can miss one.

## Read these first — they are the specification

1. `packages/kernel/src/rules/evidence.ts` — the verified TypeScript
   implementation you are porting. Its structure, ordering and JSDoc reasoning
   are the specification. Port the behaviour, not the syntax.
2. `crates/kernel/src/domain/types.rs` — `Claim`, `Episode`, `Inference`,
   `EvidenceRef`, `EvidenceSourceType`, `Speaker`, `SemanticRole`.
3. `crates/kernel/src/domain/predicates.rs` — `spec_for`,
   `inference_allowed_for`, `Domain`.
4. `crates/kernel/src/rules/record_identity.rs` and
   `crates/kernel/src/rules/mention_gate.rs` — the established Rust style. Match
   it: `///` docs citing invariant numbers, named enum result types rather than
   booleans, no panics for expected outcomes.

## Deliverables

1. `crates/kernel/src/rules/evidence.rs`
2. `crates/kernel/src/rules/mod.rs` — add `pub mod evidence;` preserving the
   existing content and doc comment.
3. `crates/kernel/tests/evidence.rs`

## Required API

```rust
pub enum EvidenceViolation {
    AssistantSpeaker { reference: EvidenceRef },
    InferenceDisallowed { reference: EvidenceRef, predicate: String },
    BoundaryIsConstraint { reference: EvidenceRef, predicate: String },
    UnknownSource { reference: EvidenceRef },
    SourceTypeMismatch { reference: EvidenceRef, expected: EvidenceSourceType },
    SuppressedSource { reference: EvidenceRef },
    UnresolvedEvidence { reason: SuppressedSourceKind },
}

/// The evidence the caller can resolve. The host owns the message log, so
/// message refs resolve by construction and `suppressed` is the only thing that
/// removes them.
#[derive(Debug, Default, Clone)]
pub struct EvidenceResolution {
    pub claims: HashMap<String, Claim>,
    pub episodes: HashMap<String, Episode>,
    pub suppressed: HashSet<String>,
}

pub fn may_support_user_inference(reference: &EvidenceRef, resolution: &EvidenceResolution) -> Option<EvidenceViolation>;
pub fn verify_inference_evidence(support: &[EvidenceRef], resolution: &EvidenceResolution) -> EvidenceVerdict;
pub fn is_collapsed(support: &[EvidenceRef], resolution: &EvidenceResolution) -> bool;
pub fn live_evidence<'a>(refs: &'a [EvidenceRef], resolution: &EvidenceResolution) -> Vec<&'a EvidenceRef>;
pub fn live_counter_evidence<'a>(counter: &'a [EvidenceRef], resolution: &EvidenceResolution) -> Vec<&'a EvidenceRef>;

pub struct EvidenceVerdict {
    pub valid: bool,
    pub violations: Vec<EvidenceViolation>,
}
```

## Behavioural requirements

**Resolution.** `source_type: Claim` looks up `claims`; `Episode` looks up
`episodes`; `Message` resolves by construction (no map). If a claim ref's id is
present in `episodes` but not `claims`, that is `SourceTypeMismatch` — collapsing
it into `UnknownSource` would hide a real bookkeeping bug.

**`may_support_user_inference`** evaluates in this order and returns the first
violation:
1. `reference.speaker == Speaker::Assistant` → `AssistantSpeaker`
2. source does not resolve → `UnknownSource` (or `SourceTypeMismatch` per above)
3. `resolution.suppressed.contains(&reference.source_id)` → `SuppressedSource`
4. if the source is a claim: predicate domain is `Boundary` → `BoundaryIsConstraint`;
   otherwise predicate `inference_allowed` is false (including
   `misc.unclassified`) → `InferenceDisallowed`

Boundary is checked **before** the generic disallow, because every `boundary.*`
row already has `inference_allowed: false`; the ordering is what makes the
reported reason the specific one. Read the domain via
`spec_for(predicate).map(|s| s.domain)` and fall back to
`split_predicate(predicate)` so an unregistered `boundary.*` key still counts as
a constraint.

**`verify_inference_evidence`** returns **every** violation for every ref, not
one per ref: one assistant ref on a `boundary.topic_avoid` claim yields both
`AssistantSpeaker` and `BoundaryIsConstraint`, and `valid` is false if the list
is non-empty. `may_support_user_inference` stays first-violation-only. Both must
share one ordered rule list so they cannot drift — implement the rules once and
let one take index 0 while the other takes all.

**`is_collapsed`** (I5) is true when there is no support ref at all, or when
every support ref is suppressed or unresolvable.

**`live_evidence` / `live_counter_evidence`** are pure resolution and suppression
filters. They are deliberately **not** admissibility filters: a boundary claim or
an assistant ref can be perfectly live, because counter-evidence may cite what
support evidence may not.

`UnresolvedEvidence` exists for a caller that must distinguish "suppressed" from
"never resolvable"; use `SuppressedSourceKind` (an enum with `Suppressed` and
`Unresolvable`) when you need it, and document when each is returned.

## Tests

Cover at minimum:
- I1: an assistant-speaker ref is rejected **even when** its source claim has
  `inference_allowed: true` and is otherwise perfectly good
- I8: a claim under `boundary.topic_avoid` yields `BoundaryIsConstraint`; a claim
  under `misc.unclassified` yields `InferenceDisallowed`; a claim under
  `identity.occupation` (which has `inference_allowed: true`) passes
- `UnknownSource` for a claim id that is in neither map
- `SourceTypeMismatch` for a claim ref whose id exists only as an episode
- I5: `is_collapsed` true for an empty support slice; true when every support ref
  is suppressed; **false** when at least one support ref is live
- `verify_inference_evidence` returns *all* violations for a support set with two
  different problems, and `valid: false`
- `may_support_user_inference` returns only the first violation for the same input
- `live_evidence` drops suppressed and unresolvable refs and keeps the rest
- `live_counter_evidence` keeps a live user-speaker ref and drops a suppressed one
- a message ref with a user speaker passes `may_support_user_inference`
- an unrecognised `boundary.custom_thing` key is still treated as a constraint

Build minimal fixtures inline with a helper, the way `tests/record_identity.rs`
does.

## Verify before reporting

From the repository root:

```
cargo test -p companion-memory-kernel
cargo clippy -p companion-memory-kernel --all-targets -- -D warnings
```

Both must pass. The crate denies `missing_docs`, so every public item needs a doc
comment. Note the declared MSRV is 1.75 (`Cargo.toml`), so avoid APIs stabilized
after that. If you believe any requirement above is wrong, implement it as
specified and report the disagreement rather than silently changing behaviour.
