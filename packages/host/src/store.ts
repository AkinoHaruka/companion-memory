/**
 * Persistent storage for the host runtime.
 *
 * Uses Node's built-in `node:sqlite`, so the runtime adds no dependency. The
 * schema mirrors `crates/storage/src/schema_v1.sql` closely enough that the two
 * can be read side by side; where they differ it is noted.
 *
 * Two properties carried over from the Rust crate because they are the ones that
 * fail silently.
 *
 * **Every read is scoped.** There is no unscoped accessor, so a query cannot
 * forget the relationship it belongs to.
 *
 * **Expiry is applied on read.** A sweeper that runs periodically would leave a
 * window where stale state is live.
 */

import { DatabaseSync } from 'node:sqlite';

import type { MemoryScope } from '../../dsh-plugin/src/memory.js';

/** One stored statement about the user. */
export interface StoredClaim {
  id: string;
  predicate: string;
  value: string;
  /** How loudly it may appear; mirrors the kernel's mention levels. */
  mention: 'never_surface' | 'background_only' | 'mention_if_user_cues' | 'freely_mentionable';
  /** Where the record came from, for the audit trail. */
  sourceType: string;
  confidence: number;
  importance: number;
  status: 'active' | 'superseded' | 'revoked';
  /** The user's own words, kept verbatim. */
  rawValue?: string;
  validFrom: string;
  sessionId?: string;
}

/** One stored shared experience. */
export interface StoredEpisode {
  id: string;
  narrative: string;
  occurredFrom: string;
  /** What the user did or said next. Descriptive, not causal. */
  userReaction?: string;
  /** The session it came from, so a later pass can group by session. */
  sessionId?: string;
}

/** The conversation's present condition. */
export interface StoredState {
  affect?: string[];
  apparentNeed?: string;
  topic?: string;
  expiresAt: string;
}

/** An entry in the append-only record of what happened to memory. */
export interface StoredAudit {
  action: string;
  recordKind: string;
  recordId: string;
  detail: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS claims (
  id            TEXT PRIMARY KEY,
  scope_key     TEXT NOT NULL,
  predicate     TEXT NOT NULL,
  value         TEXT NOT NULL,
  mention       TEXT NOT NULL,
  source_type   TEXT NOT NULL,
  confidence    REAL NOT NULL,
  importance    REAL NOT NULL,
  status        TEXT NOT NULL,
  raw_value     TEXT,
  valid_from    TEXT NOT NULL,
  session_id    TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_claims_scope ON claims (scope_key, predicate, status);

CREATE TABLE IF NOT EXISTS episodes (
  id            TEXT PRIMARY KEY,
  scope_key     TEXT NOT NULL,
  narrative     TEXT NOT NULL,
  occurred_from TEXT NOT NULL,
  user_reaction TEXT,
  session_id    TEXT,
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_episodes_scope ON episodes (scope_key, occurred_from DESC);

CREATE TABLE IF NOT EXISTS runtime_state (
  scope_key   TEXT PRIMARY KEY,
  payload_json TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS suppression (
  scope_key   TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  label       TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  PRIMARY KEY (scope_key, fingerprint)
);

CREATE TABLE IF NOT EXISTS suppression_target (
  scope_key TEXT NOT NULL,
  kind      TEXT NOT NULL,
  target    TEXT NOT NULL,
  PRIMARY KEY (scope_key, kind, target)
);

CREATE TABLE IF NOT EXISTS audit_events (
  id          TEXT PRIMARY KEY,
  scope_key   TEXT NOT NULL,
  action      TEXT NOT NULL,
  record_kind TEXT NOT NULL,
  record_id   TEXT NOT NULL,
  detail      TEXT NOT NULL,
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS meta (
  scope_key TEXT PRIMARY KEY,
  revision  INTEGER NOT NULL DEFAULT 0
);
`;

/**
 * The database handle.
 *
 * One connection per process: `node:sqlite` is synchronous, and every operation
 * here is small enough that a pool would add coordination without adding
 * throughput.
 */
export class HostStore {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;');
    this.db.exec(SCHEMA);
  }

  /** Close the database. */
  close(): void {
    this.db.close();
  }

  /**
   * A stable key for a relationship.
   *
   * NUL-separated, so no printable separator inside an identifier can collide
   * two relationships.
   */
  private key(scope: MemoryScope): string {
    return [scope.serviceId, scope.ownerUserId, scope.companionProfileId].join('\u0000');
  }

  /**
   * A monotonic counter for the relationship.
   *
   * Bumped by every mutation. The warm cache uses it to tell a re-render from a
   * repeat, and a transcript that carries it makes a stale block detectable.
   */
  revision(scope: MemoryScope): number {
    const row = this.db
      .prepare('SELECT revision FROM meta WHERE scope_key = ?')
      .get(this.key(scope)) as { revision?: number } | undefined;
    return row?.revision ?? 0;
  }

  /** Bump the revision, returning the new value. */
  private bump(scope: MemoryScope): number {
    this.db
      .prepare(
        'INSERT INTO meta (scope_key, revision) VALUES (?, 1) ' +
          'ON CONFLICT(scope_key) DO UPDATE SET revision = revision + 1',
      )
      .run(this.key(scope));
    return this.revision(scope);
  }

  /**
   * Insert or replace a claim, bumping the revision.
   *
   * @param scope - the relationship it belongs to.
   * @param claim - the record.
   * @param now - the instant, passed in so a run is reproducible.
   */
  putClaim(scope: MemoryScope, claim: StoredClaim, now: string): void {
    this.db
      .prepare(
        `INSERT INTO claims (id, scope_key, predicate, value, mention, source_type, confidence,
                             importance, status, raw_value, valid_from, session_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           value = excluded.value, mention = excluded.mention, confidence = excluded.confidence,
           importance = excluded.importance, status = excluded.status, updated_at = excluded.updated_at`,
      )
      .run(
        claim.id,
        this.key(scope),
        claim.predicate,
        claim.value,
        claim.mention,
        claim.sourceType,
        claim.confidence,
        claim.importance,
        claim.status,
        claim.rawValue ?? null,
        claim.validFrom,
        claim.sessionId ?? null,
        now,
        now,
      );
    this.bump(scope);
  }

  /** Active claims in a relationship, newest first. */
  activeClaims(scope: MemoryScope): StoredClaim[] {
    const rows = this.db
      .prepare(
        `SELECT id, predicate, value, mention, source_type, confidence, importance, status,
                raw_value, valid_from, session_id
         FROM claims WHERE scope_key = ? AND status = 'active'
         ORDER BY importance DESC, updated_at DESC`,
      )
      .all(this.key(scope)) as Record<string, unknown>[];
    return rows.map((row) => ({
      id: String(row.id),
      predicate: String(row.predicate),
      value: String(row.value),
      mention: String(row.mention) as StoredClaim['mention'],
      sourceType: String(row.source_type),
      confidence: Number(row.confidence),
      importance: Number(row.importance),
      status: String(row.status) as StoredClaim['status'],
      ...(row.raw_value ? { rawValue: String(row.raw_value) } : {}),
      validFrom: String(row.valid_from),
      ...(row.session_id ? { sessionId: String(row.session_id) } : {}),
    }));
  }

  /** Mark a claim superseded, as a correction does. */
  supersedeClaim(scope: MemoryScope, id: string, now: string): void {
    this.db
      .prepare(
        "UPDATE claims SET status = 'superseded', updated_at = ? WHERE scope_key = ? AND id = ?",
      )
      .run(now, this.key(scope), id);
    this.bump(scope);
  }

  /** Insert an episode, bumping the revision. */
  putEpisode(scope: MemoryScope, episode: StoredEpisode, now: string): void {
    this.db
      .prepare(
        `INSERT INTO episodes (id, scope_key, narrative, occurred_from, user_reaction, session_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET narrative = excluded.narrative`,
      )
      .run(
        episode.id,
        this.key(scope),
        episode.narrative,
        episode.occurredFrom,
        episode.userReaction ?? null,
        episode.sessionId ?? null,
        now,
      );
    this.bump(scope);
  }

  /** Episodes in a relationship, most recent first. */
  episodes(scope: MemoryScope): StoredEpisode[] {
    const rows = this.db
      .prepare(
        `SELECT id, narrative, occurred_from, user_reaction, session_id
         FROM episodes WHERE scope_key = ? ORDER BY occurred_from DESC`,
      )
      .all(this.key(scope)) as Record<string, unknown>[];
    return rows.map((row) => ({
      id: String(row.id),
      narrative: String(row.narrative),
      occurredFrom: String(row.occurred_from),
      ...(row.user_reaction ? { userReaction: String(row.user_reaction) } : {}),
      ...(row.session_id ? { sessionId: String(row.session_id) } : {}),
    }));
  }

  /** Store the present condition, replacing any previous one. */
  putState(scope: MemoryScope, state: StoredState, now: string): void {
    this.db
      .prepare(
        `INSERT INTO runtime_state (scope_key, payload_json, expires_at, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(scope_key) DO UPDATE SET
           payload_json = excluded.payload_json, expires_at = excluded.expires_at,
           updated_at = excluded.updated_at`,
      )
      .run(this.key(scope), JSON.stringify(state), state.expiresAt, now);
    this.bump(scope);
  }

  /**
   * The live condition, or `undefined` when absent or expired.
   *
   * Compared as instants rather than as strings: lexicographic ordering cannot
   * tell a malformed expiry from a valid one, so a bad timestamp would compare
   * as still-live and the reading would persist indefinitely.
   */
  liveState(scope: MemoryScope, now: string): StoredState | undefined {
    const row = this.db
      .prepare('SELECT payload_json, expires_at FROM runtime_state WHERE scope_key = ?')
      .get(this.key(scope)) as { payload_json?: string; expires_at?: string } | undefined;
    if (!row?.payload_json || !row.expires_at) return undefined;
    const expiry = Date.parse(row.expires_at);
    const instant = Date.parse(now);
    if (Number.isNaN(expiry) || Number.isNaN(instant) || expiry <= instant) return undefined;
    return JSON.parse(row.payload_json) as StoredState;
  }

  /** Record that content was forgotten. */
  suppress(scope: MemoryScope, kind: string, target: string, now: string): void {
    this.db
      .prepare(
        'INSERT OR REPLACE INTO suppression_target (scope_key, kind, target) VALUES (?, ?, ?)',
      )
      .run(this.key(scope), kind, target);
    void now;
    this.bump(scope);
  }

  /** Record a forgotten value's fingerprint, which is what stops resurrection. */
  suppressFingerprint(scope: MemoryScope, fingerprint: string, label: string, now: string): void {
    this.db
      .prepare(
        'INSERT OR REPLACE INTO suppression (scope_key, fingerprint, label, created_at) VALUES (?, ?, ?, ?)',
      )
      .run(this.key(scope), fingerprint, label, now);
    this.bump(scope);
  }

  /** Whether a value would reintroduce forgotten content. */
  isSuppressed(scope: MemoryScope, fingerprint: string): boolean {
    const row = this.db
      .prepare('SELECT fingerprint FROM suppression WHERE scope_key = ? AND fingerprint = ?')
      .get(this.key(scope), fingerprint) as { fingerprint?: string } | undefined;
    return Boolean(row);
  }

  /** Append an audit entry. */
  audit(scope: MemoryScope, event: StoredAudit, now: string): void {
    const id = `audit-${now}-${event.action}-${event.recordKind}-${event.recordId}`;
    this.db
      .prepare(
        `INSERT OR REPLACE INTO audit_events
           (id, scope_key, action, record_kind, record_id, detail, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, this.key(scope), event.action, event.recordKind, event.recordId, event.detail, now);
  }

  /** Every audit entry in a relationship, oldest first. */
  auditTrail(scope: MemoryScope): StoredAudit[] {
    const rows = this.db
      .prepare(
        `SELECT action, record_kind, record_id, detail FROM audit_events
         WHERE scope_key = ? ORDER BY created_at ASC, id ASC`,
      )
      .all(this.key(scope)) as Record<string, unknown>[];
    return rows.map((row) => ({
      action: String(row.action),
      recordKind: String(row.record_kind),
      recordId: String(row.record_id),
      detail: String(row.detail),
    }));
  }
}
