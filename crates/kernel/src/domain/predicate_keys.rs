//! Companion memory predicate vocabulary.
//!
//! This module declares *which* predicate keys exist, grouped by domain. The
//! behavioural half of every predicate (cardinality, sensitivity, whether a
//! model may build an inference on it, and how it may be mentioned) lives in
//! [`crate::domain::predicates`].
//!
//! Why the vocabulary is data rather than a plain enum: the registry is
//! verified against it by `tests/agreement.rs`. A key added to one table and
//! forgotten in the other fails the build instead of silently becoming
//! unreachable.
//!
//! Design note (DESIGN.md §3.0): a controlled vocabulary solves the
//! *classification* problem. It does not solve the *record identity* problem —
//! that is what `cardinality` is for.

/// Relationship-native domains. `Misc` is the single global escape hatch.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum Domain {
    /// Who the user is and how they should be addressed.
    Identity,
    /// An instruction the companion must obey.
    Boundary,
    /// A stated preference about how the companion writes or converses.
    Communication,
    /// What kind of presence the user wants when they are struggling.
    Support,
    /// How the user wants recommendations delivered.
    Advice,
    /// A desired outcome or an aspiration.
    Goal,
    /// Something unfinished that may need following up.
    OpenLoop,
    /// A recurring activity, habit or routine the user described.
    Ritual,
    /// A person in the user's life.
    Person,
    /// A dyad: how the user relates to a person.
    Relationship,
    /// The single escape hatch for statements the vocabulary cannot classify.
    Misc,
}

impl Domain {
    /// Every domain, in declaration order.
    pub const ALL: &'static [Domain] = &[
        Domain::Identity,
        Domain::Boundary,
        Domain::Communication,
        Domain::Support,
        Domain::Advice,
        Domain::Goal,
        Domain::OpenLoop,
        Domain::Ritual,
        Domain::Person,
        Domain::Relationship,
        Domain::Misc,
    ];

    /// The literal prefix used in predicate keys.
    pub const fn as_str(self) -> &'static str {
        match self {
            Domain::Identity => "identity",
            Domain::Boundary => "boundary",
            Domain::Communication => "communication",
            Domain::Support => "support",
            Domain::Advice => "advice",
            Domain::Goal => "goal",
            Domain::OpenLoop => "open_loop",
            Domain::Ritual => "ritual",
            Domain::Person => "person",
            Domain::Relationship => "relationship",
            Domain::Misc => "misc",
        }
    }

    /// Parse a domain prefix.
    pub fn parse(value: &str) -> Option<Domain> {
        match value {
            "identity" => Some(Domain::Identity),
            "boundary" => Some(Domain::Boundary),
            "communication" => Some(Domain::Communication),
            "support" => Some(Domain::Support),
            "advice" => Some(Domain::Advice),
            "goal" => Some(Domain::Goal),
            "open_loop" => Some(Domain::OpenLoop),
            "ritual" => Some(Domain::Ritual),
            "person" => Some(Domain::Person),
            "relationship" => Some(Domain::Relationship),
            "misc" => Some(Domain::Misc),
            _ => None,
        }
    }
}

/// The one global escape hatch.
///
/// Every domain's unclassifiable cases collapse here instead of growing a
/// per-domain `other` subject. A per-domain `other` would silently rebuild the
/// free-text fragmentation this design exists to remove; one shared `misc`
/// makes the failure rate measurable (a `misc` ratio above 15% is a hard signal
/// that the vocabulary is mismatched), and records filed under it never
/// supersede anything (invariant I2), so a misclassification degrades to "one
/// more misc row" rather than "a destroyed fact".
pub const MISC_PREDICATE: &str = "misc.unclassified";

/// A predicate key.
///
/// Kept as a string rather than a large enum so that stored records survive a
/// vocabulary change without a migration, and so an unknown key can be
/// *reported* rather than failing to parse.
pub type PredicateKey = &'static str;

/// Every predicate key in the vocabulary.
///
/// Grouped by domain so a reviewer can see the vocabulary's balance at a
/// glance, and so a test can assert per-domain counts.
pub const PREDICATE_KEYS: &[&[PredicateKey]] = &[
    // identity
    &[
        "identity.name",
        "identity.pronouns",
        "identity.timezone",
        "identity.locale",
        "identity.location",
        "identity.occupation",
        "identity.role",
        "identity.language",
        "identity.age",
    ],
    // boundary
    &[
        "boundary.prohibition",
        "boundary.safety_limit",
        "boundary.privacy_rule",
        "boundary.refusal",
        "boundary.topic_avoid",
        "boundary.soft_preference",
    ],
    // communication
    &[
        "communication.language",
        "communication.format",
        "communication.verbosity",
        "communication.tone",
        "communication.interaction_style",
    ],
    // support
    &[
        "support.presence_style",
        "support.when_distressed",
        "support.advice_permission",
        "support.physical_context",
    ],
    // advice
    &[
        "advice.directness",
        "advice.reasoning_depth",
        "advice.when_to_offer_steps",
    ],
    // goal
    &[
        "goal.long_term_objective",
        "goal.current_focus",
        "goal.aspiration",
        "goal.constraint",
    ],
    // open_loop
    &[
        "open_loop.pending_action",
        "open_loop.waiting_on",
        "open_loop.promised_followup",
        "open_loop.deadline",
    ],
    // ritual
    &[
        "ritual.recurring_activity",
        "ritual.frequency",
        "ritual.trigger",
    ],
    // person
    &[
        "person.name",
        "person.relation_label",
        "person.occupation",
        "person.age",
    ],
    // relationship
    &[
        "relationship.type",
        "relationship.closeness",
        "relationship.contact_frequency",
    ],
    // misc
    &[MISC_PREDICATE],
];

/// Flat view of every declared key.
///
/// Returning a `Vec` rather than a slice keeps the grouping above as the single
/// source of truth; this is called at test and startup time, not per turn.
pub fn all_predicate_keys() -> Vec<PredicateKey> {
    PREDICATE_KEYS.iter().flat_map(|group| group.iter().copied()).collect()
}

/// Whether a key is declared in the vocabulary.
pub fn is_predicate_key(value: &str) -> bool {
    PREDICATE_KEYS
        .iter()
        .any(|group| group.contains(&value))
}

/// Split a predicate key into its domain and subject.
///
/// Returns `None` for a malformed key rather than panicking: callers at a trust
/// boundary (extractor output, migration input) need to *report* a bad key, not
/// crash on it.
///
/// Only the first separator counts, so a subject may itself contain a dot.
pub fn split_predicate(key: &str) -> Option<(Domain, &str)> {
    let (domain_part, subject) = key.split_once('.')?;
    if domain_part.is_empty() || subject.is_empty() {
        return None;
    }
    let domain = Domain::parse(domain_part)?;
    Some((domain, subject))
}

/// Whether `key` is `{domain}.{subject}` with a known domain and a non-empty
/// subject.
pub fn is_valid_predicate_shape(key: &str) -> bool {
    split_predicate(key).is_some()
}
