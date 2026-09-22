# External Benchmark Protocol

This protocol defines the only permitted path for closing `REQ-EVAL-035`; it is a test-layer evaluation contract and does not add a production benchmark mode to the runtime.

## Separation of question and retrieval query

`originalQuestion` is the exact benchmark question used by the answer generator and official scorer.

`retrievalQuery` is produced by the fixed `benchmark-query-v1` adapter, which adds only a generic long-term-memory intent and a no-invention instruction.

The adapter may normalize Unicode, whitespace and punctuation for retrieval, and may carry an evaluation `asOf` value separately; it must not alter the scored question.

Benchmark answers, evidence identifiers, answer-session identifiers, availability labels and category labels are evaluation data, not retrieval input.

## Conversation ingestion

LoCoMo uses one isolated scope per conversation, replays sessions in dataset order, maps `speaker_a` to `user` and `speaker_b` to `assistant` for the whole conversation, and keeps the original speaker name on every mapped turn.

LongMemEval uses one isolated scope per question, replays the supplied history in order, and preserves each dataset `user` or `assistant` role without changing it to improve a score.

Generated summaries, observation fields, event annotations and ground-truth evidence are excluded from the headline raw-conversation protocol; an augmented protocol must be named separately and cannot replace the headline result.

## Read-only query phase

Conversation ingestion is completed before QA execution begins.

Each QA item records its original question, adapted retrieval query, planner result, recall trace, candidate identifiers and ranks, rendered context and timing.

The QA question must not be appended to memory after it is asked, and one conversation snapshot must be reusable by all of its QA items.

The answer generator receives only the original question and the retrieved context; it does not receive answer labels, evidence labels or retrieval hints derived from them.

## Checkpoint stages

Every item advances monotonically through `pending`, `ingested`, `recalled`, `answered`, `scored` and `completed`.

A retryable failure records its stage, attempt count and sanitized message; a terminal protocol, schema or fingerprint failure stops the campaign.

Checkpoint identity includes benchmark name and version, dataset SHA-256, adapter version, ingestion mapping version, runtime fingerprint, provider/model names, scorer version and timeout/retry policy.

Credential values never enter checkpoint identity or artifacts.

Checkpoint writes use a temporary file followed by an atomic rename, and completed stages are reused only when the full identity matches.

## Evidence units

The external requirement is reported through dataset identity, adapter no-leakage, conversation ingestion, recall execution, answer generation, official-compatible scoring, checkpoint resume and artifact completeness.

The current package has deterministic adapter, role-mapping and checkpoint contract tests only; these are harness evidence and do not close the empirical external requirement.

## Smoke and stop conditions

The first external run is recall-only and uses a fixed diagnostic subset from each benchmark.

If adapted queries still produce systematic empty recall, role or time mapping is unexplained, a ground-truth field appears in retrieval input, the dataset or checkpoint fingerprint changes, or the provider exceeds its retry budget, preserve artifacts and stop.

Only after recall-only smoke is non-systematically empty may the campaign call an answer provider and official-compatible scorer.

The failed LoCoMo experiment that produced empty context or a zero score remains a diagnostic result and is not evidence that closes `REQ-EVAL-035`.

## Current smoke evidence

On 2026-09-22 the real LoCoMo `conv-26` conversation replay ingested 419 turns and produced non-empty adapted recall for 9 of 12 diagnostic questions; 3 empty results remain recorded as terminal recall diagnostics.

The LongMemEval-S diagnostic replay ingested 1,035 role-preserving turns for 2 isolated questions and produced non-empty adapted recall for both; the question date was carried separately as `asOf` and was not inserted into the question text.

These smoke artifacts demonstrate that the adapter and live memory path are not systematically empty, but they do not claim full LoCoMo or LongMemEval-S answer/scorer completion and do not change the `REQ-EVAL-035` evidence status.
