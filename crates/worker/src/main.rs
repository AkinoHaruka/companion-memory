//! Persistent JSONL bridge for the companion-memory Rust authority.
//!
//! Standard output is reserved for one protocol response per request.  Human
//! diagnostics go to standard error so a damaged caller line never desynchronises
//! later requests.

use std::io::{self, BufRead, Write};

use companion_memory_kernel::domain::predicate_keys::all_predicate_keys;
use companion_memory_kernel::domain::predicates::{spec_for, MentionMode, Sensitivity, ValueKind};
use companion_memory_kernel::domain::types::{
    Claim, ClaimStatus, Episode, EpisodeStatus, EvidenceRef, EvidenceSourceType, Provenance,
    RelationshipScope, Salience, SemanticRole, Speaker,
};
use companion_memory_kernel::rules::forgetting::would_resurrect;
use companion_memory_kernel::rules::mention_gate::{
    claim_mention, is_constraint, MentionCues, MentionDecision, SurfaceLevel,
};
use companion_memory_kernel::rules::record_identity::{
    decide_supersede, SupersedeDecision, SupersedeInput,
};
use companion_memory_storage::{OpenOptions, OpenThread, SourceMessage, SourceSpan, Store};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::{json, Value};

const PROTOCOL_VERSION: u32 = 1;
const MAX_LINE_BYTES: usize = 1_048_576;

#[derive(Debug, Deserialize)]
struct Request {
    version: u32,
    id: String,
    op: String,
    #[serde(default)]
    params: Value,
}

#[derive(Serialize)]
struct Response {
    version: u32,
    id: String,
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<Failure>,
}

#[derive(Debug, Serialize)]
struct Failure {
    code: &'static str,
    retryable: bool,
    summary: String,
}

impl Failure {
    fn invalid(summary: impl Into<String>) -> Self {
        Self {
            code: "INVALID_REQUEST",
            retryable: false,
            summary: summary.into(),
        }
    }

    fn unsupported(summary: impl Into<String>) -> Self {
        Self {
            code: "UNSUPPORTED_OPERATION",
            retryable: false,
            summary: summary.into(),
        }
    }

    fn storage(summary: impl Into<String>) -> Self {
        Self {
            code: "STORAGE_ERROR",
            retryable: true,
            summary: summary.into(),
        }
    }
}

#[derive(Debug, Deserialize)]
struct WarmInput {
    scope: RelationshipScope,
    current_message: String,
    now: String,
    #[serde(default)]
    session_id: String,
    #[serde(default)]
    new_session: bool,
    #[serde(default)]
    turn_key: String,
    #[serde(default)]
    force_record_ids: Vec<String>,
}

#[derive(Debug, Deserialize)]
struct SourceInput {
    id: String,
    session_id: String,
    text: String,
}

#[derive(Debug, Deserialize)]
struct ThreadInput {
    id: String,
    summary: String,
    #[serde(default)]
    entity_ref: Option<String>,
    #[serde(default)]
    expires_at: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ClaimCandidate {
    id: String,
    predicate: String,
    value: Value,
    #[serde(default)]
    raw_value: Option<String>,
    #[serde(default)]
    entity_ref: Option<String>,
    #[serde(default)]
    qualifiers: Option<Value>,
    start_offset: i64,
    end_offset: i64,
    quote: String,
    #[serde(default)]
    confidence: f64,
    #[serde(default)]
    open_thread: Option<ThreadInput>,
}

/// A directly user-described experience. It is distinct from an inferred
/// pattern and may be recalled only when the current topic activates it.
#[derive(Debug, Deserialize)]
struct EpisodeCandidate {
    id: String,
    narrative: String,
    start_offset: i64,
    end_offset: i64,
    quote: String,
    #[serde(default)]
    confidence: f64,
}

/// Runtime state and inferred relationships are review pointers until
/// extraction-quality gates authorise promotion. They are never selected by
/// `warm`.
#[derive(Debug, Deserialize)]
struct PendingCandidate {
    id: String,
    kind: String,
    reason: String,
}

#[derive(Debug, Deserialize)]
struct AdmitInput {
    scope: RelationshipScope,
    now: String,
    source: SourceInput,
    #[serde(default)]
    candidates: Vec<ClaimCandidate>,
    #[serde(default)]
    episodes: Vec<EpisodeCandidate>,
    #[serde(default)]
    pending: Vec<PendingCandidate>,
}

#[derive(Debug, Deserialize)]
struct QueryInput {
    scope: RelationshipScope,
    action: String,
    #[serde(default)]
    terms: String,
    #[serde(default)]
    record_id: String,
    now: String,
}

#[derive(Debug, Deserialize)]
struct SessionClosedInput {
    scope: RelationshipScope,
    session_id: String,
    now: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PlanEntry {
    record_id: String,
    text: String,
    surface: String,
    reason: String,
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct MemoryUsagePlan {
    constraints: Vec<PlanEntry>,
    response_style: Vec<PlanEntry>,
    continuity: Vec<PlanEntry>,
    topic_activated: Vec<PlanEntry>,
    deep_recall: Vec<PlanEntry>,
    do_not_surface: Vec<PlanEntry>,
}

fn main() {
    let database_path = match database_path() {
        Ok(path) => path,
        Err(message) => {
            eprintln!("companion-memory-worker: {message}");
            std::process::exit(2);
        }
    };
    let store = match Store::open(&OpenOptions::at(database_path)) {
        Ok(store) => store,
        Err(error) => {
            eprintln!("companion-memory-worker: failed to open database: {error}");
            std::process::exit(2);
        }
    };

    let stdin = io::stdin();
    let mut stdout = io::BufWriter::new(io::stdout().lock());
    for line in stdin.lock().lines() {
        let line = match line {
            Ok(line) => line,
            Err(error) => {
                eprintln!("companion-memory-worker: stdin read failed: {error}");
                break;
            }
        };
        let response = handle_line(&store, &line);
        let serialized = serde_json::to_string(&response).expect("response is serializable");
        if writeln!(stdout, "{serialized}")
            .and_then(|_| stdout.flush())
            .is_err()
        {
            break;
        }
    }
}

fn database_path() -> Result<String, String> {
    let mut args = std::env::args().skip(1);
    match (args.next().as_deref(), args.next()) {
        (Some("--database"), Some(path)) if !path.trim().is_empty() && args.next().is_none() => {
            Ok(path)
        }
        _ => Err("expected exactly: --database <path>".into()),
    }
}

fn handle_line(store: &Store, line: &str) -> Response {
    if line.len() > MAX_LINE_BYTES {
        return failure_response("", Failure::invalid("request exceeds the JSONL size limit"));
    }
    let request: Request = match serde_json::from_str(line) {
        Ok(request) => request,
        Err(_) => return failure_response("", Failure::invalid("request is not valid JSON")),
    };
    if request.version != PROTOCOL_VERSION {
        return failure_response(
            &request.id,
            Failure::invalid("unsupported protocol version"),
        );
    }
    let result = match request.op.as_str() {
        "health" => Ok(json!({
            "protocolVersion": PROTOCOL_VERSION,
            "schemaVersion": store.opened_with().to,
            "predicateKeys": all_predicate_keys(),
            "predicateSchemas": predicate_schemas(),
        })),
        "warm" => parse(request.params).and_then(|input| warm(store, input)),
        "admit" => parse(request.params).and_then(|input| admit(store, input)),
        "query" => parse(request.params).and_then(|input| query(store, input)),
        "forget" => parse(request.params).and_then(|input| forget(store, input)),
        "session_closed" => parse(request.params).and_then(|input| session_closed(store, input)),
        _ => Err(Failure::unsupported("operation is not supported")),
    };
    match result {
        Ok(value) => Response {
            version: PROTOCOL_VERSION,
            id: request.id,
            ok: true,
            result: Some(value),
            error: None,
        },
        Err(error) => failure_response(&request.id, error),
    }
}

/// Registry metadata for an extractor. It is descriptive only: Rust still
/// validates every candidate, so the TypeScript caller cannot become a second
/// source of admission or cardinality policy.
fn predicate_schemas() -> Vec<Value> {
    all_predicate_keys()
        .into_iter()
        .filter_map(|key| {
            spec_for(key).map(|spec| {
                json!({
                    "key": spec.key,
                    "valueKind": value_kind_name(spec.kind),
                    "enumValues": spec.enum_domain.unwrap_or(&[]),
                })
            })
        })
        .collect()
}

fn value_kind_name(kind: ValueKind) -> &'static str {
    match kind {
        ValueKind::Text => "text",
        ValueKind::Enum => "enum",
        ValueKind::Date => "date",
        ValueKind::Duration => "duration",
        ValueKind::Number => "number",
        ValueKind::EntityRef => "entity_ref",
    }
}

fn failure_response(id: &str, error: Failure) -> Response {
    Response {
        version: PROTOCOL_VERSION,
        id: id.to_string(),
        ok: false,
        result: None,
        error: Some(error),
    }
}

fn parse<T: DeserializeOwned>(value: Value) -> Result<T, Failure> {
    serde_json::from_value(value)
        .map_err(|_| Failure::invalid("request parameters do not match this operation"))
}

fn warm(store: &Store, input: WarmInput) -> Result<Value, Failure> {
    let claims = store.active_claims(&input.scope).map_err(storage_failure)?;
    let episodes = store
        .active_episodes(&input.scope)
        .map_err(storage_failure)?;
    let mut plan = MemoryUsagePlan::default();
    let force = input.force_record_ids;

    for claim in &claims {
        let text = claim_text(claim);
        let referenced = cue_matches(&input.current_message, claim);
        let forced = force.iter().any(|id| id == &claim.id);
        let decision = claim_mention(
            claim,
            MentionCues {
                user_referenced: referenced || forced,
                topic_implies: referenced || forced,
                ..MentionCues::default()
            },
        );
        let entry = PlanEntry {
            record_id: claim.id.clone(),
            text,
            surface: surface_name(&decision).into(),
            reason: decision_reason(&decision, referenced || forced).into(),
        };

        if is_constraint(Some(&claim.predicate)) {
            // A boundary is model-visible as an instruction to respect, not a
            // conversational fact to recite. Its mention policy governs what
            // the companion says aloud; it must not hide the constraint from
            // the response planner itself.
            plan.constraints.push(PlanEntry {
                surface: "background_only".into(),
                reason: "constraint_policy".into(),
                ..entry
            });
        } else if is_policy_claim(&claim.predicate) {
            if !matches!(
                decision,
                MentionDecision::Denied {
                    level: SurfaceLevel::NeverSurface,
                    ..
                }
            ) {
                plan.response_style.push(entry);
            } else {
                plan.do_not_surface.push(entry);
            }
        } else {
            match decision {
                MentionDecision::Allowed { .. } if referenced || forced => {
                    plan.topic_activated.push(entry)
                }
                MentionDecision::Allowed { .. } if claim.salience.importance >= 0.8 => {
                    plan.deep_recall.push(entry)
                }
                MentionDecision::Denied { .. } => plan.do_not_surface.push(entry),
                MentionDecision::Allowed { .. } => {}
            }
        }
    }

    for episode in &episodes {
        let referenced = cue_matches_episode(&input.current_message, episode);
        let forced = force.iter().any(|id| id == &episode.id);
        if referenced || forced {
            plan.topic_activated.push(PlanEntry {
                record_id: episode.id.clone(),
                text: episode.narrative.clone(),
                surface: "mention_if_user_cues".into(),
                reason: if forced {
                    "forced_oracle_injection"
                } else {
                    "episode_topic_activated"
                }
                .into(),
            });
        }
    }

    if input.new_session && is_greeting(&input.current_message) && !input.session_id.is_empty() {
        let threads = store
            .active_open_threads(&input.scope, &input.now)
            .map_err(storage_failure)?;
        if let Some(thread) = threads.into_iter().find(|thread| {
            thread.sensitivity == "low"
                && matches!(
                    thread.mention_mode.as_str(),
                    "freely_mentionable" | "mention_if_user_cues"
                )
                && thread.followup_session_id.as_deref() != Some(input.session_id.as_str())
        }) {
            plan.continuity.push(PlanEntry {
                record_id: thread.record_id.clone(),
                text: thread.summary.clone(),
                surface: thread.mention_mode.clone(),
                reason: "one_session_greeting_followup".into(),
            });
            store
                .update_open_thread(
                    &input.scope,
                    &thread.id,
                    "open",
                    Some(&input.session_id),
                    &input.now,
                )
                .map_err(storage_failure)?;
        }
    }

    let revision = (claims.len() + episodes.len()) as i64;
    let turn_key = if input.turn_key.is_empty() {
        input.now.clone()
    } else {
        input.turn_key
    };
    let detail = serde_json::to_string(&plan).expect("plan is serializable");
    store
        .telemetry(
            &input.scope,
            &format!("warm-{turn_key}"),
            &turn_key,
            "injected",
            &detail,
            &input.now,
        )
        .map_err(storage_failure)?;
    Ok(json!({ "revision": revision, "plan": plan }))
}

fn admit(store: &Store, input: AdmitInput) -> Result<Value, Failure> {
    let mut accepted = Vec::new();
    let mut rejected = Vec::new();
    for candidate in &input.candidates {
        match admit_candidate(store, &input, candidate) {
            Ok(Some(id)) => accepted.push(id),
            Ok(None) => rejected.push(json!({ "candidateId": candidate.id, "reason": "merged" })),
            Err(reason) => rejected.push(json!({ "candidateId": candidate.id, "reason": reason })),
        }
    }
    for episode in &input.episodes {
        match admit_episode(store, &input, episode) {
            Ok(id) => accepted.push(id),
            Err(reason) => rejected.push(json!({ "candidateId": episode.id, "reason": reason })),
        }
    }
    let mut pending_count = 0;
    for pending in &input.pending {
        if pending.id.trim().is_empty()
            || !matches!(pending.kind.as_str(), "runtime_state" | "inference")
        {
            rejected.push(json!({
                "candidateId": pending.id,
                "reason": "unsupported pending candidate"
            }));
            continue;
        }
        store
            .put_pending_candidate(
                &input.scope,
                &pending.id,
                &pending.kind,
                &input.source.id,
                &pending.reason,
                &input.now,
            )
            .map_err(storage_failure)?;
        pending_count += 1;
    }
    let result = json!({ "accepted": accepted, "rejected": rejected, "pending": pending_count });
    store
        .telemetry(
            &input.scope,
            &format!("admit-{}", input.source.id),
            &input.source.id,
            "admission",
            &serde_json::to_string(&result).expect("admission result is serializable"),
            &input.now,
        )
        .map_err(storage_failure)?;
    Ok(result)
}

fn admit_candidate(
    store: &Store,
    input: &AdmitInput,
    candidate: &ClaimCandidate,
) -> Result<Option<String>, String> {
    if candidate.id.trim().is_empty() || candidate.predicate.trim().is_empty() {
        return Err("candidate identifier and predicate are required".into());
    }
    let Some(spec) = spec_for(&candidate.predicate) else {
        return Err("unknown predicate".into());
    };
    if !valid_span(&input.source.text, candidate) {
        return Err("source span does not match retained user text".into());
    }
    let suppression = store
        .load_suppression_set(&input.scope)
        .map_err(|_| "unable to load suppression".to_string())?;
    let fingerprints = store
        .load_suppressed_fingerprints(&input.scope)
        .map_err(|_| "unable to load suppression".to_string())?;
    if would_resurrect(
        &candidate.predicate,
        &candidate.value,
        candidate.entity_ref.as_deref(),
        &suppression,
        &fingerprints,
    )
    .is_some()
    {
        return Err("candidate would resurrect forgotten content".into());
    }
    let active = store
        .active_claims_in_slot(
            &input.scope,
            &candidate.predicate,
            candidate.entity_ref.as_deref(),
        )
        .map_err(|_| "unable to read claim slot".to_string())?;
    let references: Vec<&Claim> = active.iter().collect();
    let decision = decide_supersede(
        &SupersedeInput {
            predicate: &candidate.predicate,
            value: &candidate.value,
            entity_ref: candidate.entity_ref.as_deref(),
            qualifiers: candidate.qualifiers.as_ref(),
        },
        &references,
    );
    let (supersedes_id, is_merge) = match decision {
        SupersedeDecision::Create { .. } | SupersedeDecision::Append { .. } => (None, false),
        SupersedeDecision::Supersede { supersedes_id, .. } => (Some(supersedes_id), false),
        SupersedeDecision::Merge { .. } => (None, true),
        SupersedeDecision::Reject { detail, .. } => return Err(detail),
    };
    if is_merge {
        store
            .audit(
                &input.scope,
                "admission_merged",
                Some(&candidate.id),
                None,
                &input.now,
            )
            .map_err(|_| "unable to audit merge".to_string())?;
        return Ok(None);
    }
    let record_id = format!("claim-{}", candidate.id);
    let confidence = candidate.confidence.clamp(0.0, 1.0);
    let claim = Claim {
        id: record_id.clone(),
        scope: input.scope.clone(),
        predicate: candidate.predicate.clone(),
        entity_ref: candidate.entity_ref.clone(),
        qualifiers: candidate.qualifiers.clone(),
        value: candidate.value.clone(),
        raw_value: candidate.raw_value.clone(),
        valid_from: input.now.clone(),
        valid_until: None,
        status: ClaimStatus::Active,
        supersedes_id: supersedes_id.clone(),
        source_refs: vec![EvidenceRef {
            source_type: EvidenceSourceType::Message,
            source_id: input.source.id.clone(),
            speaker: Speaker::User,
            semantic_role: Some(SemanticRole::UserAssertion),
        }],
        provenance: Provenance {
            agent_id: None,
            prompt_family: Some("companion-extraction".into()),
            prompt_version: Some("v1".into()),
            model: None,
            confidence,
            created_at: input.now.clone(),
        },
        salience: Salience {
            importance: confidence.max(0.5),
            ..Salience::default()
        },
        created_at: input.now.clone(),
        updated_at: input.now.clone(),
    };
    let open_thread = candidate.open_thread.as_ref().and_then(|thread| {
        // The extractor may propose a thread, but only an explicit open-loop
        // predicate can create one. This keeps an inferred mood or a resolved
        // episode from becoming a surprise follow-up in a later session.
        if candidate.predicate.starts_with("open_loop.")
            && spec.sensitivity == Sensitivity::Low
            && spec.mention_policy >= MentionMode::MentionIfUserCues
        {
            Some(OpenThread {
                id: thread.id.clone(),
                record_id: record_id.clone(),
                entity_ref: thread.entity_ref.clone(),
                summary: thread.summary.clone(),
                sensitivity: "low".into(),
                mention_mode: mention_mode_name(spec.mention_policy).into(),
                status: "open".into(),
                opened_at: input.now.clone(),
                expires_at: thread.expires_at.clone(),
                followup_session_id: None,
                updated_at: input.now.clone(),
            })
        } else {
            None
        }
    });
    store
        .admit_claim_with_evidence(
            &claim,
            &SourceMessage {
                id: input.source.id.clone(),
                session_id: input.source.session_id.clone(),
                text: input.source.text.clone(),
                created_at: input.now.clone(),
            },
            &SourceSpan {
                record_id: record_id.clone(),
                message_id: input.source.id.clone(),
                start_offset: candidate.start_offset,
                end_offset: candidate.end_offset,
                quote: candidate.quote.clone(),
            },
            supersedes_id.as_deref(),
            open_thread.as_ref(),
            &input.now,
        )
        .map_err(|_| "unable to persist admission".to_string())?;
    Ok(Some(record_id))
}

fn admit_episode(
    store: &Store,
    input: &AdmitInput,
    candidate: &EpisodeCandidate,
) -> Result<String, String> {
    if candidate.id.trim().is_empty() || candidate.narrative.trim().is_empty() {
        return Err("episode identifier and narrative are required".into());
    }
    if !valid_episode_span(&input.source.text, candidate) {
        return Err("source span does not match retained user text".into());
    }
    let fingerprint =
        companion_memory_kernel::rules::forgetting::fingerprint_text(&candidate.narrative);
    if store
        .load_suppressed_fingerprints(&input.scope)
        .map_err(|_| "unable to load suppression".to_string())?
        .contains_key(&fingerprint)
    {
        return Err("episode would resurrect forgotten content".into());
    }
    let record_id = format!("episode-{}", candidate.id);
    let confidence = candidate.confidence.clamp(0.0, 1.0);
    let episode = Episode {
        id: record_id.clone(),
        scope: input.scope.clone(),
        occurred_from: input.now.clone(),
        occurred_to: None,
        narrative: candidate.narrative.clone(),
        participants: Vec::new(),
        emotional_arc: None,
        user_reaction: None,
        response_ref: None,
        source_refs: vec![EvidenceRef {
            source_type: EvidenceSourceType::Message,
            source_id: input.source.id.clone(),
            speaker: Speaker::User,
            semantic_role: Some(SemanticRole::UserAssertion),
        }],
        status: EpisodeStatus::Active,
        salience: Salience {
            importance: confidence.max(0.5),
            ..Salience::default()
        },
        created_at: input.now.clone(),
        updated_at: input.now.clone(),
    };
    store
        .admit_episode_with_evidence(
            &episode,
            &SourceMessage {
                id: input.source.id.clone(),
                session_id: input.source.session_id.clone(),
                text: input.source.text.clone(),
                created_at: input.now.clone(),
            },
            &SourceSpan {
                record_id: record_id.clone(),
                message_id: input.source.id.clone(),
                start_offset: candidate.start_offset,
                end_offset: candidate.end_offset,
                quote: candidate.quote.clone(),
            },
            &input.now,
        )
        .map_err(|_| "unable to persist episode".to_string())?;
    Ok(record_id)
}

fn query(store: &Store, input: QueryInput) -> Result<Value, Failure> {
    if input.action != "search" {
        return Err(Failure::invalid("query action must be search"));
    }
    let claims = store.active_claims(&input.scope).map_err(storage_failure)?;
    let mut results: Vec<_> = claims
        .iter()
        .filter(|claim| cue_matches(&input.terms, claim))
        .filter_map(|claim| {
            match claim_mention(
                claim,
                MentionCues {
                    user_referenced: true,
                    topic_implies: true,
                    ..MentionCues::default()
                },
            ) {
                MentionDecision::Allowed {
                    level: SurfaceLevel::NeverSurface,
                    ..
                }
                | MentionDecision::Denied { .. } => None,
                MentionDecision::Allowed { .. } => {
                    Some(json!({ "id": claim.id, "text": claim_text(claim) }))
                }
            }
        })
        .collect();
    results.extend(
        store
            .active_episodes(&input.scope)
            .map_err(storage_failure)?
            .into_iter()
            .filter(|episode| cue_matches_episode(&input.terms, episode))
            .map(|episode| json!({ "id": episode.id, "text": episode.narrative })),
    );
    store
        .telemetry(
            &input.scope,
            &format!("query-{}", input.now),
            &input.now,
            "query",
            &serde_json::to_string(&results).expect("serializable"),
            &input.now,
        )
        .map_err(storage_failure)?;
    Ok(json!({ "records": results }))
}

fn forget(store: &Store, input: QueryInput) -> Result<Value, Failure> {
    if input.action != "forget" || input.record_id.trim().is_empty() {
        return Err(Failure::invalid("forget requires an exact record_id"));
    }
    let forgotten = store
        .forget_claim(&input.scope, &input.record_id, &input.now)
        .map_err(storage_failure)?;
    let forgotten = if forgotten {
        true
    } else {
        store
            .forget_episode(&input.scope, &input.record_id, &input.now)
            .map_err(storage_failure)?
    };
    Ok(
        json!({ "forgotten": forgotten, "recordIds": if forgotten { vec![input.record_id] } else { Vec::new() } }),
    )
}

fn session_closed(store: &Store, input: SessionClosedInput) -> Result<Value, Failure> {
    let expired = store
        .expire_unanswered_followups(&input.scope, &input.session_id, &input.now)
        .map_err(storage_failure)?;
    Ok(json!({ "expired": expired }))
}

fn storage_failure(error: rusqlite::Error) -> Failure {
    eprintln!("companion-memory-worker: storage operation failed: {error}");
    Failure::storage("memory storage is temporarily unavailable")
}

fn valid_span(text: &str, candidate: &ClaimCandidate) -> bool {
    if candidate.start_offset < 0 || candidate.end_offset < candidate.start_offset {
        return false;
    }
    let start = candidate.start_offset as usize;
    let end = candidate.end_offset as usize;
    text.get(start..end)
        .is_some_and(|span| span == candidate.quote)
}

fn valid_episode_span(text: &str, candidate: &EpisodeCandidate) -> bool {
    if candidate.start_offset < 0 || candidate.end_offset < candidate.start_offset {
        return false;
    }
    text.get(candidate.start_offset as usize..candidate.end_offset as usize)
        .is_some_and(|span| span == candidate.quote)
}

fn claim_text(claim: &Claim) -> String {
    let value = claim
        .raw_value
        .clone()
        .unwrap_or_else(|| match &claim.value {
            Value::String(text) => text.clone(),
            value => value.to_string(),
        });
    format!("{}: {}", claim.predicate, value)
}

fn is_policy_claim(predicate: &str) -> bool {
    predicate.starts_with("identity.")
        || predicate.starts_with("communication.")
        || predicate.starts_with("preference.")
        || predicate.starts_with("support.")
        || predicate.starts_with("advice.")
}

fn cue_matches(message: &str, claim: &Claim) -> bool {
    let message = message.trim().to_lowercase();
    if message.is_empty() {
        return false;
    }
    let value = claim
        .raw_value
        .as_deref()
        .unwrap_or("")
        .trim()
        .to_lowercase();
    if value.len() > 1 && message.contains(&value) {
        return true;
    }
    if let Some(entity) = &claim.entity_ref {
        if entity.len() > 1 && message.contains(&entity.to_lowercase()) {
            return true;
        }
    }
    let message_pairs = cjk_pairs(&message);
    let value_pairs = cjk_pairs(&claim_text(claim).to_lowercase());
    !message_pairs.is_empty() && message_pairs.iter().any(|pair| value_pairs.contains(pair))
}

fn cue_matches_episode(message: &str, episode: &Episode) -> bool {
    let message = message.trim().to_lowercase();
    let narrative = episode.narrative.to_lowercase();
    if message.is_empty() || narrative.is_empty() {
        return false;
    }
    if message.contains(&narrative) || narrative.contains(&message) {
        return true;
    }
    let message_pairs = cjk_pairs(&message);
    let narrative_pairs = cjk_pairs(&narrative);
    if message_pairs
        .iter()
        .any(|pair| narrative_pairs.contains(pair))
    {
        return true;
    }

    // Chinese paraphrases often preserve the entity but not an adjacent pair:
    // "猫现在好多了" should activate an episode whose narrative says the cat
    // was taken to a vet.  Ignore grammatical glue so a generic "今天怎么样"
    // cannot activate every old episode merely through "天" or "了".
    let message_chars = meaningful_cjk_chars(&message);
    let narrative_chars = meaningful_cjk_chars(&narrative);
    message_chars
        .iter()
        .any(|character| narrative_chars.contains(character))
}

fn meaningful_cjk_chars(text: &str) -> Vec<char> {
    // This is a small stop-character filter, not a vocabulary or admission
    // table.  Multi-character topic pairs and the direct entity/topic overlap
    // above remain the normal path; this fallback only handles short Chinese
    // paraphrases where the shared entity is one character long.
    const FUNCTION_CHARS: &str =
        "的了在是我你他她它和与这那有个也就不很都要会去来着过到点今天天气吗呢吧啊呀么从对把被为及并而但还又更最近总觉得想说看聊能可会已了然用户半三一二四五";
    text.chars()
        .filter(|character| is_cjk(*character) && !FUNCTION_CHARS.contains(*character))
        .collect()
}

fn cjk_pairs(text: &str) -> Vec<String> {
    let chars: Vec<char> = text
        .chars()
        .filter(|character| !character.is_whitespace())
        .collect();
    chars
        .windows(2)
        .filter_map(|pair| {
            let both_cjk = pair.iter().all(|character| is_cjk(*character));
            both_cjk.then(|| pair.iter().collect())
        })
        .collect()
}

fn is_cjk(character: char) -> bool {
    matches!(character as u32, 0x3400..=0x9fff | 0xf900..=0xfaff)
}

fn is_greeting(text: &str) -> bool {
    let text = text.trim().to_lowercase();
    ["hi", "hello", "hey", "你好", "您好", "早", "晚上好"]
        .iter()
        .any(|greeting| {
            text == *greeting
                || text.starts_with(&format!("{greeting}，"))
                || text.starts_with(&format!("{greeting},"))
        })
}

fn mention_mode_name(mode: MentionMode) -> &'static str {
    match mode {
        MentionMode::NeverSurface => "never_surface",
        MentionMode::BackgroundOnly => "background_only",
        MentionMode::MentionIfUserCues => "mention_if_user_cues",
        MentionMode::FreelyMentionable => "freely_mentionable",
    }
}

fn surface_name(decision: &MentionDecision) -> &'static str {
    match decision {
        MentionDecision::Allowed { level, .. } | MentionDecision::Denied { level, .. } => {
            match level {
                SurfaceLevel::NeverSurface => "never_surface",
                SurfaceLevel::BackgroundOnly => "background_only",
                SurfaceLevel::MentionIfUserCues => "mention_if_user_cues",
                SurfaceLevel::FreelyMentionable => "freely_mentionable",
            }
        }
    }
}

fn decision_reason(decision: &MentionDecision, has_cue: bool) -> &'static str {
    match decision {
        MentionDecision::Allowed {
            background_only: true,
            ..
        } => "background_policy",
        MentionDecision::Allowed { .. } if has_cue => "current_turn_cue",
        MentionDecision::Allowed { .. } => "policy_memory",
        MentionDecision::Denied { .. } => "mention_gate_denied",
    }
}

#[cfg(test)]
mod tests {
    use super::{cue_matches_episode, Episode};
    use companion_memory_kernel::domain::types::{EpisodeStatus, RelationshipScope, Salience};

    fn episode(narrative: &str) -> Episode {
        Episode {
            id: "episode-1".into(),
            scope: RelationshipScope {
                service_id: "service".into(),
                owner_user_id: "owner".into(),
                companion_profile_id: "profile".into(),
            },
            occurred_from: "2026-01-01T00:00:00Z".into(),
            occurred_to: None,
            narrative: narrative.into(),
            participants: Vec::new(),
            emotional_arc: None,
            user_reaction: None,
            response_ref: None,
            source_refs: Vec::new(),
            status: EpisodeStatus::Active,
            salience: Salience::default(),
            created_at: "2026-01-01T00:00:00Z".into(),
            updated_at: "2026-01-01T00:00:00Z".into(),
        }
    }

    #[test]
    fn a_short_chinese_entity_can_activate_a_paraphrased_episode() {
        assert!(cue_matches_episode(
            "猫现在好多了，能吃东西了",
            &episode("猫生病，用户半夜带猫去宠物医院，折腾到三点。"),
        ));
    }

    #[test]
    fn generic_chinese_small_talk_does_not_activate_the_episode() {
        assert!(!cue_matches_episode(
            "我最近总觉得有点烦",
            &episode("猫生病，用户半夜带猫去宠物医院，折腾到三点。"),
        ));
    }
}
