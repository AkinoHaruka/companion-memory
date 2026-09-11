//! Kernel and storage together: write, recall, supersede, forget.
//!
//! The kernel's rules and the store's queries are each tested on their own, and
//! both suites pass while a seam between them is wrong. The failure that matters
//! is a rule whose expectations the store does not satisfy — `decide_supersede`
//! requires only active records in the slot, and if a query returned superseded
//! ones the rule would quietly replace the wrong record. Nothing in either unit
//! suite can see that, so it is checked here.
//!
//! This is also where the two representations of forgetting meet. The kernel
//! reasons over a `SuppressionSet` and a fingerprint map; the store holds rows.
//! A translation that drops or mislabels a kind means the resurrection guard
//! silently stops guarding, which is invisible until a forgotten memory comes
//! back.

use companion_memory_kernel::domain::predicates::MentionMode;
use companion_memory_kernel::domain::types::{
    Claim, ClaimStatus, EvidenceRef, EvidenceSourceType, Inference, InferenceAxis, InferenceState,
    Provenance, RelationshipScope, Salience, Speaker,
};
use companion_memory_kernel::rules::evidence::{is_collapsed, live_evidence, EvidenceResolution};
use companion_memory_kernel::rules::forgetting::{
    derived_disposition, fingerprint, fingerprint_text, would_resurrect, DerivedDisposition,
    ResurrectionReason,
};
use companion_memory_kernel::rules::mention_gate::{claim_mention, MentionCues};
use companion_memory_kernel::rules::record_identity::{
    decide_supersede, SupersedeDecision, SupersedeInput,
};
use companion_memory_kernel::rules::salience::{
    apply_feedback, candidate_score, FeedbackSignal, ScoreInputs,
};
use companion_memory_storage::{OpenOptions, Store};
use serde_json::json;

const NOW: &str = "2026-06-10T12:00:00Z";

fn scope() -> RelationshipScope {
    RelationshipScope {
        service_id: "svc".into(),
        owner_user_id: "u1".into(),
        companion_profile_id: "p1".into(),
    }
}

fn provenance() -> Provenance {
    Provenance {
        agent_id: None,
        prompt_family: None,
        prompt_version: None,
        model: None,
        confidence: 0.9,
        created_at: NOW.into(),
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
        valid_from: NOW.into(),
        valid_until: None,
        status: ClaimStatus::Active,
        supersedes_id: None,
        source_refs: vec![EvidenceRef {
            source_type: EvidenceSourceType::Message,
            source_id: "m1".into(),
            speaker: Speaker::User,
            semantic_role: None,
        }],
        provenance: provenance(),
        salience: Salience { importance: 0.6, recall_count: 0, ..Salience::default() },
        created_at: NOW.into(),
        updated_at: NOW.into(),
    }
}

fn store() -> Store {
    Store::open(&OpenOptions::in_memory()).expect("open store")
}

// ---------------------------------------------------------------------------
// The write path
// ---------------------------------------------------------------------------

#[test]
fn a_new_statement_creates_a_claim_through_the_kernel_decision() {
    let store = store();
    let value = json!("designer");
    let decision = decide_supersede(
        &SupersedeInput {
            predicate: "identity.occupation",
            value: &value,
            entity_ref: None,
            qualifiers: None,
        },
        &[],
    );
    assert!(matches!(decision, SupersedeDecision::Create { .. }));

    store.put_claim(&claim("c1", "identity.occupation", value)).expect("write");
    assert_eq!(store.active_claims(&scope()).expect("read").len(), 1);
}

#[test]
fn the_slot_query_returns_exactly_what_the_rule_expects() {
    // The seam this test exists for: the rule reads the slot, so the query must
    // return active records only, for this scope, for this predicate.
    let store = store();
    store.put_claim(&claim("c1", "identity.name", json!("Xiaolin"))).expect("write");
    let superseded = claim("c0", "identity.name", json!("Old"));
    store.put_claim(&superseded).expect("write");
    store
        .set_claim_status(&scope(), "c0", ClaimStatus::Superseded, NOW)
        .expect("supersede");
    store.put_claim(&claim("c2", "identity.occupation", json!("designer"))).expect("write");

    let slot = store
        .active_claims_in_slot(&scope(), "identity.name", None)
        .expect("slot");

    assert_eq!(slot.len(), 1, "only the active name belongs in the slot");
    assert_eq!(slot[0].id, "c1");

    // And the rule, given that slice, picks the right record.
    let value = json!("Lin");
    match decide_supersede(
        &SupersedeInput {
            predicate: "identity.name",
            value: &value,
            entity_ref: None,
            qualifiers: None,
        },
        &slot.iter().collect::<Vec<_>>(),
    ) {
        SupersedeDecision::Supersede { supersedes_id, .. } => assert_eq!(supersedes_id, "c1"),
        other => panic!("expected a supersede of the active record, got {other:?}"),
    }
}

#[test]
fn a_correction_leaves_the_old_claim_readable_but_not_competing() {
    // "I changed my mind" must produce a new version without erasing the old
    // one: the history is what lets the companion explain itself, and the
    // superseded row is what stops it from being offered as current.
    let store = store();
    store.put_claim(&claim("c1", "identity.name", json!("Xiaolin"))).expect("write");

    let slot = store
        .active_claims_in_slot(&scope(), "identity.name", None)
        .expect("slot");
    let value = json!("Lin");
    let decision = decide_supersede(
        &SupersedeInput {
            predicate: "identity.name",
            value: &value,
            entity_ref: None,
            qualifiers: None,
        },
        &slot.iter().collect::<Vec<_>>(),
    );
    let SupersedeDecision::Supersede { supersedes_id, .. } = decision else {
        panic!("expected a supersede");
    };

    store
        .set_claim_status(&scope(), &supersedes_id, ClaimStatus::Superseded, NOW)
        .expect("mark superseded");
    let mut next = claim("c2", "identity.name", value);
    next.supersedes_id = Some(supersedes_id);
    store.put_claim(&next).expect("write");

    let active = store.active_claims(&scope()).expect("read");
    assert_eq!(active.len(), 1, "only the current version is active");
    assert_eq!(active[0].id, "c2");
    assert_eq!(active[0].supersedes_id.as_deref(), Some("c1"));

    // The old version is still there, reachable by id.
    let old = store.get_claim(&scope(), "c1").expect("read").expect("present");
    assert_eq!(old.status, ClaimStatus::Superseded);
    assert_eq!(old.value, json!("Xiaolin"));
}

#[test]
fn a_set_predicate_accumulates_rather_than_replacing() {
    // "I design, and I also teach painting" must not lose either half.
    let store = store();
    store.put_claim(&claim("c1", "identity.occupation", json!("designer"))).expect("write");

    let slot = store
        .active_claims_in_slot(&scope(), "identity.occupation", None)
        .expect("slot");
    let value = json!("art teacher");
    let decision = decide_supersede(
        &SupersedeInput {
            predicate: "identity.occupation",
            value: &value,
            entity_ref: None,
            qualifiers: None,
        },
        &slot.iter().collect::<Vec<_>>(),
    );
    assert!(matches!(decision, SupersedeDecision::Append { .. }));

    store.put_claim(&claim("c2", "identity.occupation", value)).expect("write");
    assert_eq!(store.active_claims(&scope()).expect("read").len(), 2);
}

#[test]
fn a_type_incompatible_write_is_refused_and_changes_nothing() {
    // The guard that makes a misclassification survivable: a vague remark must
    // not overwrite a resolved instant.
    let store = store();
    store
        .put_claim(&claim("d1", "open_loop.deadline", json!("2026-06-10T14:00:00Z")))
        .expect("write");

    let slot = store
        .active_claims_in_slot(&scope(), "open_loop.deadline", None)
        .expect("slot");
    let value = json!("next Wednesday, sometime");
    let decision = decide_supersede(
        &SupersedeInput {
            predicate: "open_loop.deadline",
            value: &value,
            entity_ref: None,
            qualifiers: None,
        },
        &slot.iter().collect::<Vec<_>>(),
    );
    assert!(matches!(decision, SupersedeDecision::Reject { .. }));

    // Nothing was written, so the resolved deadline is intact.
    let active = store.active_claims(&scope()).expect("read");
    assert_eq!(active.len(), 1);
    assert_eq!(active[0].value, json!("2026-06-10T14:00:00Z"));
}

// ---------------------------------------------------------------------------
// Recall
// ---------------------------------------------------------------------------

#[test]
fn recall_reads_a_stored_claim_and_applies_the_mention_gate() {
    let store = store();
    store
        .put_claim(&claim("b1", "boundary.topic_avoid", json!("do not bring up my ex")))
        .expect("write");

    let stored = store.active_claims(&scope()).expect("read");
    let cues = MentionCues { user_referenced: true, ..MentionCues::default() };

    // A boundary is a constraint, not a candidate: even with every cue set it
    // stays background, which is what stops the companion announcing its rules.
    let decision = claim_mention(&stored[0], cues);
    assert!(
        matches!(decision, companion_memory_kernel::rules::mention_gate::MentionDecision::Allowed { background_only: true, .. }),
        "a boundary must be usable as background and never recited"
    );
}

#[test]
fn scoring_a_recalled_claim_uses_the_salience_it_was_stored_with() {
    let store = store();
    let mut important = claim("c1", "goal.current_focus", json!("finishing a thesis"));
    important.salience.importance = 0.95;
    store.put_claim(&important).expect("write");

    let stored = store.get_claim(&scope(), "c1").expect("read").expect("present");
    assert_eq!(
        stored.salience.importance, 0.95,
        "the ranking projection must survive the round trip or scoring is blind"
    );

    let score = candidate_score(&ScoreInputs {
        predicate: &stored.predicate,
        salience: &stored.salience,
        relevance: 1.0,
        confidence: stored.provenance.confidence,
        last_seen: NOW,
        now: NOW,
        half_life_days: 30,
        explicit_trigger: false,
    })
    .expect("goal predicates are scored");
    assert!(score > 0.0);
}

#[test]
fn feedback_survives_a_write_and_read() {
    // The I6 property through the store: neutral feedback must not move
    // importance, and a real signal must.
    let store = store();
    store.put_claim(&claim("c1", "goal.current_focus", json!("x"))).expect("write");

    let stored = store.get_claim(&scope(), "c1").expect("read").expect("present");
    let unchanged = apply_feedback(&stored.salience, FeedbackSignal::None);
    assert_eq!(unchanged, stored.salience);

    let mut valued = stored.clone();
    valued.salience = apply_feedback(&stored.salience, FeedbackSignal::UserValued);
    store.put_claim(&valued).expect("write");

    let reread = store.get_claim(&scope(), "c1").expect("read").expect("present");
    assert!(reread.salience.importance > stored.salience.importance);
}

// ---------------------------------------------------------------------------
// Forgetting
// ---------------------------------------------------------------------------

#[test]
fn the_two_fingerprint_entry_points_agree_on_the_same_content() {
    // The defect this test exists for: the suppression side fingerprinted plain
    // text while the guard fingerprinted the value, and the two disagreed by the
    // quoting the string wrapper added. The guard then compared strings that
    // could never be equal and never fired, which looked like nothing at all.
    let text = "the dog was sick that night";
    assert_eq!(
        fingerprint_text(text),
        fingerprint(&json!(text)),
        "a host fingerprinting prose and the guard fingerprinting the value must agree"
    );
    // And the canonical form is not quoted text.
    assert!(!fingerprint_text(text).contains('"'));
}

#[test]
fn forgetting_suppresses_the_fingerprint_and_the_guard_refuses_the_same_value() {
    // The whole point of fingerprints: suppression that only filters reads
    // leaves the next extraction free to write the same fact again.
    let store = store();
    let text = "the dog was sick that night";
    store.put_claim(&claim("e1", "event", json!(text))).expect("write");

    store
        .suppress(
            &scope(),
            "record",
            "e1",
            Some(&fingerprint(&json!(text))),
            Some("the dog"),
            NOW,
        )
        .expect("suppress");

    let suppression = store.load_suppression_set(&scope()).expect("load set");
    let fingerprints = store.load_suppressed_fingerprints(&scope()).expect("load fingerprints");

    // The guard fires on an identical value.
    let reason = would_resurrect("event", &json!(text), None, &suppression, &fingerprints);
    assert!(
        matches!(reason, Some(ResurrectionReason::FingerprintMatch { .. })),
        "an identical value must not be writable again, got {reason:?}"
    );

    // And it does not fire on something unrelated.
    let unrelated = would_resurrect(
        "event",
        &json!("they got a new job in April"),
        None,
        &suppression,
        &fingerprints,
    );
    assert_eq!(unrelated, None, "unrelated content must still be writable");
}

#[test]
fn a_suppressed_record_is_withheld_from_the_reader() {
    let store = store();
    store.put_claim(&claim("c1", "identity.name", json!("Xiaolin"))).expect("write");
    store
        .suppress(&scope(), "record", "c1", None, None, NOW)
        .expect("suppress");

    let suppression = store.load_suppression_set(&scope()).expect("load set");
    let claims = store.active_claims(&scope()).expect("read");
    assert_eq!(claims.len(), 1, "the store still holds the row");

    // Withholding is the reader's decision, driven by the set the kernel owns.
    let visible: Vec<&Claim> = claims
        .iter()
        .filter(|candidate| !suppression.suppresses_claim(candidate))
        .collect();
    assert!(visible.is_empty(), "a suppressed record must not be offered");
}

#[test]
fn each_suppression_kind_maps_to_the_matching_kernel_field() {
    // A translation that mislabels a kind means the guard silently stops
    // guarding. Each kind is checked against the field it is supposed to fill.
    let store = store();
    store.suppress(&scope(), "record", "c1", None, None, NOW).expect("suppress");
    store
        .suppress(&scope(), "predicate", "identity.location", None, None, NOW)
        .expect("suppress");
    store.suppress(&scope(), "entity", "person-9", None, None, NOW).expect("suppress");

    let set = store.load_suppression_set(&scope()).expect("load");
    assert!(set.suppressed.contains("c1"));
    assert!(set.suppressed_predicates.contains("identity.location"));
    assert!(set.suppressed_entities.contains("person-9"));
    assert!(!set.all, "individual kinds must not set the all flag");

    // And the guard consults each one.
    let fingerprints = store.load_suppressed_fingerprints(&scope()).expect("load");
    assert!(matches!(
        would_resurrect("identity.location", &json!("shanghai"), None, &set, &fingerprints),
        Some(ResurrectionReason::PredicateSuppressed { .. })
    ));
    assert!(matches!(
        would_resurrect("person.name", &json!("someone"), Some("person-9"), &set, &fingerprints),
        Some(ResurrectionReason::EntitySuppressed { .. })
    ));
}

#[test]
fn suppressing_everything_withholds_every_predicate() {
    let store = store();
    store.suppress(&scope(), "all", "", None, None, NOW).expect("suppress");

    let set = store.load_suppression_set(&scope()).expect("load");
    assert!(set.all);
    assert!(matches!(
        would_resurrect("identity.name", &json!("anything"), None, &set, &Default::default()),
        Some(ResurrectionReason::AllSuppressed)
    ));
}

#[test]
fn an_unrecognised_suppression_kind_is_skipped_rather_than_failing_the_load() {
    // One unreadable row must not make a person's whole history inaccessible.
    let store = store();
    store.suppress(&scope(), "record", "c1", None, None, NOW).expect("suppress");
    store
        .suppress(&scope(), "some_future_kind", "x", None, None, NOW)
        .expect("suppress");

    let set = store.load_suppression_set(&scope()).expect("load");
    assert!(set.suppressed.contains("c1"));
    assert!(!set.all);
}

// ---------------------------------------------------------------------------
// Derived records
// ---------------------------------------------------------------------------

#[test]
fn suppressing_an_inferences_whole_support_collapses_it() {
    // The resurrection vector deletion misses: an inference computed from
    // forgotten evidence keeps asserting it after the original is gone.
    let store = store();
    let inference = Inference {
        id: "i1".into(),
        scope: scope(),
        axis: InferenceAxis::Pattern,
        predicate: "goal.current_focus".into(),
        value: "has been tired for months".into(),
        state: InferenceState::Accumulating,
        confidence: 0.4,
        support_evidence: vec![EvidenceRef {
            source_type: EvidenceSourceType::Claim,
            source_id: "c1".into(),
            speaker: Speaker::User,
            semantic_role: None,
        }],
        counter_evidence: Vec::new(),
        promotion_audit: None,
        user_acknowledged_at: None,
        use_mode: MentionMode::BackgroundOnly,
        expires_at: None,
        salience: Salience::default(),
        created_at: NOW.into(),
        updated_at: NOW.into(),
    };
    store.put_inference(&inference).expect("write");

    let stored = store.get_inference(&scope(), "i1").expect("read").expect("present");
    assert_eq!(stored.support_evidence.len(), 1, "evidence must survive the round trip");

    // Suppress the supporting claim.
    store.suppress(&scope(), "record", "c1", None, None, NOW).expect("suppress");
    let suppression = store.load_suppression_set(&scope()).expect("load");

    let mut resolution = EvidenceResolution::default();
    resolution.suppressed.insert("c1".into());

    assert!(
        is_collapsed(&stored.support_evidence, &resolution),
        "an inference whose evidence is gone must collapse (I5)"
    );
    assert!(live_evidence(&stored.support_evidence, &resolution).is_empty());

    // And the disposition says so rather than leaving the host to infer it.
    let disposition = derived_disposition(&stored, &suppression, &resolution, |_, _| 0.4);
    assert!(
        matches!(disposition, DerivedDisposition::Collapsed | DerivedDisposition::Withheld),
        "expected a collapsed or withheld disposition, got {disposition:?}"
    );
}

#[test]
fn directly_suppressing_an_inference_withholds_it_regardless_of_its_evidence() {
    let store = store();
    let inference = Inference {
        id: "i1".into(),
        scope: scope(),
        axis: InferenceAxis::Disposition,
        predicate: "goal.current_focus".into(),
        value: "prefers to be left alone when low".into(),
        state: InferenceState::Active,
        confidence: 0.5,
        support_evidence: vec![EvidenceRef {
            source_type: EvidenceSourceType::Claim,
            source_id: "c1".into(),
            speaker: Speaker::User,
            semantic_role: None,
        }],
        counter_evidence: Vec::new(),
        promotion_audit: None,
        user_acknowledged_at: None,
        use_mode: MentionMode::BackgroundOnly,
        expires_at: None,
        salience: Salience::default(),
        created_at: NOW.into(),
        updated_at: NOW.into(),
    };
    store.put_inference(&inference).expect("write");
    store.suppress(&scope(), "record", "i1", None, None, NOW).expect("suppress");

    let stored = store.get_inference(&scope(), "i1").expect("read").expect("present");
    let suppression = store.load_suppression_set(&scope()).expect("load");
    // The evidence itself is untouched, so only a direct check catches this.
    let resolution = EvidenceResolution::default();

    let disposition = derived_disposition(&stored, &suppression, &resolution, |_, _| 0.5);
    assert!(
        matches!(disposition, DerivedDisposition::Withheld),
        "a directly suppressed inference is withheld even with live evidence, got {disposition:?}"
    );
}
