//! Integration tests for the evidence admissibility and liveness rules.
//!
//! Fixtures stay deliberately small. The fields that could tempt a rule to
//! consult provenance confidence or semantic role are still populated so the
//! tests pin the actual invariants rather than passing by omission.

use companion_memory_kernel::domain::predicate_keys::MISC_PREDICATE;
use companion_memory_kernel::domain::predicates::inference_allowed_for;
use companion_memory_kernel::domain::types::{
    Claim, ClaimStatus, Episode, EpisodeParticipant, EpisodeStatus, EvidenceRef,
    EvidenceSourceType, ParticipantRole, Provenance, RelationshipScope, Salience, SemanticRole,
    Speaker,
};
use companion_memory_kernel::rules::evidence::{
    is_collapsed, live_counter_evidence, live_evidence, may_support_user_inference,
    verify_inference_evidence, EvidenceResolution, EvidenceViolation,
};
use serde_json::json;

const T0: &str = "2026-01-01T00:00:00Z";

fn scope() -> RelationshipScope {
    RelationshipScope {
        service_id: "svc.test".into(),
        owner_user_id: "user.test".into(),
        companion_profile_id: "companion.test".into(),
    }
}

fn provenance() -> Provenance {
    Provenance {
        agent_id: None,
        prompt_family: None,
        prompt_version: None,
        model: None,
        confidence: 0.99,
        created_at: T0.into(),
    }
}

/// Create a minimal active claim with a deliberately high producer confidence.
fn claim(id: &str, predicate: &str) -> Claim {
    Claim {
        id: id.into(),
        scope: scope(),
        predicate: predicate.into(),
        entity_ref: None,
        qualifiers: None,
        value: json!("designer"),
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

/// Create a minimal active episode for source-layer resolution tests.
fn episode(id: &str) -> Episode {
    Episode {
        id: id.into(),
        scope: scope(),
        occurred_from: T0.into(),
        occurred_to: None,
        narrative: "user: I am moving.\ncompanion: That is a big change.".into(),
        participants: vec![
            EpisodeParticipant {
                entity_ref: None,
                role: ParticipantRole::User,
            },
            EpisodeParticipant {
                entity_ref: None,
                role: ParticipantRole::Companion,
            },
        ],
        emotional_arc: None,
        user_reaction: None,
        response_ref: None,
        source_refs: Vec::new(),
        status: EpisodeStatus::Active,
        salience: Salience::default(),
        created_at: T0.into(),
        updated_at: T0.into(),
    }
}

fn reference(source_type: EvidenceSourceType, source_id: &str, speaker: Speaker) -> EvidenceRef {
    EvidenceRef {
        source_type,
        source_id: source_id.into(),
        speaker,
        semantic_role: Some(match speaker {
            Speaker::User => SemanticRole::UserAssertion,
            Speaker::Assistant => SemanticRole::AssistantAction,
        }),
    }
}

fn claim_ref(source_id: &str, speaker: Speaker) -> EvidenceRef {
    reference(EvidenceSourceType::Claim, source_id, speaker)
}

fn episode_ref(source_id: &str, speaker: Speaker) -> EvidenceRef {
    reference(EvidenceSourceType::Episode, source_id, speaker)
}

fn message_ref(source_id: &str, speaker: Speaker) -> EvidenceRef {
    reference(EvidenceSourceType::Message, source_id, speaker)
}

fn resolution(
    claims: Vec<Claim>,
    episodes: Vec<Episode>,
    suppressed: &[&str],
) -> EvidenceResolution {
    EvidenceResolution {
        claims: claims
            .into_iter()
            .map(|claim| (claim.id.clone(), claim))
            .collect(),
        episodes: episodes
            .into_iter()
            .map(|episode| (episode.id.clone(), episode))
            .collect(),
        suppressed: suppressed.iter().map(|id| (*id).to_owned()).collect(),
    }
}

// ---------------------------------------------------------------------------
// I1 and I8
// ---------------------------------------------------------------------------

#[test]
fn i1_rejects_assistant_speech_even_for_an_inference_allowed_claim() {
    let source = claim("c-occupation", "identity.occupation");
    assert!(inference_allowed_for(&source.predicate));
    let assistant = claim_ref(&source.id, Speaker::Assistant);
    let res = resolution(vec![source], Vec::new(), &[]);

    assert_eq!(
        may_support_user_inference(&assistant, &res),
        Some(EvidenceViolation::AssistantSpeaker {
            reference: assistant
        }),
    );

    let user = claim_ref("c-occupation", Speaker::User);
    assert_eq!(may_support_user_inference(&user, &res), None);
}

#[test]
fn i8_reports_boundaries_and_disallowed_predicates_but_allows_occupation() {
    let boundary = claim("c-boundary", "boundary.topic_avoid");
    let misc = claim("c-misc", MISC_PREDICATE);
    let occupation = claim("c-occupation", "identity.occupation");
    let res = resolution(vec![boundary, misc, occupation], Vec::new(), &[]);

    assert!(matches!(
        may_support_user_inference(&claim_ref("c-boundary", Speaker::User), &res),
        Some(EvidenceViolation::BoundaryIsConstraint { predicate, .. })
            if predicate == "boundary.topic_avoid"
    ));
    assert!(matches!(
        may_support_user_inference(&claim_ref("c-misc", Speaker::User), &res),
        Some(EvidenceViolation::InferenceDisallowed { predicate, .. })
            if predicate == MISC_PREDICATE
    ));
    assert_eq!(
        may_support_user_inference(&claim_ref("c-occupation", Speaker::User), &res),
        None,
    );
}

#[test]
fn unknown_source_is_reported_for_an_id_in_neither_map() {
    let reference = claim_ref("never-written", Speaker::User);
    assert_eq!(
        may_support_user_inference(&reference, &EvidenceResolution::default()),
        Some(EvidenceViolation::UnknownSource { reference }),
    );
}

#[test]
fn claim_ref_known_only_as_an_episode_is_a_source_type_mismatch() {
    let reference = claim_ref("shared-id", Speaker::User);
    let res = resolution(Vec::new(), vec![episode("shared-id")], &[]);

    assert_eq!(
        may_support_user_inference(&reference, &res),
        Some(EvidenceViolation::SourceTypeMismatch {
            reference,
            expected: EvidenceSourceType::Claim,
        }),
    );
}

#[test]
fn an_unregistered_boundary_key_is_still_a_constraint() {
    let source = claim("c-custom-boundary", "boundary.custom_thing");
    let res = resolution(vec![source], Vec::new(), &[]);
    let reference = claim_ref("c-custom-boundary", Speaker::User);

    assert!(matches!(
        may_support_user_inference(&reference, &res),
        Some(EvidenceViolation::BoundaryIsConstraint { predicate, .. })
            if predicate == "boundary.custom_thing"
    ));
}

#[test]
fn a_user_message_ref_passes_by_construction() {
    let reference = message_ref("message-1", Speaker::User);
    assert_eq!(
        may_support_user_inference(&reference, &EvidenceResolution::default()),
        None,
    );
}

// ---------------------------------------------------------------------------
// Shared audit ordering
// ---------------------------------------------------------------------------

#[test]
fn verification_returns_all_violations_but_the_gate_returns_only_the_first() {
    let source = claim("c-boundary", "boundary.topic_avoid");
    let res = resolution(vec![source], Vec::new(), &[]);
    let reference = claim_ref("c-boundary", Speaker::Assistant);

    let verdict = verify_inference_evidence(std::slice::from_ref(&reference), &res);
    assert!(!verdict.valid);
    assert_eq!(verdict.violations.len(), 2);
    assert!(matches!(
        &verdict.violations[0],
        EvidenceViolation::AssistantSpeaker { reference: found } if found == &reference
    ));
    assert!(matches!(
        &verdict.violations[1],
        EvidenceViolation::BoundaryIsConstraint { reference: found, predicate }
            if found == &reference && predicate == "boundary.topic_avoid"
    ));

    assert_eq!(
        may_support_user_inference(&reference, &res),
        Some(EvidenceViolation::AssistantSpeaker { reference }),
    );
}

// ---------------------------------------------------------------------------
// I5 and liveness
// ---------------------------------------------------------------------------

#[test]
fn i5_collapses_empty_and_fully_suppressed_support_but_not_partly_live_support() {
    let empty = EvidenceResolution::default();
    assert!(is_collapsed(&[], &empty));

    let first = claim("c1", "identity.occupation");
    let second = claim("c2", "identity.role");
    let all_suppressed = resolution(
        vec![first.clone(), second.clone()],
        Vec::new(),
        &["c1", "c2"],
    );
    let both = [
        claim_ref("c1", Speaker::User),
        claim_ref("c2", Speaker::User),
    ];
    assert!(is_collapsed(&both, &all_suppressed));

    let partly_live = resolution(vec![first, second], Vec::new(), &["c1"]);
    assert!(!is_collapsed(&both, &partly_live));
}

#[test]
fn live_evidence_drops_suppressed_and_unresolvable_refs_only() {
    let good = claim("c-good", "identity.occupation");
    let suppressed = claim("c-suppressed", "identity.role");
    let boundary = claim("c-boundary", "boundary.topic_avoid");
    let res = resolution(
        vec![good, suppressed, boundary],
        vec![episode("e1")],
        &["c-suppressed", "message-suppressed"],
    );
    let refs = vec![
        claim_ref("c-good", Speaker::User),
        claim_ref("c-suppressed", Speaker::User),
        claim_ref("c-boundary", Speaker::Assistant),
        episode_ref("e1", Speaker::User),
        claim_ref("missing-claim", Speaker::User),
        episode_ref("missing-episode", Speaker::User),
        message_ref("message-suppressed", Speaker::User),
        message_ref("message-live", Speaker::Assistant),
    ];

    let live = live_evidence(&refs, &res);
    assert_eq!(
        live.iter()
            .map(|reference| format!("{:?}:{}", reference.source_type, reference.source_id))
            .collect::<Vec<_>>(),
        vec![
            "Claim:c-good",
            "Claim:c-boundary",
            "Episode:e1",
            "Message:message-live",
        ],
    );
}

#[test]
fn live_counter_evidence_keeps_live_user_refs_and_drops_suppressed_refs() {
    let kept = claim("c-kept", "identity.occupation");
    let dropped = claim("c-dropped", "identity.role");
    let res = resolution(vec![kept, dropped], Vec::new(), &["c-dropped"]);
    let refs = [
        claim_ref("c-kept", Speaker::User),
        claim_ref("c-dropped", Speaker::User),
    ];

    assert_eq!(live_counter_evidence(&refs, &res), vec![&refs[0]]);
}
