# Companion evaluation corpus and metrics

Scope: the Appendix F live corpus declared in the package test tree, the Loader-backed runner that executes it, and the Appendix G aggregation computed over the raw observations that runner retains.

## Test surface

| File | Kind | Responsibility |
|---|---|---|
| `../tests/support/companion-corpus.ts` | evaluation support | Declares the thirty F.01–F.30 scenarios: setup kind, user turn, expected label, which of them need a switched-on capability, and, where no supported live path exists, an `unsupported` reason. |
| `../tests/support/companion-runner.ts` | evaluation support | Executes every supported scenario against an isolated real Loader composition, optionally calls a final-answer provider with the captured injected context, and persists attributed raw observations. |
| `../tests/support/answer-evaluation.ts` | evaluation support | Defines the injected final-answer provider request and the opt-in `DSH_MEMORY_ANSWER_ENDPOINT` HTTP adapter. |
| `../tests/support/evaluation-metrics.ts` | evaluation support | Aggregates raw observations into all 21 Appendix G fields: the 19 existing fields plus `safeUsageProjectionRate` and `rawTextWithheldRate`; four existing answer-side fields remain unsupported without generated answers. |
| `../tests/companion-eval.spec.ts` | spec | Runs the corpus once per round and, over that one set of observations, asserts each scenario reaches its expected label or fails closed with its recorded `unsupported` reason, then asserts every metric field, its arithmetic, its scenario attribution, its unsupported reasons, and the projection counts. |
| `../tests/answer-eval.spec.ts` | spec | Feeds synthetic answers and recalled documents through the aggregation seam without a model and asserts exact numerator/denominator arithmetic. |
| `../tests/runner-diagnostics.spec.ts` | spec | Asserts the runner's own evidence policies: the newest run artifacts survive while older runs — and only run directories — are removed, and a recorded failure reason carries the cause chain that classifies it. |
| `../tests/support/live-harness.ts` | shared harness | Starts one disposable Loader composition with deterministic local storage and a loopback HTTP listener. |
| `../tests/support/live-http.ts` | shared harness | Reads fixture responses without the Fetch browser port blocklist. |

## Corpus

`companionCorpus` holds one declarative representative per Appendix F category, in id order from F.01 to F.30.

Each entry names a `setup.kind`, the text used to create or mutate durable state, the user turn that follows, and an `expected` label of `correct injection`, `correct silence` or `governed use` together with the substring that must appear and the substring that must not.

Judgments describe fixture facts only: `contains`, `excludes` and `candidateJudgments` are authored against the scenario, never against runner output, so an assertion cannot be satisfied by feeding a recorded result back into the expectation.

Twenty-eight scenarios execute. Four carry an `unsupported` reason instead and are asserted as unsupported: F.21 (reranker failure), F.22 (graph failure), F.28 (observation weakening) and F.30 (deletion crash).

Three execute only when the capability they measure is switched on: F.05 marks an exact number recallable, and F.09 and F.10 require the user's hedged original to come back verbatim instead of being reduced to a non-disclosing projection. They declare `requiresEvidenceClassification`, so the runner starts their harness with `evidenceClassificationEnabled: true`, and a run with the capability off reports them as unsupported with a reason that says which capability was missing, rather than scoring them against a channel the run could not open.

## Runner

`runCompanionCorpus()` walks the corpus in order and returns the artifact path plus the raw observations the metrics aggregation consumes.

Each supported scenario gets its own temporary storage root, a real Loader composition built from `startLiveHarness`, and a stubbed provider endpoint that answers Dream and embedding requests deterministically.

The runner then drives real seams: session event appends, `memory_remember`, `memory_suppress`, the `/memory/v1` control routes for wiki pages, temporal replacement, supersession, deletion and purge, the `agent/pre-step` waterfall, and `/recall` with `/recall/debug`.

For every scenario it records the raw injected prompt, the Resident snapshot, the returned recall results, the recall trace, the wiki snapshot, the per-scenario boolean checks, every HTTP exchange, every tool result and, when configured, the generated final answer.

The answer seam receives `scenario`, `userTurn`, `injectedContext`, `resident`, `results` and `trace`. `injectedContext` is the exact serialized context captured after the live `agent/pre-step` waterfall, so the answer provider does not receive a separately reconstructed memory prompt.

The seam is opt-in. `CorpusRunOptions.answerGenerator` accepts a synchronous or asynchronous function in tests. A real campaign can set `DSH_MEMORY_ANSWER_ENDPOINT` to an HTTP endpoint that accepts a JSON POST containing `scenarioId`, `userTurn`, `injectedContext`, `resident`, `results` and `trace`, and returns `{"answer":"..."}`. Without the option or environment variable, no answer is generated and the four answer-side fields retain their existing `unsupported` reasons.

A scenario that throws is recorded with status `error`, its stack and its whole cause chain instead of being dropped, so a broken environment cannot silently shrink a denominator and a transport failure keeps the `fetch failed` cause that classifies it.

### Drain budget

`evidenceDrainBudgetMs(events)` bounds both the readiness fetch and the residual poll that wait on the L0 write chain, and it is derived from that chain's measured cost rather than from a constant that predates it.

One append persists the session record it wrote and defers the two records derived from it, so `n` appended lines cost about 1.1 durable writes per line instead of one whole-scope rewrite per line. Measured through this fixture on an idle machine, the chain behind a burst of `n` appends costs 0.58 s at n=60, 1.49 s at n=150 and 3.43 s at n=300 — a slope of roughly 11 ms per append, near enough linear that the previous allowance of 150 ms per append, which priced an O(n^2) rewrite per line, no longer describes it.

The budget charges four times that slope, because the same chain stretches when parallel forks contend for one disk, and adds a flat ten seconds for a store that has not finished `load()` yet, the drain's own HTTP round trip, and scheduler delay. A healthy drain finishes well inside it: the point of the budget is to fail a stall that keeps moving, not to wait it out.

## Raw artifacts

Each run writes `tests/artifacts/companion-<random>/raw-results.json` with `schemaVersion` 1: an outcomes array in corpus order, rewritten after every scenario so a crash still leaves partial evidence.

The corpus executes once per round, so one round mints one run directory. `runCompanionCorpus` prunes the artifacts directory before it mints its own run directory, retaining the newest two and then adding this round's, so a round leaves at most `RETAINED_RUNS` (three) run directories rather than one more per round.

Pruning runs before the new directory is created so the retained set is the newest directories on disk, which is the set a concurrently started run could still be writing into; the pruning never touches entries without the `companion-` prefix, including the directory's own `.gitignore`.

`../tests/artifacts/.gitignore` ignores the whole directory except itself, so artifacts stay local and no run output reaches a commit.

## Aggregation contract

`aggregateMetrics(outcomes, k = 8)` computes all 21 fields in one pass and returns `Metric` records carrying `status`, `value`, `numerator`, `denominator`, `scenarios`, `scope` and, when unmeasured, `reason`. The original Appendix G field count is 19; the added fields are `safeUsageProjectionRate` and `rawTextWithheldRate`.

It rejects a batch containing an `error` row, a batch with duplicate scenario identifiers, and a `k` that is not a positive integer.

Scenarios with status `unsupported` are excluded from every denominator and are never counted as a zero result, so a field nobody can measure is reported as `unsupported` with a reason rather than as a perfect score.

## Metric fields

| Field | Side | Definition | Computation |
|---|---|---|---|
| `candidatePrecision` | Write | Share of extracted Dream candidates a human judge marked worth durable storage. | Over F.03 snapshot candidates: worthy candidates divided by extracted candidates, where an outcome missing a judgment raises instead of being skipped. |
| `authorityViolationRate` | Write | Share of authority trials that accepted a claim lacking user evidence or explicit management action. | Over F.03, F.09 and F.10: mean of 1 when the recorded `authority` check is not true, meaning the Dream page carried the inferred claim or `memory_remember` accepted a claim absent from the latest raw user message. |
| `semanticDriftRate` | Write/Product | Answer content moving away from the memory it is expected to use. | When a generated answer has an explicitly injected raw memory, this uses a named lexical-overlap proxy: the result is 1 when the answer shares no non-stopword token with that memory. It does not detect paraphrase or judge meaning. Without answers it keeps the existing `unsupported` reason. |
| `correctionPropagation` | Write | Share of correction trials whose replacement reached canonical state while the superseded text disappeared. | Over F.06 and F.08: mean of the recorded `correction` check. |
| `recallAtK` | Read | Share of queries whose one relevant target is returned inside the cutoff. | Over the ten supported ranking scenarios: mean of 1 when the first result containing the scenario's `contains` target sits at rank 1..k; an absent target scores 0. |
| `mrr` | Read | Mean reciprocal rank of that same target. | Over the same ten: `1 / rank`, or 0 when the target is absent. |
| `ndcg` | Read | Binary NDCG@k with an ideal DCG of 1. | Over the same ten: `1 / log2(rank + 1)` inside the cutoff, otherwise 0. |
| `exactDetailRecovery` | Read | Share of exact number and exact name trials whose literal value reached Agent injection. | Over F.05 and F.06: mean of 1 when the injected prompt contains the expected literal, which for F.05 is the L0 channel returning the user's own line. |
| `temporalAccuracy` | Read | Share of temporal trials that include the current value and exclude the superseded one. | Over F.07 and F.26: mean of 1 when `inclusion` is true and `exclusion` is not false. |
| `multiHopSuccess` | Read | Share of multi-hop trials that retrieve the linked destination through the graph channel. | Over F.29: 1 when a returned result carries the `graph` channel and contains the linked destination; answer generation is not measured. |
| `negativeRecallPrecision` | Read | Share of negative trials that disclose no forbidden raw text. | Over F.11, F.12, F.14, F.17, F.25 and F.27: mean of 1 when the excluded text appears neither in injection nor, outside the utility trial, in Resident. |
| `forgetLeakage` | Read | Share of forget trials retaining a derived trace. | Over F.15: 1 when `derivedLeakage` is not true, meaning the forgotten text survives in no canonical page, candidate, Resident, recall result or injection; the retained raw Session is disclosed and excluded. |
| `purgeLeakage` | Read | Share of purge trials retaining a derived or on-disk trace after restart. | Over F.16: 1 when `derivedLeakage` is not true or the configured storage-domain scan found a file containing the purged text. |
| `falsePersonalizationRate` | Product | Share of replies asserting an unconfirmed personal claim. | Over F.03, F.09 and F.10 when answers exist: 1 when the answer contains the scenario's excluded claim or a deterministic first-person claim with content tokens absent from supplied memory and the current user turn. |
| `unwantedMentionRate` | Product | Share of replies disclosing protected or unsolicited memory absent from authorized injection. | Over F.11 and F.12 when answers exist: 1 when the answer contains the scenario's excluded text or a recalled result whose raw text was not explicitly authorized by the injected context. |
| `memoryOveruseRate` | Product | Share of utility turns whose answer drags in irrelevant memory. | Over F.27 when an answer exists: 1 when the answer contains the scenario's excluded memory or an unauthorized recalled result. |
| `falsePersonalizationInjectionRate` | Product | Injection-side proxy for `falsePersonalizationRate`. | Over F.03, F.09 and F.10: mean of 1 when the excluded unconfirmed claim appears in the injected prompt or Resident. |
| `unwantedMentionInjectionRate` | Product | Injection-side proxy for `unwantedMentionRate`. | Over F.11 and F.12: mean of 1 when the excluded sensitive text appears in the injected prompt or Resident. |
| `memoryOveruseInjectionRate` | Product | Injection-side proxy for `memoryOveruseRate`, covering dynamic recall only. | Over F.27: 1 when recall returned results or the injected pre-step payload is not the empty array. |
| `safeUsageProjectionRate` | Projection | Share of recalled result documents carrying a persisted `SafeUsageProjection`. | Over every returned `RecallResult`: projection-bearing documents divided by all returned documents; `scenarios` records the owning scenario once per returned document. |
| `rawTextWithheldRate` | Projection | Share of recalled result documents whose raw text was removed by disclosure gating. | Over every returned `RecallResult`: projection documents with non-`normal` disclosure and empty `text`, divided by all returned documents; this uses the `RecallResult` fields emitted by the gate. |

## Unsupported measurements

Without a final-answer generator, four answer-side fields have no observable subject in this fixture and are reported as `unsupported` with a reason, never as zero. The 21-field output retains the 19 existing fields and adds the two projection fields, which are independently measured from recalled documents.

`semanticDriftRate` is still unsupported without generated answers because the deterministic Loader fixture has no answer subject. With answers, it is only the lexical-overlap proxy described in the metric table, not a semantic equivalence judgment.

`falsePersonalizationRate`, `unwantedMentionRate` and `memoryOveruseRate` need final assistant answers. Their deterministic checks use authored scenario markers and token presence, so they do not replace human or model judgment. The three injection proxies remain separate model-input measurements.

## Running the answer campaign

The keyless focused suite runs with no answer provider and therefore checks the four unsupported states plus the projection arithmetic. Run it with `pnpm exec vitest run packages/bundle/riko-memory/tests/companion-eval.spec.ts packages/bundle/riko-memory/tests/answer-eval.spec.ts --reporter=dot`.

For an opt-in provider campaign, set `DSH_MEMORY_ANSWER_ENDPOINT` to an endpoint that returns the documented JSON answer response, then run the same command. The endpoint must be able to answer one POST per supported scenario; provider failures are recorded as execution errors and are not scored as successful answers. This workspace does not contain a provider key, so no real answer campaign can be verified here.

## F.05 exact number

F.05 asks whether an exact number written in a raw user turn stays recallable, and capture classification answers it: the locker number is an identifier-shaped claim, so the rule set keeps it `normal`, and an explicit question about it reaches the L0 channel and returns the user's own line.

The trial executes, and it is scored only where its one binary target belongs: `exactDetailRecovery` counts F.05 and F.06, while `recallAtK`, `mrr` and `ndcg` rank all ten supported ranking scenarios.

`../tests/companion-eval.spec.ts` asserts that F.05 recovers its literal through a `evidence` result whose mention decision is `explicit`, and that it is cited by no other field, so a later change cannot quietly widen or narrow where it counts.
