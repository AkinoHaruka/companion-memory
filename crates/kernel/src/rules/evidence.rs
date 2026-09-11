//! Evidence admissibility — what a piece of support is allowed to prove.
//!
//! An [`Inference`](crate::domain::types::Inference) is a model's belief about
//! the user. This module is the gate on the evidence it cites and enforces I1,
//! I8 and I5 from DESIGN.md §5. I1 keeps the companion's own speech out of
//! beliefs about the user, I8 keeps disallowed predicates out of inference
//! support, and I5 makes a belief collapse when no live evidence remains.
//!
//! A `boundary.*` claim is also diagnosed separately from the generic I8
//! rejection. A boundary is a constraint the companion must obey, not a fact
//! about who the user is. That diagnostic remains specific even for an
//! unregistered `boundary.*` key.
//!
//! All functions are pure. The host owns the message log, so message refs
//! resolve by construction; claims and episodes are resolved from the maps
//! supplied by the caller.

use std::collections::{HashMap, HashSet};

use crate::domain::predicate_keys::{split_predicate, Domain, MISC_PREDICATE};
use crate::domain::predicates::{inference_allowed_for, spec_for};
use crate::domain::types::{Claim, Episode, EvidenceRef, EvidenceSourceType, Speaker};

/// Why one evidence ref is unresolved for a caller that collapses outcomes.
///
/// The main evidence gate reports the more precise [`EvidenceViolation`]
/// variants [`EvidenceViolation::SuppressedSource`],
/// [`EvidenceViolation::UnknownSource`] and
/// [`EvidenceViolation::SourceTypeMismatch`]. This compact classification is
/// available when a caller only needs to distinguish a forgotten source from
/// one that was never resolvable.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SuppressedSourceKind {
    /// The declared source resolved, but its id is in the suppression set.
    Suppressed,
    /// The source is absent or is known only under a different source type.
    Unresolvable,
}

/// Why an evidence ref cannot support an inference about the user.
///
/// These are reportable outcomes rather than panics: extraction and promotion
/// run on model output and must hold a candidate for review when a rule fails.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EvidenceViolation {
    /// I1 — assistant speech can never establish what the user is like.
    AssistantSpeaker {
        /// The ref whose speaker is the assistant.
        reference: EvidenceRef,
    },
    /// I8 — the predicate registry forbids inference support.
    InferenceDisallowed {
        /// The ref whose claim predicate is disallowed.
        reference: EvidenceRef,
        /// The predicate that caused the rejection.
        predicate: String,
    },
    /// A `boundary.*` claim is a constraint, not evidence about the user.
    BoundaryIsConstraint {
        /// The ref whose claim is a boundary constraint.
        reference: EvidenceRef,
        /// The boundary predicate.
        predicate: String,
    },
    /// The ref names no record in the declared source layer or the alternate
    /// layer checked for a source-type mismatch.
    UnknownSource {
        /// The ref that could not be resolved.
        reference: EvidenceRef,
    },
    /// The id exists, but only under another evidence layer.
    SourceTypeMismatch {
        /// The ref that names the wrong layer.
        reference: EvidenceRef,
        /// The layer declared by the ref.
        expected: EvidenceSourceType,
    },
    /// The source resolved, but the user asked for that id to be forgotten.
    SuppressedSource {
        /// The ref whose source was suppressed.
        reference: EvidenceRef,
    },
    /// A compact unresolved outcome for callers that need to distinguish a
    /// suppressed source from a source that cannot be resolved.
    UnresolvedEvidence {
        /// Whether the source was suppressed or unresolvable.
        reason: SuppressedSourceKind,
    },
}

/// The evidence the caller can resolve.
///
/// The host owns the message log, so message refs resolve by construction and
/// [`EvidenceResolution::suppressed`] is the only thing that removes them.
#[derive(Debug, Default, Clone)]
pub struct EvidenceResolution {
    /// Claims keyed by their stable record id.
    pub claims: HashMap<String, Claim>,
    /// Episodes keyed by their stable record id.
    pub episodes: HashMap<String, Episode>,
    /// Message, claim and episode ids the user asked to forget.
    pub suppressed: HashSet<String>,
}

/// The result of auditing every ref in an inference's support set.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EvidenceVerdict {
    /// Whether no support ref violated an evidence rule.
    pub valid: bool,
    /// Every violation, ordered by support position and then rule order.
    pub violations: Vec<EvidenceViolation>,
}

/// What a ref resolves to before suppression and predicate checks.
#[derive(Debug, Clone, Copy)]
enum SourceResolution<'a> {
    Claim { predicate: &'a str },
    Episode,
    Message,
    Unknown,
    Mismatch,
}

/// Resolve a ref against the caller's known record maps.
///
/// A claim ref and an episode ref each check the other map when their declared
/// layer is absent. That preserves [`EvidenceViolation::SourceTypeMismatch`]
/// instead of hiding a bookkeeping error as [`EvidenceViolation::UnknownSource`].
fn resolve_source<'a>(
    reference: &EvidenceRef,
    resolution: &'a EvidenceResolution,
) -> SourceResolution<'a> {
    match reference.source_type {
        EvidenceSourceType::Claim => {
            if let Some(claim) = resolution.claims.get(&reference.source_id) {
                SourceResolution::Claim {
                    predicate: &claim.predicate,
                }
            } else if resolution.episodes.contains_key(&reference.source_id) {
                SourceResolution::Mismatch
            } else {
                SourceResolution::Unknown
            }
        }
        EvidenceSourceType::Episode => {
            if resolution.episodes.contains_key(&reference.source_id) {
                SourceResolution::Episode
            } else if resolution.claims.contains_key(&reference.source_id) {
                SourceResolution::Mismatch
            } else {
                SourceResolution::Unknown
            }
        }
        EvidenceSourceType::Message => {
            // The kernel holds no message log. A host that can prove a message
            // is gone must add its id to `suppressed`; otherwise a message ref
            // resolves by construction.
            SourceResolution::Message
        }
    }
}

/// Return every rule this ref violates, in the documented order.
///
/// The write-path gate takes the first item from this list. The promotion audit
/// keeps all of them, so the two entry points cannot drift in rule ordering or
/// accidentally disagree about a ref that breaks multiple rules.
fn violations_for(
    reference: &EvidenceRef,
    resolution: &EvidenceResolution,
) -> Vec<EvidenceViolation> {
    let mut violations = Vec::new();

    // I1 — speaker, not semantic role or provenance confidence, decides.
    if reference.speaker == Speaker::Assistant {
        violations.push(EvidenceViolation::AssistantSpeaker {
            reference: reference.clone(),
        });
    }

    let source = resolve_source(reference, resolution);
    match source {
        SourceResolution::Unknown => {
            violations.push(EvidenceViolation::UnknownSource {
                reference: reference.clone(),
            });
        }
        SourceResolution::Mismatch => {
            violations.push(EvidenceViolation::SourceTypeMismatch {
                reference: reference.clone(),
                expected: reference.source_type,
            });
        }
        SourceResolution::Claim { .. } | SourceResolution::Episode | SourceResolution::Message => {}
    }

    // Resolution deliberately precedes suppression. An id in the suppression
    // set cannot turn an absent record into a known record.
    if resolution.suppressed.contains(&reference.source_id) {
        violations.push(EvidenceViolation::SuppressedSource {
            reference: reference.clone(),
        });
    }

    if let SourceResolution::Claim { predicate } = source {
        // The registry is authoritative when it knows the key. The fallback
        // recognises an unregistered boundary as a constraint immediately.
        let domain = spec_for(predicate)
            .map(|spec| spec.domain)
            .or_else(|| split_predicate(predicate).map(|(domain, _)| domain));

        if domain == Some(Domain::Boundary) {
            violations.push(EvidenceViolation::BoundaryIsConstraint {
                reference: reference.clone(),
                predicate: predicate.to_string(),
            });
        } else if domain == Some(Domain::Misc)
            || predicate == MISC_PREDICATE
            || !inference_allowed_for(predicate)
        {
            violations.push(EvidenceViolation::InferenceDisallowed {
                reference: reference.clone(),
                predicate: predicate.to_string(),
            });
        }
    }

    violations
}

/// Whether one ref may support an inference about the user.
///
/// Returns the first violation in the I1, resolution, suppression and I8 rule
/// order, or `None` when the ref is admissible. A suppressed ref is still
/// checked here; use [`live_evidence`] when the caller needs only live refs.
pub fn may_support_user_inference(
    reference: &EvidenceRef,
    resolution: &EvidenceResolution,
) -> Option<EvidenceViolation> {
    violations_for(reference, resolution).into_iter().next()
}

/// Audit every support ref and return every violation found.
///
/// Violations are ordered by support position and, within one ref, by the
/// shared rule order. Thus an assistant ref to a boundary claim reports both
/// [`EvidenceViolation::AssistantSpeaker`] and
/// [`EvidenceViolation::BoundaryIsConstraint`]. An empty support slice is
/// valid here; whether it has collapsed under I5 is answered by
/// [`is_collapsed`].
pub fn verify_inference_evidence(
    support: &[EvidenceRef],
    resolution: &EvidenceResolution,
) -> EvidenceVerdict {
    let violations: Vec<EvidenceViolation> = support
        .iter()
        .flat_map(|reference| violations_for(reference, resolution))
        .collect();
    EvidenceVerdict {
        valid: violations.is_empty(),
        violations,
    }
}

/// Whether an inference has no live support left (I5).
///
/// An empty support set is collapsed. A non-empty set is also collapsed when
/// every ref is suppressed or cannot resolve; one live ref is enough to keep it
/// live. The inference record need not be deleted, preserving its audit trail.
pub fn is_collapsed(support: &[EvidenceRef], resolution: &EvidenceResolution) -> bool {
    live_evidence(support, resolution).is_empty()
}

/// Return support refs that resolve and are not suppressed.
///
/// This is deliberately not an admissibility filter: a live boundary claim or
/// assistant ref may be useful as counter-evidence even though it cannot
/// support an inference about the user.
pub fn live_evidence<'a>(
    refs: &'a [EvidenceRef],
    resolution: &EvidenceResolution,
) -> Vec<&'a EvidenceRef> {
    refs.iter()
        .filter(|reference| is_live(reference, resolution))
        .collect()
}

/// Return live counter-evidence refs using the same pure liveness filter.
///
/// Counter-evidence is not passed through the support admissibility rules: a
/// boundary claim can contradict a belief while remaining a constraint.
pub fn live_counter_evidence<'a>(
    counter: &'a [EvidenceRef],
    resolution: &EvidenceResolution,
) -> Vec<&'a EvidenceRef> {
    live_evidence(counter, resolution)
}

/// Whether a ref still resolves and has not been suppressed.
fn is_live(reference: &EvidenceRef, resolution: &EvidenceResolution) -> bool {
    if resolution.suppressed.contains(&reference.source_id) {
        return false;
    }

    !matches!(
        resolve_source(reference, resolution),
        SourceResolution::Unknown | SourceResolution::Mismatch
    )
}
