//! Record identity and supersede behaviour.
//!
//! These tests pin the fix for the design's most severe defect: `kind + subject`
//! is not a memory primary key, and a misclassified input must not silently
//! destroy a classified fact.

use companion_memory_kernel::domain::predicates::{require_spec, ValueKind};
use companion_memory_kernel::domain::types::{
    Claim, ClaimStatus, Provenance, RelationshipScope, Salience,
};
use companion_memory_kernel::rules::record_identity::{
    canonical_key, canonical_key_parts, classify_value, decide_supersede, is_inert,
    normalize_for_comparison, supersedes_by_cardinality, values_equivalent, SlotKey,
    SupersedeDecision, SupersedeInput, SupersedeRejection, ValueClass,
};
use serde_json::json;

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

/// A minimal active claim. `id` and `updated_at` are parameters because the
/// authority tie-break depends on them.
fn claim(id: &str, predicate: &str, value: serde_json::Value, updated_at: &str) -> Claim {
    Claim {
        id: id.into(),
        scope: scope(),
        predicate: predicate.into(),
        entity_ref: None,
        qualifiers: None,
        value,
        raw_value: None,
        valid_from: "2026-01-01T00:00:00Z".into(),
        valid_until: None,
        status: ClaimStatus::Active,
        supersedes_id: None,
        source_refs: Vec::new(),
        provenance: provenance(),
        salience: Salience::default(),
        created_at: "2026-01-01T00:00:00Z".into(),
        updated_at: updated_at.into(),
    }
}

fn input<'a>(predicate: &'a str, value: &'a serde_json::Value) -> SupersedeInput<'a> {
    SupersedeInput {
        predicate,
        value,
        entity_ref: None,
        qualifiers: None,
    }
}

// ---------------------------------------------------------------------------
// Slot identity
// ---------------------------------------------------------------------------

#[test]
fn qualifier_order_does_not_change_the_slot() {
    // The whole point of a canonical key: the same fact keyed in a different
    // field order must not accumulate duplicates.
    let first = json!({ "use": "work", "since": 2020 });
    let second = json!({ "since": 2020, "use": "work" });
    let left = SlotKey {
        predicate: "identity.location",
        entity_ref: Some("shanghai"),
        qualifiers: Some(&first),
    };
    let right = SlotKey {
        predicate: "identity.location",
        entity_ref: Some("shanghai"),
        qualifiers: Some(&second),
    };
    assert_eq!(canonical_key_parts(&left), canonical_key_parts(&right));
}

#[test]
fn different_entities_are_different_slots() {
    let qualifiers = json!({});
    let left = SlotKey {
        predicate: "person.name",
        entity_ref: Some("person-a"),
        qualifiers: Some(&qualifiers),
    };
    let right = SlotKey {
        predicate: "person.name",
        entity_ref: Some("person-b"),
        qualifiers: Some(&qualifiers),
    };
    assert_ne!(canonical_key_parts(&left), canonical_key_parts(&right));
}

#[test]
fn a_missing_entity_is_not_the_empty_string_entity() {
    let qualifiers = json!({});
    let absent = SlotKey {
        predicate: "person.name",
        entity_ref: None,
        qualifiers: Some(&qualifiers),
    };
    let empty = SlotKey {
        predicate: "person.name",
        entity_ref: Some(""),
        qualifiers: Some(&qualifiers),
    };
    assert_ne!(canonical_key_parts(&absent), canonical_key_parts(&empty));
}

#[test]
fn the_readable_key_names_the_entity_and_qualifiers() {
    let qualifiers = json!({ "use": "work" });
    let slot = SlotKey {
        predicate: "identity.location",
        entity_ref: Some("shanghai"),
        qualifiers: Some(&qualifiers),
    };
    assert_eq!(canonical_key(&slot), "identity.location@shanghai{use=work}");
}

// ---------------------------------------------------------------------------
// Value equivalence
// ---------------------------------------------------------------------------

#[test]
fn equivalence_ignores_case_and_whitespace_only() {
    assert!(values_equivalent(
        &json!("  I  Design "),
        &json!("i design")
    ));
    // Deliberately NOT fuzzy: two different statements stay two statements.
    assert!(!values_equivalent(
        &json!("I design"),
        &json!("I teach painting")
    ));
    assert!(!values_equivalent(&json!("designer"), &json!("design")));
}

#[test]
fn normalisation_is_total() {
    assert_eq!(normalize_for_comparison(&json!(null)), "null");
    assert_eq!(normalize_for_comparison(&json!(2020)), "2020");
}

// ---------------------------------------------------------------------------
// Cardinality and inertness
// ---------------------------------------------------------------------------

#[test]
fn only_single_cardinalities_supersede() {
    use companion_memory_kernel::domain::predicates::Cardinality;
    assert!(supersedes_by_cardinality(Cardinality::Single));
    assert!(supersedes_by_cardinality(Cardinality::TemporalSingle));
    assert!(!supersedes_by_cardinality(Cardinality::Set));
}

#[test]
fn only_the_misc_domain_is_inert() {
    assert!(is_inert(
        companion_memory_kernel::domain::predicate_keys::Domain::Misc
    ));
    for domain in companion_memory_kernel::domain::predicate_keys::Domain::ALL {
        if *domain != companion_memory_kernel::domain::predicate_keys::Domain::Misc {
            assert!(!is_inert(*domain), "{domain:?} must not be inert");
        }
    }
}

// ---------------------------------------------------------------------------
// decide_supersede
// ---------------------------------------------------------------------------

#[test]
fn an_empty_slot_is_a_create() {
    let value = json!("designer");
    assert!(matches!(
        decide_supersede(&input("identity.occupation", &value), &[]),
        SupersedeDecision::Create { .. }
    ));
}

#[test]
fn an_unknown_predicate_is_refused() {
    let value = json!("x");
    match decide_supersede(&input("nope.nope", &value), &[]) {
        SupersedeDecision::Reject { reason, .. } => {
            assert_eq!(reason, SupersedeRejection::UnknownPredicate)
        }
        other => panic!("expected a refusal, got {other:?}"),
    }
}

#[test]
fn a_set_predicate_appends_instead_of_replacing() {
    // The defect this encodes: "I design, and I also teach painting" must not
    // lose either half.
    let existing = claim(
        "c1",
        "identity.occupation",
        json!("designer"),
        "2026-01-01T00:00:00Z",
    );
    let value = json!("art teacher");
    match decide_supersede(&input("identity.occupation", &value), &[&existing]) {
        SupersedeDecision::Append { spec } => assert_eq!(spec.key, "identity.occupation"),
        other => panic!("a set must accumulate, got {other:?}"),
    }
}

#[test]
fn a_set_predicate_merges_an_equivalent_value() {
    let existing = claim(
        "c1",
        "identity.occupation",
        json!("Designer"),
        "2026-01-01T00:00:00Z",
    );
    let value = json!("  designer ");
    match decide_supersede(&input("identity.occupation", &value), &[&existing]) {
        SupersedeDecision::Merge { into_id, .. } => assert_eq!(into_id, "c1"),
        other => panic!("expected a merge, got {other:?}"),
    }
}

#[test]
fn a_temporal_single_predicate_supersedes() {
    let existing = claim(
        "c1",
        "identity.name",
        json!("Xiaolin"),
        "2026-01-01T00:00:00Z",
    );
    let value = json!("Lin");
    match decide_supersede(&input("identity.name", &value), &[&existing]) {
        SupersedeDecision::Supersede { supersedes_id, .. } => assert_eq!(supersedes_id, "c1"),
        other => panic!("expected a supersede, got {other:?}"),
    }
}

#[test]
fn the_misc_escape_hatch_never_displaces_anything() {
    // Invariant I2 read literally: a `misc` record never triggers a supersede.
    // It does not say the statement is thrown away, and throwing it away is the
    // one outcome the escape hatch exists to prevent — everything the registry's
    // keys cannot name would be lost, and the loss would present as a policy
    // refusing a candidate rather than as a gap in the vocabulary.
    let existing = claim(
        "c1",
        "misc.unclassified",
        json!("something"),
        "2026-01-01T00:00:00Z",
    );
    let value = json!("something else");
    match decide_supersede(&input("misc.unclassified", &value), &[&existing]) {
        SupersedeDecision::Append { .. } => {}
        other => panic!("an unclassified statement must be kept alongside, got {other:?}"),
    }
}

#[test]
fn an_unclassified_statement_is_writable_at_all() {
    // The escape hatch has to be able to hold the first statement, or the
    // accumulation above never begins. Everything the vocabulary cannot classify
    // passes through here, which for a daily companionship product is not a rare
    // path: it is most of what a person talks about.
    let value = json!("楼下那只三花猫今天又蹲在同一个台阶上");
    match decide_supersede(&input("misc.unclassified", &value), &[]) {
        SupersedeDecision::Create { .. } => {}
        other => panic!("nothing else can hold this statement, got {other:?}"),
    }
}

#[test]
fn an_unclassified_restatement_is_merged_rather_than_duplicated() {
    // The other half of inertness: repeating yourself must not build a pile of
    // identical records. Without this, "stored rather than dropped" would trade
    // one problem for a worse one, because nothing here is ever superseded.
    let existing = claim("c1", "misc.unclassified", json!("又下雨了"), "2026-01-01T00:00:00Z");
    let value = json!("又下雨了");
    match decide_supersede(&input("misc.unclassified", &value), &[&existing]) {
        SupersedeDecision::Merge { into_id, .. } => assert_eq!(into_id, "c1"),
        other => panic!("a restatement must not become a second record, got {other:?}"),
    }
}

#[test]
fn an_entity_predicate_without_an_entity_is_refused() {
    let value = json!("shanghai");
    match decide_supersede(&input("identity.location", &value), &[]) {
        SupersedeDecision::Reject { reason, .. } => {
            assert_eq!(reason, SupersedeRejection::RequiresEntityRef)
        }
        other => panic!("expected a refusal, got {other:?}"),
    }
}

#[test]
fn prose_never_supersedes_a_structured_value() {
    // The type-compatibility guard. A resolved date must survive a vague
    // remark: "next Wednesday, sometime" is not a correction.
    //
    // It now fails at classification rather than compatibility, which is the
    // stricter and correct outcome: an unresolved time reference is not a Date
    // value at all, so it never reaches the slot. It stays a candidate with the
    // user's wording in `raw_value` until a resolver turns it into an instant.
    let existing = claim(
        "c1",
        "open_loop.deadline",
        json!("2026-06-10T14:00:00Z"),
        "2026-01-01T00:00:00Z",
    );
    let value = json!("next Wednesday, sometime");
    match decide_supersede(&input("open_loop.deadline", &value), &[&existing]) {
        SupersedeDecision::Reject { reason, detail } => {
            assert_eq!(reason, SupersedeRejection::InvalidValue);
            assert!(
                detail.contains("ISO 8601"),
                "detail should name the shape: {detail}"
            );
        }
        other => panic!("prose must not overwrite a structured value, got {other:?}"),
    }
}

#[test]
fn a_more_precise_date_may_refine_a_coarser_one() {
    // The refinement direction that does exist: a day resolved to a time, and a
    // month resolved to a day.
    let day = claim(
        "c1",
        "open_loop.deadline",
        json!("2026-06-10"),
        "2026-01-01T00:00:00Z",
    );
    let with_time = json!("2026-06-10T14:00:00Z");
    match decide_supersede(&input("open_loop.deadline", &with_time), &[&day]) {
        SupersedeDecision::Supersede { supersedes_id, .. } => assert_eq!(supersedes_id, "c1"),
        other => panic!("a resolved time should refine a date, got {other:?}"),
    }

    let month = claim(
        "c2",
        "open_loop.deadline",
        json!("2026-06"),
        "2026-01-01T00:00:00Z",
    );
    let with_day = json!("2026-06-10");
    match decide_supersede(&input("open_loop.deadline", &with_day), &[&month]) {
        SupersedeDecision::Supersede { supersedes_id, .. } => assert_eq!(supersedes_id, "c2"),
        other => panic!("a resolved day should refine a month, got {other:?}"),
    }
}

#[test]
fn iso_date_shape_accepts_calendar_forms_and_rejects_prose() {
    use companion_memory_kernel::domain::types::is_iso_date_shape;
    for good in [
        "2026-06-10",
        "2026-06",
        "2026",
        "2026-06-10T14:00",
        "2026-06-10T14:00:00",
        "2026-06-10T14:00:00Z",
        "2026-06-10T14:00:00.123Z",
        "2026-06-10T14:00:00+08:00",
        "2026-06-10T14:00:00+0800",
        "2026-06-10 14:00",
    ] {
        assert!(is_iso_date_shape(good), "{good:?} should be a date shape");
    }
    for bad in [
        "",
        "next Wednesday",
        "next Wednesday, sometime",
        "sometime next week",
        "2026/06/10",
        "26-06-10",
        "2026-6-10",
        "2026-06-10T14",
        "2026-06-10T14:00:00+08:0",
        "2026-06-10T-1:00",
    ] {
        assert!(!is_iso_date_shape(bad), "{bad:?} must not be a date shape");
    }
}

#[test]
fn an_out_of_domain_enum_value_is_refused() {
    let value = json!("banana");
    match decide_supersede(&input("communication.verbosity", &value), &[]) {
        SupersedeDecision::Reject { reason, .. } => {
            assert_eq!(reason, SupersedeRejection::InvalidValue)
        }
        other => panic!("expected a refusal, got {other:?}"),
    }
}

#[test]
fn a_numeric_string_is_accepted_for_a_number_predicate() {
    let value = json!("1990");
    assert!(matches!(
        decide_supersede(&input("identity.age", &value), &[]),
        SupersedeDecision::Create { .. }
    ));
}

#[test]
fn the_newest_record_represents_a_slot_with_several_actives() {
    // Concurrent writes should resolve deterministically, not by slice order.
    let older = claim("c1", "identity.name", json!("Old"), "2026-01-01T00:00:00Z");
    let newer = claim("c2", "identity.name", json!("New"), "2026-02-01T00:00:00Z");
    let value = json!("Newest");
    match decide_supersede(&input("identity.name", &value), &[&newer, &older]) {
        SupersedeDecision::Supersede { supersedes_id, .. } => assert_eq!(supersedes_id, "c2"),
        other => panic!("expected the newest active to be replaced, got {other:?}"),
    }
}

// ---------------------------------------------------------------------------
// Value classification
// ---------------------------------------------------------------------------

#[test]
fn classification_reports_the_declared_kind() {
    let verbosity = require_spec("communication.verbosity");
    assert_eq!(
        classify_value(verbosity, &json!("short")),
        ValueClass::Classifiable(ValueKind::Enum)
    );
    assert!(matches!(
        classify_value(verbosity, &json!("banana")),
        ValueClass::Unclassifiable(_)
    ));

    let age = require_spec("identity.age");
    assert_eq!(
        classify_value(age, &json!(1990)),
        ValueClass::Classifiable(ValueKind::Number)
    );
    assert_eq!(
        classify_value(age, &json!("1990")),
        ValueClass::Classifiable(ValueKind::Number)
    );
    assert!(matches!(
        classify_value(age, &json!("old")),
        ValueClass::Unclassifiable(_)
    ));
}

#[test]
fn classification_refuses_empty_and_ill_typed_values() {
    let name = require_spec("identity.name");
    assert!(matches!(
        classify_value(name, &json!(null)),
        ValueClass::Unclassifiable(_)
    ));
    assert!(matches!(
        classify_value(name, &json!("   ")),
        ValueClass::Unclassifiable(_)
    ));
    assert!(matches!(
        classify_value(name, &json!(42)),
        ValueClass::Unclassifiable(_)
    ));
}

#[test]
fn numeric_text_recognition_rejects_partial_numbers() {
    let age = require_spec("identity.age");
    for bad in ["", "-", ".", "1.2.3", "12a", "1e5"] {
        assert!(
            matches!(
                classify_value(age, &json!(bad)),
                ValueClass::Unclassifiable(_)
            ),
            "{bad:?} must not classify as a number"
        );
    }
    for good in ["1990", "-5", "1.5", " 42 "] {
        assert_eq!(
            classify_value(age, &json!(good)),
            ValueClass::Classifiable(ValueKind::Number),
            "{good:?} should classify as a number"
        );
    }
}
