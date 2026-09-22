import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const packageDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function readDocument(name: string): string {
  return readFileSync(join(packageDirectory, 'docs', name), 'utf8')
}

function containsAll(text: string, terms: readonly string[]): void {
  for (const term of terms) expect(text).toContain(term)
}

describe('static normative contract gates', () => {
  it('keeps the canonical owner, mirror and capability downgrade explicit', () => {
    const readme = readFileSync(join(packageDirectory, 'README.md'), 'utf8')
    const baseline = readDocument('memory-architecture-baseline.md')
    const capability = JSON.parse(readDocument('capability-status.json')) as { overall?: string }
    containsAll(readme, [
      'The canonical source is `packages/bundle/riko-memory`',
      'source mirror of this bundle',
      'not a claim that every production evaluation gate is complete',
    ])
    containsAll(baseline, ['storage-domain', 'journaled transaction', 'No parallel SQLite'])
    expect(capability.overall).toBe('unassessed')
  })

  it('requires the baseline to record runtime write and read paths', () => {
    const baseline = readDocument('memory-architecture-baseline.md')
    containsAll(baseline, [
      'Session event',
      'storageDomain:riko_memory.sessions',
      'Explicit remember / candidate confirm / Wiki write',
      'storageDomain:riko_memory.pages',
      'Current user message with recallEnabled',
      'agent/pre-step',
      'canonical lexical + raw L0 lexical',
    ])
  })

  it('requires the baseline to inventory concepts, tables and failure paths', () => {
    const baseline = readDocument('memory-architecture-baseline.md')
    containsAll(baseline, [
      'canonical Wiki',
      'Resident projection',
      'RecallPlan',
      'Dream provider',
      'observations',
      'purges',
      'index_meta',
      'vectors',
      'Dream/provider failure records a sanitized error',
      'Raw purge is disabled by default and journaled',
    ])
  })

  it('requires the baseline and progress ledger artifacts to exist with evidence columns', () => {
    const baseline = readDocument('memory-architecture-baseline.md')
    const progress = readDocument('memory-v3-progress.md')
    containsAll(baseline, ['# Riko Memory architecture baseline', '## Baseline evidence'])
    containsAll(progress, [
      '## Phase ledger',
      '| Phase | Status | Material files | Exact evidence | Gates NOT met |',
      '| Phase 0 |',
      '| Phase 1A |',
      '| Phase 1B |',
      '| Phase 2 |',
      '| Phase 3 |',
      '| Phase 4 |',
      '| Phase 5 |',
    ])
  })

  it('requires the baseline to name executable verification facts', () => {
    const baseline = readDocument('memory-architecture-baseline.md')
    const readme = readFileSync(join(packageDirectory, 'README.md'), 'utf8')
    containsAll(baseline, [
      'pnpm exec tsc',
      'pnpm exec vitest',
      'current suite inventory',
    ])
    containsAll(readme, ['DSH_MEMORY_BGE_ENDPOINT', 'default package run reports no BGE quality measurement'])
  })

  it('requires every recorded phase to expose a rollback control', () => {
    const migrationDocuments = [
      readDocument('migration-phase-1-recall.md'),
      readDocument('migration-phase-2-temporal-resident.md'),
      readDocument('migration-phase-3-5-hardening.md'),
    ]
    for (const document of migrationDocuments) expect(document.toLowerCase()).toContain('rollback')
    const readme = readFileSync(join(packageDirectory, 'README.md'), 'utf8')
    containsAll(readme, ['recallEnabled', 'temporalEnabled', 'purgeEnabled'])
  })

  it('requires progress evidence to distinguish green scope from unmet gates', () => {
    const progress = readDocument('memory-v3-progress.md')
    containsAll(progress, [
      'PASS means the current package evidence for the row is green.',
      'PARTIAL means the implementation exists but one or more named acceptance gates remain open.',
      'NOT STARTED means no implementation or evidence exists for the named scope.',
      'Gates NOT met',
      'Still NOT met',
      'production-scale evaluation remains open',
    ])
  })

  it('requires the phase ledger to encode mandatory failure and automatic transitions', () => {
    const progress = readDocument('memory-v3-progress.md')
    containsAll(progress, [
      'Any mandatory item with `FAIL` makes `Overall = FAIL`',
      '| Phase 0 complete | Phase 0 PASS | Phase 1A | none |',
      '| Phase 1A complete | Phase 1A PASS | Phase 1B | none |',
      '| Phase 1B complete | Phase 1B PASS | Phase 2 | none |',
      '| Phase 3 complete | Phase 3 PASS | Phase 4 | none |',
      '| Phase 4 start | Phase 0, 1A, 1B, 2 and 3 all PASS | Phase 4 | none |',
    ])
  })

  it('requires STOP conditions and the rollback security window to be recorded', () => {
    const progress = readDocument('memory-v3-progress.md')
    const migration = readDocument('migration-phase-3-5-hardening.md')
    containsAll(progress, [
      'Execution may stop only for',
      'Routine implementation choices',
      'are not STOP conditions',
      'rollback is limited to one package release',
    ])
    containsAll(migration, [
      'No known rollback security issue is currently recorded',
      'the rollback window is limited to one package release',
    ])
  })

  it('requires the README to keep external benchmark evidence separate from product evidence', () => {
    const readme = readFileSync(join(packageDirectory, 'README.md'), 'utf8')
    const progress = readDocument('memory-v3-progress.md')
    const recallSource = readFileSync(join(packageDirectory, 'src', 'recall.ts'), 'utf8')
    containsAll(readme, [
      'These are keyless routing and selection measurements, not BGE quality results.',
      'Production benchmark, coverage and production-scale load/chaos evidence must still be collected',
    ])
    containsAll(progress, [
      'REQ-EVAL-001 therefore has a static applicability guard',
      'LongMemEval and LoCoMo remain conditional external campaigns',
      'REQ-RCL-037 remains conditional and the current bounded graph path does not activate PPR',
      'provider-backed regression evidence remains required for REQ-PERF-011',
    ])
    expect(recallSource).toContain('readonly rrfK?: number')
    expect(recallSource).not.toContain('channelWeights')
  })

  it('requires every baseline gap to have an allowed status and named evidence', () => {
    const audit = readDocument('gap-baseline-audit.md')
    containsAll(audit, ['| GAP-01 |', '| GAP-09 |', 'ALREADY_FIXED', 'CONFIRMED'])
    for (let index = 1; index <= 9; index += 1) {
      expect(audit).toMatch(new RegExp(`\\| GAP-0${index} \\| (?:ALREADY_FIXED|CONFIRMED|NOT_APPLICABLE_WITH_REASON) \\| .+ \\|`))
    }
    expect(audit).toContain('does not promote any requirement status from `unassessed` to `verified`')
  })
})
