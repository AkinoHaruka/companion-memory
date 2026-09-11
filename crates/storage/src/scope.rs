//! Relationship scope as it appears in the database.
//!
//! The kernel's [`RelationshipScope`] is the authority; this module only decides
//! how it becomes a single indexed column.
//!
//! [`RelationshipScope`]: companion_memory_kernel::domain::types::RelationshipScope

use companion_memory_kernel::domain::types::RelationshipScope;

/// The `scope_key` column value for a relationship.
///
/// A newtype rather than a bare `String` so that a function taking a scope key
/// cannot be handed an arbitrary id by mistake. That matters here more than
/// usual: every isolation guarantee is a `WHERE scope_key = ?` clause, and the
/// cheapest way to break one is to pass the wrong string.
#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct ScopeKey(String);

impl ScopeKey {
    /// Derive the key for a relationship.
    pub fn of(scope: &RelationshipScope) -> Self {
        // Reuses the kernel's serialisation so that one definition of "the same
        // relationship" serves both the rules and the storage.
        ScopeKey(scope.key())
    }

    /// Build a key from a value already stored.
    ///
    /// For reading rows back out. Callers must not construct a key this way from
    /// user input; use [`ScopeKey::of`].
    pub fn from_stored(value: String) -> Self {
        ScopeKey(value)
    }

    /// The value to bind into a query.
    pub fn as_str(&self) -> &str {
        &self.0
    }

    /// Consume into the value to bind into a query.
    pub fn into_string(self) -> String {
        self.0
    }
}

impl std::fmt::Display for ScopeKey {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.0)
    }
}
