//! SQLite persistence for companion memory.
//!
//! This crate is the only place in the project that touches a database. The
//! kernel decides *what* may be written, surfaced or believed; this crate
//! records those decisions and reads them back.
//!
//! Two properties are load-bearing:
//!
//! - **Scope isolation.** Every read is filtered by the relationship scope. A
//!   query that forgets the filter would leak one person's memories into
//!   another's conversation, so the filter is part of the query builder rather
//!   than something a caller remembers to add.
//! - **Idempotent migrations.** The schema version lives in SQLite's own
//!   `user_version`, and applying migrations twice is a no-op. A profile is
//!   opened on every start, so a migration that is not idempotent corrupts data
//!   the second time the process runs.

#![forbid(unsafe_code)]
#![warn(missing_docs)]

pub mod migrations;
pub mod scope;
pub mod store;

pub use migrations::{apply_migrations, MigrationState, CURRENT_SCHEMA_VERSION};
pub use scope::ScopeKey;
pub use store::{OpenOptions, OpenThread, SourceMessage, SourceSpan, Store, WarmSnapshot};
