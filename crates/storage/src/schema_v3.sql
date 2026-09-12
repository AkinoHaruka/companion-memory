-- companion memory schema, version 3
--
-- Non-claim extraction products are deliberately not promoted into durable
-- memories until extraction-quality gates have been measured. The original
-- transcript remains L0; this table records only the review pointer and why
-- automatic promotion was withheld.

CREATE TABLE IF NOT EXISTS pending_candidates (
    id                TEXT PRIMARY KEY,
    scope_key         TEXT NOT NULL,
    kind              TEXT NOT NULL,
    source_message_id TEXT NOT NULL,
    reason            TEXT NOT NULL,
    status            TEXT NOT NULL,
    created_at        TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_pending_candidates_scope_status
    ON pending_candidates (scope_key, status, created_at DESC);
