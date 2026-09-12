//! Record identity across scopes.
//!
//! A record id is a global primary key, and a scope is a column beside it. The
//! store therefore refuses a write whose id already belongs to another scope,
//! because the alternative — `INSERT OR REPLACE` on the id — would delete the
//! other relationship's row and leave one user holding another's memory, or with
//! none.
//!
//! These cases exist because the refusal is silent from a distance. It returns a
//! rejection with a reason, the caller counts it as a rejected candidate, and a
//! caller that reuses ids across scopes sees its writes quietly not happen. That
//! is exactly what the Oracle evaluator did: four arms, one set of ids, so three
//! arms stored nothing and the comparison would have read as memory having no
//! effect.

mod harness;

use harness::{
    admit_params, candidate, channels, scope, warm_params, Worker,
};
use serde_json::json;

/// A second relationship on the same service and owner.
fn other_scope() -> serde_json::Value {
    json!({
        "service_id": "service",
        "owner_user_id": "owner",
        "companion_profile_id": "other-preset",
    })
}

fn admit_params_in(
    scope: serde_json::Value,
    now: &str,
    source_id: &str,
    text: &str,
    candidates: Vec<serde_json::Value>,
) -> serde_json::Value {
    json!({
        "scope": scope,
        "now": now,
        "source": { "id": source_id, "session_id": "session-1", "text": text },
        "candidates": candidates,
    })
}

fn rejections(response: &serde_json::Value) -> Vec<(String, String)> {
    response["result"]["rejected"]
        .as_array()
        .expect("rejected array")
        .iter()
        .map(|entry| {
            (
                entry["candidateId"].as_str().unwrap_or("?").to_string(),
                entry["reason"].as_str().unwrap_or("?").to_string(),
            )
        })
        .collect()
}

#[test]
fn one_id_belongs_to_one_scope() {
    // The same id proposed in two relationships. The first write stands; the
    // second is refused rather than replacing it, and the refusal has to name
    // itself because a caller cannot tell it apart from any other rejection.
    let mut worker = Worker::start();
    worker.send(
        "first",
        "admit",
        admit_params(
            "2026-09-12T00:00:00Z",
            "message-1",
            "My name is Xiaolin.",
            vec![candidate("shared-1", "identity.name", "Xiaolin", "My name is Xiaolin.")],
        ),
    );
    worker.send(
        "second",
        "admit",
        admit_params_in(
            other_scope(),
            "2026-09-12T00:00:01Z",
            "message-2",
            "My name is Xiaolin.",
            vec![candidate("shared-1", "identity.name", "Xiaolin", "My name is Xiaolin.")],
        ),
    );
    let responses = worker.responses();

    assert_eq!(
        responses[0]["result"]["accepted"][0], "claim-shared-1",
        "the first relationship owns the id: {}",
        responses[0]
    );
    let reasons = rejections(&responses[1]);
    assert_eq!(reasons.len(), 1, "response was {}", responses[1]);
    assert!(
        reasons[0].1.contains("persist"),
        "the second write must be refused, got {reasons:?}"
    );
}

#[test]
fn the_first_relationship_still_holds_its_record_afterwards() {
    // What the refusal is protecting. Under `INSERT OR REPLACE` the second write
    // would have taken the id and the first relationship would silently lose a
    // fact it is entitled to, which is worse than the second write failing.
    let mut worker = Worker::start();
    worker.send(
        "first",
        "admit",
        admit_params(
            "2026-09-12T00:00:00Z",
            "message-1",
            "My name is Xiaolin.",
            vec![candidate("shared-1", "identity.name", "Xiaolin", "My name is Xiaolin.")],
        ),
    );
    worker.send(
        "second",
        "admit",
        admit_params_in(
            other_scope(),
            "2026-09-12T00:00:01Z",
            "message-2",
            "My name is Xiaolin.",
            vec![candidate("shared-1", "identity.name", "Xiaolin", "My name is Xiaolin.")],
        ),
    );
    worker.send(
        "warm-owner",
        "warm",
        warm_params("hello", "session-2", true),
    );
    let responses = worker.responses();

    let plan = channels(&responses[2]);
    let placed: Vec<&str> = ["constraints", "identity", "responseStyle", "continuity", "topicActivated", "deepRecall"]
        .iter()
        .flat_map(|channel| plan[channel].as_array().expect(channel).iter())
        .filter_map(|entry| entry["recordId"].as_str())
        .collect();
    assert!(
        placed.contains(&"claim-shared-1"),
        "the owning relationship must still see its record, plan was {plan}"
    );
    let _ = scope();
}

#[test]
fn distinct_ids_in_distinct_scopes_both_persist() {
    // The control, and the shape the Oracle evaluator had to adopt: namespacing
    // ids by arm is what lets four relationships be written through one worker.
    // Without this case, `one_id_belongs_to_one_scope` would be satisfied by a
    // store that simply refuses everything.
    let mut worker = Worker::start();
    worker.send(
        "first",
        "admit",
        admit_params(
            "2026-09-12T00:00:00Z",
            "message-1",
            "My name is Xiaolin.",
            vec![candidate("a-1", "identity.name", "Xiaolin", "My name is Xiaolin.")],
        ),
    );
    worker.send(
        "second",
        "admit",
        admit_params_in(
            other_scope(),
            "2026-09-12T00:00:01Z",
            "message-2",
            "My name is Xiaolin.",
            vec![candidate("b-1", "identity.name", "Xiaolin", "My name is Xiaolin.")],
        ),
    );
    let responses = worker.responses();

    assert_eq!(responses[0]["result"]["accepted"][0], "claim-a-1");
    assert_eq!(
        responses[1]["result"]["accepted"][0], "claim-b-1",
        "a distinct id in another relationship must persist: {}",
        responses[1]
    );
}
