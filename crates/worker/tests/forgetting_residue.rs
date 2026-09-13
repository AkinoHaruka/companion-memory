//! Forgetting scans surviving memory for lexical paraphrases without deleting
//! them automatically.

mod harness;

use harness::{scope, Worker};
use serde_json::json;

fn episode(id: &str, narrative: &str, quote: &str) -> serde_json::Value {
    json!({
        "id": id,
        "narrative": narrative,
        "start_offset": 0,
        "end_offset": quote.len(),
        "quote": quote,
        "confidence": 0.9,
    })
}

#[test]
fn forgetting_reports_a_surviving_paraphrase_for_review() {
    let original_text = "The user visited the blue lake after a storm.";
    let paraphrase_text = "The user visited a blue lake after heavy rain.";
    let mut worker = Worker::start();
    worker.send(
        "admit-original",
        "admit",
        json!({
            "scope": scope(),
            "now": "2026-09-12T00:00:00Z",
            "source": { "id": "message-original", "session_id": "session-1", "text": original_text },
            "episodes": [episode("original", original_text, original_text)]
        }),
    );
    worker.send(
        "admit-paraphrase",
        "admit",
        json!({
            "scope": scope(),
            "now": "2026-09-12T00:00:01Z",
            "source": { "id": "message-paraphrase", "session_id": "session-1", "text": paraphrase_text },
            "episodes": [episode("paraphrase", "The user visited the blue lake after heavy rain.", paraphrase_text)]
        }),
    );
    worker.send(
        "forget-original",
        "forget",
        json!({
            "scope": scope(),
            "action": "forget",
            "record_id": "episode-original",
            "current_message": "请忘掉 episode-original",
            "now": "2026-09-12T00:00:02Z"
        }),
    );
    let responses = worker.responses();

    assert_eq!(responses[0]["result"]["accepted"][0], "episode-original");
    assert_eq!(responses[1]["result"]["accepted"][0], "episode-paraphrase");
    let residue = responses[2]["result"]["residue"]
        .as_array()
        .expect("residue report");
    assert!(
        residue.iter().any(|entry| {
            entry["kind"] == "suspected"
                && entry["sourceType"] == "episode"
                && entry["sourceId"] == "episode-paraphrase"
                && entry["similarity"]
                    .as_f64()
                    .is_some_and(|score| score >= 0.5)
        }),
        "forget must surface a paraphrase for review without deleting it: {residue:?}"
    );
}
