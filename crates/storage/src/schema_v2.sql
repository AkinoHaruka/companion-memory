-- companion memory schema, version 2
--
-- Source text is retained only for a record the admission path accepted.  The
-- record id on every span makes an explicit forget operation able to erase the
-- reversible evidence without weakening the one-way suppression fingerprint.

CREATE TABLE IF NOT EXISTS source_messages (
    scope_key   TEXT NOT NULL,
    id          TEXT NOT NULL,
    session_id  TEXT NOT NULL,
    text        TEXT NOT NULL,
    created_at  TEXT NOT NULL,
    PRIMARY KEY (scope_key, id)
);

CREATE TABLE IF NOT EXISTS source_spans (
    scope_key   TEXT NOT NULL,
    record_id   TEXT NOT NULL,
    message_id  TEXT NOT NULL,
    start_offset INTEGER NOT NULL,
    end_offset   INTEGER NOT NULL,
    quote        TEXT NOT NULL,
    PRIMARY KEY (scope_key, record_id, message_id, start_offset, end_offset),
    FOREIGN KEY (scope_key, message_id)
        REFERENCES source_messages(scope_key, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_source_spans_record
    ON source_spans (scope_key, record_id);

CREATE TABLE IF NOT EXISTS open_threads (
    id                   TEXT PRIMARY KEY,
    scope_key            TEXT NOT NULL,
    record_id            TEXT NOT NULL,
    entity_ref           TEXT,
    summary              TEXT NOT NULL,
    sensitivity          TEXT NOT NULL,
    mention_mode         TEXT NOT NULL,
    status               TEXT NOT NULL,
    opened_at            TEXT NOT NULL,
    expires_at           TEXT,
    followup_session_id  TEXT,
    updated_at           TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_open_threads_scope_status
    ON open_threads (scope_key, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS turn_telemetry (
    id          TEXT PRIMARY KEY,
    scope_key   TEXT NOT NULL,
    turn_key    TEXT NOT NULL,
    phase       TEXT NOT NULL,
    detail_json TEXT NOT NULL,
    created_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_turn_telemetry_scope_turn
    ON turn_telemetry (scope_key, turn_key, created_at);
