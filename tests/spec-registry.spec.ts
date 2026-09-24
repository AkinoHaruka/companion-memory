/**
 * Contract test for the spec execution registry.
 *
 * The registry is the only place that records which specs run by default and which need external configuration.
 * This test fails whenever the tests directory and the registry disagree, so a spec cannot stop executing without
 * a recorded reason and a named owner. The evidence registry and normalized report are consumed here too, so a
 * declared evidence grade cannot drift away from the spec that actually ran.
 *
 * It checks discovery and registration, then reconciles required candidates against the normalized Vitest report.
 * The `observed` block in the registry remains a compact record while the report carries the detailed evidence.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { load } from 'js-yaml'
import { describe, expect, it } from 'vitest'
import { computeSpecReportInputFingerprint } from './support/spec-report-fingerprint.ts'

const testDirectory = dirname(fileURLToPath(import.meta.url))
const packageDirectory = resolve(testDirectory, '..')
const reportRefreshRun = process.env.DSH_RIKO_MEMORY_REFRESH_SPEC_REPORT === '1'
const registryFile = join(packageDirectory, 'docs', 'spec-execution-registry.json')
const registryText = readFileSync(registryFile, 'utf8')
const requirementsFile = join(packageDirectory, 'docs', 'memory-v3-requirements.yml')
const executionReportFile = join(packageDirectory, 'docs', 'spec-execution-report.json')
const evidenceRegistryFile = join(packageDirectory, 'docs', 'spec-evidence-registry.json')
const capabilityStatusFile = join(packageDirectory, 'docs', 'capability-status.json')

type DefaultEntry = { mode: 'default' }
type OptInEntry = {
  mode: 'opt-in'
  reason: string
  envGate: string[]
  coveredBy: string
  acceptedGap?: boolean
}
type Registry = {
  package: string
  specDirectory: string
  specs: Record<string, DefaultEntry | OptInEntry>
}

type EvidenceLevel = 'static' | 'unit' | 'integration' | 'loader_e2e' | 'empirical' | 'chaos'
type CandidateTest = { path: string; required_in_ci: boolean }
type Requirement = { candidate_tests: CandidateTest[]; evidence_min: EvidenceLevel; status: string }
type SpecEvidence = { level: EvidenceLevel; provider: string }
type EvidenceRegistry = {
  levels: Record<EvidenceLevel, number>
  providers: string[]
  specs: Record<string, SpecEvidence>
}
type CapabilityStatus = {
  packageVersion: string
  overall: 'unassessed'
  requirementStatus: { total: number; unassessed: number; verified: number }
  evidence: { eligibleRequirements: number; requirementsWithEvidenceGaps: number; requirementsWithCandidateDeficits: number }
  gapRegister: { path: string; count: number }
  readme: Record<string, { path: string; anchor: string }>
}
type GapRegister = {
  packageVersion: string
  count: number
  gaps: Array<{
    id: string
    evidence_min: EvidenceLevel
    candidate_tests: string[]
    closure: { kind: 'static_gate' | 'executable_test' | 'stronger_test' | 'opt_in_execution' | 'provider_campaign'; next: string }
  }>
}
type CandidateExecution = {
  path: string
  requiredInCi: boolean
  evidenceLevel: EvidenceLevel
  provider: string
  meetsMinimum: boolean
  providerCompatible: boolean
  executed: boolean
  usable: boolean
}
type RequirementExecution = {
  status: string
  evidenceMinimum: EvidenceLevel
  evidenceEligible: boolean
  evidenceGap: boolean
  deficits: string[]
  candidateCount: number
  requiredInCi: string[]
  executed: string[]
  notExecuted: string[]
  failed: string[]
  candidates: CandidateExecution[]
}
type ExecutionReport = {
  generatedAt: string
  command: string
  rawJsonSha256: string
  inputFingerprint: string
  packageVersion: string
  suite: { files: number; tests: number; passed: number; failed: number; skipped: number; success: boolean }
  specs: Record<string, { status: string; executed: boolean; failed: number; evidenceLevel: EvidenceLevel; provider: string }>
  requirements: Record<string, RequirementExecution>
}

const registry = JSON.parse(registryText) as Registry
const requirements = load(readFileSync(requirementsFile, 'utf8')) as Record<string, Requirement>
const evidenceRegistry = JSON.parse(readFileSync(evidenceRegistryFile, 'utf8')) as EvidenceRegistry
const capabilityStatus = JSON.parse(readFileSync(capabilityStatusFile, 'utf8')) as CapabilityStatus
const gapRegister = JSON.parse(readFileSync(join(packageDirectory, 'docs', 'traceability-gap-register.json'), 'utf8')) as GapRegister

function walk(directory: string, accept: (name: string) => boolean): string[] {
  const found: string[] = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = join(directory, entry.name)
    if (entry.isDirectory()) found.push(...walk(full, accept))
    else if (accept(entry.name)) found.push(full)
  }
  return found.sort()
}

const specFiles = walk(testDirectory, name => name.endsWith('.spec.ts')).map(file =>
  relative(testDirectory, file).split('\\').join('/'))
const registered = Object.keys(registry.specs).sort()
const optIn = Object.entries(registry.specs).filter(
  (pair): pair is [string, OptInEntry] => pair[1].mode === 'opt-in')
const defaultSpecs = Object.entries(registry.specs).filter(([, entry]) => entry.mode === 'default')

// Assembled from fragments so this file never reads as a spec that skips itself.
const markerBases = ['describe', 'it', 'test']
const markerSuffixes = ['skip', 'skipIf', 'todo', 'runIf']
const dottedMarkers = markerBases.flatMap(base => markerSuffixes.map(suffix => [base, suffix].join('.')))
const bareMarkers = ['x' + 'it(', 'x' + 'describe(']

const packageSources = walk(testDirectory, name => name.endsWith('.ts')).map(file => readFileSync(file, 'utf8')).join('\n')

describe('spec execution registry', () => {
  it.skipIf(reportRefreshRun)('records fresh runner output bound to the current code and traceability inputs', () => {
    const executionReport = JSON.parse(readFileSync(executionReportFile, 'utf8')) as ExecutionReport
    expect(Number.isFinite(Date.parse(executionReport.generatedAt))).toBe(true)
    expect(executionReport.command.trim().length).toBeGreaterThan(0)
    expect(executionReport.rawJsonSha256).toMatch(/^[0-9a-f]{64}$/)
    expect(executionReport.inputFingerprint).toBe(computeSpecReportInputFingerprint(resolve(packageDirectory, '..', '..', '..')))
  })

  it('discovers a spec corpus that is neither empty nor narrowed', () => {
    expect(specFiles.length).toBeGreaterThan(40)
    expect(registered.length).toBeGreaterThan(40)
  })

  it('registers every spec that exists on disk', () => {
    expect(specFiles.filter(file => registry.specs[file] === undefined)).toEqual([])
  })

  it('registers nothing that does not exist on disk', () => {
    expect(registered.filter(file => !specFiles.includes(file))).toEqual([])
  })

  it('declares each spec once, so a repeated key cannot swallow its predecessor', () => {
    const start = registryText.indexOf('"specs"')
    const end = registryText.indexOf('"observed"')
    expect(start, 'the registry declares a specs object').toBeGreaterThan(-1)
    expect(end, 'the observed block follows the specs object').toBeGreaterThan(start)
    const declared = registryText.slice(start, end).match(/"[^"]+\.spec\.ts":/g) ?? []
    expect(declared.length).toBe(registered.length)
    expect(new Set(declared).size).toBe(declared.length)
  })

  it('records a reason and a covering owner for every spec that does not run by default', () => {
    expect(optIn.length).toBeGreaterThan(0)
    for (const [file, entry] of optIn) {
      expect(entry.reason.trim().length, file).toBeGreaterThan(80)
      expect(entry.envGate.length, file).toBeGreaterThan(0)
      expect(entry.envGate.every(name => name.startsWith('DSH_MEMORY_')), file).toBe(true)
      expect(entry.coveredBy, file).toMatch(/^(?:none|ci-[a-z0-9-]+|manual:[a-z0-9-]+)$/)
      if (entry.coveredBy === 'none') expect(entry.acceptedGap, file).toBe(true)
      else expect(entry.acceptedGap, file).toBeUndefined()
    }
  })

  it('keeps every declared environment variable present in the package test sources', () => {
    expect(packageSources.length).toBeGreaterThan(10000)
    for (const [file, entry] of optIn) {
      for (const name of entry.envGate) expect(packageSources.includes(name), `${file} declares ${name}`).toBe(true)
    }
  })

  it('keeps skipped, todo and conditional tests out of the specs that run by default', () => {
    expect(defaultSpecs.length).toBeGreaterThan(30)
    for (const [file] of defaultSpecs) {
      const source = readFileSync(join(testDirectory, file), 'utf8')
      // This registry test conditionally omits only report-dependent assertions during refresh runs.
      const markerSource = file === 'spec-registry.spec.ts'
        ? source.replaceAll('it.skipIf(reportRefreshRun)', '')
        : source
      const markers = [...dottedMarkers, ...bareMarkers].filter(marker => markerSource.includes(marker))
      expect(markers, file).toEqual([])
    }
  })

  it.skipIf(reportRefreshRun)('reconciles required requirement candidates against a real Vitest execution report', () => {
    const executionReport = JSON.parse(readFileSync(executionReportFile, 'utf8')) as ExecutionReport
    expect(Object.keys(requirements)).toHaveLength(335)
    expect(executionReport.suite.files).toBe(specFiles.length)
    expect(executionReport.suite.success).toBe(true)
    expect(executionReport.suite.failed).toBe(0)
    const reportSpecs = Object.keys(executionReport.specs).sort()
    expect(reportSpecs).toEqual(specFiles.map(file => `tests/${file}`))
    expect(Object.keys(evidenceRegistry.specs).sort()).toEqual(reportSpecs)
    expect(evidenceRegistry.providers).toContain('real_embedding')
    expect(evidenceRegistry.providers).toContain('real_provider')
    for (const file of reportSpecs) {
      const evidence = evidenceRegistry.specs[file]
      if (evidence === undefined) throw new Error(`missing evidence classification for ${file}`)
      expect(executionReport.specs[file]?.evidenceLevel, file).toBe(evidence.level)
      expect(executionReport.specs[file]?.provider, file).toBe(evidence.provider)
      expect(evidenceRegistry.levels[evidence.level], file).toBeTypeOf('number')
    }
    const candidates = Object.entries(requirements).flatMap(([id, requirement]) =>
      requirement.candidate_tests.map(candidate => ({ id, candidate })))
    expect(candidates.length).toBeGreaterThan(0)
    expect(candidates.filter(({ candidate }) => candidate.required_in_ci &&
      executionReport.specs[candidate.path] === undefined)).toEqual([])
    expect(candidates.filter(({ candidate }) => candidate.required_in_ci &&
      !executionReport.specs[candidate.path]?.executed).map(({ id, candidate }) => `${id}: ${candidate.path}`)).toEqual([])
    expect(candidates.filter(({ candidate }) => candidate.required_in_ci &&
      (executionReport.specs[candidate.path]?.failed ?? 0) > 0)).toEqual([])
    expect(candidates.filter(({ candidate }) => !candidate.required_in_ci &&
      executionReport.specs[candidate.path] === undefined)).toEqual([])
    expect(Object.keys(executionReport.requirements).sort()).toEqual(Object.keys(requirements).sort())
    for (const [id, requirement] of Object.entries(requirements)) {
      const summary = executionReport.requirements[id]
      if (summary === undefined) throw new Error(`missing execution evidence for ${id}`)
      const candidatePaths = requirement.candidate_tests.map(candidate => candidate.path)
      const requiredPaths = requirement.candidate_tests
        .filter(candidate => candidate.required_in_ci)
        .map(candidate => candidate.path)
      const observedPaths = [...new Set([
        ...summary.requiredInCi,
        ...summary.executed,
        ...summary.notExecuted,
        ...summary.failed,
      ])].sort()
      expect(summary.status, id).toBe(requirement.status)
      expect(summary.evidenceMinimum, id).toBe(requirement.evidence_min)
      expect(summary.candidateCount, id).toBe(candidatePaths.length)
      expect([...summary.requiredInCi].sort(), id).toEqual([...requiredPaths].sort())
      expect(observedPaths, id).toEqual([...new Set(candidatePaths)].sort())
      expect(summary.candidates.map(candidate => candidate.path), id).toEqual(candidatePaths)
      for (const candidate of summary.candidates) {
        const evidence = evidenceRegistry.specs[candidate.path]
        if (evidence === undefined) throw new Error(`missing candidate evidence for ${id}: ${candidate.path}`)
        expect(candidate.evidenceLevel, `${id}: ${candidate.path}`).toBe(evidence.level)
        expect(candidate.provider, `${id}: ${candidate.path}`).toBe(evidence.provider)
      }
      if (/^(?:verified_contract|verified_e2e|validated_empirically)$/.test(requirement.status)) {
        expect(summary.evidenceEligible, id).toBe(true)
      }
    }
    const unassessed = Object.values(requirements).filter(requirement => requirement.status === 'unassessed').length
    const verified = Object.values(requirements)
      .filter(requirement => /^(?:verified_contract|verified_e2e|validated_empirically)$/.test(requirement.status))
      .length
    const eligibleRequirements = Object.values(executionReport.requirements).filter(requirement => requirement.evidenceEligible).length
    const requirementsWithEvidenceGaps = Object.values(executionReport.requirements).filter(requirement => requirement.evidenceGap).length
    const requirementsWithCandidateDeficits = Object.values(executionReport.requirements)
      .filter(requirement => requirement.deficits.length > 0)
      .length
    const evidenceGapIds = Object.entries(executionReport.requirements)
      .filter(([, requirement]) => requirement.evidenceGap)
      .map(([id]) => id)
      .sort()
    expect(gapRegister.packageVersion).toBe(executionReport.packageVersion)
    expect(gapRegister.count).toBe(evidenceGapIds.length)
    expect(gapRegister.gaps.map(gap => gap.id).sort()).toEqual(evidenceGapIds)
    for (const gap of gapRegister.gaps) {
      expect(gap.closure.next.trim(), gap.id).not.toBe('')
      expect(gap.candidate_tests.every(path => executionReport.specs[path] !== undefined), gap.id).toBe(true)
    }
    expect(unassessed).toBe(Object.keys(requirements).length)
    expect(capabilityStatus.packageVersion).toBe(executionReport.packageVersion)
    expect(capabilityStatus.overall).toBe('unassessed')
    expect(capabilityStatus.requirementStatus).toEqual({ total: Object.keys(requirements).length, unassessed, verified })
    expect(capabilityStatus.evidence).toEqual({ eligibleRequirements, requirementsWithEvidenceGaps, requirementsWithCandidateDeficits })
    expect(capabilityStatus.gapRegister).toEqual({ path: 'docs/traceability-gap-register.json', count: gapRegister.count })
    for (const entry of Object.values(capabilityStatus.readme)) {
      expect(readFileSync(join(packageDirectory, entry.path), 'utf8')).toContain(entry.anchor)
    }
  })
})
