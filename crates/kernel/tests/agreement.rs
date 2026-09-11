//! The vocabulary and the registry must describe exactly the same key set.
//!
//! This is the test that makes the vocabulary-as-data design worth its weight:
//! a key declared in one table and forgotten in the other fails here instead of
//! silently becoming unreachable, which is how the TypeScript prototype lost
//! value validation for `relationship.type` without any signal.

use companion_memory_kernel::domain::predicate_keys::{
    all_predicate_keys, is_predicate_key, is_valid_predicate_shape, split_predicate, Domain,
    MISC_PREDICATE, PREDICATE_KEYS,
};
use companion_memory_kernel::domain::predicates::{
    kinds_compatible, mention_policy_for, missing_specs, orphan_specs, registry, require_spec,
    spec_for, Cardinality, MentionMode, ValueKind,
};

#[test]
fn vocabulary_and_registry_agree() {
    assert_eq!(missing_specs(), Vec::<&str>::new(), "declared keys without a registry row");
    assert_eq!(orphan_specs(), Vec::<&str>::new(), "registry rows without a declared key");
}

#[test]
fn every_declared_key_parses_into_its_own_domain() {
    for key in all_predicate_keys() {
        assert!(
            is_valid_predicate_shape(key),
            "malformed key in the vocabulary: {key}"
        );
        let (domain, subject) = split_predicate(key).unwrap_or_else(|| panic!("malformed key {key}"));
        assert!(!subject.is_empty(), "empty subject in {key}");
        assert_eq!(
            format!("{}.{}", domain.as_str(), subject),
            key,
            "key does not round-trip through its domain prefix"
        );
    }
}

#[test]
fn the_key_splitter_rejects_malformed_input() {
    // The registry derives each row's domain through this function, so its
    // rejection cases are load-bearing rather than incidental.
    assert!(split_predicate("identity").is_none(), "no separator");
    assert!(split_predicate(".name").is_none(), "empty domain");
    assert!(split_predicate("identity.").is_none(), "empty subject");
    assert!(split_predicate("nope.name").is_none(), "unknown domain");
    assert!(split_predicate("").is_none(), "empty input");
    assert_eq!(split_predicate("identity.name"), Some((Domain::Identity, "name")));
    // A subject may itself contain a dot; only the first separator counts.
    assert_eq!(
        split_predicate("identity.name.extra"),
        Some((Domain::Identity, "name.extra"))
    );
}

#[test]
fn grouping_matches_the_declared_domains() {
    assert_eq!(
        PREDICATE_KEYS.len(),
        Domain::ALL.len(),
        "one group per domain, in Domain::ALL order"
    );
    for (group, domain) in PREDICATE_KEYS.iter().zip(Domain::ALL.iter()) {
        for key in group.iter() {
            let (parsed, _) = split_predicate(key).expect("key parses");
            assert_eq!(parsed, *domain, "{key} is filed under the wrong domain group");
        }
    }
}

#[test]
fn every_registry_row_is_self_consistent() {
    for spec in registry() {
        let (domain, _) = split_predicate(spec.key).expect("registry key parses");
        assert_eq!(domain, spec.domain, "{} has a mismatched domain", spec.key);
        assert!(
            is_predicate_key(spec.key),
            "{} is not declared in the vocabulary",
            spec.key
        );

        // A closed vocabulary with no domain means value validation accepts
        // anything, which is the defect this assertion exists to prevent.
        if spec.kind == ValueKind::Enum {
            let domain_values = spec
                .enum_domain
                .unwrap_or_else(|| panic!("enum predicate {} has no declared domain", spec.key));
            assert!(!domain_values.is_empty(), "{} has an empty enum domain", spec.key);
        } else {
            assert!(
                spec.enum_domain.is_none(),
                "{} is not an enum but declares an enum domain",
                spec.key
            );
        }

        assert!(!spec.description.is_empty(), "{} has no description", spec.key);
    }
}

#[test]
fn misc_is_inert() {
    let spec = require_spec(MISC_PREDICATE);
    assert_eq!(spec.domain, Domain::Misc);
    assert_eq!(spec.cardinality, Cardinality::Set, "a set never supersedes");
    assert!(!spec.inference_allowed, "unclassified statements must not seed inference");
}

#[test]
fn boundary_is_a_constraint_not_a_candidate() {
    for spec in registry().iter().filter(|spec| spec.domain == Domain::Boundary) {
        assert_eq!(
            spec.mention_policy,
            MentionMode::BackgroundOnly,
            "{} must never be recited",
            spec.key
        );
        assert!(
            !spec.inference_allowed,
            "{} is an obligation, not evidence about the user",
            spec.key
        );
    }
}

#[test]
fn predicates_that_can_legitimately_hold_several_values_are_sets() {
    // These specific rows encode the fix for "kind + subject is not a memory
    // primary key". If one of them becomes Single, a second concurrent value
    // would silently supersede the first.
    assert_eq!(require_spec("identity.occupation").cardinality, Cardinality::Set);
    assert_eq!(require_spec("identity.role").cardinality, Cardinality::Set);
    assert_eq!(require_spec("boundary.topic_avoid").cardinality, Cardinality::Set);
    assert_eq!(require_spec("identity.name").cardinality, Cardinality::TemporalSingle);
    assert_eq!(require_spec("communication.verbosity").cardinality, Cardinality::Single);
}

#[test]
fn text_may_refine_but_never_overwrite_a_structured_value() {
    // The asymmetry is the whole point of the table: prose must not replace a
    // resolved date.
    for kind in ValueKind::ALL.iter().copied().filter(|k| *k != ValueKind::Text) {
        assert!(
            kinds_compatible(ValueKind::Text, kind),
            "text should be able to refine {kind:?}"
        );
        assert!(
            !kinds_compatible(kind, ValueKind::Text),
            "{kind:?} must not be overwritable by prose"
        );
    }
}

#[test]
fn compatibility_is_reflexive() {
    for kind in ValueKind::ALL.iter().copied() {
        assert!(kinds_compatible(kind, kind), "{kind:?} is not compatible with itself");
    }
}

#[test]
fn unknown_predicates_default_closed() {
    assert!(spec_for("nope.nope").is_none());
    assert_eq!(
        mention_policy_for("nope.nope"),
        MentionMode::BackgroundOnly,
        "an unknown predicate must not become freely mentionable"
    );
    assert!(
        !companion_memory_kernel::domain::predicates::inference_allowed_for("nope.nope"),
        "an unknown predicate must not be usable as inference evidence"
    );
}

#[test]
fn relationship_type_keeps_its_closed_domain() {
    // Regression pin for the subject-keyed lookup defect.
    let spec = require_spec("relationship.type");
    let values = spec.enum_domain.expect("relationship.type must declare its domain");
    assert!(values.contains(&"romantic"));
    assert!(!values.contains(&"complicated"));
}
