# Task: implement forgetting in Rust — suppression sets, content scan, derived recompute

You are implementing a new module in the `companion-memory` repository at
`C:\TRAE\Riko-dsh-TencentDB\companion-memory`.

Work only in this repository. Do not touch anything outside it.

Other agents may be working in the same crate. You may create and edit only:

- `crates/kernel/src/rules/forgetting.rs` (new)
- `crates/kernel/tests/forgetting.rs` (new)

Do **not** edit `crates/kernel/src/rules/mod.rs` or any sibling module; the
parent agent wires the module in. Reference your module by its full path
(`companion_memory_kernel::rules::forgetting::...`) in tests. If it does not
compile because it is not declared, stop and report that rather than editing
`mod.rs`.

## Why this module exists

Forgetting in this system is **not** entity-level cascade deletion. It is a
suppression set plus derived recomputation, for three reasons:

1. A cascade delete has to visit every layer and always eventually misses one.
2. Deleted rows are indistinguishable from never-written ones, so a re-extraction
   of the same conversation silently resurrects the memory.
3. Derived records are the resurrection vector that deletion misses entirely: an
   inference that was computed *from* forgotten evidence keeps asserting it, in
   the model's own words, after the original is gone.

So the model is: suppress an evidence set, let readers ignore suppressed
evidence, and let every derived record that depended on it recompute.

This module owns the parts that are decidable without a model: normalising a
forget target, fingerprint matching, and deciding what happens to a derived
record when its evidence collapses. The host owns actually applying the result.

## Read these first

1. `crates/kernel/src/rules/evidence.rs` — `EvidenceResolution`, `live_evidence`,
   `is_collapsed`, and the existing `suppressed: HashSet<String>`. Your module
   extends this idea rather than replacing it; do not duplicate those functions.
2. `crates/kernel/src/domain/types.rs` — `Claim`, `Episode`, `Inference`,
   `EvidenceRef`, `EvidenceSourceType`, `InferenceState`.
3. `crates/kernel/src/rules/record_identity.rs` — `normalize_for_comparison`,
   `canonical_json`. Reuse these rather than writing a second normaliser.
4. `crates/kernel/src/rules/mention_gate.rs` — the established Rust style. Match
   it: `///` docs citing invariant numbers, named enum result types rather than
   booleans, no panics for expected outcomes, no ambient time.

## Deliverables: `crates/kernel/src/rules/forgetting.rs`

### Resolving what the user asked to forget

A user says "forget that", "forget everything about my ex", "forget last night".
The parser is the host's job; deciding what a resolved target *means* is this
module's job.

```rust
/// What the user asked to forget, after the host has resolved their words.
pub enum ForgetTarget {
    /// Named records and messages.
    Records { source_ids: Vec<String> },
    /// Every record carrying one predicate, e.g. all of `identity.location`.
    Predicate { predicate: String },
    /// Every record naming one entity.
    Entity { entity_ref: String },
    /// Everything, for a profile reset.
    All,
}

/// A suppression set, plus why each id is in it, for the audit trail.
#[derive(Debug, Default, Clone)]
pub struct SuppressionSet {
    /// Ids no reader may use, across every layer.
    pub suppressed: HashSet<String>,
    /// Predicate keys whose records are withheld, for the `Predicate` target.
    pub suppressed_predicates: HashSet<String>,
    /// Entity references whose records are withheld, for the `Entity` target.
    pub suppressed_entities: HashSet<String>,
    /// Whether everything is withheld.
    pub all: bool,
}

impl SuppressionSet {
    /// Whether one record is withheld.
    pub fn suppresses_claim(&self, claim: &Claim) -> bool;
    /// Whether one episode is withheld.
    pub fn suppresses_episode(&self, episode: &Episode) -> bool;
    /// Whether one inference is withheld outright, ignoring its evidence.
    pub fn suppresses_inference(&self, inference: &Inference) -> bool;
    /// Whether one evidence reference is withheld.
    pub fn suppresses_ref(&self, reference: &EvidenceRef) -> bool;
}
```

### Fingerprints

A forgotten sentence can survive inside a *different* record's text — an
episode narrative that quotes it, an inference that paraphrases it. Exact
matching catches the quoted case; nothing catches paraphrase without a model,
and this module must not pretend otherwise.

```rust
/// A normalised fingerprint of record text, for exact-match scanning.
pub fn fingerprint(text: &str) -> String;

/// A record whose text still contains a suppressed fingerprint exactly.
pub struct ExactResidue<'a> {
    pub source_type: EvidenceSourceType,
    pub source_id: &'a str,
    pub matched_id: &'a str,
}

/// Find surviving records whose text still contains a suppressed fingerprint.
pub fn find_exact_residue<'a>(
    suppressed_fingerprints: &HashMap<String, String>,
    candidates: &'a [TextCandidate<'a>],
) -> Vec<ExactResidue<'a>>;

pub struct TextCandidate<'a> {
    pub source_type: EvidenceSourceType,
    pub source_id: &'a str,
    pub text: &'a str,
}
```

`fingerprint` must be built on `normalize_for_comparison` so the same text
written twice yields the same fingerprint. Document that it is exact-match by
design: a token-overlap heuristic would flag unrelated records that merely share
vocabulary, and silently deleting those is worse than missing a paraphrase.

### Near matches are reported, never auto-deleted

```rust
/// A record that partly overlaps a suppressed fingerprint.
pub struct SuspectedResidue<'a> {
    pub source_type: EvidenceSourceType,
    pub source_id: &'a str,
    /// Jaccard similarity over the two texts' tokens, for triage order.
    pub similarity: f64,
}

/// Report candidates that may paraphrase suppressed content, loudest first.
///
/// These are **reported for review, never deleted automatically.** A paraphrase
/// detector with no model behind it is a guess, and deleting a guess destroys
/// unrelated memory.
pub fn find_suspected_residue<'a>(
    suppressed_fingerprints: &HashMap<String, String>,
    candidates: &'a [TextCandidate<'a>],
    min_similarity: f64,
) -> Vec<SuspectedResidue<'a>>;
```

Tokenisation must not require a word-segmentation dependency. For a run of
non-ASCII characters, use overlapping bigrams; for ASCII, split on
non-alphanumeric. Document the choice.

### What happens to a derived record when evidence collapses

```rust
/// The disposition of one inference after its evidence was recomputed.
pub enum DerivedDisposition {
    /// Nothing changed; evidence still supports it.
    Unchanged,
    /// Some support was suppressed but enough remains; confidence drops.
    Weakened { new_confidence: f64, removed_support: usize },
    /// No support remains. The record is invalid; the caller must not delete it
    /// silently but must stop using it (I5).
    Collapsed,
    /// The record itself, or all of its evidence, was directly suppressed.
    Withheld,
}

/// Decide what becomes of one inference once a suppression set is applied.
///
/// `recompute_confidence` is the host's re-derivation from the surviving
/// evidence; the kernel decides the disposition, not the new truth.
pub fn derived_disposition(
    inference: &Inference,
    suppression: &SuppressionSet,
    resolution: &EvidenceResolution,
    recompute_confidence: impl Fn(&Inference, &[&EvidenceRef]) -> f64,
) -> DerivedDisposition;
```

Rules:
- `Withheld` when `suppression.suppresses_inference(inference)` is true.
- `Collapsed` when the surviving support set is empty. This must agree with
  `evidence::is_collapsed` semantics (I5) — call it rather than reimplementing.
- `Weakened` when support was removed but remains; `new_confidence` comes from
  `recompute_confidence`, clamped to `[0, 1]`, and must never exceed the old
  confidence. Losing evidence must never increase certainty.
- `Unchanged` otherwise.

### Resurrection guard

```rust
/// Whether a freshly proposed record would reintroduce forgotten content.
///
/// Every write path must call this (I4). Suppression that only filters reads
/// leaves the next extraction free to write the same fact again, which is the
/// failure the fingerprint exists to prevent.
pub fn would_resurrect(
    predicate: &str,
    value: &serde_json::Value,
    entity_ref: Option<&str>,
    suppression: &SuppressionSet,
    suppressed_fingerprints: &HashMap<String, String>,
) -> Option<ResurrectionReason>;

pub enum ResurrectionReason {
    /// A suppressed predicate.
    PredicateSuppressed { predicate: String },
    /// A suppressed entity.
    EntitySuppressed { entity_ref: String },
    /// Everything is suppressed.
    AllSuppressed,
    /// The value's fingerprint matches forgotten content.
    FingerprintMatch { matched_id: String },
}
```

## Tests: `crates/kernel/tests/forgetting.rs`

Cover at minimum:
- `SuppressionSet` with `All` suppresses every claim, episode and inference
- `Predicate` suppresses a matching claim but not one under another predicate
- `Entity` suppresses a claim carrying that entity reference, and does not
  suppress a claim with no entity reference
- `Records` suppresses exactly the named ids
- `fingerprint` is stable across whitespace and case differences, and differs
  for genuinely different text
- `find_exact_residue` finds a record that still contains forgotten text, and
  returns nothing for unrelated text
- `find_suspected_residue` reports a paraphrase above the threshold, never
  reports below it, and returns results ordered loudest-first
- `derived_disposition` returns `Unchanged` for untouched evidence,
  `Weakened` with `new_confidence <= old` when part is suppressed, `Collapsed`
  when all support is suppressed, and `Withheld` when the record itself is
- **losing evidence never raises confidence**: for a recompute closure that
  returns a higher number, the result is still clamped at the old confidence
- `would_resurrect` fires for each of the four reasons, and returns `None` for a
  value that was never forgotten
- I4 round trip: suppress a value, then confirm `would_resurrect` refuses to let
  the identical value be written again

## Verify before reporting

From the repository root:

```
cargo test -p companion-memory-kernel
cargo clippy -p companion-memory-kernel --all-targets -- -D warnings
```

Both must pass. The crate denies `missing_docs` so every public item needs a doc
comment, and the declared MSRV is 1.75 (`Cargo.toml`) so avoid APIs stabilized
after that — in particular `Option::is_none_or` (1.82) and `HashSet::extract_if`
are unavailable. If you believe a requirement above is wrong, implement it as
specified and report the disagreement rather than silently changing behaviour.
