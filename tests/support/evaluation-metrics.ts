/** Appendix G scoring over raw live observations; unsupported measurements never become zero. */
import type { DenseAblationRun, RawOutcome } from './companion-runner.ts'

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

function answerRatio(rows: readonly RawOutcome[], score: (row: RawOutcome) => number, scope: string, reason: string): Metric {
  if (rows.length === 0) return unsupported(reason)
  return ratio(rows, score, scope)
}

function answerRows(rows: readonly RawOutcome[]): RawOutcome[] { return rows.filter(row => row.answer !== undefined) }

function normalizedTokens(text: string): Set<string> {
  return new Set((text.normalize('NFKC').toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter(token => !ANSWER_STOPWORDS.has(token)))
}

const ANSWER_STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'be', 'do', 'for', 'i', 'in', 'is', 'it', 'my', 'of', 'on', 'that', 'the', 'to', 'user', 'you',
  '我', '我的', '用户', '是', '的', '了',
])
const PERSONAL_ASSERTION_PATTERN = new RegExp(
  String.raw`\b(?:i|my|the user|user)\b[^.!?。！？\n]{0,80}\b(?:am|live|like|prefer|have|use|work|know|want)\b`
  + String.raw`|(?:我|我的|用户)[^。！？\n]{0,40}(?:住|喜欢|偏好|有|是|在)`,
  'i',
)

function escapedMemoryText(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

function memoryIsAuthorized(row: RawOutcome, result: RawOutcome['results'][number]): boolean {
  if (result.mentionDecision !== 'explicit' || result.text.length === 0) return false
  return row.injected.includes(result.text) || row.injected.includes(escapedMemoryText(result.text))
}

function suppliedMemoryText(row: RawOutcome): string {
  const visibleResults = row.results.filter(result => memoryIsAuthorized(row, result)).map(result => result.text)
  const authored = row.scenario.setup.source ?? row.scenario.setup.text
  return [authored, row.scenario.userTurn, ...visibleResults].join('\n')
}

function hasUnsuppliedPersonalAssertion(row: RawOutcome): boolean {
  const answer = row.answer ?? ''
  const forbidden = row.scenario.expected.excludes
  if (forbidden !== undefined && answer.includes(forbidden) && !row.injected.includes(forbidden)) return true
  const supplied = normalizedTokens(suppliedMemoryText(row))
  return answer.split(/[.!?。！？\n]+/u).some((sentence) => {
    if (!PERSONAL_ASSERTION_PATTERN.test(sentence)) return false
    return [...normalizedTokens(sentence)].some(token => !supplied.has(token))
  })
}

function hasUnauthorizedMention(row: RawOutcome): boolean {
  const answer = row.answer ?? ''
  const resultMention = row.results.some(result => !memoryIsAuthorized(row, result)
    && result.text.length > 0 && answer.includes(result.text))
  const forbidden = row.scenario.expected.excludes
  return resultMention || forbidden !== undefined && answer.includes(forbidden) && !row.injected.includes(forbidden)
}

function hasMemoryOveruse(row: RawOutcome): boolean {
  const answer = row.answer ?? ''
  const forbidden = row.scenario.expected.excludes
  if (forbidden !== undefined && answer.includes(forbidden) && !row.injected.includes(forbidden)) return true
  return row.results.some(result => !memoryIsAuthorized(row, result) && result.text.length > 0 && answer.includes(result.text))
}

function hasLexicalAnswerDrift(row: RawOutcome): boolean {
  const memory = normalizedTokens(row.results.filter(result => memoryIsAuthorized(row, result)).map(result => result.text).join('\n'))
  if (memory.size === 0) return false
  const answer = normalizedTokens(row.answer ?? '')
  return ![...memory].some(token => answer.has(token))
}

function resultRatio(rows: readonly RawOutcome[], selected: (row: RawOutcome['results'][number]) => boolean, scope: string): Metric {
  const documents = rows.flatMap(row => row.results.map(result => ({ row, result })))
  if (documents.length === 0) return unsupported(`No recalled documents for ${scope}.`)
  const numerator = documents.reduce((sum, document) => sum + Number(selected(document.result)), 0)
  return {
    status: 'measured', value: numerator / documents.length, numerator, denominator: documents.length,
    scenarios: documents.map(document => document.row.scenario.id), scope,
  }
}

function candidateMatchesExpected(row: RawOutcome, text: string): boolean {
  const expected = row.scenario.expected.contains
  if (expected === undefined) return false
  return text.includes(expected) || text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').includes(expected)
}

/** Compute all twenty-one Appendix G fields, including answer and projection measurements.
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
  const generatedAnswers = answerRows(rows)
  const answerFalsePersonalization = generatedAnswers.filter(row => ['F.03', 'F.09', 'F.10'].includes(row.scenario.id))
  const answerUnwantedMention = generatedAnswers.filter(row => ['F.11', 'F.12'].includes(row.scenario.id))
  const answerMemoryOveruse = generatedAnswers.filter(row => row.scenario.id === 'F.27')
  const answerSemanticDrift = generatedAnswers.filter(row => row.results.some(result => memoryIsAuthorized(row, result)))
  const forbidden = (row: RawOutcome): boolean => {
    const text = row.scenario.expected.excludes
    if (!text) throw new Error(`Missing negative judgment for ${row.scenario.id}`)
    return row.injected.includes(text) || (row.scenario.id !== 'F.27' && row.resident.includes(text))
  }
  const leak = (row: RawOutcome): number => Number(row.checks.derivedLeakage !== true || (row.scenario.id === 'F.16' && row.checks.diskLeakage !== true))
  const candidates = select('F.03').flatMap(row => (row.snapshot?.candidates ?? []).map(candidate => ({ row, candidate })))
  const judged = candidates.flatMap(({ row, candidate }) => {
    const judgments = row.scenario.candidateJudgments
    const judgment = judgments?.find(item => item.text === candidate.page.body)
      ?? judgments?.find(item => item.contains !== undefined && candidate.page.body.includes(item.contains))
    return judgment === undefined ? [] : [{ row, judgment }]
  })
  const unjudged = candidates.length - judged.length
  const worthy = judged.filter(({ judgment }) => judgment.worthKeeping).length
  const precision: Metric = judged.length === 0 ? unsupported('No extracted candidate matched a declared relevance judgment.') : {
    status: 'measured', value: worthy / judged.length,
    numerator: worthy, denominator: judged.length,
    scenarios: judged.map(({ row }) => row.scenario.id),
    scope: `F.03 inferred running preference; human relevance judgment: not worth durable factual storage${unjudged === 0 ? '' : `; ${String(unjudged)} candidate(s) matched no declared judgment and were excluded`}`,
  }
  return {
    candidatePrecision: precision,
    authorityViolationRate: ratio(select('F.03', 'F.09', 'F.10'), row => Number(row.checks.authority !== true), 'Dream authority and rejected model remember calls'),
    semanticDriftRate: answerRatio(
      answerSemanticDrift,
      row => Number(hasLexicalAnswerDrift(row)),
      'answer lexical-overlap drift proxy over explicit-memory answers',
      'No multi-round semantic consolidation provider or human equivalence judgments in the deterministic Loader fixture.',
    ),
    recallAtK: ratio(ranking, row => Number(rank(row) > 0 && rank(row) <= k), `Recall@${k}; one binary relevant target per query`),
    mrr: ratio(ranking, row => rank(row) === 0 ? 0 : 1 / rank(row), 'reciprocal rank over returned governed results'),
    ndcg: ratio(ranking, row => rank(row) === 0 || rank(row) > k ? 0 : 1 / Math.log2(rank(row) + 1), `binary NDCG@${k}; ideal DCG is 1`),
    exactDetailRecovery: ratio(select('F.05', 'F.06'), row => Number(row.injected.includes(row.scenario.expected.contains!)), 'exact number/name in Agent injection'),
    temporalAccuracy: ratio(select('F.07', 'F.26'), row => Number(row.checks.inclusion === true && row.checks.exclusion !== false), 'current and historical HTTP/Agent context'),
    multiHopSuccess: ratio(select('F.29'), row => Number(row.results.some(result => result.channels.includes('graph') && result.text.includes('Kyoto'))), 'graph retrieval of linked destination; answer generation unsupported'),
    negativeRecallPrecision: ratio(negatives, row => Number(!forbidden(row)), 'negative trials without forbidden raw disclosure'),
    falsePersonalizationRate: answerRatio(
      answerFalsePersonalization, row => Number(hasUnsuppliedPersonalAssertion(row)),
      'final answers for F.03, F.09 and F.10; unsupplied personal-claim marker',
      'No final assistant answers; injection proxy is reported separately.',
    ),
    unwantedMentionRate: answerRatio(
      answerUnwantedMention, row => Number(hasUnauthorizedMention(row)),
      'final answers for F.11 and F.12; unauthorized protected-memory marker',
      'No final assistant answers; sensitive disclosure proxy is reported separately.',
    ),
    memoryOveruseRate: answerRatio(
      answerMemoryOveruse, row => Number(hasMemoryOveruse(row)),
      'final answer for F.27; irrelevant-memory marker',
      'No final assistant answers; utility-turn dynamic injection proxy is reported separately.',
    ),
    correctionPropagation: ratio(select('F.06', 'F.08'), row => Number(row.checks.correction === true), 'Canonical summary, Resident and Recall only; Graph/Observation/Answer propagation unsupported'),
    forgetLeakage: ratio(select('F.15'), leak, 'derived live state and injection; retained raw Session is disclosed and excluded'),
    purgeLeakage: ratio(select('F.16'), leak, 'live state plus configured storage-domain files after restart; external Session store excluded'),
    falsePersonalizationInjectionRate: ratio(select('F.03', 'F.09', 'F.10'), row => Number(forbidden(row)), 'unconfirmed claim disclosure in model input'),
    unwantedMentionInjectionRate: ratio(select('F.11', 'F.12'), row => Number(forbidden(row)), 'unsolicited sensitive raw disclosure in model input'),
    memoryOveruseInjectionRate: ratio(select('F.27'), row => Number(row.results.length > 0 || row.injected !== '[]'), 'dynamic recall only; always-on Resident is reported in raw results'),
    safeUsageProjectionRate: resultRatio(rows, result => result.projection !== undefined, 'recalled documents carrying a persisted SafeUsageProjection'),
    rawTextWithheldRate: resultRatio(rows, result => result.projection !== undefined
      && result.projection.disclosure !== 'normal' && result.text.length === 0, 'recalled documents whose raw text was withheld by disclosure gating'),
  }
}

function denseTrials(run: DenseAblationRun): RawOutcome[] {
  const trials = [...run.denseOff.outcomes, ...run.denseOn.outcomes]
  if (trials.some(row => row.status === 'error')) throw new Error('Cannot score incomplete dense ablation')
  return trials.filter(row => row.status === 'executed')
}

/**
 * Compute dense ablation fields from paired keyless corpus runs without replacing unsupported data.
 * @param run Paired deterministic dense-on and dense-off observations.
 * @returns The three dense ablation measurements, including explicit unsupported status when required.
 */
export function aggregateDenseAblationMetrics(run: DenseAblationRun): Record<string, Metric> {
  const off = new Map(run.denseOff.outcomes.map(row => [row.scenario.id, row]))
  const on = new Map(run.denseOn.outcomes.map(row => [row.scenario.id, row]))
  if (off.size !== run.denseOff.outcomes.length || on.size !== run.denseOn.outcomes.length) throw new Error('Duplicate scenario identifiers in dense ablation')
  const paired = [...off.keys()].filter(id => on.has(id)).flatMap((id) => {
    const disabled = off.get(id)!
    const enabled = on.get(id)!
    return disabled.status === 'executed' && enabled.status === 'executed' && enabled.scenario.expected.contains !== undefined
      ? [{ id, disabled, enabled }]
      : []
  })
  const uniqueWin = (row: (typeof paired)[number]): boolean => {
    const expected = row.enabled.scenario.expected.contains
    return expected !== undefined && row.enabled.injected.includes(expected) && !row.disabled.injected.includes(expected)
  }
  const uniqueWins = paired.filter(uniqueWin)
  const uniqueGain: Metric = paired.length === 0 ? unsupported('No executed dense on/off pairs with an expected memory.') : {
    status: 'measured',
    value: uniqueWins.length / paired.length,
    numerator: uniqueWins.length,
    denominator: paired.length,
    scenarios: paired.map(row => row.id),
    scope: 'Expected-memory scenarios whose expected text reaches injected context with deterministic dense enabled but not disabled',
  }
  const candidates = denseTrials(run).flatMap(row => row.results.filter(result => result.channels.includes('dense')).map(result => ({ row, result })))
  const noisyCandidates = candidates.filter(({ row, result }) => !candidateMatchesExpected(row, result.text))
  const noise: Metric = candidates.length === 0 ? unsupported('No dense-sourced candidates entered injected context in the deterministic ablation.') : {
    status: 'measured',
    value: noisyCandidates.length / candidates.length,
    numerator: noisyCandidates.length,
    denominator: candidates.length,
    scenarios: candidates.map(({ row }) => row.scenario.id),
    scope: 'Dense-channel results retained in the injected-context candidate list; rendered or raw result text must contain that scenario expected text',
  }
  const denseDecisions = denseTrials(run).flatMap(row => (row.trace?.gateDecisions ?? [])
    .filter(decision => decision.channels.includes('dense'))
    .map(decision => ({ row, decision })))
  const rejectedDense = denseDecisions.filter(({ decision }) => decision.decision === 'suppress')
  const reasonCounts = new Map<string, number>()
  for (const { decision } of rejectedDense) { const name = decision.reason ?? 'no-reason'; reasonCounts.set(name, (reasonCounts.get(name) ?? 0) + 1) }
  const reasonSummary = [...reasonCounts.entries()].map(([name, count]) => `${name} x${count}`).join(', ') || 'none'
  const gateRejection: Metric = denseDecisions.length === 0
    ? unsupported('No dense-channel candidates reached the mention gate in the deterministic ablation.')
    : {
      status: 'measured',
      value: rejectedDense.length / denseDecisions.length,
      numerator: rejectedDense.length,
      denominator: denseDecisions.length,
      scenarios: denseDecisions.map(({ row }) => row.scenario.id),
      scope: `Dense-channel candidates that reached the mention gate; rejection means the gate suppressed the candidate, attributed per candidate in RecallTrace.gateDecisions. Rejected reasons: ${reasonSummary}`,
    }
  return {
    denseUniqueRecallGain: uniqueGain,
    denseNoiseRate: noise,
    denseGateRejectionRate: gateRejection,
  }
}
