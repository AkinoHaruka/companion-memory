//! Record identity and supersede decisions.
//!
//! This module exists because `kind + subject` is not a memory primary key.
//! "I design, and I also teach painting on weekends" cannot have its second half
//! supersede its first, and a misclassified location remark must never silently
//! destroy a precise location fact.
//!
//! Three guards, in order of application:
//!   1. `cardinality` — a set predicate never supersedes, it only merges
//!   2. `misc` — the unclassified escape hatch is inert (invariant I2)
//!   3. type compatibility — a vague value cannot overwrite a structured one
//!
//! A rejected write is always a *reportable* outcome, never a panic: extraction
//! runs on model output, and the caller's job is to keep the candidate rather
//! than crash.

use crate::domain::predicate_keys::MISC_PREDICATE;
use crate::domain::predicates::{
    kinds_compatible, spec_for, Cardinality, PredicateSpec, ValueKind,
};
use crate::domain::types::{is_iso_date_shape, Claim};

/// The identity of a slot: the triple that decides which records compete.
///
/// Note what is *not* here — importance, timestamps, or the value itself. Two
/// claims share a slot when they make a statement about the same predicate, of
/// the same subject, under the same qualifiers, regardless of what they say.
#[derive(Debug, Clone, PartialEq)]
pub struct SlotKey<'a> {
    /// Registry key.
    pub predicate: &'a str,
    /// Person or place the statement is about.
    pub entity_ref: Option<&'a str>,
    /// Distinguishes concurrent values of one predicate.
    pub qualifiers: Option<&'a serde_json::Value>,
}

/// Recursively sort object keys so that two structurally equal JSON values
/// serialise identically.
///
/// Without this, `{"use":"work","since":2020}` and `{"since":2020,"use":"work"}`
/// would be different slots, and the same fact keyed in a different field order
/// would accumulate duplicates — the exact failure this module exists to
/// prevent.
fn canonical_json(value: &serde_json::Value) -> serde_json::Value {
    use serde_json::{Map, Value};
    match value {
        Value::Object(map) => {
            let mut sorted: Vec<(&String, &Value)> = map.iter().collect();
            sorted.sort_by(|left, right| left.0.cmp(right.0));
            let mut out = Map::new();
            for (key, inner) in sorted {
                out.insert(key.clone(), canonical_json(inner));
            }
            Value::Object(out)
        }
        Value::Array(items) => Value::Array(items.iter().map(canonical_json).collect()),
        other => other.clone(),
    }
}

/// Stable serialisation of a slot.
///
/// A JSON tuple rather than a delimiter join, because predicate keys, entity ids
/// and qualifier values are all free-form strings; any separator chosen would
/// eventually appear inside one of them.
pub fn canonical_key_parts(slot: &SlotKey<'_>) -> String {
    let empty = serde_json::Value::Object(serde_json::Map::new());
    let qualifiers = canonical_json(slot.qualifiers.unwrap_or(&empty));
    serde_json::to_string(&(slot.predicate, slot.entity_ref, qualifiers))
        .expect("slot components are strings and JSON and always serialise")
}

/// Human-readable form of the same identity, for diagnostics and the UI that
/// lists what is remembered. Never use this as a map key.
pub fn canonical_key(slot: &SlotKey<'_>) -> String {
    let mut out = String::from(slot.predicate);
    if let Some(entity) = slot.entity_ref {
        out.push('@');
        out.push_str(entity);
    }
    if let Some(serde_json::Value::Object(map)) = slot.qualifiers {
        if !map.is_empty() {
            let mut pairs: Vec<String> = map
                .iter()
                .map(|(key, value)| format!("{key}={}", compact(value)))
                .collect();
            pairs.sort();
            out.push('{');
            out.push_str(&pairs.join(","));
            out.push('}');
        }
    }
    out
}

/// Render a JSON scalar without quotes, for diagnostics only.
fn compact(value: &serde_json::Value) -> String {
    match value {
        serde_json::Value::String(text) => text.clone(),
        other => other.to_string(),
    }
}

/// Whether this cardinality ever replaces an existing value.
///
/// `Single` and `TemporalSingle` do; `Set` does not — for a set, a new differing
/// value is additional information, not a correction.
pub fn supersedes_by_cardinality(cardinality: Cardinality) -> bool {
    cardinality.supersedes()
}

/// `misc` is the one domain that is structurally inert (invariant I2).
pub fn is_inert(domain: crate::domain::predicate_keys::Domain) -> bool {
    domain == crate::domain::predicate_keys::Domain::Misc
}

/// Why a write was refused.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SupersedeRejection {
    /// The predicate key is not in the registry.
    UnknownPredicate,
    /// A `Set` predicate accumulates; it never replaces.
    CardinalitySet,
    /// An entity-bearing predicate arrived without an entity.
    RequiresEntityRef,
    /// The incoming value does not fit the predicate's declared shape.
    InvalidValue,
    /// The incoming value cannot safely replace the incumbent's shape.
    TypeIncompatible,
}

/// What a new statement does to the records already in its slot.
#[derive(Debug, Clone, PartialEq)]
pub enum SupersedeDecision {
    /// No active record occupies the slot; this is an insert.
    Create {
        /// The registry row the caller must consult for write policy.
        spec: &'static PredicateSpec,
    },
    /// A new value replaces the active one; the named record is superseded.
    Supersede {
        /// The registry row.
        spec: &'static PredicateSpec,
        /// The record being replaced.
        supersedes_id: String,
    },
    /// Same slot, equivalent value — reinforce the existing record, write
    /// nothing.
    Merge {
        /// The registry row.
        spec: &'static PredicateSpec,
        /// The record to reinforce.
        into_id: String,
    },
    /// A `Set` predicate gaining an additional distinct value.
    Append {
        /// The registry row.
        spec: &'static PredicateSpec,
    },
    /// Refused. The caller keeps the candidate for review; nothing is destroyed.
    Reject {
        /// Which guard refused it.
        reason: SupersedeRejection,
        /// Human-readable detail for logs and the review UI.
        detail: String,
    },
}

/// The incoming statement under consideration.
#[derive(Debug, Clone)]
pub struct SupersedeInput<'a> {
    /// Registry key.
    pub predicate: &'a str,
    /// The value being written.
    pub value: &'a serde_json::Value,
    /// Person or place the statement is about.
    pub entity_ref: Option<&'a str>,
    /// Distinguishes concurrent values of one predicate.
    pub qualifiers: Option<&'a serde_json::Value>,
}

/// Normalise a value for equivalence comparison.
///
/// Only string whitespace and case are flattened. Deliberately no stemming, no
/// synonymy, no fuzzy matching: "I design" and "I teach painting" are different
/// values, and guessing otherwise is how a system silently merges two facts into
/// one wrong one.
pub fn normalize_for_comparison(value: &serde_json::Value) -> String {
    match value {
        serde_json::Value::String(text) => text
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ")
            .to_lowercase(),
        other => canonical_json(other).to_string(),
    }
}

/// Whether two values state the same thing.
pub fn values_equivalent(left: &serde_json::Value, right: &serde_json::Value) -> bool {
    normalize_for_comparison(left) == normalize_for_comparison(right)
}

/// The outcome of classifying a value against a predicate's declared shape.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ValueClass {
    /// Fits the declared shape.
    Classifiable(ValueKind),
    /// Does not fit; held for review rather than coerced.
    Unclassifiable(String),
}

/// Classify an incoming value against a predicate's declared shape.
///
/// The [`ValueClass::Unclassifiable`] outcome is the important one: it is what
/// turns "a model said something we cannot type-check" from a silent overwrite
/// into a held candidate.
pub fn classify_value(spec: &PredicateSpec, value: &serde_json::Value) -> ValueClass {
    use serde_json::Value;
    if value.is_null() {
        return ValueClass::Unclassifiable("value is empty".into());
    }
    match spec.kind {
        ValueKind::Enum => match value {
            Value::String(text) => match spec.enum_domain {
                Some(domain) if !domain.contains(&text.as_str()) => {
                    ValueClass::Unclassifiable("value is outside the declared enum domain".into())
                }
                _ => ValueClass::Classifiable(ValueKind::Enum),
            },
            _ => ValueClass::Unclassifiable("enum value must be a string".into()),
        },
        ValueKind::Number => match value {
            Value::Number(_) => ValueClass::Classifiable(ValueKind::Number),
            Value::String(text) if is_numeric(text) => ValueClass::Classifiable(ValueKind::Number),
            _ => ValueClass::Unclassifiable("numeric value expected".into()),
        },
        ValueKind::Date => match value {
            // Shape-checked, not merely type-checked: prose is also a string,
            // and accepting any string here would disable the compatibility
            // guard that protects a resolved date from being overwritten by
            // "next Wednesday, sometime" (invariant I3).
            Value::String(text) if is_iso_date_shape(text) => {
                ValueClass::Classifiable(ValueKind::Date)
            }
            Value::String(_) => ValueClass::Unclassifiable("not an ISO 8601 date".into()),
            _ => ValueClass::Unclassifiable("date value expected".into()),
        },
        ValueKind::Duration => match value {
            Value::String(_) => ValueClass::Classifiable(ValueKind::Duration),
            Value::Object(_) => ValueClass::Classifiable(ValueKind::Duration),
            _ => ValueClass::Unclassifiable("duration value expected".into()),
        },
        ValueKind::EntityRef => match value {
            Value::String(text) if !text.trim().is_empty() => {
                ValueClass::Classifiable(ValueKind::EntityRef)
            }
            _ => ValueClass::Unclassifiable("entity reference expected".into()),
        },
        ValueKind::Text => match value {
            Value::String(text) if !text.trim().is_empty() => {
                ValueClass::Classifiable(ValueKind::Text)
            }
            Value::String(_) => ValueClass::Unclassifiable("value is blank".into()),
            _ => ValueClass::Unclassifiable("text value expected".into()),
        },
    }
}

/// Whether a string is a plain decimal number, optionally signed.
fn is_numeric(text: &str) -> bool {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return false;
    }
    let body = trimmed.strip_prefix(['-', '+']).unwrap_or(trimmed);
    let mut parts = body.split('.');
    let whole = parts.next().unwrap_or("");
    let fraction = parts.next();
    if parts.next().is_some() || whole.is_empty() {
        return false;
    }
    whole.bytes().all(|b| b.is_ascii_digit())
        && fraction.map_or(true, |f| {
            !f.is_empty() && f.bytes().all(|b| b.is_ascii_digit())
        })
}

/// Decide what a new statement does to the records already in its slot.
///
/// `same_slot_active` must contain only records that are active, share the
/// caller's scope, and — for entity-bearing predicates — the same entity. The
/// caller owns scoping; this function owns the rules.
///
/// Ordering matters: cardinality and inertness are checked before type
/// compatibility, because "a set never supersedes" is a stronger statement than
/// "this value would not have been compatible anyway".
pub fn decide_supersede(
    input: &SupersedeInput<'_>,
    same_slot_active: &[&Claim],
) -> SupersedeDecision {
    let Some(spec) = spec_for(input.predicate) else {
        return SupersedeDecision::Reject {
            reason: SupersedeRejection::UnknownPredicate,
            detail: input.predicate.to_string(),
        };
    };

    // `misc` records never displace a classified fact. This used to refuse the
    // write outright, which reads as the same policy and quietly loses the one
    // thing the escape hatch exists to keep: a statement the vocabulary could
    // not classify. The guard therefore removes the ability to supersede and
    // lets the rest of the decision run, so an unclassified statement is stored
    // beside what is already known instead of being dropped for being unusual.
    //
    // The slot is keyed by predicate, so an unclassified statement never
    // competes with a classified one anyway. What this buys is that a later
    // registry row cannot quietly hand `misc` the power to overwrite.
    let may_displace = !is_inert(spec.domain) && spec.key != MISC_PREDICATE;

    if spec.kind == ValueKind::EntityRef && input.entity_ref.is_none() {
        return SupersedeDecision::Reject {
            reason: SupersedeRejection::RequiresEntityRef,
            detail: format!("{} needs an entity reference", spec.key),
        };
    }

    let incoming_kind = match classify_value(spec, input.value) {
        ValueClass::Classifiable(kind) => kind,
        ValueClass::Unclassifiable(reason) => {
            return SupersedeDecision::Reject {
                reason: SupersedeRejection::InvalidValue,
                detail: reason,
            }
        }
    };

    if same_slot_active.is_empty() {
        return SupersedeDecision::Create { spec };
    }

    if let Some(equivalent) = same_slot_active
        .iter()
        .find(|claim| values_equivalent(&claim.value, input.value))
    {
        return SupersedeDecision::Merge {
            spec,
            into_id: equivalent.id.clone(),
        };
    }

    let incumbent = pick_most_authoritative(same_slot_active);

    if !may_displace || !supersedes_by_cardinality(spec.cardinality) {
        // A set accumulates, and an inert domain is treated as one whatever its
        // row says. Still type-check the incumbent so that adding "I'm thinking
        // about moving" into a set of places is refused rather than quietly
        // polluting the accumulation.
        if let ValueClass::Classifiable(incumbent_kind) = classify_value(spec, &incumbent.value) {
            if incumbent_kind != incoming_kind {
                return SupersedeDecision::Reject {
                    reason: SupersedeRejection::TypeIncompatible,
                    detail: format!("{incoming_kind:?} cannot join a {incumbent_kind:?} slot"),
                };
            }
        }
        return SupersedeDecision::Append { spec };
    }

    let incumbent_kind = match classify_value(spec, &incumbent.value) {
        ValueClass::Classifiable(kind) => kind,
        ValueClass::Unclassifiable(_) => {
            // The incumbent cannot be type-checked, so it cannot be safely
            // displaced.
            return SupersedeDecision::Reject {
                reason: SupersedeRejection::TypeIncompatible,
                detail: "incumbent value is unclassifiable; refusing to supersede it".into(),
            };
        }
    };

    if !kinds_compatible(incumbent_kind, incoming_kind) {
        return SupersedeDecision::Reject {
            reason: SupersedeRejection::TypeIncompatible,
            detail: format!("{incoming_kind:?} cannot supersede {incumbent_kind:?}"),
        };
    }

    SupersedeDecision::Supersede {
        spec,
        supersedes_id: incumbent.id.clone(),
    }
}

/// Choose which active record represents a slot when several coexist.
///
/// Multiple actives in one `Single` slot means an earlier bug or a concurrent
/// write; picking deterministically by newest update keeps the outcome stable
/// and reproducible rather than dependent on slice order.
fn pick_most_authoritative<'a>(claims: &[&'a Claim]) -> &'a Claim {
    claims
        .iter()
        .copied()
        .reduce(|best, candidate| {
            if candidate.updated_at > best.updated_at
                || (candidate.updated_at == best.updated_at && candidate.id > best.id)
            {
                candidate
            } else {
                best
            }
        })
        .expect("caller checked the slice is non-empty")
}
