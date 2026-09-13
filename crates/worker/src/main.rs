//! Persistent JSONL bridge for the companion-memory Rust authority.
//!
//! Standard output is reserved for one protocol response per request.  Human
//! diagnostics go to standard error so a damaged caller line never desynchronises
//! later requests.

use std::io::{self, BufRead, Write};

use companion_memory_kernel::domain::predicate_keys::all_predicate_keys;
use companion_memory_kernel::domain::predicates::{
    spec_for, Cardinality, MentionMode, Sensitivity, ValueKind,
};
use companion_memory_kernel::domain::types::{
    Claim, ClaimStatus, EmotionalArcPoint, Episode, EpisodeParticipant, EpisodeStatus, EvidenceRef,
    EvidenceSourceType, Provenance, RelationshipScope, Salience, SemanticRole, Speaker,
};
use companion_memory_kernel::rules::forgetting::{
    find_exact_residue, find_suspected_residue, would_resurrect, TextCandidate,
};
use companion_memory_kernel::rules::mention_gate::{
    claim_mention, episode_mention, is_constraint, MentionCues, MentionDecision, SurfaceLevel,
};
use companion_memory_kernel::rules::record_identity::{
    decide_supersede, SupersedeDecision, SupersedeInput,
};
use companion_memory_kernel::rules::salience::{candidate_score, recency_factor, ScoreInputs};
use companion_memory_storage::{OpenOptions, OpenThread, SourceMessage, SourceSpan, Store};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::{json, Value};

const PROTOCOL_VERSION: u32 = 1;
const MAX_LINE_BYTES: usize = 1_048_576;
const MAX_TOPIC_ACTIVATED: usize = 8;
const MAX_DEEP_RECALL: usize = 8;
const MIN_DEEP_RECALL_SCORE: f64 = 0.25;
const RESIDUE_SIMILARITY_THRESHOLD: f64 = 0.5;
const SALIENCE_HALF_LIFE_DAYS: u32 = 90;

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
    #[serde(default)]
    participants: Vec<EpisodeParticipant>,
    #[serde(default)]
    emotional_arc: Option<Vec<EmotionalArcPoint>>,
    #[serde(default)]
    user_reaction: Option<String>,
    #[serde(default)]
    response_ref: Option<String>,
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
    current_message: String,
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
    /// Who the user is, as something to address them by rather than a style knob.
    ///
    /// `identity.name` used to be rendered into `responseStyle`, whose guidance
    /// tells the model the record is there to choose "language, tone, format, and
    /// level of detail". Measured: eight forced records with the name in the plan
    /// and not one reply used it, which was reported as the name memory not
    /// working. The mention gate decides whether a name may be used; that is a
    /// different question from whether this is a name at all.
    identity: Vec<PlanEntry>,
    response_style: Vec<PlanEntry>,
    continuity: Vec<PlanEntry>,
    topic_activated: Vec<PlanEntry>,
    deep_recall: Vec<PlanEntry>,
    do_not_surface: Vec<PlanEntry>,
}

#[derive(Debug, Clone, Copy, Default)]
struct CueEvidence {
    /// The current user message names the stored value or entity directly.
    user_referenced: bool,
    /// The current user message shares a topic-bearing pair with the record.
    topic_implies: bool,
}

impl CueEvidence {
    fn any(self) -> bool {
        self.user_referenced || self.topic_implies
    }

    fn relevance(self) -> f64 {
        match (self.user_referenced, self.topic_implies) {
            (true, _) => 1.0,
            (false, true) => 0.8,
            (false, false) => 0.0,
        }
    }
}

#[derive(Debug)]
struct RankedPlanEntry {
    score: f64,
    entry: PlanEntry,
}

/// Admission rejects are expected model output; storage failures are not.
/// Keeping the two paths distinct is what lets a durable queue retry a locked
/// or unavailable SQLite database instead of recording a false validation
/// rejection and marking the job complete.
#[derive(Debug)]
enum AdmissionError {
    Reject(String),
    Storage(rusqlite::Error),
}

impl From<rusqlite::Error> for AdmissionError {
    fn from(error: rusqlite::Error) -> Self {
        Self::Storage(error)
    }
}

fn classify_admission_error(error: rusqlite::Error) -> AdmissionError {
    match error {
        rusqlite::Error::InvalidParameterName(reason)
            if reason == "record id belongs to another scope" =>
        {
            AdmissionError::Reject(reason)
        }
        other => AdmissionError::Storage(other),
    }
}

fn finish_ranked(
    entries: &mut Vec<RankedPlanEntry>,
    limit: usize,
) -> (Vec<PlanEntry>, Vec<PlanEntry>) {
    entries.sort_by(|left, right| {
        right
            .score
            .partial_cmp(&left.score)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| left.entry.record_id.cmp(&right.entry.record_id))
    });
    let ranked = entries
        .drain(..entries.len().min(limit))
        .map(|ranked| ranked.entry)
        .collect::<Vec<_>>();
    let overflow = entries
        .drain(..)
        .map(|ranked| ranked.entry)
        .collect::<Vec<_>>();
    (ranked, overflow)
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
                    "cardinality": cardinality_name(spec.cardinality),
                    "requiresEntityRef": matches!(spec.kind, ValueKind::EntityRef),
                    "qualifierSchema": qualifier_schema(spec.key),
                    "description": spec.description,
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

fn cardinality_name(cardinality: Cardinality) -> &'static str {
    match cardinality {
        Cardinality::Single => "single",
        Cardinality::Set => "set",
        Cardinality::TemporalSingle => "temporal_single",
    }
}

/// Qualifiers are intentionally closed only where the registry documents their
/// meaning. Other predicates expose `null` instead of inviting the extractor to
/// invent a context key that admission cannot interpret semantically.
fn qualifier_schema(key: &str) -> Value {
    match key {
        "identity.location" | "communication.verbosity" => json!({
            "type": "object",
            "properties": {
                "context": { "type": "string", "enum": if key == "identity.location" {
                    json!(["current", "home", "work"])
                } else {
                    json!(["work", "casual"])
                } }
            },
            "additionalProperties": false,
        }),
        _ => Value::Null,
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
    let snapshot = store
        .warm_snapshot(&input.scope, &input.now)
        .map_err(storage_failure)?;
    let claims = snapshot.claims;
    let episodes = snapshot.episodes;
    let open_threads = snapshot.open_threads;
    let mut revision = snapshot.revision;
    let mut plan = MemoryUsagePlan::default();
    let mut ranked_topic = Vec::new();
    let mut ranked_deep = Vec::new();
    let force = input.force_record_ids;
    let boundaries: Vec<&Claim> = claims
        .iter()
        .filter(|claim| is_constraint(Some(&claim.predicate)))
        .collect();

    for claim in &claims {
        let text = claim_text(claim);
        let cue = claim_cue_evidence(&input.current_message, claim);
        let forced = force.iter().any(|id| id == &claim.id);
        let decision = claim_mention(
            claim,
            MentionCues {
                user_referenced: cue.user_referenced || forced,
                topic_implies: cue.topic_implies,
                ..MentionCues::default()
            },
        );
        let entry = PlanEntry {
            record_id: claim.id.clone(),
            text,
            surface: surface_name(&decision).into(),
            reason: decision_reason(&decision, cue, forced).into(),
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
        } else if is_identity_claim(&claim.predicate) {
            // Identity is not a style preference. It goes where a name can be a
            // name; the gate above has already decided whether it may be said.
            match decision {
                MentionDecision::Denied {
                    level: SurfaceLevel::NeverSurface,
                    ..
                } => plan.do_not_surface.push(entry),
                _ => plan.identity.push(entry),
            }
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
                MentionDecision::Allowed { .. } if cue.any() || forced => {
                    let score = claim_recall_score(claim, cue, forced, &input.now);
                    ranked_topic.push(RankedPlanEntry { score, entry });
                }
                MentionDecision::Allowed { level, .. }
                    if level == SurfaceLevel::FreelyMentionable
                        && claim_recall_score(claim, cue, false, &input.now)
                            >= MIN_DEEP_RECALL_SCORE =>
                {
                    let score = claim_recall_score(claim, cue, false, &input.now);
                    ranked_deep.push(RankedPlanEntry { score, entry });
                }
                MentionDecision::Denied { .. } => plan.do_not_surface.push(entry),
                MentionDecision::Allowed { .. } => {}
            }
        }
    }

    for episode in &episodes {
        let cue = episode_cue_evidence(&input.current_message, episode);
        let forced = force.iter().any(|id| id == &episode.id);
        let decision = episode_mention(
            episode,
            MentionCues {
                user_referenced: cue.user_referenced || forced,
                topic_implies: cue.topic_implies,
                ..MentionCues::default()
            },
        );
        if cue.any() || forced {
            let entry = PlanEntry {
                record_id: episode.id.clone(),
                text: episode.narrative.clone(),
                surface: surface_name(&decision).into(),
                reason: decision_reason(&decision, cue, forced).into(),
            };
            // A cue makes an episode relevant, but relevance cannot override a
            // standing boundary. Withhold the narrative before rendering so a
            // downstream model never receives both the prohibition and the
            // sensitive record and is not asked to arbitrate the conflict.
            if matches!(decision, MentionDecision::Denied { .. }) {
                plan.do_not_surface.push(PlanEntry {
                    surface: "never_surface".into(),
                    reason: "mention_gate".into(),
                    ..entry
                });
            } else if boundaries
                .iter()
                .any(|boundary| boundary_blocks_episode(boundary, episode))
            {
                plan.do_not_surface.push(PlanEntry {
                    surface: "never_surface".into(),
                    reason: "boundary_policy".into(),
                    ..entry
                });
            } else {
                ranked_topic.push(RankedPlanEntry {
                    score: episode_recall_score(episode, cue, forced, &input.now),
                    entry,
                });
            }
        }
    }

    let (topic_activated, topic_overflow) = finish_ranked(&mut ranked_topic, MAX_TOPIC_ACTIVATED);
    let (deep_recall, deep_overflow) = finish_ranked(&mut ranked_deep, MAX_DEEP_RECALL);
    plan.topic_activated = topic_activated;
    plan.deep_recall = deep_recall;
    plan.do_not_surface.extend(
        topic_overflow
            .into_iter()
            .chain(deep_overflow)
            .map(|entry| PlanEntry {
                surface: "never_surface".into(),
                reason: "prompt_budget".into(),
                ..entry
            }),
    );

    if input.new_session && is_greeting(&input.current_message) && !input.session_id.is_empty() {
        if let Some(thread) = open_threads.into_iter().find(|thread| {
            thread.sensitivity == "low"
                && matches!(
                    thread.mention_mode.as_str(),
                    "freely_mentionable" | "mention_if_user_cues"
                )
                && thread.followup_session_id.as_deref() != Some(input.session_id.as_str())
        }) {
            let changed = store
                .update_open_thread(
                    &input.scope,
                    &thread.id,
                    "open",
                    Some(&input.session_id),
                    &input.now,
                )
                .map_err(storage_failure)?;
            if changed > 0 {
                plan.continuity.push(PlanEntry {
                    record_id: thread.record_id.clone(),
                    text: thread.summary.clone(),
                    surface: thread.mention_mode.clone(),
                    reason: "one_session_greeting_followup".into(),
                });
                // Consuming a one-session follow-up is itself a durable change.
                // It happens after the row snapshot, so refresh only the
                // watermark; claims and episodes remain the exact rows
                // selected above.
                revision = store
                    .memory_revision(&input.scope)
                    .map_err(storage_failure)?;
            }
        }
    }

    // The storage watermark survives replacement and forgetting; row counts do
    // not, so they cannot tell a resumed client that its snapshot is stale.
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
            Err(AdmissionError::Reject(reason)) => {
                rejected.push(json!({ "candidateId": candidate.id, "reason": reason }))
            }
            Err(AdmissionError::Storage(error)) => return Err(storage_failure(error)),
        }
    }
    for episode in &input.episodes {
        match admit_episode(store, &input, episode) {
            Ok(id) => accepted.push(id),
            Err(AdmissionError::Reject(reason)) => {
                rejected.push(json!({ "candidateId": episode.id, "reason": reason }))
            }
            Err(AdmissionError::Storage(error)) => return Err(storage_failure(error)),
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
) -> Result<Option<String>, AdmissionError> {
    if candidate.id.trim().is_empty() || candidate.predicate.trim().is_empty() {
        return Err(AdmissionError::Reject(
            "candidate identifier and predicate are required".into(),
        ));
    }
    let Some(spec) = spec_for(&candidate.predicate) else {
        return Err(AdmissionError::Reject("unknown predicate".into()));
    };
    if !valid_qualifiers(&candidate.predicate, candidate.qualifiers.as_ref()) {
        return Err(AdmissionError::Reject(
            "qualifiers do not match predicate contract".into(),
        ));
    };
    if !valid_span(&input.source.text, candidate) {
        return Err(AdmissionError::Reject(
            "source span does not match retained user text".into(),
        ));
    }
    let suppression = store
        .load_suppression_set(&input.scope)
        .map_err(AdmissionError::Storage)?;
    let fingerprints = store
        .load_suppressed_fingerprints(&input.scope)
        .map_err(AdmissionError::Storage)?;
    if would_resurrect(
        &candidate.predicate,
        &candidate.value,
        candidate.entity_ref.as_deref(),
        &suppression,
        &fingerprints,
    )
    .is_some()
    {
        return Err(AdmissionError::Reject(
            "candidate would resurrect forgotten content".into(),
        ));
    }
    let active = store
        .active_claims_in_slot(
            &input.scope,
            &candidate.predicate,
            candidate.entity_ref.as_deref(),
            candidate.qualifiers.as_ref(),
        )
        .map_err(AdmissionError::Storage)?;
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
        SupersedeDecision::Reject { detail, .. } => return Err(AdmissionError::Reject(detail)),
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
            .map_err(AdmissionError::Storage)?;
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
        .map_err(classify_admission_error)?;
    Ok(Some(record_id))
}

fn admit_episode(
    store: &Store,
    input: &AdmitInput,
    candidate: &EpisodeCandidate,
) -> Result<String, AdmissionError> {
    if candidate.id.trim().is_empty() || candidate.narrative.trim().is_empty() {
        return Err(AdmissionError::Reject(
            "episode identifier and narrative are required".into(),
        ));
    }
    if !valid_episode_span(&input.source.text, candidate) {
        return Err(AdmissionError::Reject(
            "source span does not match retained user text".into(),
        ));
    }
    if !valid_episode_details(candidate, &input.source.text) {
        return Err(AdmissionError::Reject(
            "episode structured fields are invalid".into(),
        ));
    }
    let fingerprint =
        companion_memory_kernel::rules::forgetting::fingerprint_text(&candidate.narrative);
    if store
        .load_suppressed_fingerprints(&input.scope)
        .map_err(AdmissionError::Storage)?
        .contains_key(&fingerprint)
    {
        return Err(AdmissionError::Reject(
            "episode would resurrect forgotten content".into(),
        ));
    }
    let record_id = format!("episode-{}", candidate.id);
    let confidence = candidate.confidence.clamp(0.0, 1.0);
    let episode = Episode {
        id: record_id.clone(),
        scope: input.scope.clone(),
        occurred_from: input.now.clone(),
        occurred_to: None,
        narrative: candidate.narrative.clone(),
        participants: candidate.participants.clone(),
        emotional_arc: candidate.emotional_arc.clone(),
        user_reaction: candidate.user_reaction.clone(),
        response_ref: candidate.response_ref.clone(),
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
        .map_err(classify_admission_error)?;
    Ok(record_id)
}

fn query(store: &Store, input: QueryInput) -> Result<Value, Failure> {
    if input.action != "search" {
        return Err(Failure::invalid("query action must be search"));
    }
    // Tool arguments are model-generated. A query can only authorize a
    // mention when the current direct user turn itself supplies the cue; the
    // model cannot mint a cue by choosing a search string.
    let current_message = input.current_message.trim();
    if current_message.is_empty() {
        return Ok(json!({ "records": [] }));
    }
    let claims = store.active_claims(&input.scope).map_err(storage_failure)?;
    let boundaries: Vec<&Claim> = claims
        .iter()
        .filter(|claim| is_constraint(Some(&claim.predicate)))
        .collect();
    let mut results: Vec<_> = claims
        .iter()
        .filter(|claim| cue_matches(&input.terms, claim))
        .filter(|claim| !is_constraint(Some(&claim.predicate)))
        .filter(|claim| cue_matches(current_message, claim))
        .filter_map(|claim| {
            let cue = claim_cue_evidence(current_message, claim);
            if !cue.any() {
                return None;
            }
            match claim_mention(
                claim,
                MentionCues {
                    user_referenced: cue.user_referenced,
                    topic_implies: cue.topic_implies,
                    ..MentionCues::default()
                },
            ) {
                MentionDecision::Allowed {
                    level: SurfaceLevel::NeverSurface | SurfaceLevel::BackgroundOnly,
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
            .filter_map(|episode| {
                let cue = episode_cue_evidence(current_message, &episode);
                if !cue.any() {
                    return None;
                }
                if boundaries
                    .iter()
                    .any(|boundary| boundary_blocks_episode(boundary, &episode))
                {
                    return None;
                }
                match episode_mention(
                    &episode,
                    MentionCues {
                        user_referenced: cue.user_referenced,
                        topic_implies: cue.topic_implies,
                        ..MentionCues::default()
                    },
                ) {
                    MentionDecision::Allowed {
                        level: SurfaceLevel::MentionIfUserCues | SurfaceLevel::FreelyMentionable,
                        ..
                    } => Some(json!({ "id": episode.id, "text": episode.narrative })),
                    MentionDecision::Allowed { .. } | MentionDecision::Denied { .. } => None,
                }
            }),
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
    if !forget_authorized(&input.current_message, &input.record_id) {
        return Err(Failure::invalid(
            "forget requires an explicit user request containing the exact record id",
        ));
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
    let (residue, residue_scan_failed) = if forgotten {
        match residue_report(store, &input.scope) {
            Ok(report) => (report, false),
            Err(error) => {
                // Forget is already committed and must not be reported as a
                // failed deletion merely because advisory post-scan telemetry
                // could not be read. Preserve the failure as an explicit bit
                // so an operator can distinguish "no residue" from "scan unavailable".
                eprintln!("companion-memory-worker: residue scan failed: {error}");
                (Vec::new(), true)
            }
        }
    } else {
        (Vec::new(), false)
    };
    Ok(json!({
        "forgotten": forgotten,
        "recordIds": if forgotten { vec![input.record_id] } else { Vec::new() },
        "residue": residue,
        "residueScanFailed": residue_scan_failed,
    }))
}

/// Tool arguments are model-generated, so deletion needs an independent cue
/// from the direct user turn. Requiring the exact id in that turn prevents a
/// model from deleting a record merely because it found the id in a snapshot.
fn forget_authorized(message: &str, record_id: &str) -> bool {
    let message = message.trim().to_lowercase();
    let record_id = record_id.trim().to_lowercase();
    if message.is_empty() || record_id.is_empty() || !message.contains(&record_id) {
        return false;
    }
    let explicit = [
        "忘掉", "忘了", "忘记", "删除", "删掉", "移除", "forget", "delete", "remove",
    ];
    let negated = [
        "不要忘",
        "别忘",
        "不要删除",
        "别删除",
        "不要删",
        "别删",
        "don't forget",
        "do not forget",
        "dont forget",
        "never forget",
        "don't delete",
        "do not delete",
        "dont delete",
        "never delete",
        "don't remove",
        "do not remove",
        "dont remove",
        "never remove",
    ];
    explicit.iter().any(|cue| message.contains(cue))
        && !negated.iter().any(|cue| message.contains(cue))
}

/// Scan surviving memory after a forget and expose semantic residue as review
/// telemetry. The lexical detector is deliberately advisory: it can flag a
/// paraphrase, but it never deletes or suppresses the survivor automatically.
fn residue_report(store: &Store, scope: &RelationshipScope) -> Result<Vec<Value>, rusqlite::Error> {
    let suppressed = store.load_suppressed_fingerprints(scope)?;
    if suppressed.is_empty() {
        return Ok(Vec::new());
    }

    let claims = store.active_claims(scope)?;
    let episodes = store.active_episodes(scope)?;
    let mut owned = Vec::with_capacity(claims.len() + episodes.len());
    for claim in &claims {
        owned.push((
            EvidenceSourceType::Claim,
            claim.id.clone(),
            claim_text(claim),
        ));
    }
    for episode in &episodes {
        owned.push((
            EvidenceSourceType::Episode,
            episode.id.clone(),
            episode.narrative.clone(),
        ));
    }
    let candidates = owned
        .iter()
        .map(|(source_type, source_id, text)| TextCandidate {
            source_type: *source_type,
            source_id,
            text,
        })
        .collect::<Vec<_>>();

    let exact = find_exact_residue(&suppressed, &candidates);
    let exact_ids = exact
        .iter()
        .map(|residue| residue.source_id)
        .collect::<std::collections::HashSet<_>>();
    let mut report = exact
        .into_iter()
        .map(|residue| {
            json!({
                "kind": "exact",
                "sourceType": residue.source_type,
                "sourceId": residue.source_id,
                "matchedId": residue.matched_id,
            })
        })
        .collect::<Vec<_>>();
    report.extend(
        find_suspected_residue(&suppressed, &candidates, RESIDUE_SIMILARITY_THRESHOLD)
            .into_iter()
            .filter(|residue| !exact_ids.contains(residue.source_id))
            .map(|residue| {
                json!({
                    "kind": "suspected",
                    "sourceType": residue.source_type,
                    "sourceId": residue.source_id,
                    "similarity": residue.similarity,
                })
            }),
    );
    Ok(report)
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

/// Validate the closed qualifier contract exposed by `predicate_schemas`.
/// Qualifiers are part of canonical slot identity, so accepting an undeclared
/// key would let a model manufacture parallel values for a single predicate.
fn valid_qualifiers(predicate: &str, qualifiers: Option<&Value>) -> bool {
    let Some(qualifiers) = qualifiers else {
        return true;
    };
    if qualifiers.is_null() {
        return true;
    }
    match predicate {
        "identity.location" | "communication.verbosity" => {
            let Some(object) = qualifiers.as_object() else {
                return false;
            };
            let allowed = if predicate == "identity.location" {
                ["current", "home", "work"].as_slice()
            } else {
                ["work", "casual"].as_slice()
            };
            object.iter().all(|(key, value)| {
                key == "context"
                    && value
                        .as_str()
                        .is_some_and(|context| allowed.contains(&context))
            })
        }
        _ => qualifiers
            .as_object()
            .is_some_and(|object| object.is_empty()),
    }
}

fn valid_episode_span(text: &str, candidate: &EpisodeCandidate) -> bool {
    if candidate.start_offset < 0 || candidate.end_offset < candidate.start_offset {
        return false;
    }
    text.get(candidate.start_offset as usize..candidate.end_offset as usize)
        .is_some_and(|span| span == candidate.quote)
}

fn valid_episode_details(candidate: &EpisodeCandidate, source_text: &str) -> bool {
    let participants_valid = candidate.participants.iter().all(|participant| {
        participant
            .entity_ref
            .as_deref()
            .map_or(true, |entity| !entity.trim().is_empty())
    });
    let arc_valid = candidate.emotional_arc.as_ref().map_or(true, |arc| {
        arc.iter().all(|point| {
            !point.labels.is_empty()
                && point.labels.iter().all(|label| !label.trim().is_empty())
                && point.intensity.map_or(true, |intensity| {
                    intensity.is_finite() && (0.0..=1.0).contains(&intensity)
                })
        })
    });
    let reaction_valid = candidate.user_reaction.as_deref().map_or(true, |reaction| {
        let reaction = reaction.trim();
        !reaction.is_empty() && source_text.contains(reaction)
    });
    let response_ref_valid = candidate
        .response_ref
        .as_deref()
        .map_or(true, |response_ref| !response_ref.trim().is_empty());
    participants_valid && arc_valid && reaction_valid && response_ref_valid
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

/// Whether a standing boundary names content in an episode narrative.
///
/// Boundary values are normalised into `Claim::value`, while `raw_value` may
/// contain the user's longer prohibition (for example, "别跟我提前任"). The
/// normalised value is the strongest signal because it is the extracted topic
/// token; the raw wording remains a fallback for non-string values.
fn boundary_blocks_episode(boundary: &Claim, episode: &Episode) -> bool {
    let token = match &boundary.value {
        Value::String(value) if !value.trim().is_empty() => value.trim(),
        _ => boundary
            .raw_value
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or(""),
    };
    if token.is_empty() {
        return false;
    }
    episode
        .narrative
        .to_lowercase()
        .contains(&token.to_lowercase())
}

/// Who the user is. Rendered into its own channel, not into the style channel:
/// a name is something to address someone by, and the style channel's guidance
/// is about language, tone, format and level of detail.
fn is_identity_claim(predicate: &str) -> bool {
    predicate.starts_with("identity.")
}

fn is_policy_claim(predicate: &str) -> bool {
    predicate.starts_with("communication.")
        || predicate.starts_with("preference.")
        || predicate.starts_with("support.")
        || predicate.starts_with("advice.")
}

fn claim_cue_evidence(message: &str, claim: &Claim) -> CueEvidence {
    let message = message.trim().to_lowercase();
    if message.is_empty() {
        return CueEvidence::default();
    }
    let direct_values = [
        claim.raw_value.as_deref().unwrap_or(""),
        claim.entity_ref.as_deref().unwrap_or(""),
    ];
    let user_referenced = direct_values.iter().any(|value| {
        let value = value.trim().to_lowercase();
        value.chars().count() > 1 && message.contains(&value)
    });
    let message_pairs = cjk_topic_pairs(&message);
    let value_pairs = cjk_topic_pairs(&claim_text(claim).to_lowercase());
    CueEvidence {
        user_referenced,
        topic_implies: !user_referenced
            && !message_pairs.is_empty()
            && message_pairs.iter().any(|pair| value_pairs.contains(pair)),
    }
}

fn cue_matches(message: &str, claim: &Claim) -> bool {
    claim_cue_evidence(message, claim).any()
}

/// Authorization evidence for an episode. A single shared CJK character is
/// intentionally excluded: it may help a candidate retriever find a paraphrase,
/// but it is not enough to tell the companion that the user meant this episode.
fn episode_cue_evidence(message: &str, episode: &Episode) -> CueEvidence {
    let message = message.trim().to_lowercase();
    let narrative = episode.narrative.to_lowercase();
    if message.is_empty() || narrative.is_empty() {
        return CueEvidence::default();
    }
    if narrative.chars().count() > 1 && message.contains(&narrative) {
        return CueEvidence {
            user_referenced: true,
            ..CueEvidence::default()
        };
    }
    let message_pairs = cjk_topic_pairs(&message);
    let narrative_pairs = cjk_topic_pairs(&narrative);
    CueEvidence {
        topic_implies: message_pairs
            .iter()
            .any(|pair| narrative_pairs.contains(pair)),
        ..CueEvidence::default()
    }
}

/// Broad episode candidate matching used by search. It deliberately retains a
/// single-character fallback, but callers must not pass this boolean as
/// `MentionCues`: authorization uses [`episode_cue_evidence`] above.
fn cue_matches_episode(message: &str, episode: &Episode) -> bool {
    let message = message.trim().to_lowercase();
    let narrative = episode.narrative.to_lowercase();
    if message.is_empty() || narrative.is_empty() {
        return false;
    }
    if message.contains(&narrative) || narrative.contains(&message) {
        return true;
    }
    if episode_cue_evidence(&message, episode).any() {
        return true;
    }

    let message_chars = meaningful_cjk_chars(&message);
    let narrative_chars = meaningful_cjk_chars(&narrative);
    message_chars
        .iter()
        .any(|character| narrative_chars.contains(character))
}

/// Characters that carry grammar rather than topic.
///
/// This is a small stop-character filter, not a vocabulary or admission table.
/// It exists so that a shared character cannot be mistaken for a shared subject.
const FUNCTION_CHARS: &str =
    "的了在是我你他她它和与这那有个也就不很都要会去来着过到点今天天气吗呢吧啊呀么从对把被为及并而但还又更最近总觉得想说看聊能可会已了然用户半三一二四五";

fn is_function_char(character: char) -> bool {
    FUNCTION_CHARS.contains(character)
}

fn meaningful_cjk_chars(text: &str) -> Vec<char> {
    // Multi-character topic pairs and the direct entity/topic overlap in the
    // cue matchers remain the normal path; this fallback only handles short
    // Chinese paraphrases where the shared entity is one character long.
    text.chars()
        .filter(|character| is_cjk(*character) && !is_function_char(*character))
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

/// Adjacent CJK pairs, minus the ones that are nothing but grammatical glue.
///
/// A shared pair is the cue matchers' main evidence, so a pair carrying no topic
/// is not evidence. `今天` is two of the most frequent characters in the
/// language: left in, any record that happens to say "today" activates on any
/// message that happens to say "today", which is most of them. The matcher then
/// reports a confident `current_turn_cue` for a turn that shares no subject at
/// all, and every downstream reading of the plan — how often memory was used,
/// whether it helped — is measuring that instead.
fn cjk_topic_pairs(text: &str) -> Vec<String> {
    cjk_pairs(text)
        .into_iter()
        .filter(|pair| !pair.chars().all(is_function_char))
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

fn claim_recall_score(claim: &Claim, cue: CueEvidence, forced: bool, now: &str) -> f64 {
    let standing_relevance = spec_for(&claim.predicate)
        .is_some_and(|spec| spec.mention_policy == MentionMode::FreelyMentionable);
    let relevance = if forced || cue.any() {
        cue.relevance().max(if forced { 1.0 } else { 0.0 })
    } else if standing_relevance {
        1.0
    } else {
        0.0
    };
    candidate_score(&ScoreInputs {
        predicate: &claim.predicate,
        salience: &claim.salience,
        relevance,
        confidence: claim.provenance.confidence,
        last_seen: claim
            .salience
            .last_recalled_at
            .as_deref()
            .unwrap_or(&claim.updated_at),
        now,
        half_life_days: SALIENCE_HALF_LIFE_DAYS,
        explicit_trigger: forced,
    })
    .unwrap_or(0.0)
}

fn episode_recall_score(episode: &Episode, cue: CueEvidence, forced: bool, now: &str) -> f64 {
    let relevance = if forced || cue.any() {
        cue.relevance().max(if forced { 1.0 } else { 0.0 })
    } else {
        0.0
    };
    let recency = recency_factor(
        episode
            .salience
            .last_recalled_at
            .as_deref()
            .unwrap_or(&episode.updated_at),
        now,
        SALIENCE_HALF_LIFE_DAYS,
    );
    relevance * episode.salience.importance * recency * if forced { 1.25 } else { 1.0 }
}

fn decision_reason(decision: &MentionDecision, cue: CueEvidence, forced: bool) -> &'static str {
    match decision {
        MentionDecision::Allowed {
            background_only: true,
            ..
        } => "background_policy",
        // A record the oracle forced was not cued by the user, and saying it was
        // makes the forced arm's plan indistinguishable from the arm that really
        // did remember. `reason` is the field a diagnosis reads to decide why
        // something surfaced, so a label that cannot tell the harness apart from
        // the product answers that question wrongly for two arms out of four.
        MentionDecision::Allowed { .. } if forced && !cue.any() => "forced_oracle_injection",
        MentionDecision::Allowed { .. } if cue.user_referenced => "current_turn_cue",
        MentionDecision::Allowed { .. } if cue.topic_implies => "topic_implied",
        MentionDecision::Allowed { .. } if forced => "forced_oracle_injection",
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
    fn a_short_chinese_entity_can_match_an_episode_search_candidate() {
        // This is the broad candidate matcher, not authorization. Warm/query
        // use `episode_cue_evidence`, where the same single-character overlap
        // is deliberately insufficient to surface the episode.
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
