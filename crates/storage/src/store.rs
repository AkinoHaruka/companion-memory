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

use companion_memory_kernel::domain::types::{
    Claim, ClaimStatus, Episode, Inference, RelationshipScope, Salience,
};
use companion_memory_kernel::domain::predicates::MentionMode;
use companion_memory_kernel::domain::types::{EpisodeStatus, InferenceAxis, InferenceState};
use rusqlite::{Connection, OptionalExtension};

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
        Self { path: None, migrate: true }
    }
}

impl OpenOptions {
    /// An in-memory database, for tests and ephemeral use.
    pub fn in_memory() -> Self {
        Self { path: None, migrate: true }
    }

    /// A database at `path`.
    pub fn at(path: impl Into<String>) -> Self {
        Self { path: Some(path.into()), migrate: true }
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

impl Store {
    /// Open a database according to `options`.
    pub fn open(options: &OpenOptions) -> rusqlite::Result<Self> {
        let connection = match &options.path {
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

        let opened_with = if options.migrate {
            apply_migrations(&connection)?
        } else {
            MigrationState { from: 0, to: 0 }
        };

        Ok(Self { connection, opened_with })
    }

    /// What opening this database did to the schema.
    pub fn opened_with(&self) -> MigrationState {
        self.opened_with
    }

    /// The underlying connection, for tests and migrations.
    pub fn connection(&self) -> &Connection {
        &self.connection
    }

    // -----------------------------------------------------------------------
    // Claims
    // -----------------------------------------------------------------------

    /// Insert or replace a claim.
    pub fn put_claim(&self, claim: &Claim) -> rusqlite::Result<()> {
        let scope = ScopeKey::of(&claim.scope);
        self.connection.execute(
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
        Ok(())
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
                &format!(
                    "SELECT {CLAIM_COLUMNS} FROM claims WHERE scope_key = ?1 AND id = ?2"
                ),
                rusqlite::params![key.as_str(), id],
                |row| read_claim(row, scope),
            )
            .optional()
    }

    /// Active claims in a scope, most recently updated first.
    pub fn active_claims(&self, scope: &RelationshipScope) -> rusqlite::Result<Vec<Claim>> {
        let key = ScopeKey::of(scope);
        let mut statement = self.connection.prepare(&format!(
            "SELECT {CLAIM_COLUMNS} FROM claims WHERE scope_key = ?1 AND status = 'active'
             ORDER BY updated_at DESC, id ASC"
        ))?;
        let rows = statement.query_map([key.as_str()], |row| read_claim(row, scope))?;
        rows.collect()
    }

    /// Active claims occupying one slot.
    ///
    /// This is what `record_identity::decide_supersede` expects: only active
    /// records, only the same scope, only the same predicate and entity. The
    /// qualifier comparison is left to the caller because it is a JSON equality
    /// the kernel already defines canonically.
    pub fn active_claims_in_slot(
        &self,
        scope: &RelationshipScope,
        predicate: &str,
        entity_ref: Option<&str>,
    ) -> rusqlite::Result<Vec<Claim>> {
        let key = ScopeKey::of(scope);
        let mut statement = self.connection.prepare(&format!(
            "SELECT {CLAIM_COLUMNS} FROM claims
             WHERE scope_key = ?1 AND predicate = ?2 AND status = 'active'
               AND ((entity_ref IS NULL AND ?3 IS NULL) OR entity_ref = ?3)
             ORDER BY updated_at DESC, id ASC"
        ))?;
        let rows = statement.query_map(
            rusqlite::params![key.as_str(), predicate, entity_ref],
            |row| read_claim(row, scope),
        )?;
        rows.collect()
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
        self.connection.execute(
            "UPDATE claims SET status = ?1, updated_at = ?2 WHERE scope_key = ?3 AND id = ?4",
            rusqlite::params![claim_status(status), now, key.as_str(), id],
        )
    }

    // -----------------------------------------------------------------------
    // Episodes
    // -----------------------------------------------------------------------

    /// Insert or replace an episode.
    pub fn put_episode(&self, episode: &Episode) -> rusqlite::Result<()> {
        let scope = ScopeKey::of(&episode.scope);
        self.connection.execute(
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
        Ok(())
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
                &format!(
                    "SELECT {EPISODE_COLUMNS} FROM episodes WHERE scope_key = ?1 AND id = ?2"
                ),
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
        rows.collect()
    }

    // -----------------------------------------------------------------------
    // Inferences
    // -----------------------------------------------------------------------

    /// Insert or replace an inference.
    pub fn put_inference(&self, inference: &Inference) -> rusqlite::Result<()> {
        let scope = ScopeKey::of(&inference.scope);
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
        let id = format!("sup-{kind}-{target}");
        self.connection.execute(
            "INSERT OR REPLACE INTO suppression (id, scope_key, kind, target, fingerprint, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            rusqlite::params![id, key.as_str(), kind, target, fingerprint, now],
        )?;
        if let Some(fingerprint) = fingerprint {
            self.connection.execute(
                "INSERT OR REPLACE INTO suppressed_fingerprints
                    (scope_key, fingerprint, label, created_at)
                 VALUES (?1, ?2, ?3, ?4)",
                rusqlite::params![key.as_str(), fingerprint, label.unwrap_or(target), now],
            )?;
        }
        Ok(())
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
        let id = format!("audit-{now}-{action}-{}", record_id.unwrap_or(""));
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
    pub fn count_in_scope(
        &self,
        scope: &RelationshipScope,
        table: &str,
    ) -> rusqlite::Result<i64> {
        let table = match table {
            "claims" | "episodes" | "inferences" | "suppression" | "audit_events" => table,
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

fn read_inference(row: &rusqlite::Row<'_>, scope: &RelationshipScope) -> rusqlite::Result<Inference> {
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
