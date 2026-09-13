//! What admission refuses, and why.
//!
//! `admit` returns accepted ids and, for everything it turned down, a reason.
//! That reason is the only thing standing between a model's proposal and durable
//! memory, and the paths are not equivalent: refusing a fabricated quote and
//! refusing a duplicate both return a rejection, but only one of them is
//! protecting the user.
//!
//! These tests exist because a rejection list that is always empty looks like
//! clean extraction, and one that is always full looks like a broken extractor.
//! Neither reading is available without knowing which reasons can occur.

mod harness;

use harness::{
    admit_params, candidate, channels, fabricated_candidate, scope, warm_params, Worker,
};
use serde_json::json;

/// The reasons in a response's `rejected` array, as `(id, reason)` pairs.
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
fn a_candidate_with_no_predicate_is_refused() {
    let mut worker = Worker::start();
    worker.send(
        "admit",
        "admit",
        admit_params(
            "2026-09-12T00:00:00Z",
            "message-1",
            "My name is Xiaolin.",
            vec![candidate("empty-1", "", "Xiaolin", "My name is Xiaolin.")],
        ),
    );
    let mut responses = worker.responses();
    let response = responses.pop().expect("one response");

    assert!(
        response["result"]["accepted"]
            .as_array()
            .expect("accepted")
            .is_empty(),
        "nothing may be accepted without a predicate: {response}"
    );
    let reasons = rejections(&response);
    assert_eq!(reasons.len(), 1);
    assert!(
        reasons[0].1.contains("predicate"),
        "the reason must name the problem, got {:?}",
        reasons[0]
    );
}

#[test]
fn undeclared_qualifiers_are_refused_instead_of_creating_parallel_slots() {
    let mut worker = Worker::start();
    let mut proposal = candidate(
        "name-qualified",
        "identity.name",
        "Xiaolin",
        "My name is Xiaolin.",
    );
    proposal["qualifiers"] = json!({ "context": "work" });
    worker.send(
        "admit",
        "admit",
        admit_params(
            "2026-09-12T00:00:00Z",
            "message-qualifier",
            "My name is Xiaolin.",
            vec![proposal],
        ),
    );
    let responses = worker.responses();
    let reasons = rejections(&responses[0]);
    assert_eq!(reasons[0].1, "qualifiers do not match predicate contract");
}

#[test]
fn a_predicate_the_vocabulary_does_not_declare_is_refused() {
    // The vocabulary is closed in Rust. A model inventing a key must not be able
    // to extend it, which is what an earlier run did with `work.stress_pattern`.
    let mut worker = Worker::start();
    worker.send(
        "admit",
        "admit",
        admit_params(
            "2026-09-12T00:00:00Z",
            "message-1",
            "Working late again.",
            vec![candidate(
                "invented-1",
                "work.stress_pattern",
                "Working late again.",
                "Working late again.",
            )],
        ),
    );
    let mut responses = worker.responses();
    let response = responses.pop().expect("one response");

    let reasons = rejections(&response);
    assert_eq!(reasons.len(), 1, "response was {response}");
    assert!(
        reasons[0].1.contains("unknown predicate"),
        "expected the vocabulary to refuse it, got {:?}",
        reasons[0]
    );
}

#[test]
fn a_quote_that_does_not_appear_in_the_message_is_refused() {
    // The anti-fabrication guard, and the reason it has to exist at this layer
    // rather than in a prompt: the offset pair plus the quote are checkable
    // against the retained text, so a model cannot cite something the user never
    // said. Without it, provenance would be a claim the model makes about itself.
    let mut worker = Worker::start();
    worker.send(
        "admit",
        "admit",
        admit_params(
            "2026-09-12T00:00:00Z",
            "message-1",
            "今天天气怎么样",
            vec![fabricated_candidate(
                "fabricated-1",
                "identity.name",
                "用户叫张三",
                "今天天气怎么样",
            )],
        ),
    );
    let mut responses = worker.responses();
    let response = responses.pop().expect("one response");

    assert!(
        response["result"]["accepted"]
            .as_array()
            .expect("accepted")
            .is_empty(),
        "a quote absent from the message must not be admitted: {response}"
    );
    let reasons = rejections(&response);
    assert_eq!(reasons.len(), 1);
    assert!(
        reasons[0].1.contains("source span"),
        "expected the span check to refuse it, got {:?}",
        reasons[0]
    );
}

#[test]
fn malformed_episode_structure_is_refused_before_persistence() {
    let mut worker = Worker::start();
    worker.send(
        "admit",
        "admit",
        json!({
            "scope": scope(),
            "now": "2026-09-12T00:00:00Z",
            "source": {
                "id": "message-episode",
                "session_id": "session-1",
                "text": "我和猫咪去了医院。"
            },
            "episodes": [{
                "id": "episode-invalid",
                "narrative": "我和猫咪去了医院。",
                "start_offset": 0,
                "end_offset": 27,
                "quote": "我和猫咪去了医院。",
                "confidence": 0.9,
                "participants": [{ "role": "user", "entity_ref": "   " }],
                "emotional_arc": [{
                    "at_turn": 1,
                    "labels": ["担心"],
                    "intensity": 1.5,
                    "source": "user_expressed"
                }]
            }]
        }),
    );
    let mut responses = worker.responses();
    let response = responses.pop().expect("one response");

    assert!(
        response["result"]["accepted"]
            .as_array()
            .expect("accepted")
            .is_empty(),
        "invalid structured fields must not be persisted: {response}"
    );
    let reasons = rejections(&response);
    assert_eq!(reasons.len(), 1);
    assert!(
        reasons[0].1.contains("structured fields"),
        "the rejection should identify the structured-field contract: {reasons:?}"
    );
}

#[test]
fn a_restatement_of_a_held_value_is_reported_as_merged_rather_than_accepted() {
    // Merged is not the same as refused. The model proposed something the system
    // already holds, so nothing is written and nothing is wrong; the reason has
    // to say which, or a healthy dedup rate reads as an extraction failure.
    let mut worker = Worker::start();
    for (id, at) in [
        ("first", "2026-09-12T00:00:00Z"),
        ("second", "2026-09-12T00:00:01Z"),
    ] {
        worker.send(
            id,
            "admit",
            admit_params(
                at,
                "message-1",
                "My name is Xiaolin.",
                vec![candidate(
                    "name-1",
                    "identity.name",
                    "Xiaolin",
                    "My name is Xiaolin.",
                )],
            ),
        );
    }
    let responses = worker.responses();

    assert_eq!(
        responses[0]["result"]["accepted"][0], "claim-name-1",
        "the first proposal is written"
    );
    let reasons = rejections(&responses[1]);
    assert!(
        reasons.iter().any(|(_, reason)| reason == "merged"),
        "a restatement must be reported as merged, got {reasons:?}"
    );
}

#[test]
fn a_forgotten_value_cannot_be_written_back() {
    // The resurrection guard, at the layer where it matters. Suppression that
    // only filters reads leaves the next extraction free to write the same fact
    // again, so the refusal has to happen on the write path.
    let mut worker = Worker::start();
    worker.send(
        "admit",
        "admit",
        admit_params(
            "2026-09-12T00:00:00Z",
            "message-1",
            "My name is Xiaolin.",
            vec![candidate(
                "name-1",
                "identity.name",
                "Xiaolin",
                "My name is Xiaolin.",
            )],
        ),
    );
    worker.send(
        "forget",
        "forget",
        json!({
            "scope": scope(),
            "action": "forget",
            "record_id": "claim-name-1",
            "current_message": "请忘掉 claim-name-1",
            "now": "2026-09-12T00:00:01Z",
        }),
    );
    worker.send(
        "readmit",
        "admit",
        admit_params(
            "2026-09-12T00:00:02Z",
            "message-2",
            "My name is Xiaolin.",
            vec![candidate(
                "name-again",
                "identity.name",
                "Xiaolin",
                "My name is Xiaolin.",
            )],
        ),
    );
    let responses = worker.responses();

    assert_eq!(
        responses[1]["result"]["forgotten"], true,
        "the forget must land first"
    );
    let reasons = rejections(&responses[2]);
    assert!(
        reasons
            .iter()
            .any(|(_, reason)| reason.contains("resurrect")),
        "the same value must not be writable after being forgotten, got {reasons:?}"
    );
    assert!(
        responses[2]["result"]["accepted"]
            .as_array()
            .expect("accepted")
            .is_empty(),
        "nothing may be accepted: {}",
        responses[2]
    );
}

#[test]
fn forgetting_requires_a_direct_user_request() {
    let mut worker = Worker::start();
    worker.send(
        "admit",
        "admit",
        admit_params(
            "2026-09-12T00:00:00Z",
            "message-1",
            "My name is Xiaolin.",
            vec![candidate(
                "name-1",
                "identity.name",
                "Xiaolin",
                "My name is Xiaolin.",
            )],
        ),
    );
    worker.send(
        "forget",
        "forget",
        json!({
            "scope": scope(),
            "action": "forget",
            "record_id": "claim-name-1",
            "current_message": "请继续聊聊你的名字",
            "now": "2026-09-12T00:00:01Z",
        }),
    );
    let responses = worker.responses();
    assert_eq!(responses[1]["ok"], false);
    assert_eq!(responses[1]["error"]["code"], "INVALID_REQUEST");
}

#[test]
fn a_rejected_candidate_leaves_the_plan_unchanged() {
    // A refusal must not leave a half-written record behind. Measured through the
    // plan rather than the row count, because a record that is stored but
    // unreachable would pass a count check and still be invisible.
    //
    // The second half is the control. An empty plan is also what a worker that
    // cannot write anything at all produces, so the same predicate is proposed
    // again from the same message with a truthful quote, and has to arrive.
    const MESSAGE: &str = "别跟我提前任";
    let mut worker = Worker::start();
    worker.send(
        "admit-fabricated",
        "admit",
        admit_params(
            "2026-09-12T00:00:00Z",
            "message-1",
            MESSAGE,
            vec![fabricated_candidate(
                "fabricated-1",
                "boundary.topic_avoid",
                "别提那个人了",
                MESSAGE,
            )],
        ),
    );
    worker.send(
        "warm-empty",
        "warm",
        warm_params("今天天气怎么样", "session-2", true),
    );
    worker.send(
        "admit-truthful",
        "admit",
        admit_params(
            "2026-09-12T00:00:02Z",
            "message-2",
            MESSAGE,
            vec![candidate("b1", "boundary.topic_avoid", MESSAGE, MESSAGE)],
        ),
    );
    worker.send(
        "warm-populated",
        "warm",
        warm_params("今天天气怎么样", "session-3", true),
    );
    let responses = worker.responses();

    assert!(
        responses[0]["result"]["accepted"]
            .as_array()
            .expect("accepted")
            .is_empty(),
        "the fabricated proposal must be refused: {}",
        responses[0]
    );
    let plan = channels(&responses[1]);
    assert_eq!(
        occupied(&plan),
        0,
        "a refused proposal must not reach the plan: {plan}"
    );

    let plan = channels(&responses[3]);
    assert_eq!(
        occupied(&plan),
        1,
        "the control must reach the plan, or the empty plan above measures nothing: {plan}"
    );
}

#[test]
fn the_offsets_the_extractor_produces_are_the_offsets_admission_accepts() {
    // Both languages compute this span, independently. TypeScript finds a UTF-16
    // index and converts it to a UTF-8 byte offset; Rust indexes the message as
    // bytes. Nothing makes them agree except the convention, and the convention
    // is invisible from either side alone: a disagreement refuses every
    // candidate the extractor ever proposes, which reads exactly like a model
    // that never has anything worth remembering.
    //
    // These numbers are the ones `sourceSpanForUniqueQuote` is asserted to
    // return for this sentence in packages/dsh-plugin/src/extractor.test.ts.
    // Moving one side without the other fails here rather than in production.
    const MESSAGE: &str = "猫现在好多了，能吃东西了。";
    const QUOTE: &str = "能吃东西";
    let mut worker = Worker::start();
    worker.send(
        "admit",
        "admit",
        admit_params(
            "2026-09-12T00:00:00Z",
            "message-1",
            MESSAGE,
            vec![json!({
                "id": "cross-language-1",
                // The vocabulary has no slot for a cat's appetite, which is what
                // the catch-all is for. This case is about the span, not the slot.
                "predicate": "misc.unclassified",
                "value": QUOTE,
                "raw_value": QUOTE,
                "start_offset": 21,
                "end_offset": 33,
                "quote": QUOTE,
                "confidence": 0.9,
            })],
        ),
    );
    let mut responses = worker.responses();
    let response = responses.pop().expect("one response");

    assert_eq!(
        response["result"]["accepted"][0], "claim-cross-language-1",
        "the extractor's byte offsets must be the ones admission checks: {response}"
    );
}

#[test]
fn a_statement_the_vocabulary_cannot_name_is_kept() {
    // The escape hatch, and the reason it is not merely decorative. Forty-six
    // keys cannot describe a daily conversation; a companionship product whose
    // memory only holds what the registry anticipated would forget most of what
    // the user said, and would do it silently — the candidate is refused, the
    // refusal has a reason, and the reason reads as policy.
    //
    // `misc.unclassified` is registered `never supersedes`, which is a rule about
    // displacement. Enforcement used to refuse the write outright, so the one
    // predicate that exists to hold the unclassifiable held nothing.
    let mut worker = Worker::start();
    worker.send(
        "admit",
        "admit",
        admit_params(
            "2026-09-12T00:00:00Z",
            "message-1",
            "楼下那只三花猫今天又蹲在同一个台阶上",
            vec![candidate(
                "misc-1",
                "misc.unclassified",
                "楼下那只三花猫今天又蹲在同一个台阶上",
                "楼下那只三花猫今天又蹲在同一个台阶上",
            )],
        ),
    );
    let mut responses = worker.responses();
    let response = responses.pop().expect("one response");

    assert_eq!(
        response["result"]["accepted"][0], "claim-misc-1",
        "the escape hatch must accept what nothing else can hold: {response}"
    );
}

/// How many records a plan placed, across every channel.
fn occupied(plan: &serde_json::Value) -> usize {
    [
        "constraints",
        "identity",
        "responseStyle",
        "continuity",
        "topicActivated",
        "deepRecall",
        "doNotSurface",
    ]
    .iter()
    .map(|channel| plan[channel].as_array().expect(channel).len())
    .sum()
}

#[test]
fn an_unsupported_pending_kind_is_refused_and_counted_separately() {
    // Pending candidates are the extraction's own uncertainty. An unrecognised
    // kind must be refused rather than stored, and the refusal must not be
    // confused with a rejected claim.
    let mut worker = Worker::start();
    worker.send(
        "admit",
        "admit",
        json!({
            "scope": scope(),
            "now": "2026-09-12T00:00:00Z",
            "source": { "id": "message-1", "session_id": "session-1", "text": "嗯。" },
            "candidates": [],
            "pending": [
                { "id": "p-known", "kind": "runtime_state", "reason": "awaiting evidence" },
                { "id": "p-unknown", "kind": "something_new", "reason": "awaiting evidence" },
            ],
        }),
    );
    let mut responses = worker.responses();
    let response = responses.pop().expect("one response");

    assert_eq!(
        response["result"]["pending"], 1,
        "only the known kind may be retained: {response}"
    );
    let reasons = rejections(&response);
    assert_eq!(reasons.len(), 1, "response was {response}");
    assert_eq!(reasons[0].0, "p-unknown");
}
