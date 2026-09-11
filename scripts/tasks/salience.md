# Task: implement salience, scoring and feedback rules in Rust

You are implementing a new module in the `companion-memory` repository at
`C:\TRAE\Riko-dsh-TencentDB\companion-memory`.

Work only in this repository. Do not touch anything outside it.

Other agents are working in the same crate right now. You may create and edit
these files only:

- `crates/kernel/src/rules/salience.rs` (new)
- `crates/kernel/tests/salience.rs` (new)

Do **not** edit `crates/kernel/src/rules/mod.rs`, `evidence.rs`, `mention_gate.rs`
or `record_identity.rs`; the parent agent wires the module in. Add the tests as a
separate integration test file and reference the module by its full path
(`companion_memory_kernel::rules::salience::...`), which works without the mod.rs
edit only if you are told otherwise — so if the module does not compile because
it is not declared, stop and report that instead of editing `mod.rs`.

## Background: the defect this module fixes

An earlier design used `reinforcement` that increased whenever a record was
recalled and the user did not object. That is a one-way ratchet, and it is wrong,
because **no negative feedback is the default state**. Any record that drifted
into the top-N once got reinforced for being ignored, and after two months the
salience distribution was a path-dependent mirror of early random draws rather
than of what the user actually cared about.

Two rules replace it:

- **I6 — silence is not a reward.** Neutral means *unchanged*. Repeated
  application of no-feedback must leave `importance` bit-for-bit identical
  (idempotent).
- Only *real* signals reinforce. A user saying "you remembered that, it made me
  happy", correcting the record, or voluntarily raising the same thing again.

There is also an architectural rule to respect:

- **I10 — `boundary` is a gate, not a scored item.** A boundary predicate must
  never participate in ranking arithmetic. It is returned as a constraint, and
  the scoring function must refuse it rather than return a small number.

## Read these first

1. `crates/kernel/src/domain/types.rs` — `Salience`, `Claim`, `Episode`,
   `Inference`, `RelationshipScope`, the `*_DAYS` constants.
2. `crates/kernel/src/domain/predicates.rs` — `spec_for`, `Domain`,
   `Sensitivity`, `MentionMode`.
3. `crates/kernel/src/rules/record_identity.rs` and
   `crates/kernel/src/rules/mention_gate.rs` — the established Rust style. Match
   it: `///` docs citing invariant numbers, named enum result types rather than
   booleans, no panics for expected outcomes, no ambient time (the caller passes
   `now` in).

## Deliverables: `crates/kernel/src/rules/salience.rs`

### Feedback

```rust
/// A real signal that a record should be more or less prominent.
pub enum FeedbackSignal {
    /// The user said the companion remembering this was good.
    UserValued,
    /// The user corrected the record.
    UserCorrected,
    /// The user raised the same thing again unprompted.
    UserRaisedAgain,
    /// The user said the companion's way of responding worked.
    ResponseWorked,
    /// The user asked for this not to come up again.
    UserAskedToStop,
    /// Nothing observable happened. Carries no information.
    None,
}

/// Apply one signal, returning the updated projection.
///
/// `FeedbackSignal::None` MUST return the input unchanged.
pub fn apply_feedback(salience: &Salience, signal: FeedbackSignal) -> Salience;
```

Requirements:
- `None` is a bit-for-bit no-op. This is I6 and it is the most important test in
  the module.
- The four positive signals raise `importance`, each by a documented amount, and
  clamp at 1.0. They are not required to differ in magnitude, but say why if they
  do not.
- `UserAskedToStop` sets `do_not_surface: Some(true)`. It does **not** delete the
  record and does **not** lower `importance` to zero — the record stays valid, it
  just never speaks (I7 lives in the mention gate, not here).
- `apply_feedback` never touches `recall_count` or `last_recalled_at`; those are
  written by `record_recall`, because "was shown" and "was valuable" are
  different facts.

```rust
/// Record that a record was surfaced. Returns the updated projection.
pub fn record_recall(salience: &Salience, now: &str) -> Salience;
```

Sets `last_recalled_at = now` and increments `recall_count`. It must **not**
change `importance` — that is the whole point of separating the two.

### Recency

```rust
/// Whole days between two ISO 8601 timestamps, saturating at 0.
///
/// A day-resolution difference is enough for decay; the kernel does not parse
/// calendars beyond `YYYY-MM-DD`.
pub fn days_between(from: &str, to: &str) -> u32;

/// Exponential half-life decay in `(0, 1]`.
pub fn recency_factor(last_seen: &str, now: &str, half_life_days: u32) -> f64;
```

`recency_factor` returns 1.0 when `last_seen == now`, 0.5 after exactly one
half-life, 0.25 after two, and never returns 0 or a negative number. A
`half_life_days` of 0 must not panic or produce NaN — pick a documented,
defensible behaviour and test it.

### Scoring

```rust
pub enum ScoreRejection {
    /// I10: a boundary is an obligation, not a candidate.
    BoundaryIsAConstraint,
}

pub struct ScoreInputs<'a> {
    /// Registry predicate, so the gate can be applied.
    pub predicate: &'a str,
    pub salience: &'a Salience,
    /// Semantic relatedness of the record to the current turn, in `[0, 1]`.
    pub relevance: f64,
    /// Confidence of the record, in `[0, 1]`.
    pub confidence: f64,
    /// ISO 8601 of when the record was last relevant.
    pub last_seen: &'a str,
    /// ISO 8601 now.
    pub now: &'a str,
    /// Half-life in days.
    pub half_life_days: u32,
    /// Whether an authorised trigger names this record.
    pub explicit_trigger: bool,
}

/// Rank a candidate. Boundaries are refused, never scored (I10).
pub fn candidate_score(inputs: &ScoreInputs<'_>) -> Result<f64, ScoreRejection>;
```

The formula is `relevance × importance × recency × confidence`, plus a documented
bonus when `explicit_trigger` is set. Document why it is a product and not a sum:
a record with zero relevance must score zero regardless of how important it is,
which a weighted sum cannot express.

Also provide, for the caller that allocates prompt budget:

```rust
/// Order candidates loudest-first, dropping boundaries and non-scoring records.
pub fn rank<'a>(items: &'a [ScoreInputs<'a>]) -> Vec<(&'a ScoreInputs<'a>, f64)>;
```

### Promotion thresholds

```rust
pub struct PromotionReadiness {
    pub ready: bool,
    pub blocking: Vec<PromotionBlocker>,
}

pub enum PromotionBlocker {
    /// Fewer than MIN_DISTINCT_SESSIONS separate sessions.
    TooFewSessions { have: u32, need: u32 },
    /// The contributions are too close together in time.
    SpanTooShort { have_days: u32, need_days: u32 },
    /// Not enough distinct contexts; repeated aftershocks of one event are one
    /// cause, not several confirmations.
    InsufficientDiversity { have: u32, need: u32 },
    /// Counter-evidence was never looked for.
    CounterExamplesNotChecked,
}

/// Whether the accumulated evidence justifies promoting an inference.
///
/// Independence, not repetition: three consecutive Sundays spent on one deadline
/// are one underlying cause.
pub fn promotion_readiness(audit: &PromotionAudit) -> PromotionReadiness;
```

Use the `MIN_DISTINCT_SESSIONS` and `MIN_TEMPORAL_SPAN_DAYS` constants from
`domain::types`. Pick and document a minimum `context_diversity`; explain the
choice. `CounterExamplesNotChecked` blocks promotion when
`counter_examples_checked == 0` — a promotion that never looked for a
counter-example is exactly how a stereotype gets manufactured.

## Tests: `crates/kernel/tests/salience.rs`

Cover at minimum:
- **I6**: `apply_feedback` with `FeedbackSignal::None` returns a projection equal
  to the input for a spread of starting values including `importance` 0.0, 0.5
  and 1.0; and applying it ten times in a row is still identical (idempotence)
- each positive signal raises importance and clamps at 1.0
- `UserAskedToStop` sets the flag and leaves `importance` untouched
- `record_recall` increments the count and stamps the time but leaves
  `importance` alone
- `days_between` handles equal timestamps, reversed order (saturating at 0), and
  multi-day gaps
- `recency_factor` gives 1.0 for the same instant, 0.5 at one half-life, ~0.25 at
  two, and stays in `(0, 1]` across a wide range including a very old timestamp
- `candidate_score` returns `Err(BoundaryIsAConstraint)` for
  `boundary.topic_avoid` and for an unregistered `boundary.whatever`, and `Ok`
  for `identity.name`
- zero relevance scores zero no matter how large importance is
- `explicit_trigger` raises the score above the same input without it
- `rank` drops boundaries and is sorted loudest-first
- `promotion_readiness` is not ready for each blocker in turn, is ready when all
  thresholds are met, and reports *every* blocker rather than only the first

## Verify before reporting

From the repository root:

```
cargo test -p companion-memory-kernel
cargo clippy -p companion-memory-kernel --all-targets -- -D warnings
```

Both must pass. The crate denies `missing_docs` so every public item needs a doc
comment, and the declared MSRV is 1.75 (`Cargo.toml`) so avoid APIs stabilized
after that. If you believe a requirement above is wrong, implement it as
specified and report the disagreement rather than silently changing behaviour.
