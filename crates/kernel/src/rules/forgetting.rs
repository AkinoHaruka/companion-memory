//! Forgetting as suppression, content scanning and derived recomputation.
//!
//! Forgetting does not erase a record from the evidence graph. It creates a
//! pure, auditable decision that readers can apply, and it makes an inference
//! collapse when the support that justified it is no longer live (I4 and I5).
//! Exact content scanning catches copied text that escaped into another layer;
//! possible paraphrases are reported for review because a lexical guess is not
//! safe enough to delete memory automatically.

use std::cmp::Ordering;
use std::collections::{HashMap, HashSet};

use crate::domain::types::{Claim, Episode, EvidenceRef, EvidenceSourceType, Inference};
use crate::rules::evidence::{self, EvidenceResolution};
use crate::rules::record_identity::normalize_for_comparison;

/// What the user asked to forget, after the host has resolved their words.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ForgetTarget {
    /// Named records and messages.
    Records {
        /// Stable record or message ids named by the resolved request.
        source_ids: Vec<String>,
    },
    /// Every record carrying one predicate, e.g. all of `identity.location`.
    Predicate {
        /// The canonical predicate key to suppress.
        predicate: String,
    },
    /// Every record naming one entity.
    Entity {
        /// The stable entity reference to suppress.
        entity_ref: String,
    },
    /// Everything, for a profile reset.
    All,
}

/// A suppression set, plus why each id is in it, for the audit trail.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct SuppressionSet {
    /// Ids no reader may use, across every layer.
    pub suppressed: HashSet<String>,
    /// Predicate keys whose records are withheld, for the `Predicate` target.
    pub suppressed_predicates: HashSet<String>,
    /// Entity references whose records are withheld, for the `Entity` target.
    pub suppressed_entities: HashSet<String>,
    /// Whether everything is withheld.
    pub all: bool,
}

impl SuppressionSet {
    /// Build the suppression representation for a resolved forget target.
    ///
    /// Record ids are deduplicated by the set. Predicate and entity strings
    /// remain exact because they are already canonical identifiers by the time
    /// the host constructs a [`ForgetTarget`].
    pub fn from_target(target: impl Into<ForgetTarget>) -> Self {
        match target.into() {
            ForgetTarget::Records { source_ids } => Self {
                suppressed: source_ids.into_iter().collect(),
                ..Self::default()
            },
            ForgetTarget::Predicate { predicate } => Self {
                suppressed_predicates: [predicate].into_iter().collect(),
                ..Self::default()
            },
            ForgetTarget::Entity { entity_ref } => Self {
                suppressed_entities: [entity_ref].into_iter().collect(),
                ..Self::default()
            },
            ForgetTarget::All => Self {
                all: true,
                ..Self::default()
            },
        }
    }

    /// Whether one claim is withheld by this set.
    ///
    /// An entity target only matches a claim that carries a structured
    /// `entity_ref`; it does not guess from the claim's value text.
    pub fn suppresses_claim(&self, claim: &Claim) -> bool {
        self.all
            || self.suppressed.contains(&claim.id)
            || self.suppressed_predicates.contains(&claim.predicate)
            || claim
                .entity_ref
                .as_deref()
                .is_some_and(|entity_ref| self.suppressed_entities.contains(entity_ref))
    }

    /// Whether one episode is withheld by this set.
    ///
    /// Episodes carry no predicate, so predicate suppression does not match an
    /// episode. An entity target matches a named participant; free-form
    /// narrative text is intentionally left to the content scanners.
    pub fn suppresses_episode(&self, episode: &Episode) -> bool {
        self.all
            || self.suppressed.contains(&episode.id)
            || episode.participants.iter().any(|participant| {
                participant
                    .entity_ref
                    .as_deref()
                    .is_some_and(|entity_ref| self.suppressed_entities.contains(entity_ref))
            })
    }

    /// Whether one inference is withheld outright, ignoring its evidence.
    ///
    /// [`Inference`] has no structured entity reference. Entity-targeted
    /// effects on its support are therefore decided by
    /// [`derived_disposition`], not guessed from its natural-language value.
    pub fn suppresses_inference(&self, inference: &Inference) -> bool {
        self.all
            || self.suppressed.contains(&inference.id)
            || self.suppressed_predicates.contains(&inference.predicate)
    }

    /// Whether one evidence reference is withheld by this set.
    ///
    /// A reference carries its source id but not the source record's predicate
    /// or entity, so those two target kinds are applied when the host resolves
    /// the referenced record.
    pub fn suppresses_ref(&self, reference: &EvidenceRef) -> bool {
        self.all || self.suppressed.contains(&reference.source_id)
    }
}

impl From<ForgetTarget> for SuppressionSet {
    fn from(target: ForgetTarget) -> Self {
        Self::from_target(target)
    }
}

impl From<&ForgetTarget> for ForgetTarget {
    fn from(target: &ForgetTarget) -> Self {
        target.clone()
    }
}

/// A normalised fingerprint of a record value, for exact-match scanning.
///
/// Takes the value rather than a string so that there is exactly **one**
/// canonical form. An earlier signature took `&str` and wrapped it in a JSON
/// string before normalising, which quoted it, while [`would_resurrect`]
/// normalised the value directly. The two produced different fingerprints for
/// the same content, so a suppressed record could be written straight back: the
/// guard compared two strings that could never be equal, and neither function
/// looked wrong on its own.
///
/// Delegates to [`normalize_for_comparison`], so case and runs of whitespace do
/// not change the result. It deliberately does not stem, find synonyms or
/// otherwise make a semantic claim: exact matching is safe to act on, while a
/// token-overlap guess belongs in [`find_suspected_residue`].
pub fn fingerprint(value: &serde_json::Value) -> String {
    normalize_for_comparison(value)
}

/// The fingerprint of content that is plain text.
///
/// The convenience form for callers holding prose — a narrative, a message body
/// — where the wrapping is mechanical. Prefer [`fingerprint`] wherever a
/// `serde_json::Value` is already in hand, so the canonical form stays visible
/// at the call site.
pub fn fingerprint_text(text: &str) -> String {
    fingerprint(&serde_json::Value::String(text.to_owned()))
}

/// A record whose text still contains a suppressed fingerprint exactly.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ExactResidue<'a> {
    /// The layer containing the surviving record.
    pub source_type: EvidenceSourceType,
    /// The surviving record's id.
    pub source_id: &'a str,
    /// The forgotten record id whose fingerprint was found.
    pub matched_id: &'a str,
}

/// A text-bearing record supplied by the host for residue scanning.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TextCandidate<'a> {
    /// The layer containing the candidate.
    pub source_type: EvidenceSourceType,
    /// The candidate record's id.
    pub source_id: &'a str,
    /// Text retained by the candidate record.
    pub text: &'a str,
}

/// Return map entries in deterministic id order for audit results.
fn ordered_fingerprint_entries(
    suppressed_fingerprints: &HashMap<String, String>,
) -> Vec<(&str, &str)> {
    let mut entries: Vec<(&str, &str)> = suppressed_fingerprints
        .iter()
        .map(|(matched_id, text)| (matched_id.as_str(), text.as_str()))
        .collect();
    entries.sort_unstable_by(|left, right| left.0.cmp(right.0));
    entries
}

/// Find surviving records whose text still contains a suppressed fingerprint.
///
/// `suppressed_fingerprints` is keyed by the forgotten source id and stores
/// that record's [`fingerprint`]. The candidate list is expected to contain
/// records that are otherwise still eligible for reading; a candidate with a
/// suppressed id is ignored as the original, not reported as residue.
pub fn find_exact_residue<'a>(
    suppressed_fingerprints: &'a HashMap<String, String>,
    candidates: &'a [TextCandidate<'a>],
) -> Vec<ExactResidue<'a>> {
    let entries = ordered_fingerprint_entries(suppressed_fingerprints);
    let mut residue = Vec::new();

    for candidate in candidates {
        if suppressed_fingerprints.contains_key(candidate.source_id) {
            continue;
        }

        let candidate_fingerprint = fingerprint_text(candidate.text);
        if candidate_fingerprint.is_empty() {
            continue;
        }

        for (matched_id, suppressed_fingerprint) in &entries {
            if !suppressed_fingerprint.is_empty()
                && candidate_fingerprint.contains(suppressed_fingerprint)
            {
                residue.push(ExactResidue {
                    source_type: candidate.source_type,
                    source_id: candidate.source_id,
                    matched_id,
                });
            }
        }
    }

    residue
}

/// A record that partly overlaps a suppressed fingerprint.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct SuspectedResidue<'a> {
    /// The layer containing the candidate.
    pub source_type: EvidenceSourceType,
    /// The candidate record's id.
    pub source_id: &'a str,
    /// Jaccard similarity over the two texts' tokens, for triage order.
    pub similarity: f64,
}

/// Report candidates that may paraphrase suppressed content, loudest first.
///
/// These are **reported for review, never deleted automatically.** A paraphrase
/// detector with no model behind it is a guess, and deleting a guess destroys
/// unrelated memory. ASCII runs are split on non-alphanumeric characters;
/// runs of non-ASCII characters use overlapping bigrams, with a single
/// character kept as a one-character token. This avoids a word-segmentation
/// dependency while retaining useful overlap for languages without spaces.
pub fn find_suspected_residue<'a>(
    suppressed_fingerprints: &HashMap<String, String>,
    candidates: &'a [TextCandidate<'a>],
    min_similarity: f64,
) -> Vec<SuspectedResidue<'a>> {
    let entries = ordered_fingerprint_entries(suppressed_fingerprints);
    if entries.is_empty() {
        return Vec::new();
    }

    let mut suspected = Vec::new();
    for candidate in candidates {
        if suppressed_fingerprints.contains_key(candidate.source_id) {
            continue;
        }

        let candidate_tokens = tokens(candidate.text);
        if candidate_tokens.is_empty() {
            continue;
        }

        let similarity = entries
            .iter()
            .map(|(_, suppressed_text)| jaccard(&candidate_tokens, &tokens(suppressed_text)))
            .fold(0.0, f64::max);

        // An empty intersection is not a suspected residue even when callers
        // deliberately choose a zero threshold.
        if similarity > 0.0 && similarity >= min_similarity {
            suspected.push(SuspectedResidue {
                source_type: candidate.source_type,
                source_id: candidate.source_id,
                similarity,
            });
        }
    }

    suspected.sort_by(|left, right| {
        right
            .similarity
            .partial_cmp(&left.similarity)
            .unwrap_or(Ordering::Equal)
    });
    suspected
}

/// Split text into deterministic lexical tokens without a segmentation model.
fn tokens(text: &str) -> HashSet<String> {
    let normalised = fingerprint_text(text);
    let mut tokens = HashSet::new();
    let mut ascii_run = String::new();
    let mut non_ascii_run = Vec::new();

    for character in normalised.chars() {
        if character.is_ascii() {
            flush_non_ascii_run(&mut non_ascii_run, &mut tokens);
            if character.is_ascii_alphanumeric() {
                ascii_run.push(character);
            } else {
                flush_ascii_run(&mut ascii_run, &mut tokens);
            }
        } else {
            flush_ascii_run(&mut ascii_run, &mut tokens);
            non_ascii_run.push(character);
        }
    }

    flush_ascii_run(&mut ascii_run, &mut tokens);
    flush_non_ascii_run(&mut non_ascii_run, &mut tokens);
    tokens
}

/// Finish one ASCII token run.
fn flush_ascii_run(run: &mut String, tokens: &mut HashSet<String>) {
    if !run.is_empty() {
        tokens.insert(std::mem::take(run));
    }
}

/// Finish one non-ASCII run as overlapping bigrams.
fn flush_non_ascii_run(run: &mut Vec<char>, tokens: &mut HashSet<String>) {
    match run.len() {
        0 => {}
        1 => {
            tokens.insert(run[0].to_string());
        }
        _ => {
            for window in run.windows(2) {
                tokens.insert(window.iter().collect());
            }
        }
    }
    run.clear();
}

/// Compute Jaccard similarity for two token sets.
fn jaccard(left: &HashSet<String>, right: &HashSet<String>) -> f64 {
    if left.is_empty() || right.is_empty() {
        return 0.0;
    }

    let intersection = left.intersection(right).count() as f64;
    let union = left.union(right).count() as f64;
    intersection / union
}

/// The disposition of one inference after its evidence was recomputed.
#[derive(Debug, Clone, PartialEq)]
pub enum DerivedDisposition {
    /// Nothing changed; evidence still supports it.
    Unchanged,
    /// Some support was suppressed but enough remains; confidence drops.
    Weakened {
        /// Confidence after host recomputation, bounded by the old value.
        new_confidence: f64,
        /// Number of support references removed from the live set.
        removed_support: usize,
    },
    /// No support remains. The record is invalid; the caller must not delete it
    /// silently but must stop using it (I5).
    Collapsed,
    /// The record itself, or all of its evidence, was directly suppressed.
    Withheld,
}

/// Add the suppression decisions that can be resolved from the supplied maps.
///
/// `EvidenceResolution` is intentionally still the authority for liveness and
/// collapse. This helper only projects the richer target selectors onto the
/// ids that the evidence resolver can see, leaving the actual I5 decision to
/// [`evidence::is_collapsed`].
fn effective_resolution(
    inference: &Inference,
    suppression: &SuppressionSet,
    resolution: &EvidenceResolution,
) -> EvidenceResolution {
    let mut effective = resolution.clone();
    effective
        .suppressed
        .extend(suppression.suppressed.iter().cloned());

    if suppression.all {
        effective.suppressed.extend(
            inference
                .support_evidence
                .iter()
                .map(|reference| reference.source_id.clone()),
        );
        return effective;
    }

    effective.suppressed.extend(
        resolution
            .claims
            .values()
            .filter(|claim| suppression.suppresses_claim(claim))
            .map(|claim| claim.id.clone()),
    );
    effective.suppressed.extend(
        resolution
            .episodes
            .values()
            .filter(|episode| suppression.suppresses_episode(episode))
            .map(|episode| episode.id.clone()),
    );
    effective
}

/// Decide what becomes of one inference once a suppression set is applied.
///
/// `recompute_confidence` is the host's re-derivation from the surviving
/// evidence; the kernel decides the disposition, not the new truth. The
/// resolution is copied and augmented with target matches that can be resolved
/// from its claim and episode maps, then the existing evidence liveness and I5
/// helpers decide which references survived.
pub fn derived_disposition(
    inference: &Inference,
    suppression: &SuppressionSet,
    resolution: &EvidenceResolution,
    recompute_confidence: impl Fn(&Inference, &[&EvidenceRef]) -> f64,
) -> DerivedDisposition {
    if suppression.suppresses_inference(inference) {
        return DerivedDisposition::Withheld;
    }

    let effective = effective_resolution(inference, suppression, resolution);
    if evidence::is_collapsed(&inference.support_evidence, &effective) {
        return DerivedDisposition::Collapsed;
    }

    let surviving = evidence::live_evidence(&inference.support_evidence, &effective);
    let removed_support = inference
        .support_evidence
        .len()
        .saturating_sub(surviving.len());
    if removed_support == 0 {
        return DerivedDisposition::Unchanged;
    }

    let old_confidence = clamp_unit(inference.confidence);
    let recomputed = clamp_unit(recompute_confidence(inference, &surviving));
    let new_confidence = recomputed.min(old_confidence);
    DerivedDisposition::Weakened {
        new_confidence,
        removed_support,
    }
}

/// Whether a freshly proposed record would reintroduce forgotten content.
///
/// Every write path must call this (I4). Suppression that only filters reads
/// leaves the next extraction free to write the same fact again, which is the
/// failure the fingerprint exists to prevent. When multiple exact fingerprints
/// match, the lexicographically first id gives the audit result deterministic
/// precedence.
pub fn would_resurrect(
    predicate: &str,
    value: &serde_json::Value,
    entity_ref: Option<&str>,
    suppression: &SuppressionSet,
    suppressed_fingerprints: &HashMap<String, String>,
) -> Option<ResurrectionReason> {
    if suppression.all {
        return Some(ResurrectionReason::AllSuppressed);
    }
    if suppression.suppressed_predicates.contains(predicate) {
        return Some(ResurrectionReason::PredicateSuppressed {
            predicate: predicate.to_owned(),
        });
    }
    if let Some(entity_ref) = entity_ref {
        if suppression.suppressed_entities.contains(entity_ref) {
            return Some(ResurrectionReason::EntitySuppressed {
                entity_ref: entity_ref.to_owned(),
            });
        }
    }

    let value_fingerprint = normalize_for_comparison(value);
    if value_fingerprint.is_empty() {
        return None;
    }

    // The map holds **label -> fingerprint**, and the orientation is
    // load-bearing. Reversed, this compares a fingerprint against a
    // human-readable label, the two can never be equal, and the guard silently
    // never fires while every suppression row still looks correct. The storage
    // loader converts its rows into exactly this orientation, and the
    // integration test pins the direction.
    suppressed_fingerprints
        .iter()
        .filter(|(_, fingerprint)| !fingerprint.is_empty() && value_fingerprint == **fingerprint)
        .map(|(label, _)| label.as_str())
        .min()
        .map(|matched_id| ResurrectionReason::FingerprintMatch {
            matched_id: matched_id.to_owned(),
        })
}

/// Why a proposed record would reintroduce forgotten content.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ResurrectionReason {
    /// A suppressed predicate.
    PredicateSuppressed {
        /// The predicate that is withheld.
        predicate: String,
    },
    /// A suppressed entity.
    EntitySuppressed {
        /// The entity reference that is withheld.
        entity_ref: String,
    },
    /// Everything is suppressed.
    AllSuppressed,
    /// The value's fingerprint matches forgotten content.
    FingerprintMatch {
        /// The forgotten record whose fingerprint matched.
        matched_id: String,
    },
}

/// Clamp an untrusted confidence into the mathematical confidence interval.
fn clamp_unit(value: f64) -> f64 {    if value.is_nan() {
        0.0
    } else {
        value.clamp(0.0, 1.0)
    }
}


