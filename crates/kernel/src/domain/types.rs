//! Companion memory domain types.
//!
//! Three persistent layers plus a non-memory runtime layer and one evidence
//! primitive. See DESIGN.md §3 for why each field exists; the short version:
//!
//! - [`Claim`] — what the user stated. Fast, automatic, low risk.
//! - [`Episode`] — what we went through together. Narrative, near-verbatim.
//! - [`Inference`] — what the model came to believe. Slow, governed, revocable.
//!
//! Every derived record cites [`EvidenceRef`]s rather than copying text, so
//! forgetting, contamination isolation and evidence collapse are one mechanism
//! instead of three.
//!
//! Timestamps are ISO 8601 strings compared lexicographically. That ordering is
//! the only time operation the kernel performs, so it needs no calendar
//! library; parsing and formatting belong to the host.

use serde::{Deserialize, Serialize};

use super::predicates::MentionMode;

/// The durable identity of a relationship.
///
/// Deliberately **not** keyed on the agent or model that happens to be talking.
/// A user who switches to a different model must not find that their companion
/// has forgotten them; the agent that produced a record is kept as
/// [`Provenance::agent_id`], never as part of the ownership key.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct RelationshipScope {
    /// Tenant or deployment the relationship belongs to.
    pub service_id: String,
    /// The person the companion is remembering.
    pub owner_user_id: String,
    /// Which companion persona this memory belongs to.
    pub companion_profile_id: String,
}

impl RelationshipScope {
    /// Stable serialisation for use as a store key.
    ///
    /// A JSON tuple rather than a delimiter join, because every component is a
    /// free-form identifier and any separator chosen would eventually appear
    /// inside one of them.
    pub fn key(&self) -> String {
        serde_json::to_string(&(
            self.service_id.as_str(),
            self.owner_user_id.as_str(),
            self.companion_profile_id.as_str(),
        ))
        .expect("scope components are strings and always serialise")
    }
}

/// Where a record came from, and how much it should be trusted.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Provenance {
    /// The agent or model that produced this record. Metadata, not identity.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_id: Option<String>,
    /// Versioned prompt contract that produced it, when a model was involved.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prompt_family: Option<String>,
    /// Version of that prompt contract.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prompt_version: Option<String>,
    /// Model identifier.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    /// Producer's own confidence, in `[0, 1]`.
    pub confidence: f64,
    /// ISO 8601.
    pub created_at: String,
}

/// Which layer a piece of evidence points at.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EvidenceSourceType {
    /// A raw conversation message.
    Message,
    /// A [`Claim`].
    Claim,
    /// An [`Episode`].
    Episode,
}

/// Who produced a piece of evidence.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Speaker {
    /// The person.
    User,
    /// The companion.
    Assistant,
}

/// What a piece of evidence is *allowed to prove*.
///
/// [`SemanticRole::AssistantAction`] can establish that the companion said
/// something and can support relationship history; it can never establish what
/// the user is like. That restriction is enforced in
/// [`crate::rules::evidence`], not by convention (invariant I1).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SemanticRole {
    /// The user asserted something.
    UserAssertion,
    /// The user reacted to something the companion did.
    UserReaction,
    /// The companion did something.
    AssistantAction,
    /// The companion observed something without the user stating it.
    Observation,
}

/// A citation into the evidence graph.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EvidenceRef {
    /// Which layer the source id belongs to.
    pub source_type: EvidenceSourceType,
    /// Id within that layer.
    pub source_id: String,
    /// Who produced it. Load-bearing for invariant I1.
    pub speaker: Speaker,
    /// What it may be used to prove.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub semantic_role: Option<SemanticRole>,
}

/// Ranking projection, embedded in every record rather than kept in a side
/// table.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Salience {
    /// Base importance, independent of when the record was last used.
    pub importance: f64,
    /// How many times it has been surfaced.
    pub recall_count: u32,
    /// ISO 8601 of the last surfacing.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_recalled_at: Option<String>,
    /// Negative-feedback landing spot. A record marked this way can never be
    /// surfaced above background (invariant I7).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub do_not_surface: Option<bool>,
}

impl Default for Salience {
    fn default() -> Self {
        Self {
            importance: 0.5,
            recall_count: 0,
            last_recalled_at: None,
            do_not_surface: None,
        }
    }
}

/// Lifecycle of a [`Claim`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ClaimStatus {
    /// Currently true.
    Active,
    /// Replaced by a newer value for the same slot.
    Superseded,
    /// The user said it was wrong.
    Revoked,
    /// Forgotten.
    Deleted,
}

/// What the user stated.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Claim {
    /// Stable record id.
    pub id: String,
    /// Relationship this belongs to.
    pub scope: RelationshipScope,
    /// Registry key, e.g. `identity.occupation`.
    pub predicate: String,
    /// Person or place this is about, when the predicate is entity-bearing.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub entity_ref: Option<String>,
    /// Distinguishes concurrent values of one predicate, e.g. `{"use": "work"}`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub qualifiers: Option<serde_json::Value>,
    /// The normalised value.
    pub value: serde_json::Value,
    /// The user's own words, kept verbatim so nothing is lost in normalisation.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub raw_value: Option<String>,
    /// ISO 8601.
    pub valid_from: String,
    /// ISO 8601, when the statement is time-bounded.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub valid_until: Option<String>,
    /// Lifecycle state.
    pub status: ClaimStatus,
    /// The record this one replaced, if any.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub supersedes_id: Option<String>,
    /// Where it came from.
    pub source_refs: Vec<EvidenceRef>,
    /// Producer metadata.
    pub provenance: Provenance,
    /// Ranking projection.
    #[serde(flatten)]
    pub salience: Salience,
    /// ISO 8601.
    pub created_at: String,
    /// ISO 8601.
    pub updated_at: String,
}

/// One point on an episode's emotional arc.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct EmotionalArcPoint {
    /// Turn index within the episode.
    pub at_turn: u32,
    /// Affect labels observed at that point.
    pub labels: Vec<String>,
    /// Intensity in `[0, 1]`, when stated.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub intensity: Option<f64>,
    /// Whether the user stated it or the companion inferred it.
    pub source: ArcSource,
}

/// Whether an affect reading was stated or merely observed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ArcSource {
    /// The user named the feeling.
    UserExpressed,
    /// The companion read it from tone or wording.
    Observed,
}

/// Someone who took part in an episode.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct EpisodeParticipant {
    /// Entity id, for a person other than the user or companion.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub entity_ref: Option<String>,
    /// Which side of the conversation.
    pub role: ParticipantRole,
}

/// Which side of the conversation a participant is on.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ParticipantRole {
    /// The person.
    User,
    /// The companion.
    Companion,
}

/// Lifecycle of an [`Episode`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EpisodeStatus {
    /// Kept.
    Active,
    /// Forgotten.
    Deleted,
}

/// What we went through together.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Episode {
    /// Stable record id.
    pub id: String,
    /// Relationship this belongs to.
    pub scope: RelationshipScope,
    /// ISO 8601 start.
    pub occurred_from: String,
    /// ISO 8601 end, for an episode with duration.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub occurred_to: Option<String>,
    /// Narrative summary. Must be segmented by speaker; see DESIGN.md §2.2.
    pub narrative: String,
    /// Who took part.
    pub participants: Vec<EpisodeParticipant>,
    /// How affect moved through the episode.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub emotional_arc: Option<Vec<EmotionalArcPoint>>,
    /// What the user did or said next. Descriptive only — never a causal claim
    /// that the companion's response helped.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub user_reaction: Option<String>,
    /// The companion turn that reaction responds to.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub response_ref: Option<String>,
    /// Where it came from.
    pub source_refs: Vec<EvidenceRef>,
    /// Lifecycle state.
    pub status: EpisodeStatus,
    /// Ranking projection.
    #[serde(flatten)]
    pub salience: Salience,
    /// ISO 8601.
    pub created_at: String,
    /// ISO 8601.
    pub updated_at: String,
}

/// Which kind of belief an [`Inference`] records.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum InferenceAxis {
    /// A stable trait.
    Disposition,
    /// A behavioural regularity.
    Pattern,
    /// A theme that keeps returning.
    RecurringTheme,
    /// How the relationship itself is going.
    Relational,
    /// The companion's own commitments and tone.
    SelfModel,
    /// A private word or shared reference.
    SharedWorld,
}

/// Lifecycle of an [`Inference`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum InferenceState {
    /// Seen, not yet enough independent evidence.
    Accumulating,
    /// Promoted by the consolidation pass.
    Active,
    /// The user rejected it.
    Rejected,
    /// Outlived its review window.
    Expired,
}

/// Record of the checks that justified a promotion.
///
/// Counts alone manufacture stereotypes: three consecutive Sundays spent on one
/// deadline are one underlying cause, not three independent confirmations.
/// Independence is what the promotion gate requires, and this is the evidence
/// that it was actually checked.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PromotionAudit {
    /// How many separate sessions contributed.
    pub distinct_sessions: u32,
    /// How far apart the first and last contribution were.
    pub temporal_span_days: u32,
    /// How many distinct contexts they came from.
    pub context_diversity: u32,
    /// How many counter-examples were looked for and counted.
    pub counter_examples_checked: u32,
}

/// What the model came to believe.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Inference {
    /// Stable record id.
    pub id: String,
    /// Relationship this belongs to.
    pub scope: RelationshipScope,
    /// Which kind of belief.
    pub axis: InferenceAxis,
    /// Registry key the belief is about.
    pub predicate: String,
    /// The belief, in natural language.
    pub value: String,
    /// Lifecycle state.
    pub state: InferenceState,
    /// Confidence in `[0, 1]`. Capped while unacknowledged (invariant I11).
    pub confidence: f64,
    /// Evidence supporting it.
    pub support_evidence: Vec<EvidenceRef>,
    /// Evidence against it.
    pub counter_evidence: Vec<EvidenceRef>,
    /// Promotion justification, once promoted.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub promotion_audit: Option<PromotionAudit>,
    /// ISO 8601, set when the user confirmed the belief.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub user_acknowledged_at: Option<String>,
    /// How it may be surfaced.
    pub use_mode: MentionMode,
    /// ISO 8601 review deadline, for `Pattern`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<String>,
    /// Ranking projection.
    #[serde(flatten)]
    pub salience: Salience,
    /// ISO 8601.
    pub created_at: String,
    /// ISO 8601.
    pub updated_at: String,
}

/// One point on the session's trajectory.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SessionTrajectoryPoint {
    /// Turn index within the session.
    pub at_turn: u32,
    /// Affect labels observed.
    pub affect: Vec<String>,
    /// Topic at that point.
    pub topic: String,
}

/// The conversation's present condition, with a TTL.
///
/// "I'm so done with today" must change this and nothing else. Writing it into a
/// [`Claim`] or an [`Inference`] is how long-term memory gets poisoned by
/// transient state (DESIGN.md §3.5).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RuntimeState {
    /// Relationship this belongs to.
    pub scope: RelationshipScope,
    /// Affect labels for the present moment.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current_affect: Option<Vec<String>>,
    /// What is being discussed.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current_topic: Option<String>,
    /// What the user appears to need right now.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub apparent_need: Option<String>,
    /// Named mode of the conversation, when one applies.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub conversation_mode: Option<String>,
    /// Entities mentioned in this session.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub active_entities: Option<Vec<String>>,
    /// An intent from this turn that has not been resolved.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unresolved_turn_intent: Option<String>,
    /// How affect and topic moved through the session.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_trajectory: Option<Vec<SessionTrajectoryPoint>>,
    /// ISO 8601. Turns, hours or the session, never a date.
    pub expires_at: String,
    /// ISO 8601.
    pub updated_at: String,
}

/// Highest confidence an inference may reach before the user has acknowledged
/// it. A model's own observation must never feel like a settled fact
/// (invariant I11).
pub const UNACKNOWLEDGED_CONFIDENCE_CAP: f64 = 0.65;

/// Days a [`InferenceAxis::Pattern`] inference may go without fresh evidence
/// before its confidence is lowered (invariant I12).
pub const PATTERN_REVIEW_DAYS: u32 = 90;

/// Fraction of `misc` records above which the vocabulary is considered
/// mismatched.
pub const MISC_RATIO_ALARM: f64 = 0.15;

/// Minimum independent sessions before an inference may be promoted.
pub const MIN_DISTINCT_SESSIONS: u32 = 3;

/// Minimum span, in days, over which those sessions must be spread.
pub const MIN_TEMPORAL_SPAN_DAYS: u32 = 14;

// ---------------------------------------------------------------------------
// Value shape predicates
// ---------------------------------------------------------------------------

/// Whether `text` is an ISO 8601 calendar date, optionally with a time.
///
/// The kernel checks the *shape*, not the calendar: `2026-02-31` passes here and
/// a host that cares can reject it. What this must catch is the distinction that
/// matters for data safety — a resolved date written as `2026-06-10T14:00:00Z`
/// versus prose like `next Wednesday, sometime`. Both are strings, and without
/// this check a `Date` predicate would accept any string at all, which silently
/// disables the type-compatibility guard that protects resolved facts.
///
/// Accepted: `YYYY-MM-DD`, `YYYY-MM`, `YYYY`, each optionally followed by
/// `THH:MM` with optional seconds, fractional seconds and a `Z` or `±HH:MM`
/// offset.
pub fn is_iso_date_shape(text: &str) -> bool {
    let trimmed = text.trim();
    let (date_part, rest) = match trimmed.split_once(['T', 't', ' ']) {
        Some((date, rest)) => (date, Some(rest)),
        None => (trimmed, None),
    };

    // `YYYY`, `YYYY-MM` or `YYYY-MM-DD`. Parsed by explicit position rather
    // than by splitting, because a split loses the segment count as soon as one
    // segment is consumed.
    let date_ok = match date_part.len() {
        4 => is_digit_run(date_part, 4),
        7 => {
            is_digit_run(&date_part[0..4], 4)
                && date_part.as_bytes()[4] == b'-'
                && is_digit_run(&date_part[5..7], 2)
        }
        10 => {
            is_digit_run(&date_part[0..4], 4)
                && date_part.as_bytes()[4] == b'-'
                && is_digit_run(&date_part[5..7], 2)
                && date_part.as_bytes()[7] == b'-'
                && is_digit_run(&date_part[8..10], 2)
        }
        _ => false,
    };
    if !date_ok {
        return false;
    }

    let Some(time_part) = rest else {
        return true;
    };
    let time_part = time_part.trim();
    if time_part.is_empty() {
        return false;
    }
    // Strip a trailing timezone designator.
    let time_core = if let Some(stripped) = time_part.strip_suffix(['Z', 'z']) {
        stripped
    } else if let Some(index) = time_part.rfind(['+', '-']) {
        // An offset must be present and look like `±HH:MM` or `±HHMM`.
        let (head, offset) = time_part.split_at(index);
        let digits: String = offset[1..].chars().filter(|c| *c != ':').collect();
        if digits.len() != 4 || !digits.bytes().all(|b| b.is_ascii_digit()) {
            return false;
        }
        head
    } else {
        time_part
    };

    let mut clock = time_core.split(':');
    let hours = clock.next().unwrap_or("");
    let minutes = clock.next().unwrap_or("");
    if !is_digit_run(hours, 2) || !is_digit_run(minutes, 2) {
        return false;
    }
    match clock.next() {
        None => true,
        Some(seconds) => {
            let whole = seconds.split('.').next().unwrap_or("");
            is_digit_run(whole, 2)
        }
    }
}

/// Whether a string is exactly `width` ASCII digits.
fn is_digit_run(text: &str, width: usize) -> bool {
    text.len() == width && text.bytes().all(|b| b.is_ascii_digit())
}
