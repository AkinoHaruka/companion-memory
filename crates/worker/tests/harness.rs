//! Drives the worker over its JSONL protocol from a test.
//!
//! Extracted so a new case can read as a sequence of requests rather than as
//! `writeln!` boilerplate. The worker is a real subprocess either way: the
//! protocol boundary is what the adapter actually talks to, so a test that
//! called the handler functions directly would verify the wrong seam.

#![allow(dead_code)]

use std::io::Write;
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};

use serde_json::{json, Value};

/// A running worker with a fresh database.
pub struct Worker {
    child: Child,
    stdin: Option<ChildStdin>,
    /// Path to the temporary database, removed on drop.
    database: PathBuf,
}

impl Worker {
    /// Start a worker on a temporary database.
    pub fn start() -> Self {
        let mut database = std::env::temp_dir();
        database.push(format!(
            "companion-memory-worker-test-{}-{}.db",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock")
                .as_nanos(),
        ));
        let mut child = Command::new(env!("CARGO_BIN_EXE_companion-memory-worker"))
            .arg("--database")
            .arg(&database)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("start worker");
        let stdin = child.stdin.take().expect("stdin");
        Self {
            child,
            stdin: Some(stdin),
            database,
        }
    }

    /// Send one request. The response is collected by [`Worker::responses`].
    pub fn send(&mut self, id: &str, op: &str, params: Value) {
        let line = json!({ "version": 1, "id": id, "op": op, "params": params }).to_string();
        writeln!(self.stdin.as_mut().expect("stdin open"), "{line}").expect("write request");
    }

    /// Close stdin and collect every response, in order.
    ///
    /// Takes `&mut self` rather than consuming, because the `Drop` impl removes
    /// the temporary database and a type cannot both be dropped and be moved out
    /// of. That rules out `wait_with_output`, which needs ownership, so the
    /// pipes are read directly.
    pub fn responses(&mut self) -> Vec<Value> {
        // Dropping the handle closes the pipe, which is what tells the worker to
        // finish and exit.
        self.stdin = None;

        let mut stdout = String::new();
        if let Some(pipe) = self.child.stdout.as_mut() {
            std::io::Read::read_to_string(pipe, &mut stdout).expect("read stdout");
        }
        let mut stderr = String::new();
        if let Some(pipe) = self.child.stderr.as_mut() {
            std::io::Read::read_to_string(pipe, &mut stderr).expect("read stderr");
        }
        let status = self.child.wait().expect("worker exit");
        assert!(status.success(), "worker stderr: {stderr}");

        // A clean run must be silent. Anything on stderr is a signal the worker
        // is degrading, and a test that ignored it would keep passing while the
        // service logged a failure on every turn.
        assert!(stderr.trim().is_empty(), "worker wrote to stderr: {stderr}");

        stdout
            .lines()
            .map(|line| serde_json::from_str(line).expect("response json"))
            .collect()
    }
}

impl Drop for Worker {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.database);
    }
}

/// The scope every request in these tests uses.
pub fn scope() -> Value {
    json!({
        "service_id": "service",
        "owner_user_id": "owner",
        "companion_profile_id": "preset",
    })
}

/// One candidate as the extractor would propose it.
pub fn candidate(id: &str, predicate: &str, value: &str) -> Value {
    json!({
        "id": id,
        "predicate": predicate,
        "value": value,
        "raw_value": value,
        "start_offset": 0,
        "end_offset": value.len(),
        "quote": value,
        "confidence": 0.9,
    })
}

/// An `admit` request carrying one message and its candidates.
pub fn admit_params(now: &str, source_id: &str, text: &str, candidates: Vec<Value>) -> Value {
    json!({
        "scope": scope(),
        "now": now,
        "source": { "id": source_id, "session_id": "session-1", "text": text },
        "candidates": candidates,
    })
}

/// A `warm` request.
pub fn warm_params(current_message: &str, session_id: &str, new_session: bool) -> Value {
    json!({
        "scope": scope(),
        "current_message": current_message,
        "now": "2026-09-12T00:00:02Z",
        "session_id": session_id,
        "new_session": new_session,
        "turn_key": format!("turn-{session_id}-{new_session}"),
    })
}

/// The five channels of a plan, so a test can assert them as a set.
pub fn channels(response: &Value) -> Value {
    let plan = &response["result"]["plan"];
    json!({
        "constraints": plan["constraints"],
        "responseStyle": plan["responseStyle"],
        "continuity": plan["continuity"],
        "topicActivated": plan["topicActivated"],
        "deepRecall": plan["deepRecall"],
        "doNotSurface": plan["doNotSurface"],
    })
}
