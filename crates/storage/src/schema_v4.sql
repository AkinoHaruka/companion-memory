-- companion memory schema, version 4
--
-- A revision is a durable change watermark for one relationship scope.  It is
-- deliberately separate from row counts: replacing a single-cardinality
-- claim, forgetting a record, or changing suppression must all invalidate a
-- previously rendered snapshot even when the number of rows stays constant.

CREATE TABLE IF NOT EXISTS memory_revisions (
    scope_key TEXT PRIMARY KEY,
    revision  INTEGER NOT NULL DEFAULT 0
);
