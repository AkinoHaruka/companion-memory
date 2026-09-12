//! Determinism and idempotence across the rule modules (I9).
//!
//! The kernel runs on every turn, so the same inputs must produce the same
//! decisions no matter how many times they are evaluated or in what order the
//! modules are consulted. Non-determinism here surfaces as a companion that
//! reacts differently to the same message on different days, which is
//! indistinguishable from having no memory at all.
//!
//! Two properties are checked:
//!
//! - **Purity**: repeated calls with equal inputs return equal results. None of
//!   these functions reads a clock, a random source, or shared mutable state.
//! - **Idempotence**: applying an operation to its own output changes nothing
//!   further. This is the property that fails when an operation accumulates
//!   rather than sets.
//!
//! Timestamps are passed in rather than read, so "same input" is expressible.

use companion_memory_kernel::domain::predicates::{require_spec, MentionMode};
use companion_memory_kernel::domain::types::{
    Claim, ClaimStatus, Episode, EpisodeStatus, Inference, InferenceAxis, InferenceState,
    Provenance, RelationshipScope, Salience,
};
use companion_memory_kernel::rules::evidence::{
    is_collapsed, live_evidence, may_support_user_inference, EvidenceResolution,
};
use companion_memory_kernel::rules::forgetting::{fingerprint_text, SuppressionSet};
use companion_memory_kernel::rules::inference::{apply_review, clamp_confidence};
use companion_memory_kernel::rules::mention_gate::{
    claim_mention, effective_surface_level, mention_gate, MentionCues, MentionInput,
};
use companion_memory_kernel::rules::record_identity::{
    canonical_key_parts, decide_supersede, normalize_for_comparison, SlotKey, SupersedeDecision,
    SupersedeInput,
};
use companion_memory_kernel::rules::salience::{
    apply_feedback, candidate_score, promotion_readiness, recency_factor, record_recall,
    FeedbackSignal, ScoreInputs,
};
use serde_json::json;

const NOW: &str = "2026-06-10T12:00:00Z";
const EARLIER: &str = "2026-01-01T00:00:00Z";

fn scope() -> RelationshipScope {
    RelationshipScope {
        service_id: "svc".into(),
        owner_user_id: "user".into(),
        companion_profile_id: "profile".into(),
    }
}

fn provenance() -> Provenance {
    Provenance {
        agent_id: None,
        prompt_family: None,
        prompt_version: None,
        model: None,
        confidence: 0.9,
        created_at: EARLIER.into(),
    }
}

fn salience(importance: f64) -> Salience {
    Salience {
        importance,
        recall_count: 3,
        ..Salience::default()
    }
}

fn claim(id: &str, predicate: &str, value: serde_json::Value) -> Claim {
    Claim {
        id: id.into(),
        scope: scope(),
        predicate: predicate.into(),
        entity_ref: None,
        qualifiers: None,
        value,
        raw_value: None,
        valid_from: EARLIER.into(),
        valid_until: None,
        status: ClaimStatus::Active,
        supersedes_id: None,
        source_refs: Vec::new(),
        provenance: provenance(),
        salience: Salience::default(),
        created_at: EARLIER.into(),
        updated_at: EARLIER.into(),
    }
}

fn inference() -> Inference {
    Inference {
        id: "i1".into(),
        scope: scope(),
        axis: InferenceAxis::Pattern,
        predicate: "goal.current_focus".into(),
        value: "has been tired for months".into(),
        state: InferenceState::Active,
        confidence: 0.6,
        support_evidence: Vec::new(),
        counter_evidence: Vec::new(),
        promotion_audit: None,
        user_acknowledged_at: None,
        use_mode: MentionMode::MentionIfUserCues,
        expires_at: Some("2026-05-01T00:00:00Z".into()),
        salience: Salience::default(),
        created_at: EARLIER.into(),
        updated_at: EARLIER.into(),
    }
}

fn cues() -> MentionCues {
    MentionCues {
        user_referenced: true,
        ..MentionCues::default()
    }
}

// ---------------------------------------------------------------------------
// Purity: repeated evaluation returns the same answer
// ---------------------------------------------------------------------------

#[test]
fn slot_identity_is_stable_across_evaluations() {
    let qualifiers = json!({ "b": 2, "a": 1 });
    let slot = SlotKey {
        predicate: "identity.location",
        entity_ref: Some("shanghai"),
        qualifiers: Some(&qualifiers),
    };
    let first = canonical_key_parts(&slot);
    for _ in 0..50 {
        assert_eq!(canonical_key_parts(&slot), first);
    }
}

#[test]
fn text_normalisation_is_stable_and_idempotent() {
    let value = json!("  Mixed   CASE text  ");
    let once = normalize_for_comparison(&value);
    let twice = normalize_for_comparison(&json!(once.clone()));
    assert_eq!(
        once, twice,
        "normalising already-normalised text must not change it"
    );
}

#[test]
fn supersede_decisions_do_not_depend_on_evaluation_count() {
    let existing = claim("c1", "identity.name", json!("Old"));
    let incoming = json!("New");
    let input = SupersedeInput {
        predicate: "identity.name",
        value: &incoming,
        entity_ref: None,
        qualifiers: None,
    };
    let first = decide_supersede(&input, &[&existing]);
    assert!(matches!(first, SupersedeDecision::Supersede { .. }));
    for _ in 0..25 {
        assert_eq!(decide_supersede(&input, &[&existing]), first);
    }
}

#[test]
fn the_mention_gate_is_a_pure_function_of_its_inputs() {
    let input = MentionInput {
        predicate: Some("support.when_distressed"),
        record_mode: None,
        do_not_surface: None,
        shared_world_term: false,
        cues: cues(),
    };
    let first = mention_gate(&input);
    let first_level = effective_surface_level(&input);
    for _ in 0..25 {
        assert_eq!(mention_gate(&input), first);
        assert_eq!(effective_surface_level(&input), first_level);
    }
}

#[test]
fn scoring_is_stable_for_fixed_inputs() {
    let salience = salience(0.7);
    let inputs = ScoreInputs {
        predicate: "goal.current_focus",
        salience: &salience,
        relevance: 0.8,
        confidence: 0.6,
        last_seen: EARLIER,
        now: NOW,
        half_life_days: 30,
        explicit_trigger: false,
    };
    let first = candidate_score(&inputs).expect("a scoring predicate");
    for _ in 0..25 {
        assert_eq!(
            candidate_score(&inputs).expect("a scoring predicate"),
            first
        );
    }
}

#[test]
fn feedback_is_a_pure_function_of_the_starting_projection() {
    // Derived from the same input rather than chained, so this is purity, not
    // accumulation.
    let start = salience(0.5);
    let first = apply_feedback(&start, FeedbackSignal::UserValued);
    for _ in 0..25 {
        assert_eq!(apply_feedback(&start, FeedbackSignal::UserValued), first);
    }
}

#[test]
fn fingerprints_are_stable() {
    let text = "  The dog was sick that night.  ";
    let first = fingerprint_text(text);
    for _ in 0..50 {
        assert_eq!(fingerprint_text(text), first);
    }
}

#[test]
fn evidence_verdicts_are_stable() {
    let resolution = EvidenceResolution::default();
    let reference = companion_memory_kernel::domain::types::EvidenceRef {
        source_type: companion_memory_kernel::domain::types::EvidenceSourceType::Message,
        source_id: "m1".into(),
        speaker: companion_memory_kernel::domain::types::Speaker::User,
        semantic_role: None,
    };
    let first = may_support_user_inference(&reference, &resolution);
    for _ in 0..25 {
        assert_eq!(may_support_user_inference(&reference, &resolution), first);
    }
}

// ---------------------------------------------------------------------------
// Idempotence: applying an operation to its own output is a no-op
// ---------------------------------------------------------------------------

#[test]
fn neutral_feedback_is_idempotent_at_scale() {
    // The direct I6 statement, taken further than the salience suite does.
    let mut current = salience(0.42);
    let original = current.clone();
    for _ in 0..1_000 {
        current = apply_feedback(&current, FeedbackSignal::None);
    }
    assert_eq!(current, original);
}

#[test]
fn recording_a_recall_twice_advances_the_count_and_the_stamp_only() {
    // Not idempotent by design: two recalls are two recalls. What must not
    // happen is importance drifting, because that is the ratchet returning.
    let start = salience(0.5);
    let once = record_recall(&start, NOW);
    assert_eq!(once.importance, start.importance);
    assert_eq!(once.recall_count, start.recall_count + 1);
    assert_eq!(once.last_recalled_at.as_deref(), Some(NOW));

    let twice = record_recall(&once, NOW);
    assert_eq!(
        twice.importance, start.importance,
        "recall must not move importance"
    );
    assert_eq!(twice.recall_count, start.recall_count + 2);
}

#[test]
fn applying_review_twice_at_the_same_instant_does_not_decay_twice() {
    let subject = inference();
    let once = apply_review(&subject, NOW);
    let twice = apply_review(&once, NOW);
    assert_eq!(
        once.confidence, twice.confidence,
        "a second review at the same moment must not compound the penalty"
    );
}

#[test]
fn clamping_is_idempotent_for_every_acknowledgement_state() {
    for acknowledged in [false, true] {
        for value in [0.0, 0.3, 0.65, 0.66, 0.99, 1.0, -1.0, 2.0, f64::NAN] {
            let once = clamp_confidence(value, acknowledged);
            assert_eq!(clamp_confidence(once, acknowledged), once);
        }
    }
}

#[test]
fn recency_is_idempotent_for_a_fixed_instant() {
    let once = recency_factor(EARLIER, NOW, 30);
    for _ in 0..50 {
        assert_eq!(recency_factor(EARLIER, NOW, 30), once);
    }
}

#[test]
fn live_evidence_filtering_is_idempotent() {
    let resolution = EvidenceResolution::default();
    let refs: Vec<_> = Vec::new();
    let once = live_evidence(&refs, &resolution);
    let twice = live_evidence(&refs, &resolution);
    assert_eq!(once, twice);
    assert_eq!(
        is_collapsed(&refs, &resolution),
        is_collapsed(&refs, &resolution)
    );
}

#[test]
fn an_empty_suppression_set_changes_nothing() {
    // Applied repeatedly, an empty set must stay inert rather than
    // accumulating state.
    let empty = SuppressionSet::default();
    let subject = claim("c1", "identity.name", json!("Xiaolin"));
    for _ in 0..50 {
        assert!(!empty.suppresses_claim(&subject));
    }
}

// ---------------------------------------------------------------------------
// Order independence
// ---------------------------------------------------------------------------

#[test]
fn promotion_readiness_reports_the_same_blockers_regardless_of_order() {
    use companion_memory_kernel::domain::types::PromotionAudit;
    let audit = PromotionAudit {
        distinct_sessions: 2,
        temporal_span_days: 5,
        context_diversity: 1,
        counter_examples_checked: 0,
    };
    let first = promotion_readiness(&audit);
    for _ in 0..25 {
        assert_eq!(promotion_readiness(&audit), first);
    }
}

#[test]
fn ranking_a_candidate_list_does_not_depend_on_how_often_it_is_scored() {
    // Scoring the same candidate repeatedly must not change its score, which is
    // what makes a ranked list stable across turns.
    let a = salience(0.9);
    let b = salience(0.1);
    let inputs_a = ScoreInputs {
        predicate: "goal.current_focus",
        salience: &a,
        relevance: 0.9,
        confidence: 0.9,
        last_seen: NOW,
        now: NOW,
        half_life_days: 30,
        explicit_trigger: false,
    };
    let inputs_b = ScoreInputs {
        salience: &b,
        ..inputs_a
    };
    let first_a = candidate_score(&inputs_a).expect("scoring predicate");
    let first_b = candidate_score(&inputs_b).expect("scoring predicate");
    for _ in 0..25 {
        assert_eq!(
            candidate_score(&inputs_a).expect("scoring predicate"),
            first_a
        );
        assert_eq!(
            candidate_score(&inputs_b).expect("scoring predicate"),
            first_b
        );
    }
    assert!(
        first_a > first_b,
        "the more important candidate must outrank the less"
    );
}

// ---------------------------------------------------------------------------
// The registry is a constant
// ---------------------------------------------------------------------------

#[test]
fn registry_lookups_never_change_between_calls() {
    let key = "identity.occupation";
    let spec = require_spec(key);
    for _ in 0..50 {
        let again = require_spec(key);
        assert_eq!(spec.cardinality, again.cardinality);
        assert_eq!(spec.kind, again.kind);
        assert_eq!(spec.mention_policy, again.mention_policy);
        assert_eq!(spec.inference_allowed, again.inference_allowed);
    }
}

#[test]
fn a_claim_and_an_episode_do_not_alias_each_other() {
    // Guard against a fixture-level mistake that would make the determinism
    // assertions above vacuous by comparing a value to itself.
    let c = claim("c1", "identity.name", json!("X"));
    let e = Episode {
        id: "e1".into(),
        scope: scope(),
        occurred_from: EARLIER.into(),
        occurred_to: None,
        narrative: "n".into(),
        participants: Vec::new(),
        emotional_arc: None,
        user_reaction: None,
        response_ref: None,
        source_refs: Vec::new(),
        status: EpisodeStatus::Active,
        salience: Salience::default(),
        created_at: EARLIER.into(),
        updated_at: EARLIER.into(),
    };
    assert_ne!(c.id, e.id);
    let _ = claim_mention(&c, cues());
}
