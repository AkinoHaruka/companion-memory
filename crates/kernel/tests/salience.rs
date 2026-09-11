//! Integration tests for salience, scoring and promotion rules.

use companion_memory_kernel::domain::types::{PromotionAudit, Salience};
use companion_memory_kernel::rules::salience::{
    apply_feedback, candidate_score, days_between, promotion_readiness, rank, recency_factor,
    record_recall, FeedbackSignal, PromotionBlocker, ScoreInputs, ScoreRejection,
    MIN_CONTEXT_DIVERSITY,
};

fn salience(importance: f64) -> Salience {
    Salience {
        importance,
        recall_count: 4,
        last_recalled_at: Some("2026-01-01T00:00:00Z".into()),
        do_not_surface: Some(false),
    }
}

fn score_input<'a>(
    predicate: &'a str,
    salience: &'a Salience,
    relevance: f64,
    confidence: f64,
    explicit_trigger: bool,
) -> ScoreInputs<'a> {
    ScoreInputs {
        predicate,
        salience,
        relevance,
        confidence,
        last_seen: "2026-01-01T00:00:00Z",
        now: "2026-01-15T00:00:00Z",
        half_life_days: 14,
        explicit_trigger,
    }
}

fn audit(
    distinct_sessions: u32,
    temporal_span_days: u32,
    context_diversity: u32,
    counter_examples_checked: u32,
) -> PromotionAudit {
    PromotionAudit {
        distinct_sessions,
        temporal_span_days,
        context_diversity,
        counter_examples_checked,
    }
}

#[test]
fn neutral_feedback_is_an_idempotent_bitwise_no_op() {
    for importance in [0.0, 0.5, 1.0] {
        let original = salience(importance);
        assert_eq!(apply_feedback(&original, FeedbackSignal::None), original);

        let mut repeated = original.clone();
        for _ in 0..10 {
            repeated = apply_feedback(&repeated, FeedbackSignal::None);
        }
        assert_eq!(repeated, original);
    }
}

#[test]
fn every_positive_signal_raises_importance_and_clamps() {
    let signals = [
        FeedbackSignal::UserValued,
        FeedbackSignal::UserCorrected,
        FeedbackSignal::UserRaisedAgain,
        FeedbackSignal::ResponseWorked,
    ];

    for signal in signals {
        let original = salience(0.5);
        let updated = apply_feedback(&original, signal);
        assert!(updated.importance > original.importance);
        assert_eq!(updated.recall_count, original.recall_count);
        assert_eq!(updated.last_recalled_at, original.last_recalled_at);
        assert_eq!(updated.do_not_surface, original.do_not_surface);

        assert_eq!(
            apply_feedback(&salience(0.95), signal).importance,
            1.0,
            "{signal:?} must clamp at one"
        );
    }
}

#[test]
fn asking_to_stop_sets_the_flag_without_erasing_importance() {
    let original = salience(0.73);
    let updated = apply_feedback(&original, FeedbackSignal::UserAskedToStop);

    assert_eq!(updated.importance, original.importance);
    assert_eq!(updated.recall_count, original.recall_count);
    assert_eq!(updated.last_recalled_at, original.last_recalled_at);
    assert_eq!(updated.do_not_surface, Some(true));
}

#[test]
fn recall_updates_usage_only() {
    let original = salience(0.73);
    let updated = record_recall(&original, "2026-02-15T12:00:00Z");

    assert_eq!(updated.recall_count, original.recall_count + 1);
    assert_eq!(
        updated.last_recalled_at.as_deref(),
        Some("2026-02-15T12:00:00Z")
    );
    assert_eq!(updated.importance, original.importance);
    assert_eq!(updated.do_not_surface, original.do_not_surface);
}

#[test]
fn day_difference_is_forward_only_and_calendar_aware() {
    assert_eq!(days_between("2026-05-10", "2026-05-10T23:59:59Z"), 0);
    assert_eq!(days_between("2026-05-11", "2026-05-10"), 0);
    assert_eq!(days_between("2026-01-31", "2026-02-02"), 2);
    assert_eq!(days_between("2024-02-28", "2024-03-01"), 2);
}

#[test]
fn recency_uses_the_requested_half_life_and_stays_positive() {
    let start = "2026-01-01T00:00:00Z";
    assert_eq!(recency_factor(start, start, 14), 1.0);
    assert_eq!(recency_factor(start, "2026-01-15T00:00:00Z", 14), 0.5);
    assert!((recency_factor(start, "2026-01-29T00:00:00Z", 14) - 0.25).abs() < 1e-12);

    let very_old = recency_factor("1900-01-01T00:00:00Z", "2026-01-01T00:00:00Z", 1);
    assert!(very_old > 0.0 && very_old <= 1.0);
    assert_eq!(recency_factor(start, "2026-01-15T00:00:00Z", 0), 1.0);
}

#[test]
fn boundaries_are_refused_even_when_the_key_is_unknown() {
    let record_salience = salience(1.0);
    for predicate in ["boundary.topic_avoid", "boundary.whatever"] {
        let input = score_input(predicate, &record_salience, 1.0, 1.0, false);
        assert_eq!(
            candidate_score(&input),
            Err(ScoreRejection::BoundaryIsAConstraint)
        );
    }

    let input = score_input("identity.name", &record_salience, 1.0, 1.0, false);
    assert!(candidate_score(&input).is_ok());
}

#[test]
fn zero_relevance_scores_zero_and_an_explicit_trigger_adds_a_bonus() {
    let record_salience = salience(1.0);
    let unrelated = score_input("identity.name", &record_salience, 0.0, 1.0, true);
    assert_eq!(candidate_score(&unrelated), Ok(0.0));

    let without_trigger = score_input("identity.name", &record_salience, 0.8, 0.9, false);
    let with_trigger = score_input("identity.name", &record_salience, 0.8, 0.9, true);
    assert!(candidate_score(&with_trigger).unwrap() > candidate_score(&without_trigger).unwrap());
}

#[test]
fn rank_drops_boundaries_and_orders_candidates_loudest_first() {
    let high_salience = salience(0.9);
    let low_salience = salience(0.2);
    let items = vec![
        score_input("boundary.topic_avoid", &high_salience, 1.0, 1.0, true),
        score_input("identity.name", &low_salience, 0.8, 0.9, false),
        score_input("goal.current_focus", &high_salience, 0.8, 0.9, false),
    ];

    let ranked = rank(&items);
    assert_eq!(ranked.len(), 2);
    assert_eq!(ranked[0].0.predicate, "goal.current_focus");
    assert_eq!(ranked[1].0.predicate, "identity.name");
    assert!(ranked[0].1 > ranked[1].1);
}

#[test]
fn promotion_readiness_reports_each_blocker_and_allows_a_complete_audit() {
    let ready = promotion_readiness(&audit(3, 14, MIN_CONTEXT_DIVERSITY, 1));
    assert!(ready.ready);
    assert!(ready.blocking.is_empty());

    assert_eq!(
        promotion_readiness(&audit(2, 14, MIN_CONTEXT_DIVERSITY, 1)).blocking,
        vec![PromotionBlocker::TooFewSessions { have: 2, need: 3 }]
    );
    assert_eq!(
        promotion_readiness(&audit(3, 13, MIN_CONTEXT_DIVERSITY, 1)).blocking,
        vec![PromotionBlocker::SpanTooShort {
            have_days: 13,
            need_days: 14
        }]
    );
    assert_eq!(
        promotion_readiness(&audit(3, 14, 1, 1)).blocking,
        vec![PromotionBlocker::InsufficientDiversity { have: 1, need: 2 }]
    );
    assert_eq!(
        promotion_readiness(&audit(3, 14, MIN_CONTEXT_DIVERSITY, 0)).blocking,
        vec![PromotionBlocker::CounterExamplesNotChecked]
    );

    let all = promotion_readiness(&audit(2, 13, 1, 0));
    assert!(!all.ready);
    assert_eq!(
        all.blocking,
        vec![
            PromotionBlocker::TooFewSessions { have: 2, need: 3 },
            PromotionBlocker::SpanTooShort {
                have_days: 13,
                need_days: 14
            },
            PromotionBlocker::InsufficientDiversity { have: 1, need: 2 },
            PromotionBlocker::CounterExamplesNotChecked,
        ]
    );
}
