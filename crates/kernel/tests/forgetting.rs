//! Integration tests for suppression, residue scans and derived recomputation.

use std::collections::{HashMap, HashSet};

use companion_memory_kernel::domain::predicates::MentionMode;
use companion_memory_kernel::domain::types::{
    Claim, ClaimStatus, Episode, EpisodeParticipant, EpisodeStatus, EvidenceRef,
    EvidenceSourceType, Inference, InferenceAxis, InferenceState, ParticipantRole, Provenance,
    RelationshipScope, Salience, SemanticRole, Speaker,
};
use companion_memory_kernel::rules::evidence::EvidenceResolution;
use companion_memory_kernel::rules::forgetting::{
    derived_disposition, find_exact_residue, find_suspected_residue, fingerprint, fingerprint_text,
    would_resurrect, DerivedDisposition, ForgetTarget, ResurrectionReason, SuppressionSet,
    TextCandidate,
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
        confidence: 0.9,
        created_at: T0.into(),
    }
}

fn claim(id: &str, predicate: &str, entity_ref: Option<&str>) -> Claim {
    Claim {
        id: id.into(),
        scope: scope(),
        predicate: predicate.into(),
        entity_ref: entity_ref.map(str::to_owned),
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

fn episode(id: &str, entity_ref: Option<&str>) -> Episode {
    Episode {
        id: id.into(),
        scope: scope(),
        occurred_from: T0.into(),
        occurred_to: None,
        narrative: "user: We talked about it.".into(),
        participants: vec![EpisodeParticipant {
            entity_ref: entity_ref.map(str::to_owned),
            role: ParticipantRole::User,
        }],
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

fn reference(source_type: EvidenceSourceType, source_id: &str) -> EvidenceRef {
    EvidenceRef {
        source_type,
        source_id: source_id.into(),
        speaker: Speaker::User,
        semantic_role: Some(SemanticRole::UserAssertion),
    }
}

fn inference(
    id: &str,
    predicate: &str,
    support_evidence: Vec<EvidenceRef>,
    confidence: f64,
) -> Inference {
    Inference {
        id: id.into(),
        scope: scope(),
        axis: InferenceAxis::Disposition,
        predicate: predicate.into(),
        value: "The user is thoughtful.".into(),
        state: InferenceState::Active,
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

fn resolution(claims: Vec<Claim>, episodes: Vec<Episode>) -> EvidenceResolution {
    EvidenceResolution {
        claims: claims
            .into_iter()
            .map(|claim| (claim.id.clone(), claim))
            .collect(),
        episodes: episodes
            .into_iter()
            .map(|episode| (episode.id.clone(), episode))
            .collect(),
        suppressed: HashSet::new(),
    }
}

#[test]
fn all_suppression_withholds_every_record_layer() {
    let suppression = SuppressionSet::from_target(ForgetTarget::All);
    let claim = claim("claim-1", "identity.occupation", None);
    let episode = episode("episode-1", None);
    let inference = inference("inference-1", "identity.occupation", Vec::new(), 0.7);

    assert!(suppression.suppresses_claim(&claim));
    assert!(suppression.suppresses_episode(&episode));
    assert!(suppression.suppresses_inference(&inference));
    assert!(suppression.suppresses_ref(&reference(EvidenceSourceType::Message, "message-1")));
}

#[test]
fn predicate_suppression_matches_only_the_named_predicate() {
    let suppression = SuppressionSet::from(ForgetTarget::Predicate {
        predicate: "identity.occupation".into(),
    });

    assert!(suppression.suppresses_claim(&claim("occupation", "identity.occupation", None)));
    assert!(!suppression.suppresses_claim(&claim("role", "identity.role", None)));
}

#[test]
fn entity_suppression_requires_a_structured_entity_reference() {
    let suppression = SuppressionSet::from(ForgetTarget::Entity {
        entity_ref: "person:ex".into(),
    });

    assert!(suppression.suppresses_claim(&claim(
        "ex-occupation",
        "person.occupation",
        Some("person:ex"),
    )));
    assert!(!suppression.suppresses_claim(&claim("user-occupation", "identity.occupation", None)));
    assert!(!suppression.suppresses_claim(&claim(
        "other-occupation",
        "person.occupation",
        Some("person:other"),
    )));
}

#[test]
fn records_suppression_matches_exactly_the_named_ids() {
    let suppression = SuppressionSet::from_target(ForgetTarget::Records {
        source_ids: vec!["claim-1".into(), "claim-1".into(), "episode-1".into()],
    });

    assert_eq!(suppression.suppressed.len(), 2);
    assert!(suppression.suppresses_claim(&claim("claim-1", "identity.name", None)));
    assert!(!suppression.suppresses_claim(&claim("claim-2", "identity.name", None)));
    assert!(suppression.suppresses_episode(&episode("episode-1", None)));
    assert!(!suppression.suppresses_ref(&reference(EvidenceSourceType::Message, "message-1")));
}

#[test]
fn fingerprint_is_stable_for_case_and_whitespace_but_not_different_text() {
    assert_eq!(
        fingerprint_text("  I   Design\nFor Work "),
        fingerprint_text("i design for work")
    );
    assert_ne!(
        fingerprint_text("I design for work"),
        fingerprint_text("I teach painting")
    );
}

#[test]
fn exact_residue_finds_copied_text_but_not_unrelated_text() {
    let suppressed_fingerprints = HashMap::from([(
        "claim-forgotten".to_owned(),
        fingerprint_text("I loved the blue lake"),
    )]);
    let candidates = [
        TextCandidate {
            source_type: EvidenceSourceType::Episode,
            source_id: "episode-survivor",
            text: "We talked: I LOVED the   blue lake.",
        },
        TextCandidate {
            source_type: EvidenceSourceType::Claim,
            source_id: "claim-unrelated",
            text: "I prefer quiet mornings.",
        },
    ];

    let residue = find_exact_residue(&suppressed_fingerprints, &candidates);

    assert_eq!(residue.len(), 1);
    assert_eq!(residue[0].source_type, EvidenceSourceType::Episode);
    assert_eq!(residue[0].source_id, "episode-survivor");
    assert_eq!(residue[0].matched_id, "claim-forgotten");
}

#[test]
fn suspected_residue_reports_threshold_matches_loudest_first() {
    let suppressed_fingerprints = HashMap::from([(
        "forgotten-1".to_owned(),
        fingerprint_text("I am anxious about work deadlines"),
    )]);
    let candidates = [
        TextCandidate {
            source_type: EvidenceSourceType::Episode,
            source_id: "below-threshold",
            text: "We discussed work deadlines.",
        },
        TextCandidate {
            source_type: EvidenceSourceType::Episode,
            source_id: "paraphrase",
            text: "I feel anxious about work deadlines.",
        },
        TextCandidate {
            source_type: EvidenceSourceType::Claim,
            source_id: "loudest",
            text: "I am anxious about work.",
        },
        TextCandidate {
            source_type: EvidenceSourceType::Claim,
            source_id: "unrelated",
            text: "We discussed holiday recipes.",
        },
    ];

    let suspected = find_suspected_residue(&suppressed_fingerprints, &candidates, 0.5);

    assert_eq!(suspected.len(), 2);
    assert_eq!(suspected[0].source_id, "loudest");
    assert_eq!(suspected[1].source_id, "paraphrase");
    assert!(suspected[0].similarity > suspected[1].similarity);
}

#[test]
fn derived_disposition_is_unchanged_when_all_support_is_live() {
    let first = claim("claim-1", "identity.occupation", None);
    let second = claim("claim-2", "identity.role", None);
    let support = vec![
        reference(EvidenceSourceType::Claim, "claim-1"),
        reference(EvidenceSourceType::Claim, "claim-2"),
    ];
    let inference = inference("inference-1", "goal.current_focus", support, 0.7);

    let disposition = derived_disposition(
        &inference,
        &SuppressionSet::default(),
        &resolution(vec![first, second], Vec::new()),
        |_, _| 0.1,
    );

    assert_eq!(disposition, DerivedDisposition::Unchanged);
}

#[test]
fn derived_disposition_weakens_when_part_of_support_is_suppressed() {
    let first = claim("claim-1", "identity.occupation", None);
    let second = claim("claim-2", "identity.role", None);
    let inference = inference(
        "inference-1",
        "goal.current_focus",
        vec![
            reference(EvidenceSourceType::Claim, "claim-1"),
            reference(EvidenceSourceType::Claim, "claim-2"),
        ],
        0.7,
    );
    let suppression = SuppressionSet::from(ForgetTarget::Records {
        source_ids: vec!["claim-2".into()],
    });

    let disposition = derived_disposition(
        &inference,
        &suppression,
        &resolution(vec![first, second], Vec::new()),
        |_, surviving| {
            assert_eq!(surviving.len(), 1);
            0.4
        },
    );

    assert_eq!(
        disposition,
        DerivedDisposition::Weakened {
            new_confidence: 0.4,
            removed_support: 1
        },
    );
}

#[test]
fn derived_disposition_collapses_when_all_support_is_suppressed() {
    let first = claim("claim-1", "identity.occupation", None);
    let second = claim("claim-2", "identity.role", None);
    let inference = inference(
        "inference-1",
        "goal.current_focus",
        vec![
            reference(EvidenceSourceType::Claim, "claim-1"),
            reference(EvidenceSourceType::Claim, "claim-2"),
        ],
        0.7,
    );
    let suppression = SuppressionSet::from(ForgetTarget::Records {
        source_ids: vec!["claim-1".into(), "claim-2".into()],
    });

    let disposition = derived_disposition(
        &inference,
        &suppression,
        &resolution(vec![first, second], Vec::new()),
        |_, _| 0.1,
    );

    assert_eq!(disposition, DerivedDisposition::Collapsed);
}

#[test]
fn derived_disposition_withholds_an_inference_that_is_directly_suppressed() {
    let inference = inference("inference-1", "goal.current_focus", Vec::new(), 0.7);
    let suppression = SuppressionSet::from(ForgetTarget::Records {
        source_ids: vec!["inference-1".into()],
    });

    let disposition = derived_disposition(
        &inference,
        &suppression,
        &EvidenceResolution::default(),
        |_, _| 0.1,
    );

    assert_eq!(disposition, DerivedDisposition::Withheld);
}

#[test]
fn losing_evidence_never_raises_confidence() {
    let kept = claim("claim-kept", "identity.occupation", None);
    let removed = claim("claim-removed", "identity.role", None);
    let inference = inference(
        "inference-1",
        "goal.current_focus",
        vec![
            reference(EvidenceSourceType::Claim, "claim-kept"),
            reference(EvidenceSourceType::Claim, "claim-removed"),
        ],
        0.4,
    );
    let suppression = SuppressionSet::from(ForgetTarget::Records {
        source_ids: vec!["claim-removed".into()],
    });

    let disposition = derived_disposition(
        &inference,
        &suppression,
        &resolution(vec![kept, removed], Vec::new()),
        |_, _| 0.99,
    );

    assert_eq!(
        disposition,
        DerivedDisposition::Weakened {
            new_confidence: 0.4,
            removed_support: 1
        },
    );
}

#[test]
fn would_resurrect_reports_predicate_entity_all_and_fingerprint_reasons() {
    let value = json!("forgotten value");
    let no_fingerprints = HashMap::new();

    let predicate_suppression = SuppressionSet::from(ForgetTarget::Predicate {
        predicate: "identity.occupation".into(),
    });
    assert_eq!(
        would_resurrect(
            "identity.occupation",
            &value,
            None,
            &predicate_suppression,
            &no_fingerprints,
        ),
        Some(ResurrectionReason::PredicateSuppressed {
            predicate: "identity.occupation".into(),
        }),
    );

    let entity_suppression = SuppressionSet::from(ForgetTarget::Entity {
        entity_ref: "person:ex".into(),
    });
    assert_eq!(
        would_resurrect(
            "person.occupation",
            &value,
            Some("person:ex"),
            &entity_suppression,
            &no_fingerprints,
        ),
        Some(ResurrectionReason::EntitySuppressed {
            entity_ref: "person:ex".into()
        }),
    );

    let all_suppression = SuppressionSet::from(ForgetTarget::All);
    assert_eq!(
        would_resurrect(
            "identity.occupation",
            &value,
            None,
            &all_suppression,
            &no_fingerprints
        ),
        Some(ResurrectionReason::AllSuppressed),
    );

    let fingerprints =
        HashMap::from([("claim-forgotten".to_owned(), fingerprint_text("Forgotten value"))]);
    assert_eq!(
        would_resurrect(
            "identity.occupation",
            &value,
            None,
            &SuppressionSet::default(),
            &fingerprints,
        ),
        Some(ResurrectionReason::FingerprintMatch {
            matched_id: "claim-forgotten".into()
        }),
    );
}

#[test]
fn would_resurrect_returns_none_for_a_value_that_was_not_forgotten() {
    let fingerprints =
        HashMap::from([("claim-forgotten".to_owned(), fingerprint_text("Forgotten value"))]);

    assert_eq!(
        would_resurrect(
            "identity.occupation",
            &json!("A new value"),
            None,
            &SuppressionSet::default(),
            &fingerprints,
        ),
        None,
    );
}

#[test]
fn i4_round_trip_refuses_to_write_the_identical_forgotten_value() {
    let forgotten_id = "claim-forgotten";
    let forgotten_text = "I live in Shanghai";
    let forgotten_value = json!(forgotten_text);
    let suppression = SuppressionSet::from(ForgetTarget::Records {
        source_ids: vec![forgotten_id.into()],
    });
    let fingerprints =
        HashMap::from([(forgotten_id.to_owned(), fingerprint(&forgotten_value))]);

    assert_eq!(
        would_resurrect(
            "identity.location",
            &forgotten_value,
            Some("place:shanghai"),
            &suppression,
            &fingerprints,
        ),
        Some(ResurrectionReason::FingerprintMatch {
            matched_id: forgotten_id.into()
        }),
    );
}

#[test]
fn the_fingerprint_guard_fires_without_a_record_level_suppression() {
    // The round-trip test above cannot see this branch: a `Records` target
    // matches on the record id first, so the fingerprint comparison is never
    // reached and an orientation mistake in it stays invisible. This test
    // suppresses nothing by id, so the only way to get a match is the
    // fingerprint path itself — which is the path that stops a *later
    // extraction* from writing the same sentence back.
    let forgotten_text = "I live in Shanghai";
    let forgotten_value = json!(forgotten_text);
    // Keyed by a label and holding the fingerprint, which is the orientation the
    // storage loader produces.
    let fingerprints =
        HashMap::from([("the place they live".to_owned(), fingerprint(&forgotten_value))]);

    assert_eq!(
        would_resurrect(
            "identity.location",
            &forgotten_value,
            None,
            &SuppressionSet::default(),
            &fingerprints,
        ),
        Some(ResurrectionReason::FingerprintMatch {
            matched_id: "the place they live".into()
        }),
    );

    // A value that was never forgotten still passes.
    assert_eq!(
        would_resurrect(
            "identity.location",
            &json!("I moved to Hangzhou"),
            None,
            &SuppressionSet::default(),
            &fingerprints,
        ),
        None,
    );

    // And the reversed orientation must NOT match, which is what makes the
    // orientation load-bearing rather than incidental.
    let reversed =
        HashMap::from([(fingerprint(&forgotten_value), "the place they live".to_owned())]);
    assert_eq!(
        would_resurrect(
            "identity.location",
            &forgotten_value,
            None,
            &SuppressionSet::default(),
            &reversed,
        ),
        None,
        "a reversed map compares a fingerprint against a label and cannot match"
    );
}
