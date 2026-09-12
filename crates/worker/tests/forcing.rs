//! What the oracle's forced-injection arms can and cannot do.
//!
//! Two of the four arms exist only to be compared against the other two, and the
//! whole comparison rests on `force_record_ids` meaning one thing: put this
//! record in front of the model regardless of whether the user cued it. The
//! `gold_forced` arm is the ceiling — how well the companion answers when it is
//! handed the right memory — and the `counterfactual_forced` arm is the floor,
//! the same treatment with the wrong memory.
//!
//! If forcing does less than that, the ceiling is measured too low and the
//! conclusion is that memory does not help, which is the failure this file is
//! here to make impossible. If forcing does more than that, the harness becomes a
//! way to put content in front of the model that the product must never emit, and
//! the protection arms are measuring the harness rather than the policy.
//!
//! So: forcing overrides activation, and it does not override authorization.

mod harness;

use harness::{admit_params, candidate, channels, forced_warm_params, warm_params, Worker};
use serde_json::json;

/// Admit one record whose value is also the message it came from.
///
/// `value_json` overrides the value where the registry expects a shape a string
/// cannot express, such as an enum token or a number.
fn record(worker: &mut Worker, id: &str, predicate: &str, value: &str, value_json: Option<serde_json::Value>) {
    let mut proposal = candidate(id, predicate, value, value);
    if let Some(json_value) = value_json {
        proposal["value"] = json_value;
    }
    worker.send(
        "admit",
        "admit",
        admit_params("2026-09-12T00:00:00Z", "message-1", value, vec![proposal]),
    );
}

/// The record ids a plan placed in a channel that the model can see.
fn spoken(plan: &serde_json::Value) -> Vec<String> {
    ["constraints", "identity", "responseStyle", "continuity", "topicActivated", "deepRecall"]
        .iter()
        .flat_map(|channel| {
            plan[channel]
                .as_array()
                .expect(channel)
                .iter()
                .map(|entry| entry["recordId"].as_str().unwrap_or("?").to_string())
                .collect::<Vec<_>>()
        })
        .collect()
}

#[test]
fn an_uncued_record_stays_out_without_forcing_and_arrives_with_it() {
    // Both halves in one worker, because the interesting quantity is the
    // difference between them. A forced arm that behaves like the normal arm
    // makes the ceiling unmeasurable; a normal arm that behaves like the forced
    // one makes the whole comparison vacuous. Only the second turn changes.
    let mut worker = Worker::start();
    record(
        &mut worker,
        "goal-1",
        "goal.aspiration",
        "攒钱去冰岛看极光",
        None,
    );
    worker.send(
        "warm-normal",
        "warm",
        warm_params("今天天气怎么样", "session-2", true),
    );
    worker.send(
        "warm-forced",
        "warm",
        forced_warm_params(
            "今天天气怎么样",
            "session-3",
            true,
            vec!["claim-goal-1".to_string()],
        ),
    );
    let responses = worker.responses();

    let normal = channels(&responses[1]);
    assert!(
        spoken(&normal).is_empty(),
        "an uncued cue-gated record must not surface on its own, plan was {normal}"
    );

    let forced = channels(&responses[2]);
    assert_eq!(
        forced["topicActivated"].as_array().expect("topic")[0]["recordId"],
        "claim-goal-1",
        "forcing must put the record in front of the model, plan was {forced}"
    );
}

#[test]
fn a_forced_record_is_not_reported_as_a_user_cue() {
    // The plan's `reason` is what a diagnosis reads to decide why a record
    // surfaced. Labelling the oracle's own injection as `current_turn_cue` makes
    // the forced arm's plan indistinguishable from the normal arm's, so the two
    // arms cannot be told apart by the artifact they produce — and a run where
    // forcing silently stopped working would read as a run where the companion
    // remembered.
    let mut worker = Worker::start();
    record(
        &mut worker,
        "goal-1",
        "goal.aspiration",
        "攒钱去冰岛看极光",
        None,
    );
    worker.send(
        "warm",
        "warm",
        forced_warm_params(
            "今天天气怎么样",
            "session-2",
            true,
            vec!["claim-goal-1".to_string()],
        ),
    );
    let responses = worker.responses();

    let plan = channels(&responses[1]);
    assert_eq!(
        plan["topicActivated"].as_array().expect("topic")[0]["reason"],
        "forced_oracle_injection",
        "the plan must say the harness put it there, plan was {plan}"
    );
}

#[test]
fn a_genuine_cue_is_still_reported_as_a_cue_when_the_record_is_also_forced() {
    // Precedence, and the reason the two flags are tracked separately rather
    // than collapsed into one. On the forced arm the user may also have cued the
    // record; when they did, the honest answer is that they cued it.
    let mut worker = Worker::start();
    record(
        &mut worker,
        "goal-1",
        "goal.aspiration",
        "攒钱去冰岛看极光",
        None,
    );
    worker.send(
        "warm",
        "warm",
        forced_warm_params(
            "我刚又想到攒钱去冰岛看极光这件事",
            "session-2",
            true,
            vec!["claim-goal-1".to_string()],
        ),
    );
    let responses = worker.responses();

    let plan = channels(&responses[1]);
    assert_eq!(
        plan["topicActivated"].as_array().expect("topic")[0]["reason"],
        "current_turn_cue",
        "a real cue outranks the harness, plan was {plan}"
    );
}

#[test]
fn forcing_cannot_put_a_never_surface_record_in_front_of_the_model() {
    // The safety ceiling, and the one place where the harness must be weaker
    // than it looks. `support.physical_context` is registered `never_surface`
    // because the companion may act on being in public but must never say it
    // knows. If forcing could override that, the evaluation would be able to
    // produce content the product is built never to produce, and the protection
    // arms would be measuring the harness's restraint rather than the policy's.
    //
    // The value is the enum token rather than the user's phrasing because this
    // case is about authorization, not about classification.
    let mut worker = Worker::start();
    record(
        &mut worker,
        "ctx-1",
        "support.physical_context",
        "in_public",
        Some(json!("in_public")),
    );
    worker.send(
        "warm",
        "warm",
        forced_warm_params(
            "in_public",
            "session-2",
            true,
            vec!["claim-ctx-1".to_string()],
        ),
    );
    let responses = worker.responses();

    let plan = channels(&responses[1]);
    assert!(
        spoken(&plan).is_empty(),
        "forcing must not reach past the gate, plan was {plan}"
    );
    assert_eq!(
        plan["doNotSurface"].as_array().expect("withheld")[0]["recordId"],
        "claim-ctx-1",
        "it must be withheld rather than dropped, plan was {plan}"
    );
}
