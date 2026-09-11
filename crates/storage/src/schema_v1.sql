-- companion memory schema, version 1
--
-- Conventions:
--   * ISO 8601 timestamps are TEXT, compared lexicographically. The kernel does
--     the same, so no conversion happens at this boundary.
--   * Nested structures (`qualifiers`, `source_refs`, emotional arcs) are JSON
--     TEXT. They are never queried into, only read whole, so a column per field
--     would add cost without adding capability.
--   * `scope_key` is the relationship identity. Every query filters on it, which
--     is what keeps one person's memories out of another's conversation.
--   * Every statement is IF NOT EXISTS so a database that already has the
--     objects converges instead of failing.

CREATE TABLE IF NOT EXISTS claims (
    id                TEXT PRIMARY KEY,
    scope_key         TEXT NOT NULL,
    predicate         TEXT NOT NULL,
    entity_ref        TEXT,
    qualifiers_json   TEXT,
    value_json        TEXT NOT NULL,
    raw_value         TEXT,
    valid_from        TEXT NOT NULL,
    valid_until       TEXT,
    status            TEXT NOT NULL,
    supersedes_id     TEXT,
    source_refs_json  TEXT NOT NULL,
    provenance_json   TEXT NOT NULL,
    importance        REAL NOT NULL,
    recall_count      INTEGER NOT NULL,
    last_recalled_at  TEXT,
    do_not_surface    INTEGER,
    created_at        TEXT NOT NULL,
    updated_at        TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS episodes (
    id                 TEXT PRIMARY KEY,
    scope_key          TEXT NOT NULL,
    occurred_from      TEXT NOT NULL,
    occurred_to        TEXT,
    narrative          TEXT NOT NULL,
    participants_json  TEXT NOT NULL,
    emotional_arc_json TEXT,
    user_reaction      TEXT,
    response_ref       TEXT,
    source_refs_json   TEXT NOT NULL,
    status             TEXT NOT NULL,
    importance         REAL NOT NULL,
    recall_count       INTEGER NOT NULL,
    last_recalled_at   TEXT,
    do_not_surface     INTEGER,
    created_at         TEXT NOT NULL,
    updated_at         TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS inferences (
    id                     TEXT PRIMARY KEY,
    scope_key              TEXT NOT NULL,
    axis                   TEXT NOT NULL,
    predicate              TEXT NOT NULL,
    value                  TEXT NOT NULL,
    state                  TEXT NOT NULL,
    confidence             REAL NOT NULL,
    support_evidence_json  TEXT NOT NULL,
    counter_evidence_json  TEXT NOT NULL,
    promotion_audit_json   TEXT,
    user_acknowledged_at   TEXT,
    use_mode               TEXT NOT NULL,
    expires_at             TEXT,
    importance             REAL NOT NULL,
    recall_count           INTEGER NOT NULL,
    last_recalled_at       TEXT,
    do_not_surface         INTEGER,
    created_at             TEXT NOT NULL,
    updated_at             TEXT NOT NULL
);

-- Evidence edges, in one table for both directions.
--
-- `owner_id` is the record that cites the evidence; `source_id` is what it
-- cites. Keeping both in one table rather than a column per citing layer means
-- "which inferences depend on this episode" is one indexed query, which is what
-- the suppression recompute needs.
CREATE TABLE IF NOT EXISTS evidence_refs (
    owner_id     TEXT NOT NULL,
    direction    TEXT NOT NULL,   -- 'support' | 'counter' | 'source'
    ordinal      INTEGER NOT NULL,
    source_type  TEXT NOT NULL,
    source_id    TEXT NOT NULL,
    speaker      TEXT NOT NULL,
    semantic_role TEXT,
    PRIMARY KEY (owner_id, direction, ordinal)
);

CREATE INDEX IF NOT EXISTS idx_evidence_source
    ON evidence_refs (source_id);

-- Suppression: what the user asked to forget.
--
-- Nothing is deleted. A read filters against this table, and the fingerprint
-- list is what stops a later extraction from writing the same fact again.
CREATE TABLE IF NOT EXISTS suppression (
    id             TEXT PRIMARY KEY,
    scope_key      TEXT NOT NULL,
    kind           TEXT NOT NULL,   -- 'record' | 'predicate' | 'entity' | 'all'
    target         TEXT NOT NULL,
    fingerprint    TEXT,
    created_at     TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_suppression_scope
    ON suppression (scope_key, kind);

CREATE TABLE IF NOT EXISTS suppressed_fingerprints (
    scope_key   TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    label       TEXT NOT NULL,
    created_at  TEXT NOT NULL,
    PRIMARY KEY (scope_key, fingerprint)
);

-- RuntimeState is deliberately in the same database but is not memory: it has a
-- TTL measured in turns or hours and is deleted rather than kept.
CREATE TABLE IF NOT EXISTS runtime_state (
    scope_key        TEXT PRIMARY KEY,
    current_affect_json TEXT,
    current_topic    TEXT,
    apparent_need    TEXT,
    conversation_mode TEXT,
    active_entities_json TEXT,
    unresolved_turn_intent TEXT,
    trajectory_json  TEXT,
    expires_at       TEXT NOT NULL,
    updated_at       TEXT NOT NULL
);

-- Append-only record of governance actions, so a user asking "why do you think
-- that" has an answer that is not the model's recollection.
CREATE TABLE IF NOT EXISTS audit_events (
    id          TEXT PRIMARY KEY,
    scope_key   TEXT NOT NULL,
    action      TEXT NOT NULL,
    record_id   TEXT,
    detail      TEXT,
    created_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_audit_scope_time
    ON audit_events (scope_key, created_at DESC);

-- The reads the rules actually perform.
CREATE INDEX IF NOT EXISTS idx_claims_scope_predicate
    ON claims (scope_key, predicate, status);

CREATE INDEX IF NOT EXISTS idx_claims_slot
    ON claims (scope_key, predicate, entity_ref);

CREATE INDEX IF NOT EXISTS idx_episodes_scope_time
    ON episodes (scope_key, occurred_from DESC);

CREATE INDEX IF NOT EXISTS idx_inferences_scope_state
    ON inferences (scope_key, state);
