# Task: port the mention gate to Rust

You are porting one already-designed module from a verified TypeScript prototype
to Rust, inside the `companion-memory` repository at
`C:\TRAE\Riko-dsh-TencentDB\companion-memory`.

Work only in this repository. Do not touch anything outside it.

## Why this module exists (read this, it is the whole point)

Ranking answers "what matters". It does not answer "should this be said right
now". Perfect ranking still puts "the night the dog was sick" in front of a user
who spent Friday evening trying to think about something lighter. So disclosure
is a decision separate from relevance, it applies to all three memory layers, and
it is **monotone**: gates and record-level flags may only ever make a record
quieter, never louder. A record's own mode is a ceiling, never a grant.

## Read these first — they are the specification

1. `packages/kernel/src/rules/mention-gate.ts` — the verified TypeScript
   implementation you are porting. Its structure, ordering and JSDoc reasoning
   are the specification. Port the behaviour, not the syntax.
2. `crates/kernel/src/domain/predicates.rs` — Rust registry. You need
   `mention_policy_for(key) -> MentionMode` and the `MentionMode` enum.
3. `crates/kernel/src/domain/types.rs` — `Claim`, `Inference`,
   `InferenceState`, `InferenceAxis`, `Salience`.
4. `crates/kernel/src/rules/record_identity.rs` — the established Rust style for
   this codebase. Match it: `///` docs citing invariant numbers, named enum
   result types instead of booleans, no panics for expected outcomes.

## Deliverables

1. `crates/kernel/src/rules/mention_gate.rs` — the ported module.
2. `crates/kernel/src/rules/mod.rs` — add `pub mod mention_gate;` keeping the
   existing content and its doc comment.
3. Tests. Put them in `crates/kernel/tests/mention_gate.rs` (the repo keeps
   integration tests under `tests/`, one file per module).

## Required API (Rust naming; keep the semantics exactly)

```rust
pub enum SurfaceLevel { NeverSurface, BackgroundOnly, MentionIfUserCues, FreelyMentionable }
```
Ordered quietest-to-loudest (derive `PartialOrd, Ord` with variants in that
order, or expose a `level() -> u8`). Note `MentionMode` in `predicates.rs` is
already ordered this way — reuse that ordering rather than inventing a second
one, and expose whatever conversion you need.

```rust
#[derive(Default)]
pub struct MentionCues {
    pub user_referenced: bool,
    pub topic_implies: bool,
    pub time_trigger_authorised: bool,
    pub shared_term_in_user_turn: bool,
}

pub enum GateDenial {
    BoundaryIsAConstraint,   // reserved for callers; see note below
    DoNotSurface,
    NeverSurface,
    InferenceNotActive,
    UsesUnlicensedSharedTerm,
    AwaitingUserCue,
    TimeTriggerNotAuthorised,
    NoCue,
}

pub enum MentionDecision {
    Allowed { level: SurfaceLevel, background_only: bool },
    Denied { reason: GateDenial, level: SurfaceLevel },
}

pub struct MentionInput<'a> {
    pub predicate: Option<&'a str>,
    pub record_mode: Option<MentionMode>,
    pub do_not_surface: Option<bool>,
    pub shared_world_term: bool,
    pub cues: MentionCues,
}

pub fn effective_surface_level(input: &MentionInput<'_>) -> SurfaceLevel;
pub fn mention_gate(input: &MentionInput<'_>) -> MentionDecision;
pub fn claim_mention(claim: &Claim, cues: MentionCues) -> MentionDecision;
pub fn inference_mention(inference: &Inference, cues: MentionCues) -> MentionDecision;
pub fn is_constraint(predicate: Option<&str>) -> bool;
```

## Behavioural requirements (these are the numbered invariants)

- **Monotonicity.** `effective_surface_level` is the minimum over: the
  predicate's `mention_policy`, the record's own `record_mode`, and the flags. A
  record can never raise itself above its predicate's policy. Start from the
  loudest level (`FreelyMentionable`) and take minimums.
- **I7 `do_not_surface`.** Its `Some(true)` forces `NeverSurface` and the denial
  reason must be `DoNotSurface` (distinct from `NeverSurface`, so diagnostics and
  the UI can explain the silence).
- **I13.** Nothing below `FreelyMentionable` volunteers itself:
  - `NeverSurface` → denied.
  - `BackgroundOnly` → **allowed** with `background_only: true`. This is the
    important case: the record may shape tone and word choice but must not be
    recited. It is allowed, not denied.
  - `MentionIfUserCues` → allowed only when `user_referenced || topic_implies`;
    otherwise denied `AwaitingUserCue`.
  - `FreelyMentionable` → allowed, except a `shared_world_term` also requires
    `shared_term_in_user_turn`, else denied `UsesUnlicensedSharedTerm`.
- **Time triggers need prior authorisation.** When `time_trigger_authorised` is
  true and neither `user_referenced` nor `topic_implies` is set, the record is
  allowed (it is a licence the user granted). When a time trigger is *not*
  authorised there is no special path — the ordinary cue rules apply, so an
  unauthorised reminder lands in `AwaitingUserCue`. The `TimeTriggerNotAuthorised`
  denial exists for a caller that explicitly attempts one; use it when
  `time_trigger_authorised` is false and the caller marked the attempt (add a
  field `time_trigger_attempted: bool` to `MentionCues` for this, defaulting to
  false, and deny with `TimeTriggerNotAuthorised` when it is true but
  unauthorised).
- **`inference_mention`.** Any state other than `InferenceState::Active` denies
  with `InferenceNotActive` — a half-formed impression must not be voiced as if
  settled. For an `InferenceAxis::SharedWorld` inference, set `shared_world_term`.
  Respect `do_not_surface` if present.
- **`is_constraint`.** True for a predicate starting `boundary.`. Boundaries are
  obligations, not candidates (I10): they are always in force, so they never
  compete for prompt budget.

`GateDenial::BoundaryIsAConstraint` is part of the vocabulary for symmetry with
the evidence rules, but `mention_gate` itself does not produce it: a boundary is
already `BackgroundOnly` by policy, so it is allowed as background. Document that
in the module.

## Tests

Cover at minimum:
- monotonicity: a `FreelyMentionable` record with `record_mode: BackgroundOnly`
  resolves to background; a `BackgroundOnly` predicate with
  `record_mode: FreelyMentionable` also resolves to background (the predicate is
  the harder ceiling)
- `do_not_surface` forces denial with reason `DoNotSurface`, and that its denial
  survives even when every cue is set and the policy is `FreelyMentionable`
- `BackgroundOnly` is **allowed** and reports `background_only: true`
- `MentionIfUserCues` denies with `AwaitingUserCue` with no cue, and allows with
  `user_referenced` alone and with `topic_implies` alone
- `NeverSurface` always denies
- a shared-world term is denied without `shared_term_in_user_turn` and allowed
  with it
- an authorised time trigger with no other cue is allowed
- a `time_trigger_attempted` but unauthorised trigger denies with
  `TimeTriggerNotAuthorised` — and the same attempt *with* authorisation succeeds
- `inference_mention` denies for `Accumulating`, `Rejected` and `Expired`, allows
  for `Active`
- `shared_world_term` is set automatically for a `SharedWorld` inference
- `is_constraint` is true for `boundary.topic_avoid`, false for
  `identity.name` and for `None`
- a real boundary predicate from the registry is `BackgroundOnly` and therefore
  allowed-as-background, not denied

Write a small helper in the test file to build a `Claim` and an `Inference`
without repeating every field, the way `tests/record_identity.rs` does.

## Verify before reporting

From the repository root:

```
cargo test -p companion-memory-kernel
cargo clippy -p companion-memory-kernel --all-targets -- -D warnings
```

Both must pass. The crate denies `missing_docs`, so every public item needs a
doc comment. If you believe any requirement above is wrong, implement it as
specified and report the disagreement — do not silently change the behaviour.
