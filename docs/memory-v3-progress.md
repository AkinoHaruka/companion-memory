# Memory V3 Progress

Scope / owner: Canonical `packages/bundle/riko-memory` runtime declarations, implementation evidence and phase ledger.

Baseline reference: working-tree verification refreshed on 2026-09-24; no repository commit identifier is recorded because maintained documentation rejects commit identifiers.

Canonical package: `C:\TRAE\Riko-dsh\deepseek-harness\packages\bundle\riko-memory`.

Current phase: Phase 5 hardening and evaluation remains PARTIAL. V3.1 decision semantics have runtime implementations and focused tests, and the Appendix F corpus and Appendix G aggregation now run in the package suite, but the live acceptance matrix and production evaluation gates are not complete.

PASS means the current package evidence for the row is green. PARTIAL means the implementation exists but one or more named acceptance gates remain open. NOT STARTED means no implementation or evidence exists for the named scope.

## Baseline evidence

- Package typecheck: from the worktree root, `pnpm exec tsc -p tsconfig.host.json --noEmit` and `pnpm exec tsc -p tsconfig.client.json --noEmit` — both PASS. The package `tsconfig.json` is not evidence for test code: its `include` is only `src`, so it never compiles `tests/`.
- Current recorded package suite: `docs/spec-execution-report.json` records `47` spec files, `422` tests, `420` passed, `0` failed and `2` refresh-only skipped checks. The default no-credential run is `407 passed / 15 skipped / 0 failed`; isolated provider evidence includes Gemini empirical decision 4/4, companion 28 executed plus 2 unsupported, real semantic gain 5/5 and dense ablation 4/4.
- Current text-model acceptance set: Dream uses `gemini-3.5-flash-lite` as primary and `gemma-4-26b-a4b-it` as the only qualified fallback. Gemma 4 31B remains only in historical failure artifacts and is not a formal model candidate.
- Documentation suite after this ledger and linked-document refresh: from the worktree root, `pnpm run test:docs` — `run-gates: 20 passed, 0 failed, 0 skipped`; `pnpm run doc-sync` — `41 passed, 0 failed`.
- The Appendix F corpus runner covers 30 representative scenarios and the Appendix G aggregation covers 21 fields, both described in [companion-eval.md](companion-eval.md). The GAP-01 through GAP-09 baseline audit is recorded in [gap-baseline-audit.md](gap-baseline-audit.md). Focused load, restart, purge-interruption and keyless chaos probes exist; production-scale load/chaos evaluation remains open.

The latest real Dream smoke completed the full path for three independent Gemini sessions and three independent Gemma 26B sessions: conversation → native Google Dream → exact user-grounded Wiki confirmation → Resident → system prompt → `agent/pre-step` recall. A forced Gemini network failure called Gemma 26B once, produced one exact confirmed page, and made no third provider call or partial Wiki write. This proves the controlled failover path; it does not close the external quality requirement `REQ-EVAL-035`.

## Evaluation contract ledger

Any mandatory item with `FAIL` makes `Overall = FAIL`; a phase may be marked `PASS` only when every mandatory delivery gate is `PASS`.

| Gate transition | Required predecessor | Next phase | User confirmation |
|---|---|---|---|
| Phase 0 complete | Phase 0 PASS | Phase 1A | none |
| Phase 1A complete | Phase 1A PASS | Phase 1B | none |
| Phase 1B complete | Phase 1B PASS | Phase 2 | none |
| Phase 3 complete | Phase 3 PASS | Phase 4 | none |
| Phase 4 start | Phase 0, 1A, 1B, 2 and 3 all PASS | Phase 4 | none |

The phase rows are ledger transition rules; they do not claim that the current package evidence has passed every named acceptance gate.

Every phase PASS requires all eight mandatory delivery dimensions to be PASS: Runtime Wiring; Persistence / Migration; Unit Tests; Integration Tests; Behavior Acceptance; Failure Fallback; Rollback; Docs.

The current recall path uses scalar `rrfK` only and has no weighted channel coefficients; REQ-EVAL-001 therefore has a static applicability guard, and the real Gemini campaign confirmed the weighted branch remains inactive; introducing weighted channels would still require empirical calibration.

LongMemEval and LoCoMo remain conditional external campaigns. The current fixed-cohort result and its quality limitation are recorded in [external-benchmark-protocol.md](external-benchmark-protocol.md); recall-only smoke evidence is historical and does not close `REQ-EVAL-035`.

The Gemini-backed F.29 campaign measured `graphMaxHop=1` and recovered the linked destination, so no empirical insufficiency trigger for PPR was observed; REQ-RCL-037 remains conditional and the current bounded graph path does not activate PPR.

Answer-side unwanted-mention arithmetic has deterministic proxy coverage; provider-backed regression evidence remains required for REQ-PERF-011.

## STOP conditions and rollback security window

Execution may stop only for an inaccessible canonical source, an unestablishable baseline whose cause cannot be isolated, a required provider secret with no fake or local path, an imminent production hard purge, an irreversible real-data schema migration risk, a lifecycle seam proven unavailable for same-turn recall, or an undefined major privacy or product-semantics conflict.

Routine implementation choices such as the BM25 library, file names, interface decomposition, test choice, phase continuation, mock choice and helper-versus-service order are not STOP conditions.

No known rollback security issue is currently recorded for this package; if one is discovered, the compatibility rollback is limited to one package release and must be recorded in the relevant migration note before use.

## Phase ledger

| Phase | Status | Material files | Exact evidence | Gates NOT met |
|---|---|---|---|---|
| Phase 0 | PASS | `src/index.ts`, `src/contracts.ts`, `src/memory-domain.ts`, `src/store.ts`, `src/types.ts`, `tests/contracts.spec.ts`, `tests/store.spec.ts`, `tests/loader-composition.spec.ts` | Package typecheck PASS; the current package report covers 47 files / 422 tests with 420 passed, 0 failed and 2 refresh-only skips; scoped L0 → Dream → Candidate → Wiki → Resident routes and storage-domain records are exercised. | The production-scale benchmark and load/chaos evaluation remain tracked under Phase 5. |
| Phase 1A | PASS | `src/index.ts`, `src/store.ts`, `src/types.ts`, `tests/live-scenarios.spec.ts`, `tests/loader-composition.spec.ts`, `tests/recovery.spec.ts`, `tests/store.spec.ts` | The V4 baseline `live-scenarios.spec.ts` R1A-01 through R1A-12 pass, including bounded whole-item Resident output, sensitivity filtering, last-valid fallback, restart recovery and Agent system-prompt assembly. | A production benchmark and repository-wide coverage evidence are not part of this package run; focused load/chaos probes exist, but production-scale evaluation remains open. |
| Phase 1B | PASS | `src/index.ts`, `src/recall.ts`, `src/embedding-provider.ts`, `src/vector-index.ts`, `src/store.ts`, `tests/live-scenarios.spec.ts`, `tests/live-flag-matrix.spec.ts`, `tests/evidence-classification-surface.spec.ts`, `tests/dense-routing.spec.ts`, `tests/vector-index.spec.ts`, `tests/recall.spec.ts`, `docs/recall-v1.md` | The Agent pre-step and HTTP recall route pass the configured embedding provider; Q1B-09 and Q1B-10 cover provider degradation and vector-index rebuild, dense routing and index tests pass, the 12 non-classification `*Enabled` switches pass through the Loader matrix, and the remaining `evidenceClassificationEnabled` switch passes through the Loader surface test. | Live reranking is intentionally out of scope by decision; the decision is recorded in [recall-v1.md](recall-v1.md). |
| Phase 2 | PASS | `src/memory-domain.ts`, `src/types.ts`, `src/store.ts`, `src/wiki.ts`, `src/index.ts`, `tests/live-scenarios.spec.ts`, `tests/live-projection-conflict.spec.ts`, `tests/ambiguous-conflict.spec.ts`, `tests/recovery.spec.ts`, `tests/wiki.spec.ts` | T2-01 through T2-06 pass for current/history temporal selection, corrections, interval closure, bounded Resident output and contested current reads; `ambiguous-conflict.spec.ts` passes candidate, overlay, persistence and correction behavior; `live-projection-conflict.spec.ts` covers the real Loader conflict-injection path. | The complete conflict evaluation matrix remains open; focused load/chaos probes exist under Phase 5. |
| Phase 3 | PARTIAL | `src/types.ts`, `src/store.ts`, `src/recall.ts`, `src/index.ts`, `tests/live-scenarios.spec.ts`, `tests/live-flag-matrix.spec.ts`, `tests/observation-activation.spec.ts`, `tests/observation-evidence-live.spec.ts`, `tests/sensitivity-provisional.spec.ts`, `tests/loader-composition.spec.ts` | M3-01 through M3-08 pass for anchors, distinct evidence, confidence, contradiction weakening, sensitivity, recall status, reflection degradation and the reflection-failure audit; the Loader-backed evidence route rejects a mismatched profile and invalidates an owned observation when contradictions outnumber supports; Dream calls `reflectObservations()` when `reflectionEnabled` is true. | Sensitivity FN/FP metrics and the validated hedged silent-use benchmark are not met. |
| Phase 4 | PARTIAL | `src/wiki.ts`, `src/store.ts`, `src/recall.ts`, `src/index.ts`, `tests/live-scenarios.spec.ts`, `tests/entity-alias-resolution.spec.ts`, `tests/recall.spec.ts`, `tests/empirical-decision-campaign.spec.ts` | G4 graph negatives and Q6 alias tests pass for bounded graph traversal, scope isolation, explicit coreference, contested inference, invalidation and canonical-preserving rebuild; F.29 also runs through the real Gemini embedding path and records one-hop recovery, so the campaign did not justify PPR. | A full live management/Agent alias lifecycle matrix and entity resolution beyond bounded wikilink graph expansion are not met; production-scale load/chaos evaluation remains open. |
| Phase 5 | PARTIAL | `src/store.ts`, `src/index.ts`, `src/memory-domain.ts`, `src/vector-index.ts`, `tests/live-scenarios.spec.ts`, `tests/live-projection-conflict.spec.ts`, `tests/loader-composition.spec.ts`, `tests/recovery.spec.ts`, `tests/silent-use-projection.spec.ts`, `tests/ambiguous-conflict.spec.ts`, `tests/companion-eval.spec.ts`, `tests/answer-eval.spec.ts`, `tests/resilience-load.spec.ts`, `tests/resilience-restart-purge.spec.ts`, `tests/chaos-dense-ablation.spec.ts`, `tests/dense-ablation.spec.ts`, `tests/persistence-complexity.spec.ts`, `tests/runner-diagnostics.spec.ts`, `tests/empirical-decision-campaign.spec.ts` | Purge acceptance, restart recovery, persisted vector metadata, aliases, `SafeUsageProjection` and `ConflictOverlay` load/rebuild/persist paths pass in the package suite; the real Loader projection and conflict-injection assertions pass; purge supports dry-run, exact confirmation and verified completion; the Appendix F corpus covers 28 executed and 2 unsupported scenarios and the Appendix G aggregation produces 21 attributed fields from raw observations. The native Gemini/Gemma Dream smoke covers exact grounding, confirmed Wiki, Resident, system prompt and `agent/pre-step` recall; the forced Gemini → Gemma 26B failover makes one fallback call and preserves atomic Wiki writes. Real embedding semantic gain reaches 5/5 and dense ablation passes 4/4. | Four Appendix F answer-side metrics remain explicitly unsupported without a final-answer generator; the two projection metrics are direct measurements, not answer judgments. The external LoCoMo/LongMemEval quality requirement `REQ-EVAL-035` remains open, as do production-scale load/chaos gates. |

## V3.1 Decision Semantics

The normative decisions are recorded in [v3.1-decision-semantics.md](v3.1-decision-semantics.md). These rows measure the current runtime and acceptance evidence, not only declarations in types or storage schemas.

| Decision | Status | Material files and exact evidence | Gates NOT met |
|---|---|---|---|
| Q1 Sensitivity permission | PARTIAL | `src/types.ts`, `src/store.ts`, `src/recall.ts`, `tests/sensitivity-provisional.spec.ts`, `tests/live-scenarios.spec.ts`; provisional transitions, conservative recall and sensitive observation exclusions pass. | Live authority matrix plus Sensitive False Negative Rate and Sensitive False Positive Rate metrics are not met. |
| Q2 SafeUsageProjection for `silent_use` | PARTIAL | `src/types.ts`, `src/memory-domain.ts`, `src/store.ts`, `src/recall.ts`, `tests/silent-use-projection.spec.ts`, `tests/live-projection-conflict.spec.ts`; projections are generated, persisted, reloaded, rebuilt and consumed without the raw body, and the real Loader Agent assertion covers projection-only injection. | The two direct projection fields are measured; complete projection metrics beyond them are not met. |
| Q3 Contested conflict overlay | PARTIAL | `src/types.ts`, `src/memory-domain.ts`, `src/store.ts`, `src/index.ts`, `tests/ambiguous-conflict.spec.ts`, `tests/live-scenarios.spec.ts`, `tests/live-projection-conflict.spec.ts`; `pending_conflict`, persisted `ConflictOverlay`, contested reads, authenticated HTTP listing/resolution, management release, reviewed resolution and the real Loader quarantine/release path pass without unreviewed canonical mutation. | The complete conflict evaluation matrix is not met. |
| Q4 Observation activation | PARTIAL | `src/types.ts`, `src/store.ts`, `src/index.ts`, `tests/observation-activation.spec.ts`, `tests/live-flag-matrix.spec.ts`, `tests/live-scenarios.spec.ts`; automatic evidence/session/confidence thresholds, authenticated management status changes, sensitivity exclusion, contradiction weakening, optional Dream reflection and the reflection-failure audit pass. | Sensitivity FN/FP metrics and validated hedged silent-use evaluation are not met. |
| Q5 Dense recall expansion | PASS | `src/recall.ts`, `src/embedding-provider.ts`, `src/vector-index.ts`, `src/store.ts`, `tests/dense-routing.spec.ts`, `tests/vector-index.spec.ts`, `tests/live-flag-matrix.spec.ts`, `tests/evidence-classification-surface.spec.ts`, `tests/live-scenarios.spec.ts`; planner gating, separate dense cap, provider degradation, index rebuild and all 13 live `*Enabled` switches pass across the Loader matrix and surface test, and Appendix G reports Recall@8, MRR and NDCG over the ten supported ranking scenarios. | Live reranking is intentionally out of scope by decision; see [recall-v1.md](recall-v1.md). |
| Q6 Revocable aliases | PARTIAL | `src/memory-domain.ts`, `src/store.ts`, `src/index.ts`, `tests/entity-alias-resolution.spec.ts`, `tests/live-scenarios.spec.ts`; explicit coreference, contested inference, invalidation and canonical-preserving rebuild pass. | A full live HTTP/Agent authority matrix and entity resolution beyond bounded wikilink graph expansion are not met. |

## Appendix F and Appendix G evaluation

The corpus, runner, aggregation contract, artifact layout and per-field computation are documented in [companion-eval.md](companion-eval.md).

Appendix F is covered by `tests/companion-eval.spec.ts`, which runs the corpus once and asserts all thirty scenarios: twenty-eight reach their expected label and two are asserted as `unsupported` with their recorded reason (F.21 and F.22). Three of the twenty-eight — F.05, F.09 and F.10 — declare `requiresEvidenceClassification`, so the runner starts their harness with the capture classifier on and reports them as unsupported, with a reason naming the missing capability, in any run that starts with it off.

Appendix G is covered by the same `tests/companion-eval.spec.ts` run, which drives `tests/support/evaluation-metrics.ts` over the raw observations and covers 21 fields: 17 carry a measured value with a numerator, denominator and scenario list, and four answer-side fields are reported `unsupported` with a reason (`semanticDriftRate`, `falsePersonalizationRate`, `unwantedMentionRate`, `memoryOveruseRate`).

| Field | Status | Proving test |
|---|---|---|
| `candidatePrecision` | measured, 0/1 candidate worth keeping | scores candidate, correction, temporal, exact-detail and multi-hop fields from live checks |
| `authorityViolationRate` | measured, 0 violations over 3 trials | reports zero authority violations for the dream and rejected remember trials |
| `semanticDriftRate` | unsupported, no consolidation provider | marks fields with no live surface as unsupported with their own reason |
| `correctionPropagation` | measured, 2/2 corrections propagated | scores candidate, correction, temporal, exact-detail and multi-hop fields from live checks |
| `recallAtK` | measured, 10/10 targets inside Recall@8 | scores recall, MRR and NDCG from the returned live results |
| `mrr` | measured, reciprocal rank 1.0 over 10 trials | scores recall, MRR and NDCG from the returned live results |
| `ndcg` | measured, binary NDCG@8 of 1.0 over 10 trials | scores recall, MRR and NDCG from the returned live results |
| `exactDetailRecovery` | measured, 2/2 supported exact-detail trials | scores candidate, correction, temporal, exact-detail and multi-hop fields from live checks |
| `temporalAccuracy` | measured, 2/2 temporal trials | scores candidate, correction, temporal, exact-detail and multi-hop fields from live checks |
| `multiHopSuccess` | measured, 1/1 graph retrieval | scores candidate, correction, temporal, exact-detail and multi-hop fields from live checks |
| `negativeRecallPrecision` | measured, 6/6 negative trials clean | reports zero sensitive disclosure for the unsolicited mention trials |
| `forgetLeakage` | measured, 0 leakage over 1 trial | reports zero forget leakage for the derived-forget trial |
| `purgeLeakage` | measured, 0 leakage over 1 trial | reports zero purge leakage across live state and storage-domain files |
| `falsePersonalizationRate` | unsupported, no generated answers | marks fields with no live surface as unsupported with their own reason |
| `unwantedMentionRate` | unsupported, no generated answers | marks fields with no live surface as unsupported with their own reason |
| `memoryOveruseRate` | unsupported, no generated answers | marks fields with no live surface as unsupported with their own reason |
| `falsePersonalizationInjectionRate` | measured, 0/3 injection-side | reports zero authority violations for the dream and rejected remember trials |
| `unwantedMentionInjectionRate` | measured, 0/2 injection-side | reports zero sensitive disclosure for the unsolicited mention trials |
| `memoryOveruseInjectionRate` | measured, 0/1 injection-side | reports zero memory-overuse injection on the utility trial |
| `safeUsageProjectionRate` | measured, 19/19 recalled documents | counts recalled documents carrying a persisted SafeUsageProjection |
| `rawTextWithheldRate` | measured, 2/19 recalled documents | counts recalled documents whose disclosure gate withheld raw text |

## Still NOT met

- The Appendix F corpus is thirty representative scenarios rather than the 200–500-scenario production benchmark, so scenario-count coverage is not met.
- The fixed cohort completed answer/scorer execution for 49/50 LoCoMo items and 50/50 LongMemEval-S items, but relevance and answer quality remain below the closure bar; `REQ-EVAL-035` stays open.
- F.21 and F.22 remain unsupported because no supported live path can inject their faults; each carries its reason in `tests/support/companion-corpus.ts`. F.28 creates an active observation through `POST /observations`, submits contradicting evidence through `POST /observations/:id/evidence`, and expects the observation to become `invalidated` when contradictions outnumber supports. F.30 seeds a started purge journal through the real Loader storage domain, restarts the Loader, and checks completion with no cascade residue.
- F.05 is no longer among them: with `evidenceClassificationEnabled` the locker number classifies as `normal` at capture, so an explicit question reaches the L0 channel. F.05, F.09 and F.10 declare `requiresEvidenceClassification` and are reported unsupported only in a run that starts with the capability off.
- `semanticDriftRate` and the three answer-side product rates remain unsupported because this fixture never generates a final assistant answer.
- Focused resilience coverage now exists: the load spec exercises 240 pages and 2,000 evidence records, the restart/purge spec covers failed rebuild, restart mismatch, purge interruption and failed-write rollback, and the keyless chaos spec prints 0/12 unique gain, 60/60 dense noise and 36/96 gate rejection. The dense-ablation comparison prints 0/16 unique gain, 2/9 dense noise and 0/9 gate rejection. These keyless values are routing/selection measurements, not BGE quality results; production-scale load/chaos evaluation remains open.

## Known local limitation

- A fork worker is occasionally terminated on Windows under Node 24.15.0 — 5 of 32 runs at default parallelism, once with two workers in one run — which drops a spec file's results and makes Vitest report `Worker exited unexpectedly`. No assertion fails. The worker fails fast: Windows reports exit code `3221226505` (`0xC0000409`, `__fastfail`), no JavaScript handler runs, no stderr text is written, and no Windows Error Reporting entry or dump appears, so Vitest cannot show the cause. Earlier package-suite runs passed under Node 24.21.0 (45 runs, 20 of them with pnpm 11.7.0), Node 22.19.0 (25 runs) and Node 26.9.0 (30 runs), so the plugin was not the source; a second host also did not reproduce it (0 of 78 runs). Run the current 32-file suite on Node 24.21.0 or newer, which is the release the CI `PRIMARY_NODE_VERSION: '24'` installs. On an affected runtime, treat a lost file as runtime loss and re-run before reading a red count.
