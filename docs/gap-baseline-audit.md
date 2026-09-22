# GAP Baseline Audit

Recorded on 2026-09-21 from the execution contract, the current package progress ledger and the executed package tests.

The status vocabulary is deliberately limited to `CONFIRMED`, `ALREADY_FIXED` and `NOT_APPLICABLE_WITH_REASON`; `ALREADY_FIXED` means the original baseline condition is covered by the current live path and named tests, while `CONFIRMED` means the condition remains an explicit open limitation.

| Gap | Status | Current evidence | Remaining meaning |
|---|---|---|---|
| GAP-01 | ALREADY_FIXED | `docs/recall-v1.md`; `tests/live-scenarios.spec.ts`; `tests/loader-composition.spec.ts` | Live recall now runs from the current user turn through governed recall and prompt assembly. |
| GAP-02 | ALREADY_FIXED | `tests/live-scenarios.spec.ts`; `tests/resilience-load.spec.ts`; `docs/migration-phase-2-temporal-resident.md` | Resident selection is bounded before injection and whole items are retained; production-scale evidence remains separate. |
| GAP-03 | ALREADY_FIXED | `tests/sensitivity-provisional.spec.ts`; `tests/live-scenarios.spec.ts`; `tests/silent-use-projection.spec.ts` | Sensitivity participates in Resident and recall eligibility; metric calibration remains open. |
| GAP-04 | ALREADY_FIXED | `tests/live-scenarios.spec.ts`; `tests/ambiguous-conflict.spec.ts`; `docs/migration-phase-2-temporal-resident.md` | Current/history selection, corrections and temporal interval behavior are exercised. |
| GAP-05 | ALREADY_FIXED | `tests/observation-activation.spec.ts`; `tests/observation-evidence-live.spec.ts`; `tests/live-projection-conflict.spec.ts` | Inferred observations remain distinct from confirmed canonical records and cannot self-authorize mention. |
| GAP-06 | ALREADY_FIXED | `tests/recall.spec.ts`; `tests/live-scenarios.spec.ts`; `tests/evidence-classification-surface.spec.ts` | Live recall uses governed eligibility and is not a direct management search injection. |
| GAP-07 | ALREADY_FIXED | `tests/live-scenarios.spec.ts`; `docs/recall-v1.md` | Bounded graph recall is covered while PPR and graph-first expansion remain intentionally out of scope. |
| GAP-08 | CONFIRMED | `tests/resilience-restart-purge.spec.ts`; `docs/migration-phase-3-5-hardening.md` | The current release provides derived forget and journaled purge paths; a future hard purge must clear every derived and audit payload. |
| GAP-09 | CONFIRMED | `tests/live-scenarios.spec.ts`; `docs/migration-phase-3-5-hardening.md` | Deletion remains safely ID-driven; natural-language target resolution is not yet a supported contract. |

This audit records the baseline status; it does not promote any requirement status from `unassessed` to `verified`.
