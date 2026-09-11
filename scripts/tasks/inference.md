# Task: implement the inference lifecycle rules in Rust

You are implementing a new module in the `companion-memory` repository at
`C:\TRAE\Riko-dsh-TencentDB\companion-memory`.

Work only in this repository. Do not touch anything outside it.

Other agents may be working in the same crate. You may create and edit only:

- `crates/kernel/src/rules/inference.rs` (new)
- `crates/kernel/tests/inference.rs` (new)

Do **not** edit `crates/kernel/src/rules/mod.rs` or any sibling module; the
parent agent wires the module in. Reference your module by its full path
(`companion_memory_kernel::rules::inference::...`) in tests. If it does not
compile because it is not declared, stop and report that rather than editing
`mod.rs`.

## Why this module exists

An inference is a model's belief about the user. Two things must be true before
that belief is allowed to feel settled, and neither is about how confident the
model happens to be:

- **I11 — an unacknowledged inference is capped at 0.65.** A model's own
  observation must never reach the certainty of a stated fact. The user
  confirming it is what unlocks the higher range, and that has to be a real
  event the kernel can see, not a number the model reports.
- **I12 — a `pattern` inference must be reviewed.** Behavioural regularities are
  the most stereotype-shaped belief in the system: "he is usually low on Sunday
  evenings" is one bad inference away from becoming how the companion treats
  every Sunday forever. A pattern that has outlived its review window without
  fresh evidence loses confidence automatically rather than persisting because
  nobody revisited it.

The module also owns the few legal transitions between inference states, so that
a record cannot be moved from `Rejected` back to `Active` by a later extraction
without the user's involvement.

## Read these first

1. `crates/kernel/src/domain/types.rs` — `Inference`, `InferenceState`,
   `InferenceAxis`, `PromotionAudit`, and the constants
   `UNACKNOWLEDGED_CONFIDENCE_CAP`, `PATTERN_REVIEW_DAYS`.
2. `crates/kernel/src/rules/salience.rs` — `promotion_readiness`,
   `PromotionAudit` thresholds. Promotion **readiness** is already decided there;
   this module consumes that decision rather than re-deriving it.
3. `crates/kernel/src/rules/evidence.rs` — `EvidenceResolution`, `is_collapsed`.
4. `crates/kernel/src/rules/mention_gate.rs` — the established Rust style. Match
   it: `///` docs citing invariant numbers, named enum result types rather than
   booleans, no panics for expected outcomes, no ambient time (the caller passes
   `now` in).

## Deliverables: `crates/kernel/src/rules/inference.rs`

### Confidence clamping

```rust
/// Clamp a confidence to the range its acknowledgement state allows.
///
/// An acknowledged inference may reach 1.0; an unacknowledged one is capped at
/// UNACKNOWLEDGED_CONFIDENCE_CAP (I11). Values are clamped into [0, 1] first, so
/// a NaN or an out-of-range input cannot escape.
pub fn clamp_confidence(value: f64, acknowledged: bool) -> f64;
```

### Acknowledgement

```rust
/// The user confirmed a belief about themselves.
///
/// This is the only event that lifts the I11 cap, so it must be recorded with
/// the moment it happened, and it is not something a model can assert on the
/// user's behalf.
pub fn acknowledge(inference: &Inference, now: &str) -> Inference;
```

`acknowledge` sets `user_acknowledged_at`, re-clamps the existing confidence so
the record does not jump to certainty merely by being acknowledged, and leaves
everything else untouched. Document that acknowledgement permits a higher
confidence; it does not grant one.

### State transitions

```rust
/// The few legal moves between inference states.
pub enum Transition {
    /// The consolidation pass found enough independent evidence.
    Promote,
    /// The consolidation pass found a reason not to promote yet.
    HoldInAccumulation,
    /// The user rejected the belief.
    Reject { now: String },
    /// The review window elapsed without fresh evidence (I12).
    Expire { now: String },
    /// Fresh evidence arrived for an expired or accumulating belief.
    Revive,
}

pub enum TransitionOutcome {
    /// The transition is legal; the returned record is the new state.
    Applied(Box<Inference>),
    /// The transition is not legal from this state, with the reason.
    Refused(TransitionRefusal),
}

pub enum TransitionRefusal {
    /// A rejected belief may not be revived by the system, only by the user.
    RejectedIsTerminal,
    /// The belief is already in the requested state.
    AlreadyInState,
    /// Promotion requires a passing promotion audit.
    PromotionNotReady,
    /// Confidence would exceed the cap an unacknowledged belief allows.
    ExceedsUnacknowledgedCap,
}

/// Apply one transition, returning the updated record or a refusal.
pub fn apply_transition(
    inference: &Inference,
    transition: Transition,
    promotion_ready: bool,
) -> TransitionOutcome;
```

Rules:
- `Promote` is only legal from `Accumulating`, and only when `promotion_ready`
  is true. Readiness is passed in because `salience::promotion_readiness` already
  decides it; do not re-derive it here.
- `Reject` is terminal. `Revive` from `Rejected` is refused with
  `RejectedIsTerminal` — a belief the user rejected must not come back because a
  later extraction liked it again. This is the same principle as the resurrection
  guard, applied to judgements rather than facts.
- `Expire` is legal from `Accumulating` and `Active`. Apply the I12 confidence
  penalty on expiry — choose and document a reduction, and state why automatic
  review lowers confidence rather than deleting the record.
- Setting `expires_at` on promotion of a `Pattern` is required; compute it from
  `PATTERN_REVIEW_DAYS` and `now`. Do not set it for other axes. `days_between`
  from `salience` is available if you need date arithmetic; the kernel compares
  ISO 8601 strings lexicographically, so adding days needs care — keep it simple
  and document the limitation rather than writing a calendar.

### Review deadline

```rust
/// Whether a pattern inference is past its review window.
///
/// A record with no `expires_at` is never overdue, which is the correct default
/// for axes that do not expire.
pub fn is_review_overdue(inference: &Inference, now: &str) -> bool;

/// Apply the review penalty if the window has passed, otherwise return the
/// record unchanged. This is what makes I12 automatic rather than aspirational.
pub fn apply_review(inference: &Inference, now: &str) -> Inference;
```

### Refusal of unsupported beliefs

```rust
/// Whether an inference may exist at all.
///
/// A model must not record a belief about the user that no admissible evidence
/// supports, and there is a class of judgement that should not become a stored
/// belief at any confidence. Both checks live here so a caller cannot forget
/// one.
pub fn may_hold(
    inference: &Inference,
    resolution: &EvidenceResolution,
) -> Result<(), BeliefRefusal>;

pub enum BeliefRefusal {
    /// No support evidence survived resolution and suppression.
    NoLiveSupport,
    /// Every supporting reference was inadmissible.
    NoAdmissibleSupport,
    /// The predicate declares that inference is not allowed on it (I8).
    PredicateDisallowsInference { predicate: String },
}
```

Use `evidence::live_evidence` and `evidence::may_support_user_inference`; do not
reimplement admissibility.

## Tests: `crates/kernel/tests/inference.rs`

Build minimal fixtures with helpers, the way `tests/record_identity.rs` does.

Cover at minimum:
- **I11**: `clamp_confidence` caps an unacknowledged 0.99 at exactly
  `UNACKNOWLEDGED_CONFIDENCE_CAP`, allows an acknowledged 0.99 through, clamps
  negatives to 0, values above 1 to 1, and NaN to something in `[0, 1]`
- `acknowledge` sets the timestamp, leaves confidence unchanged (it permits, it
  does not grant), and a subsequent clamp now allows more
- `Promote` applies from `Accumulating` when ready, and is refused with
  `PromotionNotReady` when not
- `Promote` from `Active` is refused as `AlreadyInState`
- promoting a `Pattern` sets `expires_at`, and promoting a `Disposition` does not
- `Reject` is terminal and `Revive` from `Rejected` is refused with
  `RejectedIsTerminal`
- `Revive` from `Expired` is legal
- **I12**: `is_review_overdue` is false for a record with no `expires_at`, false
  before the deadline and true after it; `apply_review` lowers confidence once
  the window passes and is a no-op before it
- `apply_review` twice does not lower confidence twice for the same `now` — or if
  it does, that is documented and tested deliberately; state which you chose
- `may_hold` refuses `NoLiveSupport` for empty support, `NoAdmissibleSupport`
  when only assistant-speaker evidence supports it, and
  `PredicateDisallowsInference` for a `boundary.*` predicate
- `may_hold` accepts an ordinary inference supported by a live user claim

## Verify before reporting

From the repository root:

```
cargo test -p companion-memory-kernel
cargo clippy -p companion-memory-kernel --all-targets -- -D warnings
```

Both must pass. The crate denies `missing_docs` — this includes every struct
field inside an enum variant, so annotate those too. The declared MSRV is 1.75
(`Cargo.toml`) so avoid APIs stabilized after that; `Option::is_none_or` (1.82)
and `HashSet::extract_if` are not available. If you believe a requirement above
is wrong, implement it as specified and report the disagreement rather than
silently changing behaviour.
