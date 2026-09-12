//! Schema versioning.
//!
//! The version lives in SQLite's `user_version`, which is a plain integer in the
//! database header and needs no table of its own.
//!
//! Migrations are **append-only**: a released migration is never edited, because
//! an existing database has already run it and would not run the edit. A mistake
//! is corrected by adding the next migration.
//!
//! The design constraint this upholds is that a user's memory is not
//! regenerable. Rebuilding the database from the conversation log would lose
//! every confirmation, correction and suppression the user made, so a schema
//! change must transform existing rows in place rather than start over.

use rusqlite::Connection;

/// The schema a freshly created database gets.
pub const CURRENT_SCHEMA_VERSION: i32 = 3;

/// The version a database reports before any migration has run.
pub const EMPTY_SCHEMA_VERSION: i32 = 0;

/// What a migration pass did.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MigrationState {
    /// Version before the pass.
    pub from: i32,
    /// Version after the pass.
    pub to: i32,
}

impl MigrationState {
    /// Whether the pass changed anything.
    pub fn changed(&self) -> bool {
        self.from != self.to
    }
}

/// One ordered schema change.
struct Migration {
    /// The version this migration produces.
    to: i32,
    /// A short description, for the audit trail and failure messages.
    about: &'static str,
    /// The statements to run.
    sql: &'static str,
}

/// The migration list, in order.
///
/// Every statement uses `IF NOT EXISTS` so that a database which somehow has the
/// objects but not the version still converges instead of failing. That is worth
/// the small redundancy: the alternative is an unrecoverable start-up loop.
static MIGRATIONS: &[Migration] = &[
    Migration {
        to: 1,
        about: "initial companion memory schema",
        sql: include_str!("schema_v1.sql"),
    },
    Migration {
        to: 2,
        about: "source evidence, open threads, and turn telemetry",
        sql: include_str!("schema_v2.sql"),
    },
    Migration {
        to: 3,
        about: "pending extraction review pointers",
        sql: include_str!("schema_v3.sql"),
    },
];

/// Read the schema version of an open database.
pub fn schema_version(connection: &Connection) -> rusqlite::Result<i32> {
    connection.query_row("PRAGMA user_version", [], |row| row.get(0))
}

/// Bring a database up to [`CURRENT_SCHEMA_VERSION`].
///
/// Idempotent: running it on an up-to-date database reports no change and issues
/// no statements. Refuses to continue when the database is *newer* than this
/// build understands, because a downgrade would mean writing rows the older
/// schema cannot represent.
pub fn apply_migrations(connection: &Connection) -> rusqlite::Result<MigrationState> {
    let from = schema_version(connection)?;

    if from > CURRENT_SCHEMA_VERSION {
        return Err(rusqlite::Error::InvalidQuery);
    }

    let mut current = from;
    // Indexed rather than iterated with a filter over `current`: the filter
    // would borrow the variable the loop body assigns to.
    for migration in MIGRATIONS {
        if migration.to <= current {
            continue;
        }
        connection.execute_batch(migration.sql)?;
        // `user_version` does not accept a bound parameter, and the value is a
        // compile-time constant from the table above rather than user input.
        connection.pragma_update(None, "user_version", migration.to)?;
        current = migration.to;
    }

    Ok(MigrationState { from, to: current })
}

/// The migrations this build knows about, as `(version, description)`.
///
/// Exposed so a test can assert the descriptions are distinct and ordered, and
/// so an operator can see what a binary would apply without running it.
pub fn known_migrations() -> Vec<(i32, &'static str)> {
    MIGRATIONS.iter().map(|m| (m.to, m.about)).collect()
}
