use std::io::Write;
use std::process::{Command, Stdio};

use serde_json::{json, Value};

fn temp_database() -> std::path::PathBuf {
    let mut path = std::env::temp_dir();
    path.push(format!(
        "companion-memory-worker-{}-{}.db",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock")
            .as_nanos(),
    ));
    path
}

#[test]
fn jsonl_protocol_recovers_after_bad_json_and_forgets_retained_evidence() {
    let database = temp_database();
    let binary = env!("CARGO_BIN_EXE_companion-memory-worker");
    let mut child = Command::new(binary)
        .arg("--database")
        .arg(&database)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("start worker");
    let mut stdin = child.stdin.take().expect("stdin");
    let scope = json!({
        "service_id": "service",
        "owner_user_id": "owner",
        "companion_profile_id": "preset",
    });
    let request = |id: &str, op: &str, params: Value| {
        json!({ "version": 1, "id": id, "op": op, "params": params }).to_string()
    };

    writeln!(stdin, "this is not json").expect("bad json");
    writeln!(stdin, "{}", request("health", "health", json!({}))).expect("health");
    writeln!(
        stdin,
        "{}",
        request(
            "admit",
            "admit",
            json!({
                "scope": scope,
                "now": "2026-09-12T00:00:00Z",
                "source": {
                    "id": "message-1",
                    "session_id": "session-1",
                    "text": "My name is Xiaolin.",
                },
                "candidates": [{
                    "id": "name-1",
                    "predicate": "identity.name",
                    "value": "Xiaolin",
                    "raw_value": "Xiaolin",
                    "start_offset": 11,
                    "end_offset": 18,
                    "quote": "Xiaolin",
                    "confidence": 0.9,
                }],
                "pending": [{
                    "id": "runtime-review-1",
                    "kind": "runtime_state",
                    "reason": "automatic promotion awaits extractor quality evidence",
                }],
            }),
        )
    )
    .expect("admit");
    writeln!(
        stdin,
        "{}",
        request(
            "open-loop",
            "admit",
            json!({
                "scope": { "service_id": "service", "owner_user_id": "owner", "companion_profile_id": "preset" },
                "now": "2026-09-12T00:00:01Z",
                "source": {
                    "id": "message-2",
                    "session_id": "session-1",
                    "text": "明天记得给花浇水。",
                },
                "candidates": [{
                    "id": "watering-1",
                    "predicate": "open_loop.low_risk_check_in",
                    "value": "给花浇水",
                    "raw_value": "给花浇水",
                    "start_offset": 12,
                    "end_offset": 24,
                    "quote": "给花浇水",
                    "confidence": 0.9,
                    "open_thread": {
                        "id": "thread-watering-1",
                        "summary": "问问给花浇水这件小事后来办得怎么样。"
                    }
                }],
                "episodes": [{
                    "id": "watering-episode-1",
                    "narrative": "用户说明天要给花浇水。",
                    "start_offset": 12,
                    "end_offset": 24,
                    "quote": "给花浇水",
                    "confidence": 0.9
                }]
            }),
        )
    )
    .expect("open-loop admission");
    for (id, session_id) in [
        ("warm-first", "session-2"),
        ("warm-same-session", "session-2"),
    ] {
        writeln!(
            stdin,
            "{}",
            request(
                id,
                "warm",
                json!({
                    "scope": { "service_id": "service", "owner_user_id": "owner", "companion_profile_id": "preset" },
                    "current_message": "你好",
                    "now": "2026-09-12T00:00:02Z",
                    "session_id": session_id,
                    "new_session": true,
                    "turn_key": id,
                }),
            )
        )
        .expect("warm");
    }
    writeln!(
        stdin,
        "{}",
        request(
            "close-session",
            "session_closed",
            json!({
                "scope": { "service_id": "service", "owner_user_id": "owner", "companion_profile_id": "preset" },
                "session_id": "session-2",
                "now": "2026-09-12T00:00:03Z",
            }),
        )
    )
    .expect("close session");
    writeln!(
        stdin,
        "{}",
        request(
            "forget",
            "forget",
            json!({
                "scope": { "service_id": "service", "owner_user_id": "owner", "companion_profile_id": "preset" },
                "action": "forget",
                "record_id": "claim-name-1",
                "now": "2026-09-12T00:00:01Z",
            }),
        )
    )
    .expect("forget");
    writeln!(
        stdin,
        "{}",
        request(
            "forget-episode",
            "forget",
            json!({
                "scope": { "service_id": "service", "owner_user_id": "owner", "companion_profile_id": "preset" },
                "action": "forget",
                "record_id": "episode-watering-episode-1",
                "now": "2026-09-12T00:00:02Z",
            }),
        )
    )
    .expect("forget episode");
    writeln!(
        stdin,
        "{}",
        request(
            "search-after-forget",
            "query",
            json!({
                "scope": { "service_id": "service", "owner_user_id": "owner", "companion_profile_id": "preset" },
                "action": "search",
                "terms": "花",
                "now": "2026-09-12T00:00:03Z",
            }),
        )
    )
    .expect("search after forget");
    drop(stdin);

    let output = child.wait_with_output().expect("worker exit");
    assert!(
        output.status.success(),
        "worker stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let lines: Vec<Value> = String::from_utf8(output.stdout)
        .expect("utf8 stdout")
        .lines()
        .map(|line| serde_json::from_str(line).expect("response json"))
        .collect();
    assert_eq!(lines.len(), 10);
    assert_eq!(lines[0]["ok"], false);
    assert_eq!(lines[0]["error"]["code"], "INVALID_REQUEST");
    assert_eq!(lines[1]["result"]["protocolVersion"], 1);
    assert!(
        lines[1]["result"]["predicateSchemas"]
            .as_array()
            .expect("predicate schemas")
            .iter()
            .any(|schema| schema["key"] == "communication.verbosity"
                && schema["valueKind"] == "enum"
                && schema["enumValues"].as_array().expect("enum values").iter().any(|value| value == "short")),
        "Rust must give extractors the closed enum values rather than relying on a TypeScript mirror"
    );
    assert_eq!(lines[2]["result"]["accepted"][0], "claim-name-1");
    assert_eq!(lines[2]["result"]["pending"], 1);
    assert_eq!(lines[3]["result"]["accepted"][0], "claim-watering-1");
    assert_eq!(
        lines[3]["result"]["accepted"][1],
        "episode-watering-episode-1"
    );
    assert_eq!(
        lines[4]["result"]["plan"]["continuity"][0]["recordId"],
        "claim-watering-1"
    );
    assert!(lines[5]["result"]["plan"]["continuity"]
        .as_array()
        .expect("continuity")
        .is_empty());
    assert_eq!(lines[6]["result"]["expired"], 1);
    assert_eq!(lines[7]["result"]["forgotten"], true);
    assert_eq!(lines[8]["result"]["forgotten"], true);
    assert!(lines[9]["result"]["records"]
        .as_array()
        .expect("search records")
        .iter()
        .all(|record| record["id"] != "episode-watering-episode-1"));
    let _ = std::fs::remove_file(database);
}
