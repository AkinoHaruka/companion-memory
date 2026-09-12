/** Versioned JSONL protocol shared with the Rust worker. */
export const WORKER_PROTOCOL_VERSION = 1;

/** TypeScript never decides policy from this scope; it is sent to Rust verbatim. */
export interface MemoryScope {
  serviceId: string;
  ownerUserId: string;
  companionProfileId: string;
}

export interface WorkerScope {
  service_id: string;
  owner_user_id: string;
  companion_profile_id: string;
}

export function toWorkerScope(scope: MemoryScope): WorkerScope {
  return {
    service_id: scope.serviceId,
    owner_user_id: scope.ownerUserId,
    companion_profile_id: scope.companionProfileId,
  };
}

export interface WorkerFailure {
  code: string;
  retryable: boolean;
  summary: string;
}

/** Read-only registry metadata supplied by Rust for conservative extraction. */
export interface PredicateSchema {
  key: string;
  valueKind: 'text' | 'enum' | 'date' | 'duration' | 'number' | 'entity_ref';
  enumValues: string[];
}

export interface WorkerHealth {
  predicateKeys: string[];
  predicateSchemas: PredicateSchema[];
}

export interface PlanEntry {
  recordId: string;
  text: string;
  surface: 'never_surface' | 'background_only' | 'mention_if_user_cues' | 'freely_mentionable';
  reason: string;
}

/** The seven explicit response-use channels computed by the Rust authority. */
export interface MemoryUsagePlan {
  constraints: PlanEntry[];
  /**
   * Who the user is, so a name can be a name.
   *
   * Separate from `responseStyle` because the two are different kinds of
   * information: a style channel tells the model how to speak, and an identity
   * channel tells it who it is speaking to. `identity.name` in the style channel
   * measured as a name the model never said, which was reported as memory
   * failing rather than as a name filed in the wrong place.
   */
  identity: PlanEntry[];
  responseStyle: PlanEntry[];
  continuity: PlanEntry[];
  topicActivated: PlanEntry[];
  deepRecall: PlanEntry[];
  doNotSurface: PlanEntry[];
}

export interface WarmResult {
  revision: number;
  plan: MemoryUsagePlan;
}

export interface CandidateSpan {
  startOffset: number;
  endOffset: number;
  quote: string;
}

export interface ExtractedCandidate {
  id: string;
  predicate: string;
  value: unknown;
  rawValue?: string;
  entityRef?: string;
  qualifiers?: unknown;
  sourceSpan: CandidateSpan;
  confidence: number;
  openThread?: {
    id: string;
    summary: string;
    entityRef?: string;
    expiresAt?: string;
  };
}

export interface ExtractedNoMemory { kind: 'no_memory'; }
export interface ExtractedClaim { kind: 'claim'; candidate: ExtractedCandidate; }
export interface ExtractedEpisode {
  kind: 'episode';
  candidate: {
    id: string;
    narrative: string;
    sourceSpan: CandidateSpan;
    confidence: number;
  };
}
/** Runtime state is intentionally pending until extraction metrics qualify promotion. */
export interface ExtractedPending { kind: 'runtime_state'; reason: string; }
export type Extraction = ExtractedNoMemory | ExtractedClaim | ExtractedEpisode | ExtractedPending;

export interface QueryRecord { id: string; text: string; }
