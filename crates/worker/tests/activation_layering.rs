//! How a plan's channels get populated.
//!
//! The five channels are the mechanism the whole eval rests on: `constraints`
//! and `responseStyle` are meant to be standing, `continuity` carries open
//! threads, `topicActivated` carries what the current message touches, and
//! `deepRecall` is meant to carry records too important to leave out even when
//! nothing cues them.
//!
//! These tests exist because a plan whose channels silently stay empty looks
//! exactly like a plan with nothing to say, and a memory system that injects
//! nothing produces replies indistinguishable from having no memory at all.

mod harness;

use harness::{admit_params, candidate, channels, scope, warm_params, Worker};
use serde_json::json;

/// A stand-in for what the extractor would have recorded.
fn record(worker: &mut Worker, id: &str, predicate: &str, value: &str, at: &str) {
    worker.send(
        id,
        "admit",
        admit_params(
            at,
            "message-1",
            value,
            vec![candidate(id, predicate, value, value)],
        ),
    );
}

#[test]
fn a_boundary_is_a_constraint_regardless_of_the_message() {
    // A boundary is an obligation, not a candidate that competes for attention.
    // Selecting it by keyword would mean the companion forgets a prohibition on
    // exactly the turn where it matters.
    let mut worker = Worker::start();
    record(
        &mut worker,
        "boundary-1",
        "boundary.topic_avoid",
        "别跟我提前任",
        "2026-09-12T00:00:00Z",
    );
    worker.send(
        "warm",
        "warm",
        warm_params("今天天气怎么样", "session-2", true),
    );
    let responses = worker.responses();

    let plan = channels(&responses[1]);
    let constraints = plan["constraints"].as_array().expect("constraints");
    assert_eq!(constraints.len(), 1, "plan was {plan}");
    assert_eq!(constraints[0]["recordId"], "claim-boundary-1");
    assert_eq!(constraints[0]["surface"], "background_only");
}

#[test]
fn a_stated_preference_is_a_standing_style() {
    // Communication and support preferences shape every reply rather than being
    // recalled when cued, which is what "standing" has to mean if it means
    // anything.
    let mut worker = Worker::start();
    record(
        &mut worker,
        "style-1",
        "communication.verbosity",
        "short",
        "2026-09-12T00:00:00Z",
    );
    worker.send("warm", "warm", warm_params("讲个故事", "session-2", true));
    let responses = worker.responses();

    let plan = channels(&responses[1]);
    assert_eq!(
        plan["responseStyle"].as_array().expect("style").len(),
        1,
        "plan was {plan}"
    );
}

#[test]
fn a_topic_record_activates_only_when_the_message_touches_it() {
    let mut worker = Worker::start();
    record(
        &mut worker,
        "goal-1",
        "goal.current_focus",
        "准备十一月的考证考试",
        "2026-09-12T00:00:00Z",
    );
    // Cueing on the whole run of characters, which is how the matcher works for
    // text without word boundaries.
    worker.send(
        "warm-cued",
        "warm",
        warm_params("我还得继续准备十一月的考证考试", "session-2", true),
    );
    worker.send(
        "warm-uncued",
        "warm",
        warm_params("今天天气怎么样", "session-2", false),
    );
    let responses = worker.responses();

    let cued = channels(&responses[1]);
    assert_eq!(
        cued["topicActivated"].as_array().expect("topic").len(),
        1,
        "a cued goal must activate, plan was {cued}"
    );

    let uncued = channels(&responses[2]);
    assert!(
        uncued["topicActivated"]
            .as_array()
            .expect("topic")
            .is_empty(),
        "an uncued goal must not activate, plan was {uncued}"
    );
}

#[test]
fn an_uncued_freely_mentionable_goal_reaches_deep_recall() {
    // The `deepRecall` channel works, which two of my own readings of the code
    // got wrong: one predicted the branch was unreachable, the next predicted the
    // match had no arm for an allowed record without a cue. Both were settled by
    // running this rather than by reading more carefully, which is the point of
    // writing it.
    //
    // `goal.current_focus` is `freely_mentionable` and important enough, so with
    // no cue at all it still reaches the model as background. That is the
    // behaviour a companion needs: something the user said that they have not
    // just repeated stays available.
    let mut worker = Worker::start();
    record(
        &mut worker,
        "focus-1",
        "goal.current_focus",
        "准备十一月的考证考试",
        "2026-09-12T00:00:00Z",
    );
    worker.send(
        "warm",
        "warm",
        warm_params("今天天气怎么样", "session-2", true),
    );
    let responses = worker.responses();

    let plan = channels(&responses[1]);
    let deep = plan["deepRecall"].as_array().expect("deep recall");
    assert_eq!(deep.len(), 1, "plan was {plan}");
    assert_eq!(deep[0]["recordId"], "claim-focus-1");
    assert_eq!(deep[0]["surface"], "freely_mentionable");
}

#[test]
fn the_cue_gate_is_what_hides_a_high_sensitivity_goal_not_a_missing_channel() {
    // The contrast that isolates the cause. Same stored shape, same uncued
    // message — the difference is the registry row. `goal.aspiration` is HIGH
    // sensitivity and describes something the user may not have said publicly, so
    // it stays `mention_if_user_cues`; `goal.current_focus` is freely mentionable.
    // One reaches the model and the other does not.
    //
    // This pair is chosen deliberately rather than by picking two convenient
    // predicates. Making the MED rows freely mentionable was a product decision:
    // a companion that cannot raise what the user is working towards is not
    // remembering them. The HIGH rows were left cue-gated in the same change, and
    // this is the case that says so — if someone widens the policy again without
    // meaning to, the difference between the two rows disappears and this fails.
    let mut worker = Worker::start();
    record(
        &mut worker,
        "goal-1",
        "goal.aspiration",
        "攒钱去冰岛看极光",
        "2026-09-12T00:00:00Z",
    );
    worker.send(
        "warm",
        "warm",
        warm_params("今天天气怎么样", "session-2", true),
    );
    let responses = worker.responses();

    let plan = channels(&responses[1]);
    let visible = [
        "constraints",
        "identity",
        "responseStyle",
        "continuity",
        "topicActivated",
        "deepRecall",
    ]
    .iter()
    .map(|channel| plan[channel].as_array().expect(channel).len())
    .sum::<usize>();

    assert_eq!(
        visible, 0,
        "an uncued cue-gated goal became visible, so the layering or the registry \
         changed. Plan was {plan}"
    );
    assert_eq!(
        plan["doNotSurface"].as_array().expect("withheld").len(),
        1,
        "it must still be accounted for as withheld rather than dropped, plan was {plan}"
    );
}

#[test]
fn a_durable_objective_reaches_the_model_without_being_cued() {
    // What the policy change bought, asserted as behaviour rather than as a
    // registry row. The user is told what they are working towards without having
    // to reintroduce it, which is most of what remembering someone looks like in
    // a conversation that runs for months.
    let mut worker = Worker::start();
    record(
        &mut worker,
        "objective-1",
        "goal.long_term_objective",
        "攒钱去冰岛看极光",
        "2026-09-12T00:00:00Z",
    );
    worker.send(
        "warm",
        "warm",
        warm_params("今天天气怎么样", "session-2", true),
    );
    let responses = worker.responses();

    let plan = channels(&responses[1]);
    assert_eq!(
        plan["deepRecall"].as_array().expect("deep recall")[0]["recordId"],
        "claim-objective-1",
        "an uncued objective must reach the model as background, plan was {plan}"
    );
    assert!(
        plan["doNotSurface"].as_array().expect("withheld").is_empty(),
        "it must not be withheld as well as surfaced, plan was {plan}"
    );
}

#[test]
fn every_admitted_record_lands_in_exactly_one_channel() {
    // A record that reaches no channel is invisible, and a record in two would
    // be injected twice. Counting is the cheapest way to catch either, and it
    // catches the case a per-channel assertion misses: a total that is neither
    // zero nor the number of records.
    let mut worker = Worker::start();
    let boundary = "别跟我提前任";
    let style = "short";
    let goal = "攒钱去冰岛看极光";
    record(
        &mut worker,
        "b1",
        "boundary.topic_avoid",
        boundary,
        "2026-09-12T00:00:00Z",
    );
    record(
        &mut worker,
        "s1",
        "communication.verbosity",
        style,
        "2026-09-12T00:00:01Z",
    );
    record(
        &mut worker,
        "g1",
        "goal.long_term_objective",
        goal,
        "2026-09-12T00:00:02Z",
    );
    worker.send(
        "warm",
        "warm",
        warm_params("今天天气怎么样", "session-2", true),
    );
    let responses = worker.responses();

    let plan = channels(&responses[3]);
    let mut placed = 0;
    let mut ids: Vec<String> = Vec::new();
    for channel in [
        "constraints",
        "identity",
        "responseStyle",
        "continuity",
        "topicActivated",
        "deepRecall",
        "doNotSurface",
    ] {
        for entry in plan[channel].as_array().expect(channel) {
            placed += 1;
            ids.push(format!(
                "{channel}:{}",
                entry["recordId"].as_str().unwrap_or("?")
            ));
        }
    }

    // Three records, and each must appear once. `doNotSurface` counts as placed:
    // it is a decision to withhold, which is different from being overlooked.
    let unique: std::collections::HashSet<&String> = ids.iter().collect();
    assert_eq!(
        unique.len(),
        ids.len(),
        "a record reached more than one channel: {ids:?}"
    );
    assert_eq!(
        placed, 3,
        "records that reached no channel are invisible to the model; placement was {ids:?}"
    );
}

#[test]
fn a_shared_grammatical_pair_is_not_a_cue() {
    // The matcher's evidence for "the user is talking about this" is a shared
    // adjacent pair of characters. `今天` is such a pair and is two of the most
    // frequent characters in the language, so a record that happens to mention
    // today used to activate on any message that happened to mention today —
    // reported, confidently, as `current_turn_cue`.
    //
    // Both halves matter. The record must not be injected, and it must still be
    // accounted for: withheld is a decision, invisible is a bug.
    let mut worker = Worker::start();
    record(
        &mut worker,
        "cat-1",
        "misc.unclassified",
        "楼下那只三花猫今天又蹲在同一个台阶上",
        "2026-09-12T00:00:00Z",
    );
    worker.send(
        "warm",
        "warm",
        warm_params("今天天气怎么样", "session-2", true),
    );
    let responses = worker.responses();

    let plan = channels(&responses[1]);
    assert!(
        plan["topicActivated"].as_array().expect("topic").is_empty(),
        "sharing only `今天` is not sharing a subject, plan was {plan}"
    );
    assert_eq!(
        plan["doNotSurface"].as_array().expect("doNotSurface").len(),
        1,
        "it must still be accounted for, plan was {plan}"
    );
}

#[test]
fn a_shared_subject_pair_still_cues() {
    // The control for the case above. Tightening the matcher until nothing ever
    // activates would pass that test and destroy the system, so the same record
    // has to arrive when the message really is about the cat.
    let mut worker = Worker::start();
    record(
        &mut worker,
        "cat-1",
        "misc.unclassified",
        "楼下那只三花猫今天又蹲在同一个台阶上",
        "2026-09-12T00:00:00Z",
    );
    worker.send(
        "warm",
        "warm",
        warm_params("楼下那只三花猫还在吗", "session-2", true),
    );
    let responses = worker.responses();

    let plan = channels(&responses[1]);
    let topic = plan["topicActivated"].as_array().expect("topic");
    assert_eq!(topic.len(), 1, "a shared subject must still cue, plan was {plan}");
    assert_eq!(topic[0]["recordId"], "claim-cat-1");
}

#[test]
fn a_stand_in_for_the_hidden_arm_keeps_scope_isolated() {
    // The counterfactual arm and the gold arms run against one worker. If a
    // record written for one scope were readable from another, every arm
    // comparison would be measuring contamination rather than memory.
    let mut worker = Worker::start();
    worker.send(
        "admit",
        "admit",
        json!({
            "scope": { "service_id": "service", "owner_user_id": "owner", "companion_profile_id": "preset" },
            "now": "2026-09-12T00:00:00Z",
            "source": { "id": "m1", "session_id": "session-1", "text": "别跟我提前任" },
            "candidates": [candidate("b1", "boundary.topic_avoid", "别跟我提前任", "别跟我提前任")],
        }),
    );
    worker.send(
        "warm-other",
        "warm",
        json!({
            "scope": { "service_id": "service", "owner_user_id": "owner", "companion_profile_id": "other-preset" },
            "current_message": "今天天气怎么样",
            "now": "2026-09-12T00:00:02Z",
            "session_id": "session-9",
            "new_session": true,
            "turn_key": "turn-other",
        }),
    );
    let responses = worker.responses();

    let plan = channels(&responses[1]);
    assert_eq!(
        plan["constraints"].as_array().expect("constraints").len(),
        0,
        "one preset's boundary must not constrain another, plan was {plan}"
    );
    let _ = scope();
}
