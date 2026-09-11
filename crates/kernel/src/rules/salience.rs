//! Salience, recency, ranking and promotion gates.
//!
//! This module keeps "was surfaced" separate from "was valuable". A recall
//! updates the usage projection, while only an observable feedback signal may
//! change the base importance (I6). Boundary predicates remain constraints and
//! are never candidates for prompt-budget ranking (I10).

use crate::domain::predicate_keys::Domain;
use crate::domain::predicates::spec_for;
use crate::domain::types::{
    PromotionAudit, Salience, MIN_DISTINCT_SESSIONS, MIN_TEMPORAL_SPAN_DAYS,
};

/// The amount added by each positive feedback signal.
///
/// The signals are intentionally equal-weighted: this pure kernel can record
/// that a real signal happened, but it cannot reliably infer its intensity.
/// Callers can apply separate signals for separate observable events.
const POSITIVE_FEEDBACK_STEP: f64 = 0.10;

/// The relative bonus granted when an authorised trigger names a candidate.
///
/// A multiplicative bonus preserves the product's zero-relevance guarantee:
/// an explicit trigger can make a related record louder, but cannot make an
/// unrelated record relevant.
const EXPLICIT_TRIGGER_BONUS: f64 = 0.25;

/// Minimum number of distinct contexts required for an inference promotion.
///
/// Two contexts are enough to reject a pattern that only appears in one
/// setting, while still allowing three independent sessions to share one
/// broad context when the evidence genuinely recurs there.
pub const MIN_CONTEXT_DIVERSITY: u32 = 2;

/// A real signal that a record should be more or less prominent.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FeedbackSignal {
    /// The user said the companion remembering this was good.
    UserValued,
    /// The user corrected the record.
    UserCorrected,
    /// The user raised the same thing again unprompted.
    UserRaisedAgain,
    /// The user said the companion's way of responding worked.
    ResponseWorked,
    /// The user asked for this not to come up again.
    UserAskedToStop,
    /// Nothing observable happened. Carries no information.
    None,
}

/// Apply one signal, returning the updated projection.
///
/// `FeedbackSignal::None` returns the input unchanged. The four positive
/// signals each add [`POSITIVE_FEEDBACK_STEP`] and clamp `importance` at 1.0;
/// they are equal-weighted because this layer knows whether a signal happened,
/// not how emotionally intense it was. `UserAskedToStop` only sets the I7
/// landing flag and leaves the record's importance and usage history intact.
pub fn apply_feedback(salience: &Salience, signal: FeedbackSignal) -> Salience {
    match signal {
        FeedbackSignal::None => salience.clone(),
        FeedbackSignal::UserAskedToStop => {
            let mut updated = salience.clone();
            updated.do_not_surface = Some(true);
            updated
        }
        FeedbackSignal::UserValued
        | FeedbackSignal::UserCorrected
        | FeedbackSignal::UserRaisedAgain
        | FeedbackSignal::ResponseWorked => {
            let mut updated = salience.clone();
            updated.importance = (updated.importance + POSITIVE_FEEDBACK_STEP).min(1.0);
            updated
        }
    }
}

/// Record that a record was surfaced. Returns the updated projection.
///
/// Recall is deliberately not a value judgment (I6): it stamps the usage
/// fields only and never changes `importance` or the negative-feedback flag.
pub fn record_recall(salience: &Salience, now: &str) -> Salience {
    let mut updated = salience.clone();
    updated.last_recalled_at = Some(now.to_owned());
    updated.recall_count = updated.recall_count.saturating_add(1);
    updated
}

/// Whole calendar days between two ISO 8601 timestamps, saturating at 0.
///
/// Only the leading `YYYY-MM-DD` portion is used. This is sufficient for
/// day-resolution decay and avoids making the kernel a calendar or timezone
/// implementation. A malformed or unsupported timestamp yields 0, which is
/// the conservative no-decay outcome for the caller.
pub fn days_between(from: &str, to: &str) -> u32 {
    let Some(from_date) = parse_date_prefix(from) else {
        return 0;
    };
    let Some(to_date) = parse_date_prefix(to) else {
        return 0;
    };

    let from_days = days_from_civil(from_date);
    let to_days = days_from_civil(to_date);
    if to_days <= from_days {
        return 0;
    }

    // The supported four-digit year range cannot overflow u32, but retaining
    // an explicit saturation keeps this helper total if its parser changes.
    (to_days - from_days).min(i64::from(u32::MAX)) as u32
}

/// Exponential half-life decay in `(0, 1]`.
///
/// A zero half-life means decay is disabled: there is no meaningful finite
/// denominator, and returning 1.0 is safer than manufacturing NaN or an
/// infinite decay rate. The factor is clamped to the smallest positive
/// `f64`, so even a very old record never becomes exactly zero.
pub fn recency_factor(last_seen: &str, now: &str, half_life_days: u32) -> f64 {
    if half_life_days == 0 {
        return 1.0;
    }

    let elapsed_days = f64::from(days_between(last_seen, now));
    let half_life = f64::from(half_life_days);
    let factor = 2.0_f64.powf(-elapsed_days / half_life);
    factor.max(f64::MIN_POSITIVE)
}

/// Why a candidate was rejected before scoring.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ScoreRejection {
    /// I10: a boundary is an obligation, not a candidate.
    BoundaryIsAConstraint,
}

/// Inputs used to rank one candidate.
#[derive(Debug, Clone, Copy)]
pub struct ScoreInputs<'a> {
    /// Registry predicate, so the gate can be applied.
    pub predicate: &'a str,
    /// Ranking projection for the record.
    pub salience: &'a Salience,
    /// Semantic relatedness of the record to the current turn, in `[0, 1]`.
    pub relevance: f64,
    /// Confidence of the record, in `[0, 1]`.
    pub confidence: f64,
    /// ISO 8601 of when the record was last relevant.
    pub last_seen: &'a str,
    /// ISO 8601 now.
    pub now: &'a str,
    /// Half-life in days.
    pub half_life_days: u32,
    /// Whether an authorised trigger names this record.
    pub explicit_trigger: bool,
}

/// Rank a candidate, refusing boundaries rather than assigning them a score.
///
/// The product `relevance × importance × recency × confidence` is intentional:
/// every factor is a gate on the candidate's usefulness, so a record with zero
/// relevance scores zero no matter how important or confident it is. A weighted
/// sum would let a highly important but unrelated record win. An explicit
/// trigger adds a documented 25% multiplicative bonus to the product.
pub fn candidate_score(inputs: &ScoreInputs<'_>) -> Result<f64, ScoreRejection> {
    if is_boundary_predicate(inputs.predicate) {
        return Err(ScoreRejection::BoundaryIsAConstraint);
    }

    let base = inputs.relevance
        * inputs.salience.importance
        * recency_factor(inputs.last_seen, inputs.now, inputs.half_life_days)
        * inputs.confidence;
    let trigger_multiplier = if inputs.explicit_trigger {
        1.0 + EXPLICIT_TRIGGER_BONUS
    } else {
        1.0
    };
    Ok(base * trigger_multiplier)
}

/// Order candidates loudest-first, dropping boundaries and non-scoring records.
pub fn rank<'a>(items: &'a [ScoreInputs<'a>]) -> Vec<(&'a ScoreInputs<'a>, f64)> {
    let mut ranked: Vec<_> = items
        .iter()
        .filter_map(|item| candidate_score(item).ok().map(|score| (item, score)))
        .collect();
    ranked.sort_by(|left, right| {
        right
            .1
            .partial_cmp(&left.1)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    ranked
}

/// The evidence conditions that prevent promotion of an inference.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PromotionBlocker {
    /// Fewer than [`crate::domain::types::MIN_DISTINCT_SESSIONS`] separate
    /// sessions.
    TooFewSessions {
        /// Sessions observed so far.
        have: u32,
        /// Sessions required.
        need: u32,
    },
    /// The contributions are too close together in time.
    SpanTooShort {
        /// Days between the first and last contribution.
        have_days: u32,
        /// Days required.
        need_days: u32,
    },
    /// Not enough distinct contexts; repeated aftershocks of one event are one
    /// cause, not several confirmations.
    InsufficientDiversity {
        /// Distinct contexts observed so far.
        have: u32,
        /// Distinct contexts required.
        need: u32,
    },
    /// Counter-evidence was never looked for.
    CounterExamplesNotChecked,
}

/// The result of checking whether accumulated evidence may be promoted.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PromotionReadiness {
    /// Whether every promotion condition passed.
    pub ready: bool,
    /// Every condition that still blocks promotion, in check order.
    pub blocking: Vec<PromotionBlocker>,
}

/// Whether the accumulated evidence justifies promoting an inference.
///
/// This gate requires independence, not repetition: three consecutive Sundays
/// spent on one deadline are one underlying cause, not three confirmations.
/// Counter-examples must also have been sought; otherwise an apparent pattern
/// can simply manufacture a stereotype from one-sided evidence.
pub fn promotion_readiness(audit: &PromotionAudit) -> PromotionReadiness {
    let mut blocking = Vec::new();

    if audit.distinct_sessions < MIN_DISTINCT_SESSIONS {
        blocking.push(PromotionBlocker::TooFewSessions {
            have: audit.distinct_sessions,
            need: MIN_DISTINCT_SESSIONS,
        });
    }
    if audit.temporal_span_days < MIN_TEMPORAL_SPAN_DAYS {
        blocking.push(PromotionBlocker::SpanTooShort {
            have_days: audit.temporal_span_days,
            need_days: MIN_TEMPORAL_SPAN_DAYS,
        });
    }
    if audit.context_diversity < MIN_CONTEXT_DIVERSITY {
        blocking.push(PromotionBlocker::InsufficientDiversity {
            have: audit.context_diversity,
            need: MIN_CONTEXT_DIVERSITY,
        });
    }
    if audit.counter_examples_checked == 0 {
        blocking.push(PromotionBlocker::CounterExamplesNotChecked);
    }

    PromotionReadiness {
        ready: blocking.is_empty(),
        blocking,
    }
}

/// Whether a predicate names a boundary, including an unknown boundary key.
fn is_boundary_predicate(predicate: &str) -> bool {
    predicate.starts_with("boundary.")
        || spec_for(predicate).is_some_and(|spec| spec.domain == Domain::Boundary)
}

/// Parse the date prefix needed by the day-resolution helpers.
fn parse_date_prefix(timestamp: &str) -> Option<(i64, u32, u32)> {
    let date = timestamp.get(..10)?;
    let bytes = date.as_bytes();
    if bytes.len() != 10 || bytes[4] != b'-' || bytes[7] != b'-' {
        return None;
    }

    let year = parse_digits(&bytes[0..4])? as i64;
    let month = parse_digits(&bytes[5..7])?;
    let day = parse_digits(&bytes[8..10])?;
    if !(1..=12).contains(&month) || day == 0 || day > days_in_month(year, month) {
        return None;
    }

    Some((year, month, day))
}

/// Parse a short ASCII decimal field without panicking on malformed input.
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

/// Number of days in one Gregorian month of the proleptic calendar.
fn days_in_month(year: i64, month: u32) -> u32 {
    match month {
        2 if is_leap_year(year) => 29,
        2 => 28,
        4 | 6 | 9 | 11 => 30,
        _ => 31,
    }
}

/// Whether a proleptic Gregorian year is a leap year.
fn is_leap_year(year: i64) -> bool {
    year % 4 == 0 && (year % 100 != 0 || year % 400 == 0)
}

/// Map a civil date to a monotonic day number.
///
/// The absolute origin is irrelevant; only differences are used. This is the
/// proleptic Gregorian conversion with an era-sized calculation, so it does
/// not need a date-time dependency or a year-by-year loop.
fn days_from_civil((year, month, day): (i64, u32, u32)) -> i64 {
    let adjusted_year = year - if month <= 2 { 1 } else { 0 };
    let era = if adjusted_year >= 0 {
        adjusted_year / 400
    } else {
        (adjusted_year - 399) / 400
    };
    let year_of_era = adjusted_year - era * 400;
    let month = i64::from(month);
    let day_of_year = (153 * (month + if month > 2 { -3 } else { 9 }) + 2) / 5 + i64::from(day) - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146_097 + day_of_era
}
