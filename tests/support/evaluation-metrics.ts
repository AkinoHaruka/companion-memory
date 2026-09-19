/** Appendix G scoring over raw live observations; unsupported measurements never become zero. */
import type { RawOutcome } from './companion-runner.ts'

/** Every measurement retains its denominator and contributing scenario identifiers. */
export interface Metric {
  readonly status: 'measured' | 'unsupported'
  readonly value: number | null
  readonly numerator: number
  readonly denominator: number
  readonly scenarios: readonly string[]
  readonly scope: string
  readonly reason?: string
}

function unsupported(reason: string): Metric {
  return { status: 'unsupported', value: null, numerator: 0, denominator: 0, scenarios: [], scope: 'not measured', reason }
}
function ratio(rows: readonly RawOutcome[], score: (row: RawOutcome) => number, scope: string): Metric {
  if (rows.length === 0) return unsupported(`No executed observations for ${scope}.`)
  const numerator = rows.reduce((sum, row) => sum + score(row), 0)
  return { status: 'measured', value: numerator / rows.length, numerator, denominator: rows.length, scenarios: rows.map(row => row.scenario.id), scope }
}

/** Compute all sixteen Appendix G fields and three explicitly named injection proxies.
 * @param outcomes Persisted runner observations; failed execution is rejected rather than omitted.
 * @param k Rank cutoff for single-relevant-target fixture judgments.
 * @returns Attributed measurements with explicit unsupported reasons and null values.
 */
export function aggregateMetrics(outcomes: readonly RawOutcome[], k = 8): Record<string, Metric> {
  if (!Number.isInteger(k) || k < 1) throw new Error('k must be a positive integer')
  if (outcomes.some(row => row.status === 'error')) throw new Error('Cannot score incomplete executions')
  if (new Set(outcomes.map(row => row.scenario.id)).size !== outcomes.length) throw new Error('Duplicate scenario identifiers')
  const rows = outcomes.filter(row => row.status === 'executed')
  const select = (...ids: string[]): RawOutcome[] => rows.filter(row => ids.includes(row.scenario.id))
  const ranking = select('F.04', 'F.05', 'F.06', 'F.07', 'F.08', 'F.18', 'F.19', 'F.20', 'F.26', 'F.29')
  const rank = (row: RawOutcome): number => {
    const target = row.scenario.expected.contains
    if (!target) throw new Error(`Missing relevance judgment for ${row.scenario.id}`)
    const index = row.results.findIndex(result => result.text.includes(target))
    return index < 0 ? 0 : index + 1
  }
  const negatives = select('F.11', 'F.12', 'F.14', 'F.17', 'F.25', 'F.27')
  const forbidden = (row: RawOutcome): boolean => {
    const text = row.scenario.expected.excludes
    if (!text) throw new Error(`Missing negative judgment for ${row.scenario.id}`)
    return row.injected.includes(text) || (row.scenario.id !== 'F.27' && row.resident.includes(text))
  }
  const leak = (row: RawOutcome): number => Number(row.checks.derivedLeakage !== true || (row.scenario.id === 'F.16' && row.checks.diskLeakage !== true))
  const candidates = select('F.03').flatMap(row => (row.snapshot?.candidates ?? []).map(candidate => ({ row, candidate })))
  const worthy = candidates.filter(({ row, candidate }) => {
    const judgment = row.scenario.candidateJudgments?.find(item => item.text === candidate.page.body)
    if (judgment === undefined) throw new Error(`Unjudged candidate in ${row.scenario.id}`)
    return judgment.worthKeeping
  }).length
  const precision: Metric = candidates.length === 0 ? unsupported('No extracted candidates.') : {
    status: 'measured', value: worthy / candidates.length,
    numerator: worthy, denominator: candidates.length,
    scenarios: candidates.map(({ row }) => row.scenario.id), scope: 'F.03 inferred running preference; human relevance judgment: not worth durable factual storage',
  }
  return {
    candidatePrecision: precision,
    authorityViolationRate: ratio(select('F.03', 'F.09', 'F.10'), row => Number(row.checks.authority !== true), 'Dream authority and rejected model remember calls'),
    semanticDriftRate: unsupported('No multi-round semantic consolidation provider or human equivalence judgments in the deterministic Loader fixture.'),
    recallAtK: ratio(ranking, row => Number(rank(row) > 0 && rank(row) <= k), `Recall@${k}; one binary relevant target per query`),
    mrr: ratio(ranking, row => rank(row) === 0 ? 0 : 1 / rank(row), 'reciprocal rank over returned governed results'),
    ndcg: ratio(ranking, row => rank(row) === 0 || rank(row) > k ? 0 : 1 / Math.log2(rank(row) + 1), `binary NDCG@${k}; ideal DCG is 1`),
    exactDetailRecovery: ratio(select('F.05', 'F.06'), row => Number(row.injected.includes(row.scenario.expected.contains!)), 'exact number/name in Agent injection'),
    temporalAccuracy: ratio(select('F.07', 'F.26'), row => Number(row.checks.inclusion === true && row.checks.exclusion !== false), 'current and historical HTTP/Agent context'),
    multiHopSuccess: ratio(select('F.29'), row => Number(row.results.some(result => result.channels.includes('graph') && result.text.includes('Kyoto'))), 'graph retrieval of linked destination; answer generation unsupported'),
    negativeRecallPrecision: ratio(negatives, row => Number(!forbidden(row)), 'negative trials without forbidden raw disclosure'),
    falsePersonalizationRate: unsupported('No final assistant answers; injection proxy is reported separately.'),
    unwantedMentionRate: unsupported('No final assistant answers; sensitive disclosure proxy is reported separately.'),
    memoryOveruseRate: unsupported('No final assistant answers; utility-turn dynamic injection proxy is reported separately.'),
    correctionPropagation: ratio(select('F.06', 'F.08'), row => Number(row.checks.correction === true), 'Canonical summary, Resident and Recall only; Graph/Observation/Answer propagation unsupported'),
    forgetLeakage: ratio(select('F.15'), leak, 'derived live state and injection; retained raw Session is disclosed and excluded'),
    purgeLeakage: ratio(select('F.16'), leak, 'live state plus configured storage-domain files after restart; external Session store excluded'),
    falsePersonalizationInjectionRate: ratio(select('F.03', 'F.09', 'F.10'), row => Number(forbidden(row)), 'unconfirmed claim disclosure in model input'),
    unwantedMentionInjectionRate: ratio(select('F.11', 'F.12'), row => Number(forbidden(row)), 'unsolicited sensitive raw disclosure in model input'),
    memoryOveruseInjectionRate: ratio(select('F.27'), row => Number(row.results.length > 0 || row.injected !== '[]'), 'dynamic recall only; always-on Resident is reported in raw results'),
  }
}
