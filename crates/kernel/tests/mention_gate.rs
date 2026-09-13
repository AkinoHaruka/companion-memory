//! Integration tests for the mention gate.

use companion_memory_kernel::domain::predicates::{mention_policy_for, MentionMode};
use companion_memory_kernel::domain::types::{
    Claim, ClaimStatus, Episode, EpisodeStatus, Inference, InferenceAxis, InferenceState,
    Provenance, RelationshipScope, Salience,
};
use companion_memory_kernel::rules::mention_gate::{
    claim_mention, effective_surface_level, episode_mention, inference_mention, is_constraint,
    mention_gate, GateDenial, MentionCues, MentionDecision, MentionInput, SurfaceLevel,
};

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
        created_at: "2026-01-01T00:00:00Z".into(),
    }
}

/// Build a minimal claim while leaving the gate-relevant flag configurable.
fn claim(predicate: &str, do_not_surface: Option<bool>) -> Claim {
    Claim {
        id: "claim-1".into(),
        scope: scope(),
        predicate: predicate.into(),
        entity_ref: None,
        qualifiers: None,
        value: serde_json::json!("value"),
        raw_value: None,
        valid_from: "2026-01-01T00:00:00Z".into(),
        valid_until: None,
        status: ClaimStatus::Active,
        supersedes_id: None,
        source_refs: Vec::new(),
        provenance: provenance(),
        salience: Salience {
            do_not_surface,
            ..Salience::default()
        },
        created_at: "2026-01-01T00:00:00Z".into(),
        updated_at: "2026-01-01T00:00:00Z".into(),
    }
}

/// Build a minimal inference with the state, axis, mode and flag under test.
fn inference(
    axis: InferenceAxis,
    state: InferenceState,
    use_mode: MentionMode,
    do_not_surface: Option<bool>,
) -> Inference {
    Inference {
        id: "inference-1".into(),
        scope: scope(),
        axis,
        predicate: "goal.current_focus".into(),
        value: "value".into(),
        state,
        confidence: 0.9,
        support_evidence: Vec::new(),
        counter_evidence: Vec::new(),
        promotion_audit: None,
        user_acknowledged_at: None,
        use_mode,
        expires_at: None,
        salience: Salience {
            do_not_surface,
            ..Salience::default()
        },
        created_at: "2026-01-01T00:00:00Z".into(),
        updated_at: "2026-01-01T00:00:00Z".into(),
    }
}

fn episode(do_not_surface: Option<bool>) -> Episode {
    Episode {
        id: "episode-1".into(),
        scope: scope(),
        occurred_from: "2026-01-01T00:00:00Z".into(),
        occurred_to: None,
        narrative: "用户带猫去医院".into(),
        participants: Vec::new(),
        emotional_arc: None,
        user_reaction: None,
        response_ref: None,
        source_refs: Vec::new(),
        status: EpisodeStatus::Active,
        salience: Salience {
            do_not_surface,
            ..Salience::default()
        },
        created_at: "2026-01-01T00:00:00Z".into(),
        updated_at: "2026-01-01T00:00:00Z".into(),
    }
}

fn input<'a>(predicate: Option<&'a str>, record_mode: Option<MentionMode>) -> MentionInput<'a> {
    MentionInput {
        predicate,
        record_mode,
        do_not_surface: None,
        shared_world_term: false,
        cues: MentionCues::default(),
    }
}

#[test]
fn effective_level_is_monotone_for_record_mode_and_predicate_policy() {
    let record_quieter = input(Some("identity.name"), Some(MentionMode::BackgroundOnly));
    assert_eq!(
        effective_surface_level(&record_quieter),
        SurfaceLevel::BackgroundOnly
    );

    let predicate_quieter = input(
        Some("boundary.topic_avoid"),
        Some(MentionMode::FreelyMentionable),
    );
    assert_eq!(
        effective_surface_level(&predicate_quieter),
        SurfaceLevel::BackgroundOnly
    );
}

#[test]
fn episode_mention_honours_the_record_level_do_not_surface_flag() {
    let decision = episode_mention(
        &episode(Some(true)),
        MentionCues {
            user_referenced: true,
            topic_implies: true,
            ..MentionCues::default()
        },
    );
    assert_eq!(
        decision,
        MentionDecision::Denied {
            reason: GateDenial::DoNotSurface,
            level: SurfaceLevel::NeverSurface,
        }
    );
}

#[test]
fn do_not_surface_has_a_distinct_denial_reason_even_with_every_cue() {
    let mut record = input(Some("identity.name"), Some(MentionMode::FreelyMentionable));
    record.do_not_surface = Some(true);
    record.shared_world_term = true;
    record.cues = MentionCues {
        user_referenced: true,
        topic_implies: true,
        time_trigger_authorised: true,
        shared_term_in_user_turn: true,
        time_trigger_attempted: true,
    };

    assert_eq!(
        mention_gate(&record),
        MentionDecision::Denied {
            reason: GateDenial::DoNotSurface,
            level: SurfaceLevel::NeverSurface
        }
    );
}

#[test]
fn background_only_is_allowed_but_marked_background_only() {
    assert_eq!(
        mention_gate(&input(None, Some(MentionMode::BackgroundOnly))),
        MentionDecision::Allowed {
            level: SurfaceLevel::BackgroundOnly,
            background_only: true
        }
    );
}

#[test]
fn mention_if_user_cues_requires_user_or_topic_cue() {
    let mut record = input(Some("identity.occupation"), None);
    assert_eq!(
        mention_gate(&record),
        MentionDecision::Denied {
            reason: GateDenial::AwaitingUserCue,
            level: SurfaceLevel::MentionIfUserCues
        }
    );

    record.cues.user_referenced = true;
    assert_eq!(
        mention_gate(&record),
        MentionDecision::Allowed {
            level: SurfaceLevel::MentionIfUserCues,
            background_only: false
        }
    );

    record.cues.user_referenced = false;
    record.cues.topic_implies = true;
    assert_eq!(
        mention_gate(&record),
        MentionDecision::Allowed {
            level: SurfaceLevel::MentionIfUserCues,
            background_only: false
        }
    );
}

#[test]
fn never_surface_always_denies_before_cues_are_considered() {
    let mut record = input(Some("identity.age"), Some(MentionMode::FreelyMentionable));
    record.shared_world_term = true;
    record.cues = MentionCues {
        user_referenced: true,
        topic_implies: true,
        time_trigger_authorised: true,
        shared_term_in_user_turn: true,
        time_trigger_attempted: true,
    };

    assert_eq!(
        mention_gate(&record),
        MentionDecision::Denied {
            reason: GateDenial::NeverSurface,
            level: SurfaceLevel::NeverSurface
        }
    );
}

#[test]
fn shared_world_terms_need_the_user_term_in_this_turn() {
    let mut record = input(None, Some(MentionMode::FreelyMentionable));
    record.shared_world_term = true;
    assert_eq!(
        mention_gate(&record),
        MentionDecision::Denied {
            reason: GateDenial::UsesUnlicensedSharedTerm,
            level: SurfaceLevel::FreelyMentionable,
        }
    );

    record.cues.shared_term_in_user_turn = true;
    assert_eq!(
        mention_gate(&record),
        MentionDecision::Allowed {
            level: SurfaceLevel::FreelyMentionable,
            background_only: false
        }
    );
}

#[test]
fn an_authorised_time_trigger_can_speak_without_another_cue() {
    let mut record = input(None, None);
    record.cues.time_trigger_authorised = true;
    assert_eq!(
        mention_gate(&record),
        MentionDecision::Allowed {
            level: SurfaceLevel::FreelyMentionable,
            background_only: false
        }
    );
}

#[test]
fn an_unauthorised_attempt_is_reported_and_authorisation_allows_it() {
    let mut record = input(None, None);
    record.cues.time_trigger_attempted = true;
    assert_eq!(
        mention_gate(&record),
        MentionDecision::Denied {
            reason: GateDenial::TimeTriggerNotAuthorised,
            level: SurfaceLevel::FreelyMentionable,
        }
    );

    record.cues.time_trigger_authorised = true;
    assert_eq!(
        mention_gate(&record),
        MentionDecision::Allowed {
            level: SurfaceLevel::FreelyMentionable,
            background_only: false
        }
    );
}

#[test]
fn inactive_inferences_are_silent_but_active_inferences_can_be_mentioned() {
    for state in [
        InferenceState::Accumulating,
        InferenceState::Rejected,
        InferenceState::Expired,
    ] {
        let record = inference(
            InferenceAxis::Disposition,
            state,
            MentionMode::FreelyMentionable,
            None,
        );
        assert_eq!(
            inference_mention(&record, MentionCues::default()),
            MentionDecision::Denied {
                reason: GateDenial::InferenceNotActive,
                level: SurfaceLevel::FreelyMentionable,
            }
        );
    }

    let record = inference(
        InferenceAxis::Disposition,
        InferenceState::Active,
        MentionMode::FreelyMentionable,
        None,
    );
    assert_eq!(
        inference_mention(&record, MentionCues::default()),
        MentionDecision::Allowed {
            level: SurfaceLevel::FreelyMentionable,
            background_only: false
        }
    );
}

#[test]
fn shared_world_inferences_set_the_shared_term_gate_automatically() {
    let record = inference(
        InferenceAxis::SharedWorld,
        InferenceState::Active,
        MentionMode::FreelyMentionable,
        None,
    );
    assert_eq!(
        inference_mention(&record, MentionCues::default()),
        MentionDecision::Denied {
            reason: GateDenial::UsesUnlicensedSharedTerm,
            level: SurfaceLevel::FreelyMentionable,
        }
    );

    let cues = MentionCues {
        shared_term_in_user_turn: true,
        ..MentionCues::default()
    };
    assert_eq!(
        inference_mention(&record, cues),
        MentionDecision::Allowed {
            level: SurfaceLevel::FreelyMentionable,
            background_only: false
        }
    );
}

#[test]
fn wrappers_respect_claim_and_inference_do_not_surface_flags() {
    let record = claim("identity.name", Some(true));
    assert_eq!(
        claim_mention(
            &record,
            MentionCues {
                user_referenced: true,
                ..MentionCues::default()
            },
        ),
        MentionDecision::Denied {
            reason: GateDenial::DoNotSurface,
            level: SurfaceLevel::NeverSurface
        }
    );

    let record = inference(
        InferenceAxis::Disposition,
        InferenceState::Active,
        MentionMode::FreelyMentionable,
        Some(true),
    );
    assert_eq!(
        inference_mention(
            &record,
            MentionCues {
                topic_implies: true,
                ..MentionCues::default()
            },
        ),
        MentionDecision::Denied {
            reason: GateDenial::DoNotSurface,
            level: SurfaceLevel::NeverSurface
        }
    );
}

#[test]
fn boundary_predicates_are_constraints_and_background_only() {
    assert!(is_constraint(Some("boundary.topic_avoid")));
    assert!(!is_constraint(Some("identity.name")));
    assert!(!is_constraint(None));

    assert_eq!(
        mention_policy_for("boundary.topic_avoid"),
        MentionMode::BackgroundOnly
    );
    assert_eq!(
        mention_gate(&input(Some("boundary.topic_avoid"), None)),
        MentionDecision::Allowed {
            level: SurfaceLevel::BackgroundOnly,
            background_only: true
        }
    );
}
