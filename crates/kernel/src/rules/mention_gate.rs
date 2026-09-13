//! The mention gate — retrieval is not permission to speak.
//!
//! Ranking answers "what matters". It does not answer "should this be said right
//! now". Perfect ranking can still put a painful memory in front of a user who
//! is trying to think about something lighter. Disclosure is a separate decision
//! from relevance, it applies to all memory layers, and it is monotone: gates and
//! record-level flags may only make a record quieter, never louder.
//!
//! Invariants enforced here are I7 (`do_not_surface`), I10 (a boundary is a
//! constraint rather than a scored item), and I13 (nothing below
//! `FreelyMentionable` volunteers itself).
//!
//! [`GateDenial::BoundaryIsAConstraint`] is retained for vocabulary symmetry
//! with the evidence rules. This gate does not return it: registry boundary
//! predicates are already `BackgroundOnly`, so a boundary is allowed as
//! background context rather than surfaced as a citation.

use crate::domain::predicates::{mention_policy_for, MentionMode};
use crate::domain::types::{Claim, Episode, Inference, InferenceAxis, InferenceState};

/// Surface ladder, ordered from quietest to loudest.
///
/// The effective level is the minimum of the predicate policy, the record's
/// own mode, and every applicable flag. That ordering makes the monotonicity
/// rule explicit: a record can only become quieter as restrictions accumulate.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum SurfaceLevel {
    /// Never surface the record at all.
    NeverSurface,
    /// Use the record to shape tone and word choice, but never recite it.
    BackgroundOnly,
    /// Recite the record only when the user or topic supplies a cue.
    MentionIfUserCues,
    /// The record may be mentioned without a conversational cue.
    FreelyMentionable,
}

impl SurfaceLevel {
    /// Return the numeric position in the quiet-to-loud ladder.
    pub const fn level(self) -> u8 {
        match self {
            Self::NeverSurface => 0,
            Self::BackgroundOnly => 1,
            Self::MentionIfUserCues => 2,
            Self::FreelyMentionable => 3,
        }
    }
}

/// Convert the registry's ordered mention mode to the gate's surface level.
impl From<MentionMode> for SurfaceLevel {
    fn from(mode: MentionMode) -> Self {
        match mode {
            MentionMode::NeverSurface => Self::NeverSurface,
            MentionMode::BackgroundOnly => Self::BackgroundOnly,
            MentionMode::MentionIfUserCues => Self::MentionIfUserCues,
            MentionMode::FreelyMentionable => Self::FreelyMentionable,
        }
    }
}

/// Signals that can license a mention.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct MentionCues {
    /// The user referred to this record, its entity, or its subject matter.
    pub user_referenced: bool,
    /// The current turn's topic implies this record's subject.
    pub topic_implies: bool,
    /// The user previously authorised being reminded at this time.
    pub time_trigger_authorised: bool,
    /// The user used the shared-world term in the current turn.
    pub shared_term_in_user_turn: bool,
    /// The caller explicitly attempted a time-triggered mention.
    pub time_trigger_attempted: bool,
}

/// Why the gate refused to mention a record.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GateDenial {
    /// Reserved for symmetry with evidence rules; this gate does not emit it.
    BoundaryIsAConstraint,
    /// The record carries the I7 negative-feedback flag.
    DoNotSurface,
    /// The effective policy forbids surfacing the record.
    NeverSurface,
    /// An inference has not reached the active state.
    InferenceNotActive,
    /// A shared-world term was not used by the user in this turn.
    UsesUnlicensedSharedTerm,
    /// A cue is required before this record may be recited.
    AwaitingUserCue,
    /// An explicitly attempted time trigger lacks prior authorisation.
    TimeTriggerNotAuthorised,
    /// Reserved vocabulary for callers that need to distinguish a missing cue.
    NoCue,
}

/// The result of applying the mention gate.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MentionDecision {
    /// The record may be used at the returned surface level.
    Allowed {
        /// The quiet-to-loud level that survived all restrictions.
        level: SurfaceLevel,
        /// Whether the renderer must keep the record in background context.
        background_only: bool,
    },
    /// The record may not be mentioned for the returned reason.
    Denied {
        /// The first applicable reason for the denial.
        reason: GateDenial,
        /// The quiet-to-loud level that survived all restrictions.
        level: SurfaceLevel,
    },
}

/// Inputs to [`mention_gate`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MentionInput<'a> {
    /// Registry predicate, or `None` for a record without a predicate policy.
    pub predicate: Option<&'a str>,
    /// The record's own mode, which acts as a ceiling rather than a grant.
    pub record_mode: Option<MentionMode>,
    /// I7 negative-feedback flag.
    pub do_not_surface: Option<bool>,
    /// Whether this record contains a shared-world term.
    pub shared_world_term: bool,
    /// Conversational signals that may license the mention.
    pub cues: MentionCues,
}

/// Compute the quietest level this record is permitted to reach.
///
/// The result is a pure function of the record's policy and flags. It does not
/// inspect the conversation, so callers may compute it once per turn and reuse
/// it. The calculation starts at the loudest level and takes minimums, keeping
/// a record from raising itself above its predicate's policy (I7, I13).
pub fn effective_surface_level(input: &MentionInput<'_>) -> SurfaceLevel {
    let mut level = SurfaceLevel::FreelyMentionable;

    if let Some(predicate) = input.predicate {
        level = level.min(SurfaceLevel::from(mention_policy_for(predicate)));
    }
    if let Some(record_mode) = input.record_mode {
        level = level.min(SurfaceLevel::from(record_mode));
    }
    if input.do_not_surface == Some(true) {
        // The negative-feedback landing spot: a hard floor at silence (I7).
        level = SurfaceLevel::NeverSurface;
    }

    level
}

/// Decide whether a record may be spoken, and at what level.
///
/// A `BackgroundOnly` decision is allowed intentionally: the record may shape
/// tone and word choice but must not be recited. That is why this function does
/// not turn every level below `FreelyMentionable` into a denial (I13).
///
/// A time trigger is a licence only when the user granted it in advance. An
/// explicitly attempted but unauthorised trigger is reported separately; when
/// no attempt is marked, the ordinary cue rules remain in force.
pub fn mention_gate(input: &MentionInput<'_>) -> MentionDecision {
    let level = effective_surface_level(input);

    if level == SurfaceLevel::NeverSurface {
        // Distinguish why, so diagnostics and the UI can explain the silence.
        let reason = if input.do_not_surface == Some(true) {
            GateDenial::DoNotSurface
        } else {
            GateDenial::NeverSurface
        };
        return MentionDecision::Denied { reason, level };
    }

    if input.cues.time_trigger_attempted && !input.cues.time_trigger_authorised {
        return MentionDecision::Denied {
            reason: GateDenial::TimeTriggerNotAuthorised,
            level,
        };
    }

    let has_substantive_cue = input.cues.user_referenced || input.cues.topic_implies;

    // An authorised time trigger is a user-granted licence even without a
    // substantive cue. The record's own level remains a ceiling: a
    // BackgroundOnly record is still background-only.
    if input.cues.time_trigger_authorised && !has_substantive_cue {
        return MentionDecision::Allowed {
            level,
            background_only: level == SurfaceLevel::BackgroundOnly,
        };
    }

    if level == SurfaceLevel::FreelyMentionable {
        if input.shared_world_term && !input.cues.shared_term_in_user_turn {
            return MentionDecision::Denied {
                reason: GateDenial::UsesUnlicensedSharedTerm,
                level,
            };
        }
        return MentionDecision::Allowed {
            level,
            background_only: false,
        };
    }

    if level == SurfaceLevel::MentionIfUserCues {
        if !has_substantive_cue {
            return MentionDecision::Denied {
                reason: GateDenial::AwaitingUserCue,
                level,
            };
        }
        return MentionDecision::Allowed {
            level,
            background_only: false,
        };
    }

    // BackgroundOnly: usable, never citable (I13).
    MentionDecision::Allowed {
        level,
        background_only: true,
    }
}

/// Apply the mention gate to a [`Claim`].
pub fn claim_mention(claim: &Claim, cues: MentionCues) -> MentionDecision {
    mention_gate(&MentionInput {
        predicate: Some(&claim.predicate),
        record_mode: None,
        do_not_surface: claim.salience.do_not_surface,
        shared_world_term: false,
        cues,
    })
}

/// Apply the mention gate to a directly described episode.
///
/// Episodes do not have a predicate registry row, so their own policy is the
/// cue-gated ceiling. Keeping this wrapper beside `claim_mention` prevents
/// callers from reimplementing episode authorization with ad-hoc substring
/// checks and, importantly, makes `do_not_surface` effective for episodes too.
pub fn episode_mention(episode: &Episode, cues: MentionCues) -> MentionDecision {
    mention_gate(&MentionInput {
        predicate: None,
        record_mode: Some(MentionMode::MentionIfUserCues),
        do_not_surface: episode.salience.do_not_surface,
        shared_world_term: false,
        cues,
    })
}

/// Apply the mention gate to an [`Inference`].
///
/// An inference that is not `Active` is never spoken: `Accumulating`,
/// `Rejected`, and `Expired` all stay silent, which keeps a half-formed
/// impression from being voiced as if it were settled.
pub fn inference_mention(inference: &Inference, cues: MentionCues) -> MentionDecision {
    let input = MentionInput {
        predicate: Some(&inference.predicate),
        record_mode: Some(inference.use_mode),
        do_not_surface: inference.salience.do_not_surface,
        shared_world_term: matches!(inference.axis, InferenceAxis::SharedWorld),
        cues,
    };

    if inference.state != InferenceState::Active {
        return MentionDecision::Denied {
            reason: GateDenial::InferenceNotActive,
            level: effective_surface_level(&input),
        };
    }

    mention_gate(&input)
}

/// Whether a predicate belongs in the constraint set rather than the scored
/// candidate pool.
///
/// Boundaries are obligations, not candidates (I10): they are always in force,
/// so they never compete for prompt budget and never need a cue.
pub fn is_constraint(predicate: Option<&str>) -> bool {
    predicate.is_some_and(|predicate| predicate.starts_with("boundary."))
}
