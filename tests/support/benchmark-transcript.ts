export const BENCHMARK_INGESTION_MAPPING_VERSION = 'role-map-v1'

export type BenchmarkRole = 'user' | 'assistant'

export interface BenchmarkMemoryTurn {
  readonly sessionId: string
  readonly eventId: string
  readonly role: BenchmarkRole
  readonly sourceSpeaker?: string
  readonly text: string
  readonly occurredAt?: string
}

export interface LoCoMoTurnInput {
  readonly sessionId: string
  readonly occurredAt?: string
  readonly speaker: string
  readonly diaId: string
  readonly text: string
}

export interface LongMemEvalTurnInput {
  readonly sessionId: string
  readonly occurredAt?: string
  readonly role: BenchmarkRole
  readonly turnIndex: number
  readonly text: string
}

function requiredText(value: string, field: string): string {
  const text = value.trim()
  if (text.length === 0) throw new Error(`${field} must be non-empty`)
  return text
}

/** Map one LoCoMo turn with one fixed role mapping for the whole conversation. */
export function mapLoCoMoTurn(input: LoCoMoTurnInput, speakerA: string, speakerB: string): BenchmarkMemoryTurn {
  const a = requiredText(speakerA, 'speakerA')
  const b = requiredText(speakerB, 'speakerB')
  const speaker = requiredText(input.speaker, 'speaker')
  if (a === b) throw new Error('LoCoMo speakers must be distinct')
  if (speaker !== a && speaker !== b) throw new Error(`unknown LoCoMo speaker: ${speaker}`)
  return {
    sessionId: requiredText(input.sessionId, 'sessionId'),
    eventId: requiredText(input.diaId, 'diaId'),
    role: speaker === a ? 'user' : 'assistant',
    sourceSpeaker: speaker,
    text: requiredText(input.text, 'text'),
    ...(input.occurredAt === undefined ? {} : { occurredAt: input.occurredAt }),
  }
}

/** Preserve the role already defined by LongMemEval; no label fields are accepted here. */
export function mapLongMemEvalTurn(input: LongMemEvalTurnInput): BenchmarkMemoryTurn {
  if (!Number.isInteger(input.turnIndex) || input.turnIndex < 0) throw new Error('turnIndex must be a non-negative integer')
  return {
    sessionId: requiredText(input.sessionId, 'sessionId'),
    eventId: `${requiredText(input.sessionId, 'sessionId')}:turn-${String(input.turnIndex)}`,
    role: input.role,
    text: requiredText(input.text, 'text'),
    ...(input.occurredAt === undefined ? {} : { occurredAt: input.occurredAt }),
  }
}
