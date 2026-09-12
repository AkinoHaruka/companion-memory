//! Predicate registry — the behavioural half of the vocabulary.
//!
//! A predicate key decides four things at once (DESIGN.md §3.0):
//!   1. the write path          — may a new value supersede an old one?
//!   2. the dedup key           — which records are even candidates to merge?
//!   3. whether a model may build an inference on it
//!   4. how it may be mentioned
//!
//! [`crate::domain::predicate_keys`] owns *which* keys exist; this module owns
//! *what they mean*. `tests/agreement.rs` asserts the two describe exactly the
//! same key set.
//!
//! The registry is a flat table rather than nested data: it is reviewable row by
//! row, and lookup is a linear scan over 46 rows, which is faster than a hash at
//! this size.

// The axis enums (`Cardinality`, `ValueKind`, `MentionMode`, `Sensitivity`,
// `Lifetime`) are table cell types: their variants are named and read in the
// registry below, and a doc comment per variant would restate the column
// comment. The types themselves carry docs; their variants deliberately do not.
#![allow(missing_docs)]

use serde::{Deserialize, Serialize};
use std::sync::OnceLock;

use crate::domain::predicate_keys::{all_predicate_keys, split_predicate, Domain, PredicateKey};

/// How many values a predicate may hold for one (entity, qualifier) key.
///
/// This is the fix for the design's most severe defect: `kind + subject` is not
/// a memory primary key. "I design, and I also teach painting on weekends"
/// cannot have its second half supersede its first — so `occupation` is a set,
/// while `name` is not.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Cardinality {
    /// Exactly one value; a new value supersedes the previous one.
    Single,
    /// Many values coexist; only equivalent duplicates merge.
    Set,
    /// One value *at a time*, but changes over time are expected and meaningful.
    TemporalSingle,
}

impl Cardinality {
    /// Whether this cardinality ever replaces an existing value.
    ///
    /// For a set, a new differing value is additional information, not a
    /// correction.
    pub const fn supersedes(self) -> bool {
        matches!(self, Cardinality::Single | Cardinality::TemporalSingle)
    }
}

/// Coarse value shape, used for the pre-supersede type-compatibility check.
///
/// Without this check a misclassified input destroys data silently: "I'm
/// thinking about moving cities" filed into the location predicate would
/// supersede "lives in Beijing", and nothing anywhere would report an error.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ValueKind {
    Text,
    Enum,
    Date,
    Duration,
    Number,
    EntityRef,
}

impl ValueKind {
    /// Every kind, for exhaustive tests.
    pub const ALL: &'static [ValueKind] = &[
        ValueKind::Text,
        ValueKind::Enum,
        ValueKind::Date,
        ValueKind::Duration,
        ValueKind::Number,
        ValueKind::EntityRef,
    ];
}

/// How a record may be surfaced. See DESIGN.md §3.6.
///
/// Ordered from quietest to loudest so that "gates may only ever make a record
/// quieter" is expressible as a minimum over levels.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MentionMode {
    /// Never surfaced at all.
    NeverSurface,
    /// Only shapes tone and word choice; must never be recited.
    BackgroundOnly,
    /// May be recited when the user refers to it or the topic implies it.
    MentionIfUserCues,
    /// May be raised without a cue.
    FreelyMentionable,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Sensitivity {
    Low,
    Medium,
    High,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Lifetime {
    Permanent,
    Session,
    UntilSuperseded,
}

/// One row of the registry.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PredicateSpec {
    pub key: PredicateKey,
    pub domain: Domain,
    pub cardinality: Cardinality,
    pub kind: ValueKind,
    pub sensitivity: Sensitivity,
    /// Whether the model may build an inference whose evidence includes a
    /// record under this predicate (invariant I8).
    ///
    /// False for facts the user stated *about the relationship itself* — a
    /// boundary is a constraint to respect, not evidence about who someone is —
    /// and false for `misc`, so unclassified sludge cannot feed the inference
    /// engine.
    pub inference_allowed: bool,
    pub mention_policy: MentionMode,
    pub default_lifetime: Lifetime,
    /// Closed value set; always `Some` when `kind` is [`ValueKind::Enum`].
    pub enum_domain: Option<&'static [&'static str]>,
    /// One line, for reviewers and for the UI that lists what is remembered.
    pub description: &'static str,
}

// Column shorthand for the registry table below. These are table cells rather
// than public API, so the table's column comment is their documentation.
#[allow(missing_docs)]
mod cells {
    use super::{Cardinality, Lifetime, MentionMode, Sensitivity, ValueKind};

    pub const SET: Cardinality = Cardinality::Set;
    pub const ONE: Cardinality = Cardinality::Single;
    pub const T_SINGLE: Cardinality = Cardinality::TemporalSingle;

    pub const TXT: ValueKind = ValueKind::Text;
    pub const ENUM: ValueKind = ValueKind::Enum;
    pub const DATE: ValueKind = ValueKind::Date;
    pub const NUM: ValueKind = ValueKind::Number;
    pub const EREF: ValueKind = ValueKind::EntityRef;

    pub const LOW: Sensitivity = Sensitivity::Low;
    pub const MED: Sensitivity = Sensitivity::Medium;
    pub const HIGH: Sensitivity = Sensitivity::High;

    pub const BG: MentionMode = MentionMode::BackgroundOnly;
    pub const CUED: MentionMode = MentionMode::MentionIfUserCues;
    pub const FREE: MentionMode = MentionMode::FreelyMentionable;
    pub const NEVER: MentionMode = MentionMode::NeverSurface;

    pub const PERM: Lifetime = Lifetime::Permanent;
    pub const SESS: Lifetime = Lifetime::Session;
    pub const UNTIL: Lifetime = Lifetime::UntilSuperseded;
}

use cells::{
    BG, CUED, DATE, ENUM, EREF, FREE, HIGH, LOW, MED, NEVER, NUM, ONE, PERM, SESS, SET, TXT,
    T_SINGLE, UNTIL,
};

/// Closed enum domains, keyed by **full predicate key**.
///
/// Keying by subject alone was a defect in the TypeScript prototype:
/// `relationship.type` has the subject `type` while the domain table called its
/// entry `relationship_type`, so the lookup missed, the domain was omitted from
/// the spec, and value validation fell through its `is_some()` guard — silently
/// accepting *any* string for a closed vocabulary. Keying by full key makes that
/// collision impossible as the vocabulary grows.
pub mod enums {
    // Each constant is the value list for one predicate whose key names it, so
    // a per-constant doc comment would only restate the `enum_domain_for` match
    // below and the registry table above.
    #![allow(missing_docs)]

    pub const PRONOUNS: &[&str] = &["she/her", "he/him", "they/them", "ask", "other"];
    pub const FORMAT: &[&str] = &[
        "prose",
        "bullets",
        "markdown",
        "plain",
        "code_heavy",
        "mixed",
    ];
    pub const VERBOSITY: &[&str] = &["very_short", "short", "medium", "long", "adaptive"];
    pub const TONE: &[&str] = &["warm", "neutral", "direct", "playful", "formal", "gentle"];
    pub const INTERACTION_STYLE: &[&str] = &[
        "initiative_taking",
        "reactive",
        "socratic",
        "collaborative",
        "structured",
        "freeform",
    ];
    pub const PRESENCE_STYLE: &[&str] = &[
        "listen_first",
        "validate_first",
        "companionship",
        "practical_help",
        "space",
        "distraction",
    ];
    pub const WHEN_DISTRESSED: &[&str] = &[
        "listen",
        "validate",
        "clarify",
        "support",
        "problem_solve",
        "be_present_silently",
    ];
    pub const ADVICE_PERMISSION: &[&str] = &[
        "ask_before_advice",
        "advice_welcome",
        "no_advice_unless_asked",
    ];
    pub const PHYSICAL_CONTEXT: &[&str] = &[
        "mobile",
        "driving",
        "at_work",
        "in_public",
        "at_home",
        "unknown",
    ];
    pub const DIRECTNESS: &[&str] = &["very_direct", "direct", "gentle", "indirect"];
    pub const REASONING_DEPTH: &[&str] = &[
        "conclusion_only",
        "brief_reasoning",
        "detailed_reasoning",
        "show_work",
    ];
    pub const WHEN_TO_OFFER_STEPS: &[&str] = &["on_request", "when_stuck", "proactively", "never"];
    pub const RELATION_LABEL: &[&str] = &[
        "partner",
        "spouse",
        "parent",
        "child",
        "sibling",
        "friend",
        "best_friend",
        "colleague",
        "manager",
        "report",
        "ex_partner",
        "therapist",
        "pet",
        "other",
    ];
    pub const RELATIONSHIP_TYPE: &[&str] = &[
        "family",
        "friend",
        "romantic",
        "professional",
        "acquaintance",
        "adversarial",
        "other",
    ];
    pub const CLOSENESS: &[&str] = &[
        "very_close",
        "close",
        "moderate",
        "distant",
        "strained",
        "unknown",
    ];
}

/// The enum domain for a predicate key, if it has one.
///
/// Keyed by **full predicate key**. Keying by subject alone was a defect in the
/// TypeScript prototype: `relationship.type` has the subject `type` while the
/// domain table called its entry `relationship_type`, so the lookup missed, the
/// domain was omitted from the spec, and value validation fell through its
/// `is_some()` guard — silently accepting *any* string for a closed vocabulary.
/// Keying by full key makes that collision impossible as the vocabulary grows.
fn enum_domain_for(key: &str) -> Option<&'static [&'static str]> {
    use enums::*;
    match key.as_bytes() {
        b"identity.pronouns" => Some(PRONOUNS),
        b"communication.format" => Some(FORMAT),
        b"communication.verbosity" => Some(VERBOSITY),
        b"communication.tone" => Some(TONE),
        b"communication.interaction_style" => Some(INTERACTION_STYLE),
        b"support.presence_style" => Some(PRESENCE_STYLE),
        b"support.when_distressed" => Some(WHEN_DISTRESSED),
        b"support.advice_permission" => Some(ADVICE_PERMISSION),
        b"support.physical_context" => Some(PHYSICAL_CONTEXT),
        b"advice.directness" => Some(DIRECTNESS),
        b"advice.reasoning_depth" => Some(REASONING_DEPTH),
        b"advice.when_to_offer_steps" => Some(WHEN_TO_OFFER_STEPS),
        b"person.relation_label" => Some(RELATION_LABEL),
        b"relationship.type" => Some(RELATIONSHIP_TYPE),
        b"relationship.closeness" => Some(CLOSENESS),
        _ => None,
    }
}

/// One row of the registry table.
///
/// Column order: key, cardinality, kind, sensitivity, inference_allowed, mention
/// policy, lifetime, description. `domain` and `enum_domain` are derived from
/// the key by [`spec`] rather than restated, so a row cannot disagree with its
/// own prefix.
pub type Row = (
    PredicateKey,
    Cardinality,
    ValueKind,
    Sensitivity,
    bool,
    MentionMode,
    Lifetime,
    &'static str,
);

/// The registry, as a single reviewable table.
///
/// `misc.unclassified` is deliberately the one predicate that never supersedes
/// (invariant I2) and never feeds inferences (invariant I8).
#[rustfmt::skip]
pub static ROWS: &[Row] = &[
    // -- identity ----------------------------------------------------------
    ("identity.name",                    T_SINGLE, TXT,  HIGH, false, FREE, PERM,  "How the user is addressed."),
    ("identity.pronouns",                ONE,      ENUM, HIGH, false, FREE, PERM,  "Pronouns the user stated."),
    ("identity.timezone",                ONE,      TXT,  HIGH, false, FREE, PERM,  "IANA timezone or equivalent."),
    ("identity.locale",                  ONE,      TXT,  MED,  false, FREE, PERM,  "Language and region formatting preference."),
    ("identity.location",                SET,      EREF, HIGH, false, CUED, UNTIL, "A place tied to the user; the qualifier distinguishes current, home and work."),
    ("identity.occupation",              SET,      TXT,  HIGH, true,  CUED, UNTIL, "What the user does; a set allows concurrent roles."),
    ("identity.role",                    SET,      TXT,  HIGH, true,  CUED, UNTIL, "Roles the user holds, including informal ones."),
    ("identity.language",                SET,      TXT,  LOW,  false, FREE, PERM,  "Languages the user speaks or writes."),
    ("identity.age",                     T_SINGLE, NUM,  HIGH, false, NEVER, UNTIL, "Birth year or age. Never raised unprompted."),

    // -- boundary ----------------------------------------------------------
    // A boundary is a constraint to obey, not a fact to recite, so nothing
    // here is freely mentionable and nothing here may seed an inference.
    ("boundary.prohibition",             SET,      TXT,  HIGH, false, BG,   PERM,  "An explicit do-not-do instruction."),
    ("boundary.safety_limit",            SET,      TXT,  HIGH, false, BG,   PERM,  "A safety limit the companion must not cross."),
    ("boundary.privacy_rule",            SET,      TXT,  HIGH, false, BG,   PERM,  "What must not be stored, repeated or shared."),
    ("boundary.refusal",                 SET,      TXT,  HIGH, false, BG,   PERM,  "A topic or action the user refused."),
    ("boundary.topic_avoid",             SET,      TXT,  HIGH, false, BG,   PERM,  "Topics to handle with care or not raise."),
    ("boundary.soft_preference",         SET,      TXT,  MED,  false, BG,   UNTIL, "A weak do-not-do; repeated statements may promote it."),

    // -- communication -----------------------------------------------------
    ("communication.language",           ONE,      TXT,  LOW,  false, FREE, PERM,  "Language the companion should reply in."),
    ("communication.format",             SET,      ENUM, LOW,  false, FREE, UNTIL, "Preferred reply shape."),
    ("communication.verbosity",          ONE,      ENUM, LOW,  false, FREE, UNTIL, "Preferred reply length."),
    ("communication.tone",               SET,      ENUM, MED,  false, FREE, UNTIL, "Preferred register."),
    ("communication.interaction_style",  SET,      ENUM, MED,  false, FREE, UNTIL, "Preferred conversational stance."),

    // -- support -----------------------------------------------------------
    // Stated support preferences orient behaviour; phrasing them back at the
    // user would read as clinical, hence MentionIfUserCues.
    ("support.presence_style",           SET,      ENUM, MED,  false, CUED, UNTIL, "What kind of presence the user wants."),
    ("support.when_distressed",          SET,      ENUM, MED,  false, CUED, UNTIL, "What to do when the user is struggling."),
    ("support.advice_permission",        ONE,      ENUM, MED,  false, CUED, UNTIL, "Whether to ask before offering advice."),
    ("support.physical_context",         T_SINGLE, ENUM, HIGH, false, NEVER, SESS, "Being on mobile or in public; session-scoped."),

    // -- advice ------------------------------------------------------------
    ("advice.directness",                ONE,      ENUM, LOW,  false, CUED, UNTIL, "How blunt to be."),
    ("advice.reasoning_depth",           ONE,      ENUM, LOW,  false, CUED, UNTIL, "How much reasoning to show."),
    ("advice.when_to_offer_steps",       SET,      ENUM, LOW,  false, CUED, UNTIL, "When concrete steps are welcome."),

    // -- goal --------------------------------------------------------------
    // The MED rows here are `freely_mentionable`: a companion that cannot raise
    // something the user is working towards is not remembering them, it is only
    // answering. The HIGH row stays cue-gated, because "possibly not stated
    // publicly" is a reason to let the user choose the moment.
    ("goal.long_term_objective",         SET,      TXT,  MED,  true,  FREE, UNTIL, "A durable desired outcome."),
    ("goal.current_focus",               SET,      TXT,  MED,  true,  FREE, UNTIL, "What the user is actively working on."),
    ("goal.aspiration",                  SET,      TXT,  HIGH, true,  CUED, UNTIL, "A hoped-for future, possibly not stated publicly."),
    ("goal.constraint",                  SET,      TXT,  MED,  false, BG,   UNTIL, "A limit on how a goal may be pursued."),

    // -- open_loop ---------------------------------------------------------
    // Deadlines and promises are TemporalSingle: keeping every past deadline
    // active would make the surfacing pool grow without bound, and the trigger
    // only ever needs the live one.
    ("open_loop.pending_action",         SET,      TXT,  MED,  true,  FREE, UNTIL, "Something the user still has to do."),
    ("open_loop.low_risk_check_in",      SET,      TXT,  LOW,  true,  FREE, UNTIL, "An explicit low-risk practical task that may receive one greeting follow-up."),
    ("open_loop.waiting_on",             SET,      TXT,  MED,  true,  CUED, UNTIL, "Something the user is waiting for."),
    ("open_loop.promised_followup",      T_SINGLE, TXT,  MED,  false, CUED, UNTIL, "What the companion said it would follow up on. A user-facing commitment, never evidence about the user."),
    ("open_loop.deadline",               T_SINGLE, DATE, MED,  true,  CUED, UNTIL, "A dated commitment; drives authorised time triggers."),

    // -- ritual ------------------------------------------------------------
    // A habit the *user stated* is a Claim. Only a pattern the model *observed*
    // belongs to the Inference layer.
    ("ritual.recurring_activity",        SET,      TXT,  LOW,  true,  FREE, UNTIL, "A recurrent activity the user described."),
    ("ritual.frequency",                 ONE,      TXT,  LOW,  false, FREE, UNTIL, "How often the ritual happens."),
    ("ritual.trigger",                   SET,      TXT,  LOW,  false, CUED, UNTIL, "What precedes or prompts the ritual."),

    // -- person ------------------------------------------------------------
    ("person.name",                      ONE,      TXT,  MED,  true,  FREE, PERM,  "Name of a person in the user's life."),
    ("person.relation_label",            SET,      ENUM, MED,  true,  FREE, UNTIL, "How that person relates to the user."),
    ("person.occupation",                SET,      TXT,  MED,  true,  FREE, UNTIL, "What that person does."),
    ("person.age",                       T_SINGLE, NUM,  HIGH, true,  NEVER, UNTIL, "That person's age or birth year."),

    // -- relationship ------------------------------------------------------
    // Facts about a dyad. The *dynamic* of a relationship is observed over time
    // and therefore belongs to the Inference layer, not here. `closeness` stays
    // cue-gated: it is the user's private assessment of someone else.
    ("relationship.type",                ONE,      ENUM, MED,  true,  FREE, UNTIL, "Category of the relationship."),
    ("relationship.closeness",           ONE,      ENUM, HIGH, true,  CUED, UNTIL, "How close the user considers it."),
    ("relationship.contact_frequency",   ONE,      TXT,  MED,  true,  FREE, UNTIL, "How often they are in touch."),

    // -- misc --------------------------------------------------------------
    ("misc.unclassified",                SET,      TXT,  HIGH, false, CUED, UNTIL, "Unclassified user statements. Never supersedes, never seeds inference."),
];

/// Expand one table row into its spec, deriving `domain` from the key.
fn spec(row: &Row) -> PredicateSpec {
    let (
        key,
        cardinality,
        kind,
        sensitivity,
        inference_allowed,
        mention_policy,
        lifetime,
        description,
    ) = *row;
    let parsed = split_predicate(key);
    debug_assert!(
        parsed.is_some(),
        "malformed predicate key in the registry: {key}"
    );
    PredicateSpec {
        key,
        domain: parsed.map_or(Domain::Misc, |(domain, _)| domain),
        cardinality,
        kind,
        sensitivity,
        inference_allowed,
        mention_policy,
        default_lifetime: lifetime,
        enum_domain: enum_domain_for(key),
        description,
    }
}

/// The registry, built from [`ROWS`] on first use.
///
/// Building checks two things the type system cannot: that every row's key is
/// declared in the vocabulary, and that every enum row declares a value domain.
/// Both were silent failures in the TypeScript prototype, so they are loud here
/// — a mismatch panics at startup rather than degrading a validation path at
/// runtime.
pub fn registry() -> &'static [PredicateSpec] {
    static REGISTRY: OnceLock<Vec<PredicateSpec>> = OnceLock::new();
    REGISTRY.get_or_init(|| {
        let built: Vec<PredicateSpec> = ROWS.iter().map(spec).collect();

        let undeclared: Vec<PredicateKey> = built
            .iter()
            .map(|s| s.key)
            .filter(|key| !crate::domain::predicate_keys::is_predicate_key(key))
            .collect();
        assert!(
            undeclared.is_empty(),
            "registry rows are not declared in the vocabulary: {undeclared:?}"
        );

        let missing: Vec<PredicateKey> = crate::domain::predicate_keys::all_predicate_keys()
            .into_iter()
            .filter(|key| !built.iter().any(|s| s.key == *key))
            .collect();
        assert!(
            missing.is_empty(),
            "vocabulary keys have no registry row: {missing:?}"
        );

        for s in &built {
            if s.kind == ValueKind::Enum {
                assert!(
                    s.enum_domain.is_some_and(|values| !values.is_empty()),
                    "enum predicate has no declared value domain: {}",
                    s.key
                );
            }
        }

        built
    })
}

/// Look up one predicate.
pub fn spec_for(key: &str) -> Option<&'static PredicateSpec> {
    registry().iter().find(|spec| spec.key == key)
}

/// Look up one predicate, panicking on an unknown key.
///
/// For call sites that have already validated the key. Unknown keys arriving
/// from stored data or model output must go through [`spec_for`].
pub fn require_spec(key: &str) -> &'static PredicateSpec {
    spec_for(key).unwrap_or_else(|| panic!("unknown predicate: {key}"))
}

/// Whether a model may build an inference whose evidence includes this
/// predicate. Unknown keys default closed.
pub fn inference_allowed_for(key: &str) -> bool {
    spec_for(key).is_some_and(|spec| spec.inference_allowed)
}

/// The mention policy for a predicate. Unknown keys default to the quietest
/// useful mode.
pub fn mention_policy_for(key: &str) -> MentionMode {
    spec_for(key).map_or(MentionMode::BackgroundOnly, |spec| spec.mention_policy)
}

/// Declared keys with no registry row.
pub fn missing_specs() -> Vec<PredicateKey> {
    all_predicate_keys()
        .into_iter()
        .filter(|key| spec_for(key).is_none())
        .collect()
}

/// Registry rows whose key the vocabulary does not declare.
pub fn orphan_specs() -> Vec<PredicateKey> {
    registry()
        .iter()
        .map(|spec| spec.key)
        .filter(|key| !crate::domain::predicate_keys::is_predicate_key(key))
        .collect()
}

/// Which value shapes may legitimately replace which.
///
/// Asymmetric on purpose, and the asymmetry is load-bearing: a `Text` value may
/// never overwrite a structured one. "Next Wednesday, sometime" arriving as
/// prose must not replace a resolved date, because that silently trades a
/// precise fact for a vague one and nothing anywhere reports it.
///
/// Refinement in the other direction is fine — a resolved date replacing an
/// earlier prose description is an improvement.
pub const fn kinds_compatible(incumbent: ValueKind, incoming: ValueKind) -> bool {
    use ValueKind::*;
    match incumbent {
        Text => true,
        Enum => matches!(incoming, Enum),
        Date => matches!(incoming, Date | Duration),
        Duration => matches!(incoming, Duration | Date),
        Number => matches!(incoming, Number),
        EntityRef => matches!(incoming, EntityRef),
    }
}
