//! Storage behaviour: migrations, scope isolation, round trips.
//!
//! Two properties matter more than the rest. A migration that is not idempotent
//! corrupts a database the second time the process starts, and a query that
//! forgets its scope filter leaks one person's memories into another's
//! conversation. Both are tested directly rather than inferred from the code.

use companion_memory_kernel::domain::predicates::MentionMode;
use companion_memory_kernel::domain::types::{
    Claim, ClaimStatus, Episode, EpisodeStatus, EvidenceRef, EvidenceSourceType, Inference,
    InferenceAxis, InferenceState, Provenance, RelationshipScope, Salience, Speaker,
};
use companion_memory_storage::migrations::{
    apply_migrations, known_migrations, schema_version, CURRENT_SCHEMA_VERSION,
    EMPTY_SCHEMA_VERSION,
};
use companion_memory_storage::{OpenOptions, OpenThread, SourceMessage, SourceSpan, Store};
use serde_json::json;

const NOW: &str = "2026-06-10T12:00:00Z";
const EARLIER: &str = "2026-01-01T00:00:00Z";

fn scope(user: &str) -> RelationshipScope {
    RelationshipScope {
        service_id: "svc".into(),
        owner_user_id: user.into(),
        companion_profile_id: "profile".into(),
    }
}

fn provenance() -> Provenance {
    Provenance {
        agent_id: None,
        prompt_family: None,
        prompt_version: None,
        model: None,
        confidence: 0.9,
        created_at: NOW.into(),
    }
}

fn claim(id: &str, predicate: &str, value: serde_json::Value, user: &str) -> Claim {
    Claim {
        id: id.into(),
        scope: scope(user),
        predicate: predicate.into(),
        entity_ref: None,
        qualifiers: None,
        value,
        raw_value: None,
        valid_from: NOW.into(),
        valid_until: None,
        status: ClaimStatus::Active,
        supersedes_id: None,
        source_refs: vec![EvidenceRef {
            source_type: EvidenceSourceType::Message,
            source_id: "m1".into(),
            speaker: Speaker::User,
            semantic_role: None,
        }],
        provenance: provenance(),
        salience: Salience {
            importance: 0.7,
            recall_count: 2,
            ..Salience::default()
        },
        created_at: NOW.into(),
        updated_at: NOW.into(),
    }
}

fn episode(id: &str, user: &str) -> Episode {
    Episode {
        id: id.into(),
        scope: scope(user),
        occurred_from: EARLIER.into(),
        occurred_to: None,
        narrative: "The dog was sick that night.".into(),
        participants: Vec::new(),
        emotional_arc: None,
        user_reaction: Some("said it helped".into()),
        response_ref: None,
        source_refs: vec![EvidenceRef {
            source_type: EvidenceSourceType::Message,
            source_id: "m2".into(),
            speaker: Speaker::User,
            semantic_role: None,
        }],
        status: EpisodeStatus::Active,
        salience: Salience::default(),
        created_at: NOW.into(),
        updated_at: NOW.into(),
    }
}

fn inference(id: &str, user: &str) -> Inference {
    Inference {
        id: id.into(),
        scope: scope(user),
        axis: InferenceAxis::Pattern,
        predicate: "goal.current_focus".into(),
        value: "has been tired for months".into(),
        state: InferenceState::Accumulating,
        confidence: 0.4,
        support_evidence: vec![EvidenceRef {
            source_type: EvidenceSourceType::Claim,
            source_id: "c1".into(),
            speaker: Speaker::User,
            semantic_role: None,
        }],
        counter_evidence: Vec::new(),
        promotion_audit: None,
        user_acknowledged_at: None,
        use_mode: MentionMode::BackgroundOnly,
        expires_at: None,
        salience: Salience::default(),
        created_at: NOW.into(),
        updated_at: NOW.into(),
    }
}

/// A file-backed store in a fresh temporary directory.
///
/// Migrations are only observable across connections, so these tests need a real
/// file rather than `:memory:`.
struct TempDb {
    dir: std::path::PathBuf,
    path: String,
}

impl TempDb {
    fn new(name: &str) -> Self {
        let mut dir = std::env::temp_dir();
        // The process id keeps concurrent test binaries from sharing a path.
        dir.push(format!("companion-storage-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("create temp dir");
        let path = dir.join("memory.db");
        Self {
            dir,
            path: path.to_string_lossy().into_owned(),
        }
    }

    fn options(&self) -> OpenOptions {
        OpenOptions::at(self.path.clone())
    }
}

impl Drop for TempDb {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

// ---------------------------------------------------------------------------
// Migrations
// ---------------------------------------------------------------------------

#[test]
fn a_fresh_database_reaches_the_current_version() {
    let db = TempDb::new("fresh");
    let store = Store::open(&db.options()).expect("open");
    assert_eq!(store.opened_with().from, EMPTY_SCHEMA_VERSION);
    assert_eq!(store.opened_with().to, CURRENT_SCHEMA_VERSION);
    assert!(store.opened_with().changed());
    assert_eq!(
        schema_version(store.connection()).expect("version"),
        CURRENT_SCHEMA_VERSION
    );
}

#[test]
fn reopening_migrated_database_applies_nothing() {
    // The property that matters: a profile is opened on every process start, so
    // a migration that re-ran would corrupt data on the second boot.
    let db = TempDb::new("reopen");
    {
        let first = Store::open(&db.options()).expect("first open");
        assert!(first.opened_with().changed());
    }
    let second = Store::open(&db.options()).expect("second open");
    assert_eq!(second.opened_with().from, CURRENT_SCHEMA_VERSION);
    assert_eq!(second.opened_with().to, CURRENT_SCHEMA_VERSION);
    assert!(
        !second.opened_with().changed(),
        "a second open must be a no-op"
    );
}

#[test]
fn reopening_preserves_existing_rows() {
    // Idempotence is easy to claim and easy to get wrong in a way that silently
    // drops tables. This is the check that a re-open keeps the data.
    let db = TempDb::new("preserve");
    {
        let store = Store::open(&db.options()).expect("first open");
        store
            .put_claim(&claim("c1", "identity.name", json!("Xiaolin"), "u1"))
            .expect("write");
    }
    let store = Store::open(&db.options()).expect("second open");
    let found = store.get_claim(&scope("u1"), "c1").expect("read");
    assert!(
        found.is_some(),
        "the row written before the re-open must survive"
    );
}

#[test]
fn applying_migrations_twice_directly_is_a_no_op() {
    let db = TempDb::new("twice");
    let store = Store::open(&db.options()).expect("open");
    let again = apply_migrations(store.connection()).expect("re-apply");
    assert_eq!(again.from, CURRENT_SCHEMA_VERSION);
    assert!(!again.changed());
}

#[test]
fn an_unmigrated_database_reports_the_empty_version_and_has_no_tables() {
    let db = TempDb::new("unmigrated");
    let store = Store::open(&db.options().unmigrated()).expect("open");
    assert_eq!(
        schema_version(store.connection()).expect("version"),
        EMPTY_SCHEMA_VERSION
    );
    // Reading must fail cleanly rather than silently returning nothing.
    assert!(store.get_claim(&scope("u1"), "c1").is_err());
}

#[test]
fn a_newer_schema_is_refused_rather_than_downgraded() {
    // An older binary opening a newer database would write rows the newer schema
    // cannot represent, so it must refuse instead of proceeding.
    let db = TempDb::new("newer");
    let store = Store::open(&db.options()).expect("open");
    store
        .connection()
        .pragma_update(None, "user_version", CURRENT_SCHEMA_VERSION + 5)
        .expect("bump version");
    assert!(apply_migrations(store.connection()).is_err());
}

#[test]
fn the_migration_list_is_ordered_and_distinct() {
    let migrations = known_migrations();
    assert!(!migrations.is_empty());
    let mut previous = 0;
    for (version, about) in migrations {
        assert!(version > previous, "migration versions must increase");
        assert!(!about.is_empty(), "every migration needs a description");
        previous = version;
    }
    assert_eq!(previous, CURRENT_SCHEMA_VERSION);
}

#[test]
fn version_two_database_upgrades_without_replaying_old_schema() {
    let db = TempDb::new("upgrade-v2-to-v3");
    {
        let connection = rusqlite::Connection::open(&db.path).expect("open old database");
        connection
            .execute_batch(concat!(
                include_str!("../src/schema_v1.sql"),
                "\n",
                include_str!("../src/schema_v2.sql"),
            ))
            .expect("version two schema");
        connection
            .pragma_update(None, "user_version", 2_i32)
            .expect("mark v2");
    }

    let store = Store::open(&db.options()).expect("upgrade");
    assert_eq!(store.opened_with().from, 2);
    assert_eq!(store.opened_with().to, CURRENT_SCHEMA_VERSION);
    let pending_table: String = store
        .connection()
        .query_row(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'pending_candidates'",
            [],
            |row| row.get(0),
        )
        .expect("pending table");
    assert_eq!(pending_table, "pending_candidates");
}

#[test]
fn pending_extractions_remain_review_pointers_not_recallable_records() {
    let store = Store::open(&OpenOptions::in_memory()).expect("open");
    let relationship = scope("u1");
    store
        .put_pending_candidate(
            &relationship,
            "pending-runtime-1",
            "runtime_state",
            "message-1",
            "await extraction quality threshold",
            NOW,
        )
        .expect("pending pointer");

    assert_eq!(
        store
            .count_in_scope(&relationship, "pending_candidates")
            .expect("pending count"),
        1
    );
    assert!(
        store
            .active_claims(&relationship)
            .expect("claims")
            .is_empty(),
        "a pending extraction must not become an injectable claim"
    );
    assert_eq!(
        store
            .count_in_scope(&relationship, "source_messages")
            .expect("source count"),
        0,
        "the companion store must not duplicate the L0 transcript for a pending extraction"
    );
}

#[test]
fn worker_admission_commits_replacement_evidence_thread_and_audit_together() {
    let store = Store::open(&OpenOptions::in_memory()).expect("open");
    let relationship = scope("u1");
    let old = claim("old", "communication.verbosity", json!("brief"), "u1");
    store.put_claim(&old).expect("old claim");
    store
        .put_open_thread(
            &relationship,
            &OpenThread {
                id: "old-thread".into(),
                record_id: "old".into(),
                entity_ref: None,
                summary: "outdated follow-up".into(),
                sensitivity: "low".into(),
                mention_mode: "freely_mentionable".into(),
                status: "open".into(),
                opened_at: NOW.into(),
                expires_at: None,
                followup_session_id: None,
                updated_at: NOW.into(),
            },
        )
        .expect("old thread");
    let mut replacement = claim("new", "communication.verbosity", json!("detailed"), "u1");
    replacement.supersedes_id = Some("old".into());
    replacement.source_refs[0].source_id = "message-2".into();
    store
        .admit_claim_with_evidence(
            &replacement,
            &SourceMessage {
                id: "message-2".into(),
                session_id: "session-2".into(),
                text: "Please use detailed replies.".into(),
                created_at: NOW.into(),
            },
            &SourceSpan {
                record_id: "new".into(),
                message_id: "message-2".into(),
                start_offset: 11,
                end_offset: 19,
                quote: "detailed".into(),
            },
            Some("old"),
            Some(&OpenThread {
                id: "new-thread".into(),
                record_id: "new".into(),
                entity_ref: None,
                summary: "allowed low-risk follow-up".into(),
                sensitivity: "low".into(),
                mention_mode: "freely_mentionable".into(),
                status: "open".into(),
                opened_at: NOW.into(),
                expires_at: None,
                followup_session_id: None,
                updated_at: NOW.into(),
            }),
            NOW,
        )
        .expect("atomic admission");

    assert_eq!(
        store
            .active_claims(&relationship)
            .expect("active claims")
            .iter()
            .map(|claim| claim.id.as_str())
            .collect::<Vec<_>>(),
        vec!["new"]
    );
    assert_eq!(
        store
            .active_open_threads(&relationship, NOW)
            .expect("active threads")
            .iter()
            .map(|thread| thread.id.as_str())
            .collect::<Vec<_>>(),
        vec!["new-thread"]
    );
    assert_eq!(
        store
            .count_in_scope(&relationship, "source_messages")
            .expect("source count"),
        1
    );
    assert_eq!(store.audit_count(&relationship).expect("audit count"), 1);
}

#[test]
fn two_records_from_one_message_keep_both_source_spans() {
    let store = Store::open(&OpenOptions::in_memory()).expect("open");
    let relationship = scope("u1");
    let source = SourceMessage {
        id: "message-many".into(),
        session_id: "session-1".into(),
        text: "My name is Xiaolin and I prefer Chinese.".into(),
        created_at: NOW.into(),
    };
    let name = claim("name", "identity.name", json!("Xiaolin"), "u1");
    let language = claim("language", "communication.language", json!("Chinese"), "u1");
    store
        .admit_claim_with_evidence(
            &name,
            &source,
            &SourceSpan {
                record_id: "name".into(),
                message_id: source.id.clone(),
                start_offset: 11,
                end_offset: 18,
                quote: "Xiaolin".into(),
            },
            None,
            None,
            NOW,
        )
        .expect("first record");
    store
        .admit_claim_with_evidence(
            &language,
            &source,
            &SourceSpan {
                record_id: "language".into(),
                message_id: source.id.clone(),
                start_offset: 32,
                end_offset: 39,
                quote: "Chinese".into(),
            },
            None,
            None,
            NOW,
        )
        .expect("second record");

    assert_eq!(
        store
            .count_in_scope(&relationship, "source_messages")
            .expect("one source"),
        1
    );
    assert_eq!(
        store
            .count_in_scope(&relationship, "source_spans")
            .expect("both spans"),
        2
    );
}

#[test]
fn forgetting_claim_removes_recoverable_evidence_and_keeps_a_suppression_fingerprint() {
    let db = TempDb::new("forget-evidence");
    let store = Store::open(&db.options()).expect("open");
    let relationship = scope("u1");
    let mut accepted = claim("c1", "identity.name", json!("Xiaolin"), "u1");
    accepted.source_refs[0].source_id = "message-1".into();
    store.put_claim(&accepted).expect("claim");
    store
        .put_source_message(
            &relationship,
            &SourceMessage {
                id: "message-1".into(),
                session_id: "session-1".into(),
                text: "My name is Xiaolin.".into(),
                created_at: NOW.into(),
            },
        )
        .expect("source message");
    store
        .put_source_span(
            &relationship,
            &SourceSpan {
                record_id: "c1".into(),
                message_id: "message-1".into(),
                start_offset: 11,
                end_offset: 18,
                quote: "Xiaolin".into(),
            },
        )
        .expect("source span");
    store
        .put_open_thread(
            &relationship,
            &OpenThread {
                id: "thread-1".into(),
                record_id: "c1".into(),
                entity_ref: None,
                summary: "Ask how the name preference feels.".into(),
                sensitivity: "low".into(),
                mention_mode: "freely_mentionable".into(),
                status: "open".into(),
                opened_at: NOW.into(),
                expires_at: None,
                followup_session_id: None,
                updated_at: NOW.into(),
            },
        )
        .expect("thread");

    assert!(store
        .forget_claim(&relationship, "c1", NOW)
        .expect("forget"));
    assert!(store
        .get_claim(&relationship, "c1")
        .expect("claim read")
        .is_none());
    assert_eq!(
        store
            .count_in_scope(&relationship, "source_messages")
            .expect("sources"),
        0
    );
    assert_eq!(
        store
            .count_in_scope(&relationship, "source_spans")
            .expect("spans"),
        0
    );
    assert_eq!(
        store
            .count_in_scope(&relationship, "open_threads")
            .expect("threads"),
        0
    );
    assert!(
        !store
            .load_suppressed_fingerprints(&relationship)
            .expect("fingerprints")
            .is_empty(),
        "a non-reversible suppression fingerprint prevents the same claim returning",
    );
}

#[test]
fn forgetting_episode_removes_its_evidence_and_keeps_a_suppression_fingerprint() {
    let store = Store::open(&OpenOptions::in_memory()).expect("open");
    let relationship = scope("u1");
    let accepted = episode("episode-forget", "u1");
    let source = SourceMessage {
        id: "episode-message".into(),
        session_id: "session-1".into(),
        text: "My dog was sick and we went to the vet.".into(),
        created_at: NOW.into(),
    };
    store
        .admit_episode_with_evidence(
            &accepted,
            &source,
            &SourceSpan {
                record_id: accepted.id.clone(),
                message_id: source.id.clone(),
                start_offset: 3,
                end_offset: 19,
                quote: "dog was sick".into(),
            },
            NOW,
        )
        .expect("admit episode");

    assert!(store
        .forget_episode(&relationship, &accepted.id, NOW)
        .expect("forget"));
    assert!(store
        .get_episode(&relationship, &accepted.id)
        .expect("episode read")
        .is_none());
    assert_eq!(
        store
            .count_in_scope(&relationship, "source_messages")
            .expect("sources"),
        0
    );
    assert_eq!(
        store
            .count_in_scope(&relationship, "source_spans")
            .expect("spans"),
        0
    );
    assert!(
        !store
            .load_suppressed_fingerprints(&relationship)
            .expect("fingerprints")
            .is_empty(),
        "the episode remains blocked without retaining recoverable text",
    );
}

// ---------------------------------------------------------------------------
// Scope isolation
// ---------------------------------------------------------------------------

#[test]
fn a_claim_is_invisible_to_another_user() {
    let store = Store::open(&OpenOptions::in_memory()).expect("open");
    store
        .put_claim(&claim("c1", "identity.name", json!("Xiaolin"), "u1"))
        .expect("write");

    assert!(store.get_claim(&scope("u1"), "c1").expect("read").is_some());
    assert!(
        store.get_claim(&scope("u2"), "c1").expect("read").is_none(),
        "one user's claim must not be readable by another"
    );
    assert!(store.active_claims(&scope("u2")).expect("list").is_empty());
}

#[test]
fn a_same_id_in_another_scope_is_rejected_without_overwriting_the_owner() {
    let store = Store::open(&OpenOptions::in_memory()).expect("open");
    store
        .put_claim(&claim("shared-id", "identity.name", json!("A"), "u1"))
        .expect("first write");
    assert!(store
        .put_claim(&claim("shared-id", "identity.name", json!("B"), "u2"))
        .is_err());

    assert_eq!(
        store
            .get_claim(&scope("u1"), "shared-id")
            .expect("owner read")
            .expect("owner record")
            .value,
        json!("A")
    );
    assert!(store
        .get_claim(&scope("u2"), "shared-id")
        .expect("other read")
        .is_none());
}

#[test]
fn a_different_profile_is_a_different_scope() {
    // The same user with two companions must not share memory unless the product
    // decides they do, so profile is part of the key.
    let store = Store::open(&OpenOptions::in_memory()).expect("open");
    store
        .put_claim(&claim("c1", "identity.name", json!("Xiaolin"), "u1"))
        .expect("write");

    let other_profile = RelationshipScope {
        service_id: "svc".into(),
        owner_user_id: "u1".into(),
        companion_profile_id: "other".into(),
    };
    assert!(store
        .get_claim(&other_profile, "c1")
        .expect("read")
        .is_none());
}

#[test]
fn a_different_service_is_a_different_scope() {
    let store = Store::open(&OpenOptions::in_memory()).expect("open");
    store
        .put_claim(&claim("c1", "identity.name", json!("Xiaolin"), "u1"))
        .expect("write");

    let other_service = RelationshipScope {
        service_id: "other-svc".into(),
        owner_user_id: "u1".into(),
        companion_profile_id: "profile".into(),
    };
    assert!(store
        .get_claim(&other_service, "c1")
        .expect("read")
        .is_none());
}

#[test]
fn listing_is_confined_to_the_scope() {
    let store = Store::open(&OpenOptions::in_memory()).expect("open");
    store
        .put_claim(&claim("a", "identity.name", json!("A"), "u1"))
        .expect("write");
    store
        .put_claim(&claim("b", "identity.name", json!("B"), "u2"))
        .expect("write");
    store.put_episode(&episode("e1", "u1")).expect("write");
    store.put_inference(&inference("i1", "u2")).expect("write");

    assert_eq!(store.active_claims(&scope("u1")).expect("list").len(), 1);
    assert_eq!(store.active_claims(&scope("u2")).expect("list").len(), 1);
    assert_eq!(store.active_episodes(&scope("u1")).expect("list").len(), 1);
    assert_eq!(store.active_episodes(&scope("u2")).expect("list").len(), 0);
    assert_eq!(store.inferences(&scope("u1")).expect("list").len(), 0);
    assert_eq!(store.inferences(&scope("u2")).expect("list").len(), 1);
}

#[test]
fn suppression_does_not_cross_scopes() {
    let store = Store::open(&OpenOptions::in_memory()).expect("open");
    store
        .suppress(
            &scope("u1"),
            "predicate",
            "identity.location",
            None,
            None,
            NOW,
        )
        .expect("suppress");

    assert_eq!(
        store.suppression_entries(&scope("u1")).expect("read").len(),
        1
    );
    assert!(
        store
            .suppression_entries(&scope("u2"))
            .expect("read")
            .is_empty(),
        "one user forgetting something must not affect another"
    );
}

// ---------------------------------------------------------------------------
// Round trips
// ---------------------------------------------------------------------------

#[test]
fn a_claim_survives_a_round_trip_intact() {
    let store = Store::open(&OpenOptions::in_memory()).expect("open");
    let original = Claim {
        qualifiers: Some(json!({ "use": "work" })),
        raw_value: Some("I design, and I teach painting on weekends".into()),
        ..claim("c1", "identity.occupation", json!("designer"), "u1")
    };
    store.put_claim(&original).expect("write");

    let read = store
        .get_claim(&scope("u1"), "c1")
        .expect("read")
        .expect("present");
    assert_eq!(read, original);
}

#[test]
fn an_episode_survives_a_round_trip_intact() {
    let store = Store::open(&OpenOptions::in_memory()).expect("open");
    let original = episode("e1", "u1");
    store.put_episode(&original).expect("write");

    let read = store
        .get_episode(&scope("u1"), "e1")
        .expect("read")
        .expect("present");
    assert_eq!(read, original);
}

#[test]
fn an_inference_survives_a_round_trip_intact() {
    let store = Store::open(&OpenOptions::in_memory()).expect("open");
    let original = inference("i1", "u1");
    store.put_inference(&original).expect("write");

    let read = store
        .get_inference(&scope("u1"), "i1")
        .expect("read")
        .expect("present");
    assert_eq!(read, original);
}

#[test]
fn writing_the_same_id_twice_replaces_rather_than_duplicates() {
    let store = Store::open(&OpenOptions::in_memory()).expect("open");
    store
        .put_claim(&claim("c1", "identity.name", json!("First"), "u1"))
        .expect("write");
    store
        .put_claim(&claim("c1", "identity.name", json!("Second"), "u1"))
        .expect("write");

    let all = store.active_claims(&scope("u1")).expect("list");
    assert_eq!(all.len(), 1);
    assert_eq!(all[0].value, json!("Second"));
}

// ---------------------------------------------------------------------------
// Slot queries and status transitions
// ---------------------------------------------------------------------------

#[test]
fn a_slot_query_returns_only_the_matching_entity() {
    let store = Store::open(&OpenOptions::in_memory()).expect("open");
    let mut shanghai = claim("c1", "identity.location", json!("shanghai"), "u1");
    shanghai.entity_ref = Some("shanghai".into());
    let mut wuhan = claim("c2", "identity.location", json!("wuhan"), "u1");
    wuhan.entity_ref = Some("wuhan".into());
    store.put_claim(&shanghai).expect("write");
    store.put_claim(&wuhan).expect("write");

    let slot = store
        .active_claims_in_slot(&scope("u1"), "identity.location", Some("shanghai"))
        .expect("slot");
    assert_eq!(slot.len(), 1);
    assert_eq!(slot[0].id, "c1");
}

#[test]
fn a_slot_query_distinguishes_no_entity_from_a_named_one() {
    let store = Store::open(&OpenOptions::in_memory()).expect("open");
    store
        .put_claim(&claim("c1", "identity.name", json!("Xiaolin"), "u1"))
        .expect("write");
    let mut tagged = claim("c2", "identity.name", json!("Other"), "u1");
    tagged.entity_ref = Some("someone".into());
    store.put_claim(&tagged).expect("write");

    let unnamed = store
        .active_claims_in_slot(&scope("u1"), "identity.name", None)
        .expect("slot");
    assert_eq!(unnamed.len(), 1);
    assert_eq!(unnamed[0].id, "c1");
}

#[test]
fn a_slot_query_excludes_non_active_records() {
    // decide_supersede must only ever see active records, or a superseded value
    // would be treated as a competitor and could be replaced twice.
    let store = Store::open(&OpenOptions::in_memory()).expect("open");
    store
        .put_claim(&claim("c1", "identity.name", json!("Old"), "u1"))
        .expect("write");
    store
        .set_claim_status(&scope("u1"), "c1", ClaimStatus::Superseded, NOW)
        .expect("supersede");

    assert!(store
        .active_claims_in_slot(&scope("u1"), "identity.name", None)
        .expect("slot")
        .is_empty());
    assert!(store.active_claims(&scope("u1")).expect("list").is_empty());
    // Still readable by id, so history is not lost.
    assert!(store.get_claim(&scope("u1"), "c1").expect("read").is_some());
}

#[test]
fn a_status_change_does_not_cross_scopes() {
    let store = Store::open(&OpenOptions::in_memory()).expect("open");
    store
        .put_claim(&claim("c1", "identity.name", json!("X"), "u1"))
        .expect("write");

    let changed = store
        .set_claim_status(&scope("u2"), "c1", ClaimStatus::Revoked, NOW)
        .expect("update");
    assert_eq!(
        changed, 0,
        "another scope must not be able to change the row"
    );
    assert_eq!(
        store
            .get_claim(&scope("u1"), "c1")
            .expect("read")
            .expect("present")
            .status,
        ClaimStatus::Active
    );
}

// ---------------------------------------------------------------------------
// Suppression and audit
// ---------------------------------------------------------------------------

#[test]
fn a_suppressed_fingerprint_is_retrievable_for_the_resurrection_guard() {
    // would_resurrect needs this map; if the write path cannot read it back the
    // guard silently never fires.
    let store = Store::open(&OpenOptions::in_memory()).expect("open");
    store
        .suppress(
            &scope("u1"),
            "record",
            "c1",
            Some("the dog was sick that night"),
            Some("the dog"),
            NOW,
        )
        .expect("suppress");

    let fingerprints = store.suppressed_fingerprints(&scope("u1")).expect("read");
    assert_eq!(fingerprints.len(), 1);
    assert_eq!(fingerprints[0].0, "the dog was sick that night");
    assert_eq!(fingerprints[0].1, "the dog");
}

#[test]
fn suppressing_the_same_target_twice_does_not_duplicate() {
    let store = Store::open(&OpenOptions::in_memory()).expect("open");
    for _ in 0..3 {
        store
            .suppress(&scope("u1"), "entity", "person-1", None, None, NOW)
            .expect("suppress");
    }
    assert_eq!(
        store.suppression_entries(&scope("u1")).expect("read").len(),
        1
    );
}

#[test]
fn audit_entries_are_scope_confined_and_repeatable() {
    let store = Store::open(&OpenOptions::in_memory()).expect("open");
    store
        .audit(&scope("u1"), "create", Some("c1"), None, NOW)
        .expect("audit");
    // The same action at the same instant must not duplicate, so the kernel's
    // determinism survives the storage layer.
    store
        .audit(&scope("u1"), "create", Some("c1"), None, NOW)
        .expect("audit again");
    assert_eq!(store.audit_count(&scope("u1")).expect("count"), 1);
    assert_eq!(store.audit_count(&scope("u2")).expect("count"), 0);
}

#[test]
fn counting_an_unknown_table_is_refused() {
    let store = Store::open(&OpenOptions::in_memory()).expect("open");
    assert!(store.count_in_scope(&scope("u1"), "claims").is_ok());
    assert!(store.count_in_scope(&scope("u1"), "sqlite_master").is_err());
    assert!(store
        .count_in_scope(&scope("u1"), "claims; DROP TABLE claims")
        .is_err());
}
