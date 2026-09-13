//! The database handle and its scope-isolated queries.
//!
//! Every read method takes a [`ScopeKey`] and binds it. There is deliberately no
//! unscoped accessor: a query that forgets the filter leaks one person's
//! memories into another's conversation, and the way to prevent that is to make
//! the filter impossible to omit rather than to remember to add it.
//!
//! Row readers take the scope as an argument instead of reading a `scope_key`
//! column back out. The column is selected only to compare, never to trust: a
//! corrupted or hand-edited value would otherwise silently re-scope a record
//! into someone else's memory.

use std::collections::HashMap;

use companion_memory_kernel::domain::predicates::spec_for;
use companion_memory_kernel::domain::predicates::MentionMode;
use companion_memory_kernel::domain::types::{
    Claim, ClaimStatus, Episode, Inference, RelationshipScope, RuntimeState, Salience,
};
use companion_memory_kernel::domain::types::{EpisodeStatus, InferenceAxis, InferenceState};
use companion_memory_kernel::rules::forgetting::SuppressionSet;
use companion_memory_kernel::rules::record_identity::{canonical_key_parts, SlotKey};
use rusqlite::TransactionBehavior;
use rusqlite::{Connection, OptionalExtension, Transaction};

use crate::migrations::{apply_migrations, MigrationState};
use crate::scope::ScopeKey;

/// How to open a database.
#[derive(Debug, Clone)]
pub struct OpenOptions {
    /// File path, or `None` for an in-memory database.
    pub path: Option<String>,
    /// Whether to bring the schema up to date on open.
    pub migrate: bool,
}

impl Default for OpenOptions {
    fn default() -> Self {
        Self {
            path: None,
            migrate: true,
        }
    }
}

impl OpenOptions {
    /// An in-memory database, for tests and ephemeral use.
    pub fn in_memory() -> Self {
        Self {
            path: None,
            migrate: true,
        }
    }

    /// A database at `path`.
    pub fn at(path: impl Into<String>) -> Self {
        Self {
            path: Some(path.into()),
            migrate: true,
        }
    }

    /// Open without applying migrations.
    ///
    /// For a migration test that needs to observe the pre-migration state.
    pub fn unmigrated(mut self) -> Self {
        self.migrate = false;
        self
    }
}

/// An open companion memory database.
pub struct Store {
    connection: Connection,
    opened_with: MigrationState,
}

/// One accepted user message retained for record provenance.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SourceMessage {
    /// Stable DSH user-message identifier.
    pub id: String,
    /// Session that durably owns the user message.
    pub session_id: String,
    /// Full direct-user text, retained only after admission succeeds.
    pub text: String,
    /// ISO 8601 admission instant.
    pub created_at: String,
}

/// The exact portion of a retained message that supports one record.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SourceSpan {
    /// Claim or episode identifier supported by this span.
    pub record_id: String,
    /// The retained message containing the span.
    pub message_id: String,
    /// Inclusive UTF-8 byte offset in the message.
    pub start_offset: i64,
    /// Exclusive UTF-8 byte offset in the message.
    pub end_offset: i64,
    /// Exact text at the stored range.
    pub quote: String,
}

/// A user event that can receive one low-pressure continuity follow-up.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OpenThread {
    /// Stable thread identifier supplied by the extractor.
    pub id: String,
    /// Durable record that opened the thread.
    pub record_id: String,
    /// Referenced person, project, or other entity when known.
    pub entity_ref: Option<String>,
    /// Safe natural-language follow-up topic.
    pub summary: String,
    /// Registry-derived sensitivity at opening time.
    pub sensitivity: String,
    /// Registry-derived mention policy at opening time.
    pub mention_mode: String,
    /// Lifecycle state: open, closed, or expired.
    pub status: String,
    /// ISO 8601 creation instant.
    pub opened_at: String,
    /// Optional ISO 8601 expiry instant.
    pub expires_at: Option<String>,
    /// Session that has already received its one allowed follow-up.
    pub followup_session_id: Option<String>,
    /// ISO 8601 of the last lifecycle change.
    pub updated_at: String,
}

/// A consistent read view used to build one model-facing warm plan.
///
/// Claims, episodes, suppression and the revision are read from one SQLite
/// snapshot so a concurrent forget or replacement cannot produce a plan whose
/// rows disagree with its invalidation watermark.
#[derive(Debug, Clone)]
pub struct WarmSnapshot {
    /// Active, unsuppressed claims at the snapshot instant.
    pub claims: Vec<Claim>,
    /// Active, unsuppressed episodes at the snapshot instant.
    pub episodes: Vec<Episode>,
    /// Open continuity threads at the snapshot instant.
    pub open_threads: Vec<OpenThread>,
    /// Scope revision corresponding to the two row sets above.
    pub revision: i64,
}

impl Store {
    /// Open a database according to `options`.
    pub fn open(options: &OpenOptions) -> rusqlite::Result<Self> {
        let mut connection = match &options.path {
            Some(path) => Connection::open(path)?,
            None => Connection::open_in_memory()?,
        };

        // WAL keeps a read from blocking the writer, which matters because the
        // host reads on every turn while consolidation writes in the background.
        // Foreign keys are enabled for the same reason they always are: off by
        // default, and silently useless once off.
        connection.pragma_update(None, "journal_mode", "WAL")?;
        connection.pragma_update(None, "foreign_keys", "ON")?;
        connection.pragma_update(None, "busy_timeout", 5_000)?;
        // Every explicit transaction takes the SQLite RESERVED lock before it
        // reads.  This serializes writers across worker processes and prevents
        // a deferred read/then-write transaction from being upgraded after a
        // competing writer has already changed the same scope.
        connection.set_transaction_behavior(TransactionBehavior::Immediate);

        let opened_with = if options.migrate {
            apply_migrations(&connection)?
        } else {
            MigrationState { from: 0, to: 0 }
        };

        Ok(Self {
            connection,
            opened_with,
        })
    }

    /// What opening this database did to the schema.
    pub fn opened_with(&self) -> MigrationState {
        self.opened_with
    }

    /// The underlying connection, for tests and migrations.
    pub fn connection(&self) -> &Connection {
        &self.connection
    }

    /// Return the durable memory revision for one relationship scope.
    ///
    /// Revisions are monotonic even when a row is replaced in-place, so a
    /// renderer can tell that an older snapshot is stale without comparing the
    /// number of active rows.
    pub fn memory_revision(&self, scope: &RelationshipScope) -> rusqlite::Result<i64> {
        let key = ScopeKey::of(scope);
        self.connection
            .query_row(
                "SELECT revision FROM memory_revisions WHERE scope_key = ?1",
                [key.as_str()],
                |row| row.get(0),
            )
            .optional()
            .map(|revision| revision.unwrap_or(0))
    }

    // -----------------------------------------------------------------------
    // Claims
    // -----------------------------------------------------------------------

    /// Insert or replace a claim.
    pub fn put_claim(&self, claim: &Claim) -> rusqlite::Result<()> {
        let scope = ScopeKey::of(&claim.scope);
        let transaction = self.connection.unchecked_transaction()?;
        ensure_id_scope_tx(&transaction, "claims", &claim.id, scope.as_str())?;
        transaction.execute(
            "INSERT OR REPLACE INTO claims (
                id, scope_key, predicate, entity_ref, qualifiers_json, value_json, raw_value,
                valid_from, valid_until, status, supersedes_id, source_refs_json,
                provenance_json, importance, recall_count, last_recalled_at, do_not_surface,
                created_at, updated_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15,
                       ?16, ?17, ?18, ?19)",
            rusqlite::params![
                claim.id,
                scope.as_str(),
                claim.predicate,
                claim.entity_ref,
                json_opt(&claim.qualifiers)?,
                value_json(&claim.value),
                claim.raw_value,
                claim.valid_from,
                claim.valid_until,
                claim_status(claim.status),
                claim.supersedes_id,
                refs_json(&claim.source_refs),
                provenance_json(&claim.provenance),
                claim.salience.importance,
                claim.salience.recall_count,
                claim.salience.last_recalled_at,
                claim.salience.do_not_surface.map(i64::from),
                claim.created_at,
                claim.updated_at,
            ],
        )?;
        bump_revision_tx(&transaction, scope.as_str())?;
        transaction.commit()
    }

    /// Commit one worker admission as an all-or-nothing durable transition.
    ///
    /// A successful admission may replace an older claim, add the new claim's
    /// L0 evidence pointer, open one allowed continuity thread, and write its
    /// audit row. Splitting those writes would let a disk error produce a
    /// claim that looks accepted but cannot later be explained or forgotten.
    pub fn admit_claim_with_evidence(
        &self,
        claim: &Claim,
        source: &SourceMessage,
        span: &SourceSpan,
        superseded_id: Option<&str>,
        open_thread: Option<&OpenThread>,
        now: &str,
    ) -> rusqlite::Result<()> {
        let scope = ScopeKey::of(&claim.scope);
        ensure_id_scope(&self.connection, "claims", &claim.id, scope.as_str())?;
        let transaction = self.connection.unchecked_transaction()?;
        ensure_id_scope_tx(&transaction, "claims", &claim.id, scope.as_str())?;

        // The worker normally decides supersession before calling this method,
        // but another worker process may have committed the same slot in the
        // meantime. Re-check under the IMMEDIATE transaction so a stale
        // decision cannot leave two active values in a single-cardinality slot.
        if spec_for(&claim.predicate).is_some_and(|spec| spec.cardinality.supersedes()) {
            let active = active_claims_in_slot_tx(
                &transaction,
                &claim.scope,
                &claim.predicate,
                claim.entity_ref.as_deref(),
                claim.qualifiers.as_ref(),
            )?;
            let previous_is_active =
                superseded_id.is_some_and(|id| active.iter().any(|existing| existing.id == id));
            let other_active = active.iter().any(|existing| {
                existing.id != claim.id && Some(existing.id.as_str()) != superseded_id
            });
            if (superseded_id.is_some() && !previous_is_active) || other_active {
                return Err(rusqlite::Error::InvalidParameterName(
                    "claim slot changed during admission".into(),
                ));
            }
        }

        if let Some(previous) = superseded_id {
            transaction.execute(
                "UPDATE claims SET status = ?1, updated_at = ?2
                 WHERE scope_key = ?3 AND id = ?4",
                rusqlite::params![
                    claim_status(ClaimStatus::Superseded),
                    now,
                    scope.as_str(),
                    previous
                ],
            )?;
            transaction.execute(
                "UPDATE open_threads SET status = 'closed', updated_at = ?3
                 WHERE scope_key = ?1 AND record_id = ?2 AND status = 'open'",
                rusqlite::params![scope.as_str(), previous, now],
            )?;
        }

        transaction.execute(
            "INSERT OR REPLACE INTO claims (
                id, scope_key, predicate, entity_ref, qualifiers_json, value_json, raw_value,
                valid_from, valid_until, status, supersedes_id, source_refs_json,
                provenance_json, importance, recall_count, last_recalled_at, do_not_surface,
                created_at, updated_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15,
                       ?16, ?17, ?18, ?19)",
            rusqlite::params![
                claim.id,
                scope.as_str(),
                claim.predicate,
                claim.entity_ref,
                json_opt(&claim.qualifiers)?,
                value_json(&claim.value),
                claim.raw_value,
                claim.valid_from,
                claim.valid_until,
                claim_status(claim.status),
                claim.supersedes_id,
                refs_json(&claim.source_refs),
                provenance_json(&claim.provenance),
                claim.salience.importance,
                claim.salience.recall_count,
                claim.salience.last_recalled_at,
                claim.salience.do_not_surface.map(i64::from),
                claim.created_at,
                claim.updated_at,
            ],
        )?;
        ensure_source_message(&transaction, scope.as_str(), source)?;
        ensure_source_span(&transaction, scope.as_str(), span)?;
        if let Some(thread) = open_thread {
            transaction.execute(
                "INSERT OR REPLACE INTO open_threads (
                    id, scope_key, record_id, entity_ref, summary, sensitivity, mention_mode,
                    status, opened_at, expires_at, followup_session_id, updated_at
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
                rusqlite::params![
                    thread.id,
                    scope.as_str(),
                    thread.record_id,
                    thread.entity_ref,
                    thread.summary,
                    thread.sensitivity,
                    thread.mention_mode,
                    thread.status,
                    thread.opened_at,
                    thread.expires_at,
                    thread.followup_session_id,
                    thread.updated_at,
                ],
            )?;
        }
        let audit_id = format!("audit-{now}-admission_accepted-{}", claim.id);
        transaction.execute(
            "INSERT OR REPLACE INTO audit_events (id, scope_key, action, record_id, detail, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            rusqlite::params![audit_id, scope.as_str(), "admission_accepted", claim.id, Option::<&str>::None, now],
        )?;
        bump_revision_tx(&transaction, scope.as_str())?;
        transaction.commit()
    }

    /// Commit a user-described episode with its L0 pointer and audit row.
    /// Episodes are durable experience records, unlike inferred patterns; their
    /// admission is still transactional so a partial write cannot surface.
    pub fn admit_episode_with_evidence(
        &self,
        episode: &Episode,
        source: &SourceMessage,
        span: &SourceSpan,
        now: &str,
    ) -> rusqlite::Result<()> {
        let scope = ScopeKey::of(&episode.scope);
        ensure_id_scope(&self.connection, "episodes", &episode.id, scope.as_str())?;
        let transaction = self.connection.unchecked_transaction()?;
        ensure_id_scope_tx(&transaction, "episodes", &episode.id, scope.as_str())?;
        transaction.execute(
            "INSERT OR REPLACE INTO episodes (
                id, scope_key, occurred_from, occurred_to, narrative, participants_json,
                emotional_arc_json, user_reaction, response_ref, source_refs_json, status,
                importance, recall_count, last_recalled_at, do_not_surface, created_at, updated_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)",
            rusqlite::params![
                episode.id,
                scope.as_str(),
                episode.occurred_from,
                episode.occurred_to,
                episode.narrative,
                serde_json::to_string(&episode.participants).unwrap_or_else(|_| "[]".into()),
                json_opt(&episode.emotional_arc)?,
                episode.user_reaction,
                episode.response_ref,
                refs_json(&episode.source_refs),
                episode_status(episode.status),
                episode.salience.importance,
                episode.salience.recall_count,
                episode.salience.last_recalled_at,
                episode.salience.do_not_surface.map(i64::from),
                episode.created_at,
                episode.updated_at,
            ],
        )?;
        ensure_source_message(&transaction, scope.as_str(), source)?;
        ensure_source_span(&transaction, scope.as_str(), span)?;
        let audit_id = format!("audit-{now}-episode_accepted-{}", episode.id);
        transaction.execute(
            "INSERT OR REPLACE INTO audit_events (id, scope_key, action, record_id, detail, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            rusqlite::params![audit_id, scope.as_str(), "episode_accepted", episode.id, Option::<&str>::None, now],
        )?;
        bump_revision_tx(&transaction, scope.as_str())?;
        transaction.commit()
    }

    /// One claim by id, scoped.
    pub fn get_claim(
        &self,
        scope: &RelationshipScope,
        id: &str,
    ) -> rusqlite::Result<Option<Claim>> {
        let key = ScopeKey::of(scope);
        self.connection
            .query_row(
                &format!("SELECT {CLAIM_COLUMNS} FROM claims WHERE scope_key = ?1 AND id = ?2"),
                rusqlite::params![key.as_str(), id],
                |row| read_claim(row, scope),
            )
            .optional()
    }

    /// Active, unsuppressed claims in a scope, most recently updated first.
    ///
    /// Suppression is applied here, at the storage read boundary, so every
    /// injection consumer gets a fail-closed view instead of having to remember
    /// a separate filter.
    pub fn active_claims(&self, scope: &RelationshipScope) -> rusqlite::Result<Vec<Claim>> {
        let key = ScopeKey::of(scope);
        let mut statement = self.connection.prepare(&format!(
            "SELECT {CLAIM_COLUMNS} FROM claims WHERE scope_key = ?1 AND status = 'active'
             ORDER BY updated_at DESC, id ASC"
        ))?;
        let rows = statement.query_map([key.as_str()], |row| read_claim(row, scope))?;
        let claims: Vec<Claim> = rows.collect::<rusqlite::Result<_>>()?;
        let suppression = self.load_suppression_set(scope)?;
        Ok(claims
            .into_iter()
            .filter(|claim| !suppression.suppresses_claim(claim))
            .collect())
    }

    /// Read the memory rows and revision from one deferred read transaction.
    ///
    /// The transaction takes a stable SQLite snapshot without contending with
    /// writers. Suppression is reconstructed against the same transaction,
    /// rather than being loaded afterwards from a potentially newer state.
    pub fn warm_snapshot(
        &self,
        scope: &RelationshipScope,
        now: &str,
    ) -> rusqlite::Result<WarmSnapshot> {
        let key = ScopeKey::of(scope);
        let transaction =
            Transaction::new_unchecked(&self.connection, TransactionBehavior::Deferred)?;
        let claims = active_claims_tx(&transaction, scope, key.as_str())?;
        let episodes = active_episodes_tx(&transaction, scope, key.as_str())?;
        let suppression = load_suppression_set_tx(&transaction, key.as_str())?;
        let claims = claims
            .into_iter()
            .filter(|claim| !suppression.suppresses_claim(claim))
            .collect();
        let episodes = episodes
            .into_iter()
            .filter(|episode| !suppression.suppresses_episode(episode))
            .collect();
        let open_threads = active_open_threads_tx(&transaction, key.as_str(), now)?;
        let revision = transaction
            .query_row(
                "SELECT revision FROM memory_revisions WHERE scope_key = ?1",
                [key.as_str()],
                |row| row.get(0),
            )
            .optional()?
            .unwrap_or(0);
        transaction.commit()?;
        Ok(WarmSnapshot {
            claims,
            episodes,
            open_threads,
            revision,
        })
    }

    /// Active claims occupying one slot.
    ///
    /// This is what `record_identity::decide_supersede` expects: only active
    /// records, only the same scope, predicate, entity, and canonical
    /// qualifiers. Qualifier identity is compared through the same canonical
    /// representation as the kernel, so callers cannot accidentally make two
    /// concurrent contexts compete for one slot.
    pub fn active_claims_in_slot(
        &self,
        scope: &RelationshipScope,
        predicate: &str,
        entity_ref: Option<&str>,
        qualifiers: Option<&serde_json::Value>,
    ) -> rusqlite::Result<Vec<Claim>> {
        let desired = canonical_key_parts(&SlotKey {
            predicate,
            entity_ref,
            qualifiers,
        });
        Ok(self
            .active_claims(scope)?
            .into_iter()
            .filter(|claim| {
                canonical_key_parts(&SlotKey {
                    predicate: &claim.predicate,
                    entity_ref: claim.entity_ref.as_deref(),
                    qualifiers: claim.qualifiers.as_ref(),
                }) == desired
            })
            .collect())
    }

    /// Mark a claim's status without rewriting the record.
    pub fn set_claim_status(
        &self,
        scope: &RelationshipScope,
        id: &str,
        status: ClaimStatus,
        now: &str,
    ) -> rusqlite::Result<usize> {
        let key = ScopeKey::of(scope);
        let transaction = self.connection.unchecked_transaction()?;
        let changed = transaction.execute(
            "UPDATE claims SET status = ?1, updated_at = ?2 WHERE scope_key = ?3 AND id = ?4",
            rusqlite::params![claim_status(status), now, key.as_str(), id],
        )?;
        if changed > 0 {
            bump_revision_tx(&transaction, key.as_str())?;
        }
        transaction.commit()?;
        Ok(changed)
    }

    // -----------------------------------------------------------------------
    // Episodes
    // -----------------------------------------------------------------------

    /// Insert or replace an episode.
    pub fn put_episode(&self, episode: &Episode) -> rusqlite::Result<()> {
        let scope = ScopeKey::of(&episode.scope);
        let transaction = self.connection.unchecked_transaction()?;
        ensure_id_scope_tx(&transaction, "episodes", &episode.id, scope.as_str())?;
        transaction.execute(
            "INSERT OR REPLACE INTO episodes (
                id, scope_key, occurred_from, occurred_to, narrative, participants_json,
                emotional_arc_json, user_reaction, response_ref, source_refs_json, status,
                importance, recall_count, last_recalled_at, do_not_surface, created_at, updated_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)",
            rusqlite::params![
                episode.id,
                scope.as_str(),
                episode.occurred_from,
                episode.occurred_to,
                episode.narrative,
                serde_json::to_string(&episode.participants).unwrap_or_else(|_| "[]".into()),
                json_opt(&episode.emotional_arc)?,
                episode.user_reaction,
                episode.response_ref,
                refs_json(&episode.source_refs),
                episode_status(episode.status),
                episode.salience.importance,
                episode.salience.recall_count,
                episode.salience.last_recalled_at,
                episode.salience.do_not_surface.map(i64::from),
                episode.created_at,
                episode.updated_at,
            ],
        )?;
        bump_revision_tx(&transaction, scope.as_str())?;
        transaction.commit()
    }

    /// One episode by id, scoped.
    pub fn get_episode(
        &self,
        scope: &RelationshipScope,
        id: &str,
    ) -> rusqlite::Result<Option<Episode>> {
        let key = ScopeKey::of(scope);
        self.connection
            .query_row(
                &format!("SELECT {EPISODE_COLUMNS} FROM episodes WHERE scope_key = ?1 AND id = ?2"),
                rusqlite::params![key.as_str(), id],
                |row| read_episode(row, scope),
            )
            .optional()
    }

    /// Active episodes in a scope, most recent first.
    pub fn active_episodes(&self, scope: &RelationshipScope) -> rusqlite::Result<Vec<Episode>> {
        let key = ScopeKey::of(scope);
        let mut statement = self.connection.prepare(&format!(
            "SELECT {EPISODE_COLUMNS} FROM episodes WHERE scope_key = ?1 AND status = 'active'
             ORDER BY occurred_from DESC, id ASC"
        ))?;
        let rows = statement.query_map([key.as_str()], |row| read_episode(row, scope))?;
        let episodes: Vec<Episode> = rows.collect::<rusqlite::Result<_>>()?;
        let suppression = self.load_suppression_set(scope)?;
        Ok(episodes
            .into_iter()
            .filter(|episode| !suppression.suppresses_episode(episode))
            .collect())
    }

    // -----------------------------------------------------------------------
    // Inferences
    // -----------------------------------------------------------------------

    /// Insert or replace an inference.
    pub fn put_inference(&self, inference: &Inference) -> rusqlite::Result<()> {
        let scope = ScopeKey::of(&inference.scope);
        ensure_id_scope(
            &self.connection,
            "inferences",
            &inference.id,
            scope.as_str(),
        )?;
        self.connection.execute(
            "INSERT OR REPLACE INTO inferences (
                id, scope_key, axis, predicate, value, state, confidence,
                support_evidence_json, counter_evidence_json, promotion_audit_json,
                user_acknowledged_at, use_mode, expires_at, importance, recall_count,
                last_recalled_at, do_not_surface, created_at, updated_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15,
                       ?16, ?17, ?18, ?19)",
            rusqlite::params![
                inference.id,
                scope.as_str(),
                inference_axis(inference.axis),
                inference.predicate,
                inference.value,
                inference_state(inference.state),
                inference.confidence,
                refs_json(&inference.support_evidence),
                refs_json(&inference.counter_evidence),
                json_opt(&inference.promotion_audit)?,
                inference.user_acknowledged_at,
                mention_mode(inference.use_mode),
                inference.expires_at,
                inference.salience.importance,
                inference.salience.recall_count,
                inference.salience.last_recalled_at,
                inference.salience.do_not_surface.map(i64::from),
                inference.created_at,
                inference.updated_at,
            ],
        )?;
        Ok(())
    }

    /// One inference by id, scoped.
    pub fn get_inference(
        &self,
        scope: &RelationshipScope,
        id: &str,
    ) -> rusqlite::Result<Option<Inference>> {
        let key = ScopeKey::of(scope);
        self.connection
            .query_row(
                &format!(
                    "SELECT {INFERENCE_COLUMNS} FROM inferences WHERE scope_key = ?1 AND id = ?2"
                ),
                rusqlite::params![key.as_str(), id],
                |row| read_inference(row, scope),
            )
            .optional()
    }

    /// Inferences in a scope, most recently updated first.
    pub fn inferences(&self, scope: &RelationshipScope) -> rusqlite::Result<Vec<Inference>> {
        let key = ScopeKey::of(scope);
        let mut statement = self.connection.prepare(&format!(
            "SELECT {INFERENCE_COLUMNS} FROM inferences WHERE scope_key = ?1
             ORDER BY updated_at DESC, id ASC"
        ))?;
        let rows = statement.query_map([key.as_str()], |row| read_inference(row, scope))?;
        rows.collect()
    }

    // -----------------------------------------------------------------------
    // Suppression and audit
    // -----------------------------------------------------------------------

    /// Record that the user asked for something to be forgotten.
    ///
    /// The fingerprint is what closes the re-extraction hole: a later extraction
    /// proposing the same value is refused by
    /// `forgetting::would_resurrect`, which needs this row to exist.
    pub fn suppress(
        &self,
        scope: &RelationshipScope,
        kind: &str,
        target: &str,
        fingerprint: Option<&str>,
        label: Option<&str>,
        now: &str,
    ) -> rusqlite::Result<()> {
        let key = ScopeKey::of(scope);
        let transaction = self.connection.unchecked_transaction()?;
        // Remove the pre-v2 unscoped-id form for this scope when opening an
        // upgraded database. A different scope's legacy row is left intact.
        transaction.execute(
            "DELETE FROM suppression WHERE id = ?1 AND scope_key = ?2",
            rusqlite::params![format!("sup-{kind}-{target}"), key.as_str()],
        )?;
        let id = format!("sup-{}-{kind}-{target}", key.as_str());
        transaction.execute(
            "INSERT OR REPLACE INTO suppression (id, scope_key, kind, target, fingerprint, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            rusqlite::params![id, key.as_str(), kind, target, fingerprint, now],
        )?;
        if let Some(fingerprint) = fingerprint {
            transaction.execute(
                "INSERT OR REPLACE INTO suppressed_fingerprints
                    (scope_key, fingerprint, label, created_at)
                 VALUES (?1, ?2, ?3, ?4)",
                rusqlite::params![key.as_str(), fingerprint, label.unwrap_or(target), now],
            )?;
        }
        bump_revision_tx(&transaction, key.as_str())?;
        transaction.commit()
    }

    /// The suppression entries for a scope, as `(kind, target)`.
    pub fn suppression_entries(
        &self,
        scope: &RelationshipScope,
    ) -> rusqlite::Result<Vec<(String, String)>> {
        let key = ScopeKey::of(scope);
        let mut statement = self
            .connection
            .prepare("SELECT kind, target FROM suppression WHERE scope_key = ?1 ORDER BY id")?;
        let rows = statement.query_map([key.as_str()], |row| Ok((row.get(0)?, row.get(1)?)))?;
        rows.collect()
    }

    /// The `(fingerprint, label)` pairs forgotten in a scope.
    pub fn suppressed_fingerprints(
        &self,
        scope: &RelationshipScope,
    ) -> rusqlite::Result<Vec<(String, String)>> {
        let key = ScopeKey::of(scope);
        let mut statement = self.connection.prepare(
            "SELECT fingerprint, label FROM suppressed_fingerprints WHERE scope_key = ?1",
        )?;
        let rows = statement.query_map([key.as_str()], |row| Ok((row.get(0)?, row.get(1)?)))?;
        rows.collect()
    }

    /// Record a governance action for the audit trail.
    ///
    /// The id is derived from the action and the timestamp rather than randomly
    /// generated, so re-running the same operation at the same instant does not
    /// duplicate the entry. That keeps the kernel's determinism property
    /// (invariant I9) intact through the storage layer.
    pub fn audit(
        &self,
        scope: &RelationshipScope,
        action: &str,
        record_id: Option<&str>,
        detail: Option<&str>,
        now: &str,
    ) -> rusqlite::Result<()> {
        let key = ScopeKey::of(scope);
        let id = format!(
            "audit-{}-{now}-{action}-{}",
            key.as_str(),
            record_id.unwrap_or("")
        );
        self.connection.execute(
            "INSERT OR REPLACE INTO audit_events (id, scope_key, action, record_id, detail, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            rusqlite::params![id, key.as_str(), action, record_id, detail, now],
        )?;
        Ok(())
    }

    /// How many audit entries a scope has.
    pub fn audit_count(&self, scope: &RelationshipScope) -> rusqlite::Result<i64> {
        let key = ScopeKey::of(scope);
        self.connection.query_row(
            "SELECT COUNT(*) FROM audit_events WHERE scope_key = ?1",
            [key.as_str()],
            |row| row.get(0),
        )
    }

    /// How many rows of a table a scope holds, for tests.
    ///
    /// `table` is validated against a fixed list rather than interpolated from
    /// arbitrary input, because it reaches a query string.
    pub fn count_in_scope(&self, scope: &RelationshipScope, table: &str) -> rusqlite::Result<i64> {
        let table = match table {
            "claims" | "episodes" | "inferences" | "suppression" | "audit_events"
            | "runtime_state" | "source_messages" | "source_spans" | "open_threads"
            | "turn_telemetry" | "pending_candidates" | "memory_revisions" => table,
            other => {
                return Err(rusqlite::Error::InvalidParameterName(other.to_string()));
            }
        };
        let key = ScopeKey::of(scope);
        self.connection.query_row(
            &format!("SELECT COUNT(*) FROM {table} WHERE scope_key = ?1"),
            [key.as_str()],
            |row| row.get(0),
        )
    }

    // -----------------------------------------------------------------------
    // Accepted source evidence, continuity, and diagnostics
    // -----------------------------------------------------------------------

    /// Retain a direct user message only after an admission accepted a record.
    pub fn put_source_message(
        &self,
        scope: &RelationshipScope,
        message: &SourceMessage,
    ) -> rusqlite::Result<()> {
        let key = ScopeKey::of(scope);
        let transaction = self.connection.unchecked_transaction()?;
        let existing: Option<String> = transaction
            .query_row(
                "SELECT text FROM source_messages WHERE scope_key = ?1 AND id = ?2",
                rusqlite::params![key.as_str(), message.id],
                |row| row.get(0),
            )
            .optional()?;
        match existing {
            Some(text) if text != message.text => {
                return Err(rusqlite::Error::InvalidParameterName(
                    "source message text conflicts with immutable evidence".into(),
                ));
            }
            Some(_) => {}
            None => {
                transaction.execute(
                    "INSERT INTO source_messages (scope_key, id, session_id, text, created_at)
                     VALUES (?1, ?2, ?3, ?4, ?5)",
                    rusqlite::params![
                        key.as_str(),
                        message.id,
                        message.session_id,
                        message.text,
                        message.created_at
                    ],
                )?;
            }
        }
        transaction.commit()
    }

    /// Store an exact source span for a record whose admission succeeded.
    pub fn put_source_span(
        &self,
        scope: &RelationshipScope,
        span: &SourceSpan,
    ) -> rusqlite::Result<()> {
        let key = ScopeKey::of(scope);
        let transaction = self.connection.unchecked_transaction()?;
        ensure_source_span(&transaction, key.as_str(), span)?;
        transaction.commit()
    }

    /// Insert or update a continuity thread under its relationship scope.
    pub fn put_open_thread(
        &self,
        scope: &RelationshipScope,
        thread: &OpenThread,
    ) -> rusqlite::Result<()> {
        let key = ScopeKey::of(scope);
        let transaction = self.connection.unchecked_transaction()?;
        ensure_id_scope_tx(&transaction, "open_threads", &thread.id, key.as_str())?;
        transaction.execute(
            "INSERT OR REPLACE INTO open_threads (
                id, scope_key, record_id, entity_ref, summary, sensitivity, mention_mode,
                status, opened_at, expires_at, followup_session_id, updated_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
            rusqlite::params![
                thread.id,
                key.as_str(),
                thread.record_id,
                thread.entity_ref,
                thread.summary,
                thread.sensitivity,
                thread.mention_mode,
                thread.status,
                thread.opened_at,
                thread.expires_at,
                thread.followup_session_id,
                thread.updated_at,
            ],
        )?;
        bump_revision_tx(&transaction, key.as_str())?;
        transaction.commit()
    }

    /// Read active continuity threads in a scope, newest first.
    pub fn active_open_threads(
        &self,
        scope: &RelationshipScope,
        now: &str,
    ) -> rusqlite::Result<Vec<OpenThread>> {
        let key = ScopeKey::of(scope);
        let mut statement = self.connection.prepare(
            "SELECT id, record_id, entity_ref, summary, sensitivity, mention_mode, status,
                    opened_at, expires_at, followup_session_id, updated_at
             FROM open_threads
             WHERE scope_key = ?1 AND status = 'open'
               AND (expires_at IS NULL OR expires_at > ?2)
             ORDER BY updated_at DESC, id ASC",
        )?;
        let rows = statement.query_map(rusqlite::params![key.as_str(), now], |row| {
            Ok(OpenThread {
                id: row.get(0)?,
                record_id: row.get(1)?,
                entity_ref: row.get(2)?,
                summary: row.get(3)?,
                sensitivity: row.get(4)?,
                mention_mode: row.get(5)?,
                status: row.get(6)?,
                opened_at: row.get(7)?,
                expires_at: row.get(8)?,
                followup_session_id: row.get(9)?,
                updated_at: row.get(10)?,
            })
        })?;
        rows.collect()
    }

    /// Mark a thread with a lifecycle transition without exposing unscoped SQL.
    pub fn update_open_thread(
        &self,
        scope: &RelationshipScope,
        id: &str,
        status: &str,
        followup_session_id: Option<&str>,
        now: &str,
    ) -> rusqlite::Result<usize> {
        let key = ScopeKey::of(scope);
        let transaction = self.connection.unchecked_transaction()?;
        let changed = transaction.execute(
            "UPDATE open_threads
             SET status = ?1, followup_session_id = ?2, updated_at = ?3
             WHERE scope_key = ?4 AND id = ?5",
            rusqlite::params![status, followup_session_id, now, key.as_str(), id],
        )?;
        if changed > 0 {
            bump_revision_tx(&transaction, key.as_str())?;
        }
        transaction.commit()?;
        Ok(changed)
    }

    /// Close every continuity thread attached to a record that has just been
    /// replaced. An updated user statement must refresh the thread rather than
    /// let an old event be revived in a later session.
    pub fn close_open_threads_for_record(
        &self,
        scope: &RelationshipScope,
        record_id: &str,
        now: &str,
    ) -> rusqlite::Result<usize> {
        let key = ScopeKey::of(scope);
        let transaction = self.connection.unchecked_transaction()?;
        let changed = transaction.execute(
            "UPDATE open_threads SET status = 'closed', updated_at = ?3
             WHERE scope_key = ?1 AND record_id = ?2 AND status = 'open'",
            rusqlite::params![key.as_str(), record_id, now],
        )?;
        if changed > 0 {
            bump_revision_tx(&transaction, key.as_str())?;
        }
        transaction.commit()?;
        Ok(changed)
    }

    /// Expire follow-ups that received no update before their session closed.
    pub fn expire_unanswered_followups(
        &self,
        scope: &RelationshipScope,
        session_id: &str,
        now: &str,
    ) -> rusqlite::Result<usize> {
        let key = ScopeKey::of(scope);
        let transaction = self.connection.unchecked_transaction()?;
        let changed = transaction.execute(
            "UPDATE open_threads SET status = 'expired', updated_at = ?1
             WHERE scope_key = ?2 AND followup_session_id = ?3 AND status = 'open'",
            rusqlite::params![now, key.as_str(), session_id],
        )?;
        if changed > 0 {
            bump_revision_tx(&transaction, key.as_str())?;
        }
        transaction.commit()?;
        Ok(changed)
    }

    /// Persist one diagnostic phase without making model-visible context depend on it.
    pub fn telemetry(
        &self,
        scope: &RelationshipScope,
        id: &str,
        turn_key: &str,
        phase: &str,
        detail_json: &str,
        now: &str,
    ) -> rusqlite::Result<()> {
        let key = ScopeKey::of(scope);
        let storage_id = format!("telemetry-{}-{id}", key.as_str());
        self.connection.execute(
            "INSERT OR REPLACE INTO turn_telemetry
             (id, scope_key, turn_key, phase, detail_json, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            rusqlite::params![storage_id, key.as_str(), turn_key, phase, detail_json, now],
        )?;
        Ok(())
    }

    /// Keep an extraction product out of durable recall until its promotion
    /// policy has earned enough quality evidence. The source message is an L0
    /// pointer, not a copied transcript.
    pub fn put_pending_candidate(
        &self,
        scope: &RelationshipScope,
        id: &str,
        kind: &str,
        source_message_id: &str,
        reason: &str,
        now: &str,
    ) -> rusqlite::Result<()> {
        let key = ScopeKey::of(scope);
        ensure_id_scope(&self.connection, "pending_candidates", id, key.as_str())?;
        self.connection.execute(
            "INSERT OR REPLACE INTO pending_candidates
             (id, scope_key, kind, source_message_id, reason, status, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, 'pending_review', ?6)",
            rusqlite::params![id, key.as_str(), kind, source_message_id, reason, now],
        )?;
        Ok(())
    }

    /// Forget one claim and erase the raw evidence that only supported it.
    pub fn forget_claim(
        &self,
        scope: &RelationshipScope,
        id: &str,
        now: &str,
    ) -> rusqlite::Result<bool> {
        let key = ScopeKey::of(scope);
        let transaction = self.connection.unchecked_transaction()?;
        let Some(claim) = transaction
            .query_row(
                &format!("SELECT {CLAIM_COLUMNS} FROM claims WHERE scope_key = ?1 AND id = ?2"),
                rusqlite::params![key.as_str(), id],
                |row| read_claim(row, scope),
            )
            .optional()?
        else {
            return Ok(false);
        };
        let fingerprint = companion_memory_kernel::rules::forgetting::fingerprint(&claim.value);
        // Suppression, evidence cleanup, record deletion, and audit are one
        // unit. A failed forget must not leave an active record behind a
        // suppression row (or the reverse).
        transaction.execute(
            "DELETE FROM suppression WHERE id = ?1 AND scope_key = ?2",
            rusqlite::params![format!("sup-record-{id}"), key.as_str()],
        )?;
        transaction.execute(
            "INSERT OR REPLACE INTO suppression
             (id, scope_key, kind, target, fingerprint, created_at)
             VALUES (?1, ?2, 'record', ?3, ?4, ?5)",
            rusqlite::params![
                format!("sup-{}-record-{id}", key.as_str()),
                key.as_str(),
                id,
                fingerprint,
                now
            ],
        )?;
        transaction.execute(
            "INSERT OR REPLACE INTO suppressed_fingerprints
             (scope_key, fingerprint, label, created_at)
             VALUES (?1, ?2, ?3, ?4)",
            rusqlite::params![key.as_str(), fingerprint, id, now],
        )?;
        transaction.execute(
            "DELETE FROM evidence_refs WHERE owner_id = ?1 OR source_id = ?1",
            [id],
        )?;
        transaction.execute(
            "DELETE FROM open_threads WHERE scope_key = ?1 AND record_id = ?2",
            rusqlite::params![key.as_str(), id],
        )?;
        transaction.execute(
            "DELETE FROM source_spans WHERE scope_key = ?1 AND record_id = ?2",
            rusqlite::params![key.as_str(), id],
        )?;
        transaction.execute(
            "DELETE FROM source_messages
             WHERE scope_key = ?1
               AND NOT EXISTS (
                 SELECT 1 FROM source_spans
                 WHERE source_spans.scope_key = source_messages.scope_key
                   AND source_spans.message_id = source_messages.id
             )",
            [key.as_str()],
        )?;
        transaction.execute(
            "DELETE FROM claims WHERE scope_key = ?1 AND id = ?2",
            rusqlite::params![key.as_str(), id],
        )?;
        let audit_id = format!("audit-{}-{now}-forgot_claim-{id}", key.as_str());
        transaction.execute(
            "INSERT OR REPLACE INTO audit_events
             (id, scope_key, action, record_id, detail, created_at)
             VALUES (?1, ?2, 'forgot_claim', ?3, NULL, ?4)",
            rusqlite::params![audit_id, key.as_str(), id, now],
        )?;
        bump_revision_tx(&transaction, key.as_str())?;
        transaction.commit()?;
        Ok(true)
    }

    /// Forget an episode and its reversible evidence while retaining only a
    /// one-way fingerprint that prevents it from being re-written verbatim.
    pub fn forget_episode(
        &self,
        scope: &RelationshipScope,
        id: &str,
        now: &str,
    ) -> rusqlite::Result<bool> {
        let key = ScopeKey::of(scope);
        let transaction = self.connection.unchecked_transaction()?;
        let Some(episode) = transaction
            .query_row(
                &format!("SELECT {EPISODE_COLUMNS} FROM episodes WHERE scope_key = ?1 AND id = ?2"),
                rusqlite::params![key.as_str(), id],
                |row| read_episode(row, scope),
            )
            .optional()?
        else {
            return Ok(false);
        };
        let fingerprint =
            companion_memory_kernel::rules::forgetting::fingerprint_text(&episode.narrative);
        transaction.execute(
            "INSERT OR REPLACE INTO suppression (id, scope_key, kind, target, fingerprint, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            rusqlite::params![format!("suppression-{}-{now}-record-{id}", key.as_str()), key.as_str(), "record", id, fingerprint, now],
        )?;
        transaction.execute(
            "INSERT OR REPLACE INTO suppressed_fingerprints (scope_key, fingerprint, label, created_at)
             VALUES (?1, ?2, ?3, ?4)",
            rusqlite::params![key.as_str(), fingerprint, id, now],
        )?;
        transaction.execute(
            "DELETE FROM evidence_refs WHERE owner_id = ?1 OR source_id = ?1",
            [id],
        )?;
        transaction.execute(
            "DELETE FROM source_spans WHERE scope_key = ?1 AND record_id = ?2",
            rusqlite::params![key.as_str(), id],
        )?;
        transaction.execute(
            "DELETE FROM source_messages
             WHERE scope_key = ?1
               AND NOT EXISTS (
                 SELECT 1 FROM source_spans WHERE source_spans.scope_key = source_messages.scope_key
                 AND source_spans.message_id = source_messages.id
               )",
            [key.as_str()],
        )?;
        transaction.execute(
            "DELETE FROM episodes WHERE scope_key = ?1 AND id = ?2",
            rusqlite::params![key.as_str(), id],
        )?;
        bump_revision_tx(&transaction, key.as_str())?;
        transaction.commit()?;
        Ok(true)
    }

    // -----------------------------------------------------------------------
    // RuntimeState — deliberately not memory
    // -----------------------------------------------------------------------

    /// Store the conversation's present condition.
    ///
    /// One row per relationship, replaced rather than accumulated: this is the
    /// current condition, not a history of conditions. The session trajectory
    /// inside it is what carries the shape of the session, and that is promoted
    /// to an episode's emotional arc at the end rather than kept here.
    ///
    /// A record whose `expires_at` has already passed is still written. Refusing
    /// it would make the caller guess whether the state was rejected or merely
    /// stale, and the row is what lets a later reader say which.
    pub fn put_runtime_state(&self, state: &RuntimeState) -> rusqlite::Result<()> {
        let key = ScopeKey::of(&state.scope);
        self.connection.execute(
            "INSERT OR REPLACE INTO runtime_state (
                scope_key, current_affect_json, current_topic, apparent_need,
                conversation_mode, active_entities_json, unresolved_turn_intent,
                trajectory_json, expires_at, updated_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            rusqlite::params![
                key.as_str(),
                json_opt(&state.current_affect)?,
                state.current_topic,
                state.apparent_need,
                state.conversation_mode,
                json_opt(&state.active_entities)?,
                state.unresolved_turn_intent,
                json_opt(&state.session_trajectory)?,
                state.expires_at,
                state.updated_at,
            ],
        )?;
        Ok(())
    }

    /// Read the present condition, ignoring it when it has expired.
    ///
    /// Expiry is applied on read rather than by deleting, for two reasons. A
    /// sweeper that only runs periodically would leave a window where stale
    /// state is live, and a state that expires *because the conversation moved
    /// on* is worth being able to inspect afterwards when asking why the
    /// companion stopped reacting to something.
    ///
    /// A caller that wants to know whether anything was ever recorded, or that a
    /// record has gone stale, can use [`Store::runtime_state_raw`].
    pub fn get_runtime_state(
        &self,
        scope: &RelationshipScope,
        now: &str,
    ) -> rusqlite::Result<Option<RuntimeState>> {
        let stored = self.runtime_state_raw(scope)?;
        Ok(stored.filter(|state| state.expires_at.as_str() > now))
    }

    /// Read the present condition including an expired one, for diagnostics.
    pub fn runtime_state_raw(
        &self,
        scope: &RelationshipScope,
    ) -> rusqlite::Result<Option<RuntimeState>> {
        let key = ScopeKey::of(scope);
        self.connection
            .query_row(
                "SELECT current_affect_json, current_topic, apparent_need, conversation_mode,
                        active_entities_json, unresolved_turn_intent, trajectory_json,
                        expires_at, updated_at
                 FROM runtime_state WHERE scope_key = ?1",
                [key.as_str()],
                |row| {
                    Ok(RuntimeState {
                        scope: scope.clone(),
                        current_affect: json_optional(row.get(0)?, "current_affect")?,
                        current_topic: row.get(1)?,
                        apparent_need: row.get(2)?,
                        conversation_mode: row.get(3)?,
                        active_entities: json_optional(row.get(4)?, "active_entities")?,
                        unresolved_turn_intent: row.get(5)?,
                        session_trajectory: json_optional(row.get(6)?, "session_trajectory")?,
                        expires_at: row.get(7)?,
                        updated_at: row.get(8)?,
                    })
                },
            )
            .optional()
    }

    /// Delete a relationship's state outright.
    ///
    /// For profile deletion and for an explicit reset, where the point is that
    /// nothing about the conversation's condition should carry over.
    pub fn clear_runtime_state(&self, scope: &RelationshipScope) -> rusqlite::Result<usize> {
        let key = ScopeKey::of(scope);
        self.connection.execute(
            "DELETE FROM runtime_state WHERE scope_key = ?1",
            [key.as_str()],
        )
    }

    // -----------------------------------------------------------------------
    // Reconstructing the kernel's suppression representation
    // -----------------------------------------------------------------------

    /// Load the suppression set for a scope in the shape the kernel's rules take.
    ///
    /// The kernel decides what forgetting means; this decides how stored rows
    /// become that decision's input. Keeping the translation here rather than in
    /// the kernel is what lets the kernel stay free of SQL while remaining the
    /// single authority on what a suppression set contains.
    ///
    /// Rows whose `kind` is not recognised are skipped rather than failing the
    /// load. One unreadable suppression row must not make a person's whole
    /// history inaccessible.
    pub fn load_suppression_set(
        &self,
        scope: &RelationshipScope,
    ) -> rusqlite::Result<SuppressionSet> {
        let mut set = SuppressionSet::default();
        for (kind, target) in self.suppression_entries(scope)? {
            match kind.as_str() {
                "record" => {
                    set.suppressed.insert(target);
                }
                "predicate" => {
                    set.suppressed_predicates.insert(target);
                }
                "entity" => {
                    set.suppressed_entities.insert(target);
                }
                // "all" carries no target; the stored row is the flag.
                "all" => {
                    set.all = true;
                }
                _ => {}
            }
        }
        Ok(set)
    }

    /// Load forgotten content as a map the kernel's guard can consult.
    ///
    /// The kernel expects **label to fingerprint**, and the orientation matters:
    /// with the pair the other way round the guard compares a fingerprint
    /// against a human-readable label, the two can never be equal, and it never
    /// fires. Nothing about that failure is visible at either call site — the
    /// suppression row is written, the map is populated, and forgotten content
    /// comes back. The integration test is what pins the direction.
    ///
    /// Without this map at all, `would_resurrect` could refuse whole predicates
    /// or entities but not a single sentence, so a re-extraction of the same
    /// fact would be written straight back — the hole the fingerprint exists to
    /// close.
    pub fn load_suppressed_fingerprints(
        &self,
        scope: &RelationshipScope,
    ) -> rusqlite::Result<HashMap<String, String>> {
        Ok(self
            .suppressed_fingerprints(scope)?
            .into_iter()
            // Stored as (fingerprint, label); the kernel keys by label.
            .map(|(fingerprint, label)| (label, fingerprint))
            .collect())
    }
}

/// Insert an evidence message once and reject a retry that reuses its id for
/// different text. Source spans are byte offsets into this text, so replacing
/// it would silently invalidate every provenance pointer already stored.
fn ensure_source_message(
    transaction: &rusqlite::Transaction<'_>,
    scope_key: &str,
    message: &SourceMessage,
) -> rusqlite::Result<()> {
    let existing: Option<String> = transaction
        .query_row(
            "SELECT text FROM source_messages WHERE scope_key = ?1 AND id = ?2",
            rusqlite::params![scope_key, message.id],
            |row| row.get(0),
        )
        .optional()?;
    match existing {
        Some(text) if text != message.text => Err(rusqlite::Error::InvalidParameterName(
            "source message text conflicts with immutable evidence".into(),
        )),
        Some(_) => Ok(()),
        None => {
            transaction.execute(
                "INSERT INTO source_messages (scope_key, id, session_id, text, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                rusqlite::params![
                    scope_key,
                    message.id,
                    message.session_id,
                    message.text,
                    message.created_at
                ],
            )?;
            Ok(())
        }
    }
}

/// Keep provenance stable for a record id as well as for its source message.
/// A retry with the same record id and a different span is not an update: it is
/// a hard conflict, because replacing the offsets would silently rewrite what
/// the stored record claims to be evidence for.
fn ensure_source_span(
    transaction: &rusqlite::Transaction<'_>,
    scope_key: &str,
    span: &SourceSpan,
) -> rusqlite::Result<()> {
    let existing: Option<(String, i64, i64, String)> = transaction
        .query_row(
            "SELECT message_id, start_offset, end_offset, quote
             FROM source_spans WHERE scope_key = ?1 AND record_id = ?2",
            rusqlite::params![scope_key, span.record_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .optional()?;
    match existing {
        Some((message_id, start_offset, end_offset, quote))
            if message_id != span.message_id
                || start_offset != span.start_offset
                || end_offset != span.end_offset
                || quote != span.quote =>
        {
            Err(rusqlite::Error::InvalidParameterName(
                "source span conflicts with immutable provenance".into(),
            ))
        }
        Some(_) => Ok(()),
        None => {
            transaction.execute(
                "INSERT INTO source_spans
                 (scope_key, record_id, message_id, start_offset, end_offset, quote)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                rusqlite::params![
                    scope_key,
                    span.record_id,
                    span.message_id,
                    span.start_offset,
                    span.end_offset,
                    span.quote,
                ],
            )?;
            Ok(())
        }
    }
}

// ---------------------------------------------------------------------------
// Column lists
// ---------------------------------------------------------------------------

const CLAIM_COLUMNS: &str = "id, predicate, entity_ref, qualifiers_json, value_json, raw_value, \
    valid_from, valid_until, status, supersedes_id, source_refs_json, provenance_json, \
    importance, recall_count, last_recalled_at, do_not_surface, created_at, updated_at";

const EPISODE_COLUMNS: &str = "id, occurred_from, occurred_to, narrative, participants_json, \
    emotional_arc_json, user_reaction, response_ref, source_refs_json, status, importance, \
    recall_count, last_recalled_at, do_not_surface, created_at, updated_at";

const INFERENCE_COLUMNS: &str = "id, axis, predicate, value, state, confidence, \
    support_evidence_json, counter_evidence_json, promotion_audit_json, user_acknowledged_at, \
    use_mode, expires_at, importance, recall_count, last_recalled_at, do_not_surface, \
    created_at, updated_at";

// ---------------------------------------------------------------------------
// Serialisation helpers
// ---------------------------------------------------------------------------

/// Serialise JSON that is never expected to fail.
///
/// Serialising a value that came out of `serde_json` cannot fail, so a failure
/// here would mean the type itself is broken. Falling back to a valid empty
/// document keeps a broken record from taking the whole store down, and the
/// value is recoverable because the record's other columns are intact.
fn value_json(value: &serde_json::Value) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| "null".into())
}

fn refs_json(refs: &[companion_memory_kernel::domain::types::EvidenceRef]) -> String {
    serde_json::to_string(refs).unwrap_or_else(|_| "[]".into())
}

fn provenance_json(provenance: &companion_memory_kernel::domain::types::Provenance) -> String {
    serde_json::to_string(provenance).unwrap_or_else(|_| "null".into())
}

/// Serialise an optional value, mapping `None` to SQL `NULL`.
fn json_opt<T: serde::Serialize>(value: &Option<T>) -> rusqlite::Result<Option<String>> {
    match value {
        None => Ok(None),
        Some(inner) => Ok(Some(
            serde_json::to_string(inner).unwrap_or_else(|_| "null".into()),
        )),
    }
}

/// Read JSON that must be present.
fn json_required<T: serde::de::DeserializeOwned>(text: String, what: &str) -> rusqlite::Result<T> {
    serde_json::from_str(&text).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(
            0,
            rusqlite::types::Type::Text,
            Box::new(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                format!("{what} is not valid JSON: {error}"),
            )),
        )
    })
}

/// Read JSON that may be absent.
fn json_optional<T: serde::de::DeserializeOwned>(
    text: Option<String>,
    what: &str,
) -> rusqlite::Result<Option<T>> {
    match text {
        None => Ok(None),
        Some(text) => json_required(text, what).map(Some),
    }
}

// ---------------------------------------------------------------------------
// Enum <-> column text
//
// A macro was considered and rejected: it would have to enumerate every variant
// of every enum anyway, and the explicit functions below are what a reader
// actually needs to check. An unrecognised stored value falls back to the
// conservative member rather than failing the read, because a single unreadable
// row must not make a whole profile's memory inaccessible.
// ---------------------------------------------------------------------------

fn claim_status(status: ClaimStatus) -> &'static str {
    match status {
        ClaimStatus::Active => "active",
        ClaimStatus::Superseded => "superseded",
        ClaimStatus::Revoked => "revoked",
        ClaimStatus::Deleted => "deleted",
    }
}

fn claim_status_from(text: &str) -> ClaimStatus {
    match text {
        "superseded" => ClaimStatus::Superseded,
        "revoked" => ClaimStatus::Revoked,
        "deleted" => ClaimStatus::Deleted,
        // Anything unrecognised is treated as still active: hiding a record the
        // user never forgot is worse than showing one they did, and the
        // suppression table is the mechanism for the latter.
        _ => ClaimStatus::Active,
    }
}

fn episode_status(status: EpisodeStatus) -> &'static str {
    match status {
        EpisodeStatus::Active => "active",
        EpisodeStatus::Deleted => "deleted",
    }
}

fn episode_status_from(text: &str) -> EpisodeStatus {
    match text {
        "deleted" => EpisodeStatus::Deleted,
        _ => EpisodeStatus::Active,
    }
}

fn inference_axis(axis: InferenceAxis) -> &'static str {
    match axis {
        InferenceAxis::Disposition => "disposition",
        InferenceAxis::Pattern => "pattern",
        InferenceAxis::RecurringTheme => "recurring_theme",
        InferenceAxis::Relational => "relational",
        InferenceAxis::SelfModel => "self_model",
        InferenceAxis::SharedWorld => "shared_world",
    }
}

fn inference_axis_from(text: &str) -> InferenceAxis {
    match text {
        "pattern" => InferenceAxis::Pattern,
        "recurring_theme" => InferenceAxis::RecurringTheme,
        "relational" => InferenceAxis::Relational,
        "self_model" => InferenceAxis::SelfModel,
        "shared_world" => InferenceAxis::SharedWorld,
        _ => InferenceAxis::Disposition,
    }
}

fn inference_state(state: InferenceState) -> &'static str {
    match state {
        InferenceState::Accumulating => "accumulating",
        InferenceState::Active => "active",
        InferenceState::Rejected => "rejected",
        InferenceState::Expired => "expired",
    }
}

fn inference_state_from(text: &str) -> InferenceState {
    match text {
        "active" => InferenceState::Active,
        "rejected" => InferenceState::Rejected,
        "expired" => InferenceState::Expired,
        // An unreadable state falls back to accumulating, which is the state
        // that surfaces least: getting this wrong in the other direction would
        // promote a belief nobody can account for.
        _ => InferenceState::Accumulating,
    }
}

fn mention_mode(mode: MentionMode) -> &'static str {
    match mode {
        MentionMode::NeverSurface => "never_surface",
        MentionMode::BackgroundOnly => "background_only",
        MentionMode::MentionIfUserCues => "mention_if_user_cues",
        MentionMode::FreelyMentionable => "freely_mentionable",
    }
}

fn mention_mode_from(text: &str) -> MentionMode {
    match text {
        "freely_mentionable" => MentionMode::FreelyMentionable,
        "mention_if_user_cues" => MentionMode::MentionIfUserCues,
        // Unknown or unreadable mode falls back to the quietest useful setting
        // rather than the loudest, so a corrupt row cannot make a record spoke
        // about freely.
        _ => MentionMode::BackgroundOnly,
    }
}

// ---------------------------------------------------------------------------
// Row readers
// ---------------------------------------------------------------------------

/// The v1 schema uses a global id primary key and a separate scope column.
/// Refusing a same-id write from another scope preserves the old schema while
/// preventing `INSERT OR REPLACE` from deleting a different relationship's
/// row. New ids are normally globally unique, but isolation must not depend on
/// that upstream convention.
fn ensure_id_scope(
    connection: &Connection,
    table: &str,
    id: &str,
    scope: &str,
) -> rusqlite::Result<()> {
    let existing: Option<String> = connection
        .query_row(
            &format!("SELECT scope_key FROM {table} WHERE id = ?1"),
            [id],
            |row| row.get(0),
        )
        .optional()?;
    if existing.is_some_and(|existing| existing != scope) {
        return Err(rusqlite::Error::InvalidParameterName(
            "record id belongs to another scope".into(),
        ));
    }
    Ok(())
}

fn ensure_id_scope_tx(
    transaction: &Transaction<'_>,
    table: &str,
    id: &str,
    scope: &str,
) -> rusqlite::Result<()> {
    let existing: Option<String> = transaction
        .query_row(
            &format!("SELECT scope_key FROM {table} WHERE id = ?1"),
            [id],
            |row| row.get(0),
        )
        .optional()?;
    if existing.is_some_and(|existing| existing != scope) {
        return Err(rusqlite::Error::InvalidParameterName(
            "record id belongs to another scope".into(),
        ));
    }
    Ok(())
}

fn active_claims_tx(
    transaction: &Transaction<'_>,
    scope: &RelationshipScope,
    scope_key: &str,
) -> rusqlite::Result<Vec<Claim>> {
    let mut statement = transaction.prepare(&format!(
        "SELECT {CLAIM_COLUMNS} FROM claims
         WHERE scope_key = ?1 AND status = 'active'
         ORDER BY updated_at DESC, id ASC"
    ))?;
    let rows = statement.query_map([scope_key], |row| read_claim(row, scope))?;
    rows.collect()
}

fn active_episodes_tx(
    transaction: &Transaction<'_>,
    scope: &RelationshipScope,
    scope_key: &str,
) -> rusqlite::Result<Vec<Episode>> {
    let mut statement = transaction.prepare(&format!(
        "SELECT {EPISODE_COLUMNS} FROM episodes
         WHERE scope_key = ?1 AND status = 'active'
         ORDER BY occurred_from DESC, id ASC"
    ))?;
    let rows = statement.query_map([scope_key], |row| read_episode(row, scope))?;
    rows.collect()
}

fn active_open_threads_tx(
    transaction: &Transaction<'_>,
    scope_key: &str,
    now: &str,
) -> rusqlite::Result<Vec<OpenThread>> {
    let mut statement = transaction.prepare(
        "SELECT id, record_id, entity_ref, summary, sensitivity, mention_mode, status,
                opened_at, expires_at, followup_session_id, updated_at
         FROM open_threads
         WHERE scope_key = ?1 AND status = 'open'
           AND (expires_at IS NULL OR expires_at > ?2)
         ORDER BY updated_at DESC, id ASC",
    )?;
    let rows = statement.query_map(rusqlite::params![scope_key, now], |row| {
        Ok(OpenThread {
            id: row.get(0)?,
            record_id: row.get(1)?,
            entity_ref: row.get(2)?,
            summary: row.get(3)?,
            sensitivity: row.get(4)?,
            mention_mode: row.get(5)?,
            status: row.get(6)?,
            opened_at: row.get(7)?,
            expires_at: row.get(8)?,
            followup_session_id: row.get(9)?,
            updated_at: row.get(10)?,
        })
    })?;
    rows.collect()
}

fn load_suppression_set_tx(
    transaction: &Transaction<'_>,
    scope_key: &str,
) -> rusqlite::Result<SuppressionSet> {
    let mut set = SuppressionSet::default();
    let mut statement = transaction
        .prepare("SELECT kind, target FROM suppression WHERE scope_key = ?1 ORDER BY id")?;
    let rows = statement.query_map([scope_key], |row| Ok((row.get(0)?, row.get(1)?)))?;
    for row in rows {
        let (kind, target): (String, String) = row?;
        match kind.as_str() {
            "record" => {
                set.suppressed.insert(target);
            }
            "predicate" => {
                set.suppressed_predicates.insert(target);
            }
            "entity" => {
                set.suppressed_entities.insert(target);
            }
            "all" => set.all = true,
            _ => {}
        }
    }
    Ok(set)
}

fn bump_revision_tx(transaction: &Transaction<'_>, scope_key: &str) -> rusqlite::Result<()> {
    transaction.execute(
        "INSERT INTO memory_revisions (scope_key, revision) VALUES (?1, 1)
         ON CONFLICT(scope_key) DO UPDATE SET revision = memory_revisions.revision + 1",
        [scope_key],
    )?;
    Ok(())
}

fn active_claims_in_slot_tx(
    transaction: &Transaction<'_>,
    scope: &RelationshipScope,
    predicate: &str,
    entity_ref: Option<&str>,
    qualifiers: Option<&serde_json::Value>,
) -> rusqlite::Result<Vec<Claim>> {
    let desired = canonical_key_parts(&SlotKey {
        predicate,
        entity_ref,
        qualifiers,
    });
    let key = ScopeKey::of(scope);
    let mut statement = transaction.prepare(&format!(
        "SELECT {CLAIM_COLUMNS} FROM claims
         WHERE scope_key = ?1 AND predicate = ?2 AND status = 'active'"
    ))?;
    let rows = statement.query_map(rusqlite::params![key.as_str(), predicate], |row| {
        read_claim(row, scope)
    })?;
    rows.collect::<rusqlite::Result<Vec<_>>>().map(|claims| {
        claims
            .into_iter()
            .filter(|claim| {
                canonical_key_parts(&SlotKey {
                    predicate: &claim.predicate,
                    entity_ref: claim.entity_ref.as_deref(),
                    qualifiers: claim.qualifiers.as_ref(),
                }) == desired
            })
            .collect()
    })
}

fn read_claim(row: &rusqlite::Row<'_>, scope: &RelationshipScope) -> rusqlite::Result<Claim> {
    Ok(Claim {
        id: row.get(0)?,
        scope: scope.clone(),
        predicate: row.get(1)?,
        entity_ref: row.get(2)?,
        qualifiers: json_optional(row.get(3)?, "qualifiers")?,
        value: json_required(row.get(4)?, "value")?,
        raw_value: row.get(5)?,
        valid_from: row.get(6)?,
        valid_until: row.get(7)?,
        status: claim_status_from(&row.get::<_, String>(8)?),
        supersedes_id: row.get(9)?,
        source_refs: json_required(row.get(10)?, "source_refs")?,
        provenance: json_required(row.get(11)?, "provenance")?,
        salience: salience_from_row(row, 12)?,
        created_at: row.get(16)?,
        updated_at: row.get(17)?,
    })
}

fn read_episode(row: &rusqlite::Row<'_>, scope: &RelationshipScope) -> rusqlite::Result<Episode> {
    Ok(Episode {
        id: row.get(0)?,
        scope: scope.clone(),
        occurred_from: row.get(1)?,
        occurred_to: row.get(2)?,
        narrative: row.get(3)?,
        participants: json_required(row.get(4)?, "participants")?,
        emotional_arc: json_optional(row.get(5)?, "emotional_arc")?,
        user_reaction: row.get(6)?,
        response_ref: row.get(7)?,
        source_refs: json_required(row.get(8)?, "source_refs")?,
        status: episode_status_from(&row.get::<_, String>(9)?),
        salience: salience_from_row(row, 10)?,
        created_at: row.get(14)?,
        updated_at: row.get(15)?,
    })
}

fn read_inference(
    row: &rusqlite::Row<'_>,
    scope: &RelationshipScope,
) -> rusqlite::Result<Inference> {
    Ok(Inference {
        id: row.get(0)?,
        scope: scope.clone(),
        axis: inference_axis_from(&row.get::<_, String>(1)?),
        predicate: row.get(2)?,
        value: row.get(3)?,
        state: inference_state_from(&row.get::<_, String>(4)?),
        confidence: row.get(5)?,
        support_evidence: json_required(row.get(6)?, "support_evidence")?,
        counter_evidence: json_required(row.get(7)?, "counter_evidence")?,
        promotion_audit: json_optional(row.get(8)?, "promotion_audit")?,
        user_acknowledged_at: row.get(9)?,
        use_mode: mention_mode_from(&row.get::<_, String>(10)?),
        expires_at: row.get(11)?,
        salience: salience_from_row(row, 12)?,
        created_at: row.get(16)?,
        updated_at: row.get(17)?,
    })
}

fn salience_from_row(row: &rusqlite::Row<'_>, base: usize) -> rusqlite::Result<Salience> {
    Ok(Salience {
        importance: row.get(base)?,
        recall_count: row.get(base + 1)?,
        last_recalled_at: row.get(base + 2)?,
        do_not_surface: row.get::<_, Option<i64>>(base + 3)?.map(|value| value != 0),
    })
}
