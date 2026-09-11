//! Integration tests for inference confidence, admissibility and lifecycle.

use std::collections::HashMap;

use companion_memory_kernel::domain::predicates::MentionMode;
use companion_memory_kernel::domain::types::{
    Claim, ClaimStatus, EvidenceRef, EvidenceSourceType, Inference, InferenceAxis, InferenceState,
    Provenance, RelationshipScope, Salience, SemanticRole, Speaker,
};
use companion_memory_kernel::rules::evidence::EvidenceResolution;

const T0: &str = "2026-01-01T00:00:00Z";
const REVIEW_DEADLINE: &str = "2026-04-01T00:00:00Z";

fn scope() -> RelationshipScope {
    RelationshipScope {
        service_id: "svc.test".into(),
        owner_user_id: "user.test".into(),
        companion_profile_id: "companion.test".into(),
    }
}

fn provenance() -> Provenance {
    Provenance {
        agent_id: Some("test-agent".into()),
        prompt_family: None,
        prompt_version: None,
        model: None,
        confidence: 0.9,
        created_at: T0.into(),
    }
}

fn inference(
    axis: InferenceAxis,
    state: InferenceState,
    predicate: &str,
    confidence: f64,
    support_evidence: Vec<EvidenceRef>,
) -> Inference {
    Inference {
        id: "inference-1".into(),
        scope: scope(),
        axis,
        predicate: predicate.into(),
        value: "The user is thoughtful.".into(),
        state,
        confidence,
        support_evidence,
        counter_evidence: Vec::new(),
        promotion_audit: None,
        user_acknowledged_at: None,
        use_mode: MentionMode::MentionIfUserCues,
        expires_at: None,
        salience: Salience::default(),
        created_at: T0.into(),
        updated_at: T0.into(),
    }
}

fn claim(id: &str, predicate: &str) -> Claim {
    Claim {
        id: id.into(),
        scope: scope(),
        predicate: predicate.into(),
        entity_ref: None,
        qualifiers: None,
        value: serde_json::json!("designer"),
        raw_value: None,
        valid_from: T0.into(),
        valid_until: None,
        status: ClaimStatus::Active,
        supersedes_id: None,
        source_refs: Vec::new(),
        provenance: provenance(),
        salience: Salience::default(),
        created_at: T0.into(),
        updated_at: T0.into(),
    }
}

fn claim_ref(id: &str, speaker: Speaker) -> EvidenceRef {
    EvidenceRef {
        source_type: EvidenceSourceType::Claim,
        source_id: id.into(),
        speaker,
        semantic_role: Some(match speaker {
            Speaker::User => SemanticRole::UserAssertion,
            Speaker::Assistant => SemanticRole::AssistantAction,
        }),
    }
}

fn message_ref(id: &str) -> EvidenceRef {
    EvidenceRef {
        source_type: EvidenceSourceType::Message,
        source_id: id.into(),
        speaker: Speaker::User,
        semantic_role: Some(SemanticRole::UserAssertion),
    }
}

fn resolution(claims: Vec<Claim>) -> EvidenceResolution {
    EvidenceResolution {
        claims: claims
            .into_iter()
            .map(|claim| (claim.id.clone(), claim))
            .collect::<HashMap<_, _>>(),
        episodes: HashMap::new(),
        suppressed: Default::default(),
    }
}

fn applied(outcome: companion_memory_kernel::rules::inference::TransitionOutcome) -> Inference {
    match outcome {
        companion_memory_kernel::rules::inference::TransitionOutcome::Applied(inference) => {
            *inference
        }
        companion_memory_kernel::rules::inference::TransitionOutcome::Refused(reason) => {
            panic!("expected transition to apply, got {reason:?}")
        }
    }
}

#[test]
fn i11_clamps_confidence_by_acknowledgement_state() {
    assert_eq!(
        companion_memory_kernel::rules::inference::clamp_confidence(0.99, false),
        companion_memory_kernel::domain::types::UNACKNOWLEDGED_CONFIDENCE_CAP
    );
    assert_eq!(
        companion_memory_kernel::rules::inference::clamp_confidence(0.99, true),
        0.99
    );
    assert_eq!(
        companion_memory_kernel::rules::inference::clamp_confidence(-0.2, true),
        0.0
    );
    assert_eq!(
        companion_memory_kernel::rules::inference::clamp_confidence(1.2, true),
        1.0
    );

    let nan = companion_memory_kernel::rules::inference::clamp_confidence(f64::NAN, true);
    assert!((0.0..=1.0).contains(&nan));
}

#[test]
fn acknowledgement_records_the_event_without_granting_confidence() {
    let original = inference(
        InferenceAxis::Disposition,
        InferenceState::Accumulating,
        "goal.current_focus",
        0.42,
        Vec::new(),
    );
    let acknowledged =
        companion_memory_kernel::rules::inference::acknowledge(&original, "2026-02-01T00:00:00Z");

    assert_eq!(
        acknowledged.user_acknowledged_at.as_deref(),
        Some("2026-02-01T00:00:00Z")
    );
    assert_eq!(acknowledged.confidence, original.confidence);
    assert_eq!(
        companion_memory_kernel::rules::inference::clamp_confidence(0.99, true),
        0.99
    );
}

#[test]
fn promotion_requires_readiness_and_only_accumulating_can_promote() {
    let accumulating = inference(
        InferenceAxis::Disposition,
        InferenceState::Accumulating,
        "goal.current_focus",
        0.6,
        Vec::new(),
    );
    let promoted = applied(companion_memory_kernel::rules::inference::apply_transition(
        &accumulating,
        companion_memory_kernel::rules::inference::Transition::Promote,
        true,
    ));
    assert_eq!(promoted.state, InferenceState::Active);

    assert!(matches!(
        companion_memory_kernel::rules::inference::apply_transition(
            &accumulating,
            companion_memory_kernel::rules::inference::Transition::Promote,
            false,
        ),
        companion_memory_kernel::rules::inference::TransitionOutcome::Refused(
            companion_memory_kernel::rules::inference::TransitionRefusal::PromotionNotReady
        )
    ));

    let active = inference(
        InferenceAxis::Disposition,
        InferenceState::Active,
        "goal.current_focus",
        0.6,
        Vec::new(),
    );
    assert!(matches!(
        companion_memory_kernel::rules::inference::apply_transition(
            &active,
            companion_memory_kernel::rules::inference::Transition::Promote,
            true,
        ),
        companion_memory_kernel::rules::inference::TransitionOutcome::Refused(
            companion_memory_kernel::rules::inference::TransitionRefusal::AlreadyInState
        )
    ));
}

#[test]
fn pattern_promotion_sets_a_review_deadline_but_disposition_does_not() {
    let pattern = inference(
        InferenceAxis::Pattern,
        InferenceState::Accumulating,
        "ritual.recurring_activity",
        0.6,
        Vec::new(),
    );
    let promoted_pattern = applied(companion_memory_kernel::rules::inference::apply_transition(
        &pattern,
        companion_memory_kernel::rules::inference::Transition::Promote,
        true,
    ));
    assert_eq!(
        promoted_pattern.expires_at.as_deref(),
        Some(REVIEW_DEADLINE)
    );

    let disposition = inference(
        InferenceAxis::Disposition,
        InferenceState::Accumulating,
        "goal.current_focus",
        0.6,
        Vec::new(),
    );
    let promoted_disposition =
        applied(companion_memory_kernel::rules::inference::apply_transition(
            &disposition,
            companion_memory_kernel::rules::inference::Transition::Promote,
            true,
        ));
    assert_eq!(promoted_disposition.expires_at, None);
}

#[test]
fn rejection_is_terminal_and_expired_beliefs_can_revive() {
    let accumulating = inference(
        InferenceAxis::Disposition,
        InferenceState::Accumulating,
        "goal.current_focus",
        0.6,
        Vec::new(),
    );
    let rejected = applied(companion_memory_kernel::rules::inference::apply_transition(
        &accumulating,
        companion_memory_kernel::rules::inference::Transition::Reject {
            now: "2026-02-01T00:00:00Z".into(),
        },
        false,
    ));
    assert_eq!(rejected.state, InferenceState::Rejected);
    assert!(matches!(
        companion_memory_kernel::rules::inference::apply_transition(
            &rejected,
            companion_memory_kernel::rules::inference::Transition::Revive,
            false,
        ),
        companion_memory_kernel::rules::inference::TransitionOutcome::Refused(
            companion_memory_kernel::rules::inference::TransitionRefusal::RejectedIsTerminal
        )
    ));

    let expired = inference(
        InferenceAxis::Pattern,
        InferenceState::Expired,
        "ritual.recurring_activity",
        0.4,
        Vec::new(),
    );
    let revived = applied(companion_memory_kernel::rules::inference::apply_transition(
        &expired,
        companion_memory_kernel::rules::inference::Transition::Revive,
        false,
    ));
    assert_eq!(revived.state, InferenceState::Accumulating);
    assert_eq!(revived.expires_at, None);
}

#[test]
fn i12_review_deadlines_are_lexical_and_review_is_idempotent() {
    let no_deadline = inference(
        InferenceAxis::Pattern,
        InferenceState::Active,
        "ritual.recurring_activity",
        0.8,
        Vec::new(),
    );
    assert!(
        !companion_memory_kernel::rules::inference::is_review_overdue(
            &no_deadline,
            "2099-01-01T00:00:00Z"
        )
    );

    let mut pattern = no_deadline;
    pattern.expires_at = Some(REVIEW_DEADLINE.into());
    assert!(
        !companion_memory_kernel::rules::inference::is_review_overdue(
            &pattern,
            "2026-03-31T23:59:59Z"
        )
    );
    assert!(
        companion_memory_kernel::rules::inference::is_review_overdue(
            &pattern,
            "2026-04-02T00:00:00Z"
        )
    );

    let before =
        companion_memory_kernel::rules::inference::apply_review(&pattern, "2026-03-31T23:59:59Z");
    assert_eq!(before, pattern);

    let reviewed =
        companion_memory_kernel::rules::inference::apply_review(&pattern, "2026-04-02T00:00:00Z");
    assert!(reviewed.confidence < pattern.confidence);
    assert_eq!(reviewed.state, InferenceState::Expired);
    assert_eq!(reviewed.updated_at, "2026-04-02T00:00:00Z".to_owned());
    assert_eq!(
        companion_memory_kernel::rules::inference::apply_review(&reviewed, "2026-04-02T00:00:00Z",),
        reviewed
    );
}

#[test]
fn may_hold_requires_live_admissible_support_and_an_allowed_predicate() {
    let empty = inference(
        InferenceAxis::Disposition,
        InferenceState::Accumulating,
        "goal.current_focus",
        0.4,
        Vec::new(),
    );
    assert!(matches!(
        companion_memory_kernel::rules::inference::may_hold(&empty, &EvidenceResolution::default(),),
        Err(companion_memory_kernel::rules::inference::BeliefRefusal::NoLiveSupport)
    ));

    let assistant_claim = claim("assistant-claim", "identity.occupation");
    let assistant_only = inference(
        InferenceAxis::Disposition,
        InferenceState::Accumulating,
        "goal.current_focus",
        0.4,
        vec![claim_ref("assistant-claim", Speaker::Assistant)],
    );
    assert!(matches!(
        companion_memory_kernel::rules::inference::may_hold(
            &assistant_only,
            &resolution(vec![assistant_claim]),
        ),
        Err(companion_memory_kernel::rules::inference::BeliefRefusal::NoAdmissibleSupport)
    ));

    let boundary = inference(
        InferenceAxis::Disposition,
        InferenceState::Accumulating,
        "boundary.topic_avoid",
        0.4,
        vec![message_ref("message-1")],
    );
    assert!(matches!(
        companion_memory_kernel::rules::inference::may_hold(
            &boundary,
            &EvidenceResolution::default(),
        ),
        Err(
            companion_memory_kernel::rules::inference::BeliefRefusal::PredicateDisallowsInference {
                predicate
            }
        ) if predicate == "boundary.topic_avoid"
    ));

    let user_claim = claim("user-claim", "identity.occupation");
    let supported = inference(
        InferenceAxis::Disposition,
        InferenceState::Accumulating,
        "goal.current_focus",
        0.4,
        vec![claim_ref("user-claim", Speaker::User)],
    );
    assert_eq!(
        companion_memory_kernel::rules::inference::may_hold(
            &supported,
            &resolution(vec![user_claim]),
        ),
        Ok(())
    );
}
