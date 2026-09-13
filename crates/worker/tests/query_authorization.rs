//! Tool-style search must not turn a model-generated query into a user cue.

mod harness;

use harness::{admit_params, candidate, scope, Worker};
use serde_json::json;

fn query_params(terms: &str, current_message: &str) -> serde_json::Value {
    json!({
        "scope": scope(),
        "action": "search",
        "terms": terms,
        "current_message": current_message,
        "now": "2026-09-12T00:00:02Z",
    })
}

#[test]
fn search_requires_a_cue_from_the_current_direct_user_message() {
    let mut worker = Worker::start();
    worker.send(
        "admit",
        "admit",
        admit_params(
            "2026-09-12T00:00:00Z",
            "message-1",
            "我家的猫今天很乖。",
            vec![candidate(
                "cat",
                "misc.unclassified",
                "我家的猫",
                "我家的猫今天很乖。",
            )],
        ),
    );
    worker.send(
        "uncued-search",
        "query",
        query_params("我家的猫", "今天天气怎么样？"),
    );
    worker.send(
        "cued-search",
        "query",
        query_params("我家的猫", "我想聊聊我家的猫。"),
    );

    let episode_source = "我家猫咪昨晚生病，去了宠物医院。";
    let episode_quote = "猫咪昨晚生病，去了宠物医院";
    let episode_start = episode_source.find(episode_quote).expect("episode quote") as i64;
    let mut episode_admit = admit_params(
        "2026-09-12T00:00:01Z",
        "message-2",
        episode_source,
        Vec::new(),
    );
    episode_admit["episodes"] = json!([{
        "id": "cat-episode",
        "narrative": "猫咪昨晚生病，去了宠物医院。",
        "start_offset": episode_start,
        "end_offset": episode_start + episode_quote.len() as i64,
        "quote": episode_quote,
        "confidence": 0.9,
    }]);
    worker.send("admit-episode", "admit", episode_admit);
    worker.send(
        "uncued-episode-search",
        "query",
        query_params("猫咪", "今天天气怎么样？"),
    );
    worker.send(
        "cued-episode-search",
        "query",
        query_params("猫咪", "我想聊聊猫咪。"),
    );
    worker.send(
        "single-char-episode-search",
        "query",
        query_params("猫", "我想聊聊猫。"),
    );

    let responses = worker.responses();
    assert!(
        responses[1]["result"]["records"]
            .as_array()
            .expect("uncued records")
            .is_empty(),
        "a model-generated query must not manufacture a user cue: {}",
        responses[1]
    );
    assert_eq!(responses[2]["result"]["records"][0]["id"], "claim-cat");
    assert!(
        responses[4]["result"]["records"]
            .as_array()
            .expect("uncued episode records")
            .is_empty(),
        "a query term cannot authorize an episode without a cue from the direct user message: {}",
        responses[4]
    );
    assert_eq!(
        responses[5]["result"]["records"][0]["id"],
        "episode-cat-episode"
    );
    assert!(
        responses[6]["result"]["records"]
            .as_array()
            .expect("single-char episode records")
            .is_empty(),
        "a single-character overlap cannot authorize an episode query: {}",
        responses[6]
    );
}
