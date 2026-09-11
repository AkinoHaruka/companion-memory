//! Inference confidence, admissibility and lifecycle rules.
//!
//! This module owns the guards that keep a model's belief distinct from a fact
//! the user has stated. It is pure: callers provide timestamps and the
//! promotion gate's decision, while the module applies I11, I12 and the legal
//! state transitions.

use crate::domain::predicates::inference_allowed_for;
use crate::domain::types::{
    Inference, InferenceAxis, InferenceState, PATTERN_REVIEW_DAYS, UNACKNOWLEDGED_CONFIDENCE_CAP,
};
use crate::rules::evidence::{self, EvidenceResolution};

/// A review removes one fifth of the current confidence.
///
/// A relative reduction preserves the ordering between beliefs while making
/// the penalty meaningful at both low and high confidence. The record is kept
/// so its audit trail and the next round of evidence are not discarded.
const REVIEW_CONFIDENCE_FACTOR: f64 = 0.80;

/// Clamp a confidence to the range its acknowledgement state allows.
///
/// An acknowledged inference may reach 1.0; an unacknowledged one is capped at
/// [`UNACKNOWLEDGED_CONFIDENCE_CAP`] (I11). Values are clamped into `[0, 1]`
/// first, so a NaN or an out-of-range input cannot escape.
pub fn clamp_confidence(value: f64, acknowledged: bool) -> f64 {
    let bounded = if value.is_nan() {
        // NaN has no ordering in which it can be clamped. Zero is the
        // conservative, auditable result for an unusable confidence.
        0.0
    } else {
        value.max(0.0).min(1.0)
    };

    if acknowledged {
        bounded
    } else {
        bounded.min(UNACKNOWLEDGED_CONFIDENCE_CAP)
    }
}

/// The user confirmed a belief about themselves.
///
/// This is the only event that lifts the I11 cap, so it must be recorded with
/// the moment it happened, and it is not something a model can assert on the
/// user's behalf. Acknowledgement permits a higher confidence; it does not
/// grant one, so the existing value is only normalised into `[0, 1]`.
pub fn acknowledge(inference: &Inference, now: &str) -> Inference {
    let mut updated = inference.clone();
    updated.user_acknowledged_at = Some(now.to_owned());
    updated.confidence = clamp_confidence(updated.confidence, true);
    updated
}

/// The few legal moves between inference states.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Transition {
    /// The consolidation pass found enough independent evidence.
    Promote,
    /// The consolidation pass found a reason not to promote yet.
    HoldInAccumulation,
    /// The user rejected the belief.
    Reject {
        /// ISO 8601 timestamp of the user's rejection.
        now: String,
    },
    /// The review window elapsed without fresh evidence (I12).
    Expire {
        /// ISO 8601 timestamp at which expiry was recorded.
        now: String,
    },
    /// Fresh evidence arrived for an expired or accumulating belief.
    Revive,
}

/// The result of applying a lifecycle transition.
#[derive(Debug, Clone, PartialEq)]
pub enum TransitionOutcome {
    /// The transition is legal; the returned record is the new state.
    Applied(Box<Inference>),
    /// The transition is not legal from this state, with the reason.
    Refused(TransitionRefusal),
}

/// Why a requested inference transition was refused.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TransitionRefusal {
    /// A rejected belief may not be revived by the system, only by the user.
    RejectedIsTerminal,
    /// The belief is already in the requested state.
    AlreadyInState,
    /// Promotion requires a passing promotion audit.
    PromotionNotReady,
    /// Confidence would exceed the cap an unacknowledged belief allows.
    ExceedsUnacknowledgedCap,
}

/// Apply one transition, returning the updated record or a refusal.
pub fn apply_transition(
    inference: &Inference,
    transition: Transition,
    promotion_ready: bool,
) -> TransitionOutcome {
    match transition {
        Transition::Promote => promote(inference, promotion_ready),
        Transition::HoldInAccumulation => hold(inference),
        Transition::Reject { now } => reject(inference, &now),
        Transition::Expire { now } => expire(inference, &now),
        Transition::Revive => revive(inference),
    }
}

/// Whether a pattern inference is past its review window.
///
/// A record with no `expires_at` is never overdue, which is the correct default
/// for axes that do not expire. Comparison is deliberately lexical, matching
/// the kernel's timestamp contract; callers must pass normalised ISO 8601
/// strings.
pub fn is_review_overdue(inference: &Inference, now: &str) -> bool {
    if inference.axis != InferenceAxis::Pattern {
        return false;
    }

    inference
        .expires_at
        .as_deref()
        .is_some_and(|deadline| now > deadline)
}

/// Apply the review penalty if the window has passed, otherwise return the
/// record unchanged.
///
/// An overdue active or accumulating pattern is marked `Expired` and its
/// confidence is reduced by 20%. The record is retained because expiry is a
/// request for fresh evidence, not proof that the historical belief never
/// existed. Rejected and already-expired records are returned unchanged, so
/// applying review twice for the same deadline cannot lower confidence twice.
pub fn apply_review(inference: &Inference, now: &str) -> Inference {
    if !is_review_overdue(inference, now)
        || matches!(
            inference.state,
            InferenceState::Expired | InferenceState::Rejected
        )
    {
        return inference.clone();
    }

    let mut updated = inference.clone();
    updated.state = InferenceState::Expired;
    updated.confidence = reviewed_confidence(inference);
    updated.updated_at = now.to_owned();
    updated
}

/// Whether an inference may exist at all.
///
/// A model must not record a belief about the user that no admissible evidence
/// supports, and there is a class of judgement that should not become a stored
/// belief at any confidence. Both checks live here so a caller cannot forget
/// one.
pub fn may_hold(
    inference: &Inference,
    resolution: &EvidenceResolution,
) -> Result<(), BeliefRefusal> {
    let live_support = evidence::live_evidence(&inference.support_evidence, resolution);
    if live_support.is_empty() {
        return Err(BeliefRefusal::NoLiveSupport);
    }

    if !inference_allowed_for(&inference.predicate) {
        return Err(BeliefRefusal::PredicateDisallowsInference {
            predicate: inference.predicate.clone(),
        });
    }

    let has_admissible_support = live_support
        .iter()
        .any(|reference| evidence::may_support_user_inference(reference, resolution).is_none());
    if !has_admissible_support {
        return Err(BeliefRefusal::NoAdmissibleSupport);
    }

    Ok(())
}

/// Why a proposed inference cannot be retained.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BeliefRefusal {
    /// No support evidence survived resolution and suppression.
    NoLiveSupport,
    /// Every supporting reference was inadmissible.
    NoAdmissibleSupport,
    /// The predicate declares that inference is not allowed on it (I8).
    PredicateDisallowsInference {
        /// The predicate that the registry refuses for inference.
        predicate: String,
    },
}

fn promote(inference: &Inference, promotion_ready: bool) -> TransitionOutcome {
    match inference.state {
        InferenceState::Rejected => refused(TransitionRefusal::RejectedIsTerminal),
        InferenceState::Active => refused(TransitionRefusal::AlreadyInState),
        InferenceState::Expired => refused(TransitionRefusal::PromotionNotReady),
        InferenceState::Accumulating => {
            if !promotion_ready {
                return refused(TransitionRefusal::PromotionNotReady);
            }
            if exceeds_unacknowledged_cap(inference) {
                return refused(TransitionRefusal::ExceedsUnacknowledgedCap);
            }

            let mut updated = inference.clone();
            updated.state = InferenceState::Active;
            updated.confidence = normalised_confidence(inference);
            updated.expires_at = match updated.axis {
                InferenceAxis::Pattern => Some(pattern_review_deadline(&updated.updated_at)),
                InferenceAxis::Disposition
                | InferenceAxis::RecurringTheme
                | InferenceAxis::Relational
                | InferenceAxis::SelfModel
                | InferenceAxis::SharedWorld => None,
            };
            applied(updated)
        }
    }
}

fn hold(inference: &Inference) -> TransitionOutcome {
    match inference.state {
        InferenceState::Rejected => refused(TransitionRefusal::RejectedIsTerminal),
        InferenceState::Accumulating => {
            if exceeds_unacknowledged_cap(inference) {
                return refused(TransitionRefusal::ExceedsUnacknowledgedCap);
            }
            let mut updated = inference.clone();
            updated.confidence = normalised_confidence(inference);
            applied(updated)
        }
        InferenceState::Active | InferenceState::Expired => {
            refused(TransitionRefusal::AlreadyInState)
        }
    }
}

fn reject(inference: &Inference, now: &str) -> TransitionOutcome {
    if inference.state == InferenceState::Rejected {
        return refused(TransitionRefusal::AlreadyInState);
    }
    if exceeds_unacknowledged_cap(inference) {
        return refused(TransitionRefusal::ExceedsUnacknowledgedCap);
    }

    let mut updated = inference.clone();
    updated.state = InferenceState::Rejected;
    updated.confidence = normalised_confidence(inference);
    updated.updated_at = now.to_owned();
    applied(updated)
}

fn expire(inference: &Inference, now: &str) -> TransitionOutcome {
    match inference.state {
        InferenceState::Rejected => refused(TransitionRefusal::RejectedIsTerminal),
        InferenceState::Expired => refused(TransitionRefusal::AlreadyInState),
        InferenceState::Accumulating | InferenceState::Active => {
            if exceeds_unacknowledged_cap(inference) {
                return refused(TransitionRefusal::ExceedsUnacknowledgedCap);
            }

            let mut updated = inference.clone();
            updated.state = InferenceState::Expired;
            updated.confidence = reviewed_confidence(inference);
            updated.updated_at = now.to_owned();
            applied(updated)
        }
    }
}

fn revive(inference: &Inference) -> TransitionOutcome {
    match inference.state {
        InferenceState::Rejected => refused(TransitionRefusal::RejectedIsTerminal),
        InferenceState::Accumulating | InferenceState::Active => {
            refused(TransitionRefusal::AlreadyInState)
        }
        InferenceState::Expired => {
            if exceeds_unacknowledged_cap(inference) {
                return refused(TransitionRefusal::ExceedsUnacknowledgedCap);
            }

            let mut updated = inference.clone();
            updated.state = InferenceState::Accumulating;
            updated.expires_at = None;
            updated.confidence = normalised_confidence(inference);
            applied(updated)
        }
    }
}

fn applied(inference: Inference) -> TransitionOutcome {
    TransitionOutcome::Applied(Box::new(inference))
}

fn refused(reason: TransitionRefusal) -> TransitionOutcome {
    TransitionOutcome::Refused(reason)
}

fn exceeds_unacknowledged_cap(inference: &Inference) -> bool {
    inference.user_acknowledged_at.is_none() && inference.confidence > UNACKNOWLEDGED_CONFIDENCE_CAP
}

fn normalised_confidence(inference: &Inference) -> f64 {
    clamp_confidence(
        inference.confidence,
        inference.user_acknowledged_at.is_some(),
    )
}

fn reviewed_confidence(inference: &Inference) -> f64 {
    normalised_confidence(inference) * REVIEW_CONFIDENCE_FACTOR
}

/// Add the fixed pattern review interval to a normalised timestamp.
///
/// The kernel does not own a calendar library. This helper advances the
/// leading `YYYY-MM-DD` portion with Gregorian month lengths and preserves the
/// original time/offset suffix. Invalid or unsupported timestamp shapes are
/// returned unchanged; hosts that require a deadline for such input must
/// normalise the timestamp before promotion.
fn pattern_review_deadline(timestamp: &str) -> String {
    let Some(date) = timestamp.get(..10) else {
        return timestamp.to_owned();
    };
    let bytes = date.as_bytes();
    if bytes[4] != b'-' || bytes[7] != b'-' {
        return timestamp.to_owned();
    }

    let Some(mut year) = parse_digits(&bytes[0..4]) else {
        return timestamp.to_owned();
    };
    let Some(mut month) = parse_digits(&bytes[5..7]) else {
        return timestamp.to_owned();
    };
    let Some(mut day) = parse_digits(&bytes[8..10]) else {
        return timestamp.to_owned();
    };
    if !(1..=12).contains(&month) || day == 0 || day > days_in_month(year, month) {
        return timestamp.to_owned();
    }

    for _ in 0..PATTERN_REVIEW_DAYS {
        if day < days_in_month(year, month) {
            day += 1;
        } else {
            day = 1;
            if month < 12 {
                month += 1;
            } else {
                month = 1;
                year = year.saturating_add(1);
            }
        }
    }

    let Some(suffix) = timestamp.get(10..) else {
        return timestamp.to_owned();
    };
    format!("{year:04}-{month:02}-{day:02}{suffix}")
}

fn parse_digits(bytes: &[u8]) -> Option<u32> {
    if bytes.is_empty() || !bytes.iter().all(u8::is_ascii_digit) {
        return None;
    }
    Some(
        bytes
            .iter()
            .fold(0_u32, |value, digit| value * 10 + u32::from(digit - b'0')),
    )
}

fn days_in_month(year: u32, month: u32) -> u32 {
    match month {
        2 if is_leap_year(year) => 29,
        2 => 28,
        4 | 6 | 9 | 11 => 30,
        _ => 31,
    }
}

fn is_leap_year(year: u32) -> bool {
    year % 4 == 0 && (year % 100 != 0 || year % 400 == 0)
}
