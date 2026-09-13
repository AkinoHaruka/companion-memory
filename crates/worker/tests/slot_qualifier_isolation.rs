//! Admission must apply the same canonical qualifier identity as the kernel.

mod harness;

use harness::{admit_params, candidate, Worker};
use serde_json::json;

#[test]
fn different_qualifiers_do_not_compete_for_a_single_predicate() {
    let mut worker = Worker::start();
    let mut work = candidate(
        "verbosity-work",
        "communication.verbosity",
        "long",
        "工作场景是 long，闲聊场景是 short",
    );
    work["qualifiers"] = json!({"context": "work"});
    let mut casual = candidate(
        "verbosity-casual",
        "communication.verbosity",
        "short",
        "工作场景是 long，闲聊场景是 short",
    );
    casual["qualifiers"] = json!({"context": "casual"});

    worker.send(
        "admit",
        "admit",
        admit_params(
            "2026-09-12T00:00:00Z",
            "message-1",
            "工作场景是 long，闲聊场景是 short",
            vec![work, casual],
        ),
    );

    let responses = worker.responses();
    assert_eq!(
        responses[0]["result"]["accepted"]
            .as_array()
            .expect("accepted")
            .len(),
        2,
        "each qualified value occupies its own slot: {}",
        responses[0]
    );
}
