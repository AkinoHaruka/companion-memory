# External Benchmark Protocol

This protocol defines the only permitted path for closing `REQ-EVAL-035`; it is a test-layer evaluation contract and does not add a production benchmark mode to the runtime.

## Separation of question and retrieval query

`originalQuestion` is the exact benchmark question used by the answer generator and official scorer.

`retrievalQuery` is produced by the fixed `benchmark-query-v2` adapter, which adds a memory-intent cue and a no-invention instruction without using production temporal cues such as `before`, `earlier`, `last year` or `recent`.

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

The adapter has deterministic planner regression cases for personal questions shaped like `What is`, `Who is` and `Where did`, plus a genuinely temporal question; ordinary personal questions must not become temporal only because of the adapter.

Answer artifacts preserve the model's `rawAnswer` and record a deterministic `scoredAnswer` under `answer-normalization-v1`; paired `thought` wrappers are removed only from the scorer input and never from the raw artifact.

## Checkpoint stages

Every item advances monotonically through `pending`, `ingested`, `recalled`, `answered`, `scored` and `completed`.

A retryable failure records its stage, attempt count and sanitized message; a terminal protocol, schema or fingerprint failure stops the campaign.

Checkpoint identity includes benchmark name and version, dataset SHA-256, adapter version, ingestion mapping version, runtime fingerprint, provider/model names, scorer version and timeout/retry policy.

Credential values never enter checkpoint identity or artifacts.

Checkpoint writes use a temporary file followed by an atomic rename, and completed stages are reused only when the full identity matches.

Each run summary reports the fixed cohort denominator, non-empty recall, generated answers, successfully scored answers, effective completion rate, empty recall, answer-provider failures and scorer failures separately; provider or protocol failures are never counted as wrong answers.

The live answer/scorer runner uses one fixed worker lane per configured text model and pulls the next unfinished item from a shared queue whenever that model finishes; it does not pre-assign a disjoint question range to a model. An item retries the same model for ordinary empty-output or protocol failures, and only repeated provider-unavailable errors such as 429, 5xx, timeout or network failure permit failover to the next model. If every configured model is unavailable, the runner keeps cycling and retrying until one provider recovers. The embedding model is never used for text generation.

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

## Fixed-cohort v2 result

The 2026-09-22 v2 fixed cohort contains 50 LoCoMo items and 50 LongMemEval-S items. LoCoMo completed recall for 50 items, produced non-empty context for 49, and completed answer/scoring for 49 with mean official-compatible F1 0.0149; one item remains a recorded empty-recall failure. LongMemEval-S completed recall, answer generation and yes/no scoring for all 50 items, with 9 judged correct and 41 judged incorrect. That historical benchmark used three configured text models and both campaigns recorded zero API failures and zero scorer failures. The current formal Dream set is narrower: `gemini-3.5-flash-lite` primary plus `gemma-4-26b-a4b-it` fallback; Gemma 4 31B remains historical evidence only.

The complete checkpoint, hypothesis, score and failure records are published under `docs/benchmark-results/riko-memory-v2-fixed-cohort-2026-09-22/`. These results validate the resumable execution path, not the quality of the memory capability: traces were dominated by raw-evidence fallback, and non-empty context was not reliably relevant. `REQ-EVAL-035` therefore remains open and the package capability status remains unassessed.
