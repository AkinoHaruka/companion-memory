/** Frozen conversation material and explicit observable memory opportunities. */

export type EffectType = 'name' | 'language' | 'preference' | 'boundary' | 'continuity' | 'correct_silence';
export type Opportunity = 'positive' | 'negative' | 'none';
export interface GoldCandidate { predicate: string; value: unknown; rawValue: string; quote: string; confidence?: number; }
export interface GoldEpisode { narrative: string; quote: string; confidence?: number; }
/**
 * The words a reply could only carry having read this turn's memory, graded by
 * how much they prove.
 *
 * Every token must appear verbatim in the turn's own human-verified gold, and
 * none may appear in the turn's own user text -- both are checked by
 * `validateFixture` before any model call, because a token that fails either is
 * not evidence of anything.
 *
 * The grades exist because a flat keyword list cannot tell recall from
 * guesswork. Measured against a real model, 「折腾」 is a stock consolation word
 * ("这几天没少折腾吧") and 「半夜」 is a genre prior for a pet falling ill, while
 * 「三点」 is a time nobody produces without the record. A weak token on its own
 * therefore passes a reply that never read anything, so the rule requires one
 * strong token, or two tokens of any lower grade together.
 */
export interface RecallEvidence {
  /** A time, a number, a proper noun: unavailable without the record. */
  strong: readonly string[];
  /** Unlikely without the record, but reachable from how this kind of story goes. */
  medium: readonly string[];
  /** Reachable by guesswork alone; only counted alongside another token. */
  weak: readonly string[];
}

export interface UserTurn {
  intent: string; text: string; memoryOpportunity: Opportunity; effectType: EffectType;
  /**
   * What the fixture asks of the name, on turns scored for using it.
   *
   * `must_use` is an explicit question about the name, where not answering is a
   * memory failure and the effect gates. `may_use` is ordinary conversation, where
   * addressing someone by name is a stylistic choice -- gating it rewards a model
   * that opens every sentence with "林越，", which is worse than never naming
   * anyone. Measured: eight forced records and not one spontaneous mention, while
   * an explicit question is answerable from the same record.
   *
   * Defaults to `may_use`. Nothing here asks a model never to use a name.
   */
  nameExpectation?: 'must_use' | 'may_use' | 'should_not_use';
  /** Human-verified direct claims, consumed only by Gold arms. */
  gold?: GoldCandidate[];
  /** Human-verified direct experience records, used only by Gold arms. */
  goldEpisodes?: GoldEpisode[];
  /** Deliberately contradictory paired memory for causal generation checks. */
  counterfactual?: GoldCandidate[];
  /**
   * What a reply to this turn would have to contain to show it read this turn's
   * memory. Absent means this effect cannot be read from this turn, which
   * `validateFixture` reports rather than letting it score as a failure.
   */
  recallEvidence?: RecallEvidence;
}
export interface SessionScript { id: string; dayOffset: number; turns: UserTurn[]; }

export const NOW = '2026-06-01T20:00:00Z';
export const SUBJECT = 'linyue';

/** The existing 15 turns, annotated by opportunity rather than answer difference. */
export const SESSIONS: SessionScript[] = [
  { id: 's1', dayOffset: 0, turns: [
    { intent: 'identity + language preference', text: '你好，我叫林越。以后我们用中文聊吧，我英文不太行。', memoryOpportunity: 'none', effectType: 'correct_silence', gold: [
      { predicate: 'identity.name', value: '林越', rawValue: '林越', quote: '林越' },
      { predicate: 'communication.language', value: '中文', rawValue: '用中文聊', quote: '用中文聊' },
    ] },
    { intent: 'communication preference', text: '我比较喜欢简短直接的回答，别绕弯子，也不用一直问我感受。', memoryOpportunity: 'none', effectType: 'correct_silence', gold: [
      { predicate: 'communication.verbosity', value: 'short', rawValue: '简短直接的回答', quote: '简短直接的回答' },
      { predicate: 'support.presence_style', value: 'space', rawValue: '不用一直问我感受', quote: '不用一直问我感受' },
    ] },
    { intent: 'boundary', text: '有个事想说一下：别跟我提前任，那个话题我现在还不想碰。', memoryOpportunity: 'none', effectType: 'correct_silence', gold: [
      { predicate: 'boundary.topic_avoid', value: '前任', rawValue: '别跟我提前任', quote: '别跟我提前任' },
    ] },
  ] },
  { id: 's2', dayOffset: 3, turns: [
    { intent: 'transient state — must NOT become a fact', text: '今天特别累，开了一天会，脑子都是糊的。', memoryOpportunity: 'none', effectType: 'correct_silence' },
    { intent: 'durable goal', text: '我最近在准备考一个证，十一月的考试，压力挺大的。', memoryOpportunity: 'none', effectType: 'correct_silence', gold: [
      { predicate: 'goal.current_focus', value: '准备十一月考试', rawValue: '准备考一个证，十一月的考试', quote: '准备考一个证，十一月的考试' },
    ] },
    { intent: 'nothing durable — must extract nothing', text: '嗯，今天天气还不错。', memoryOpportunity: 'none', effectType: 'correct_silence' },
  ] },
  { id: 's3', dayOffset: 9, turns: [
    { intent: 'episode with emotion', text: '我家猫昨天吐了，半夜带它去了宠物医院，折腾到三点。今天上班完全是梦游状态。', memoryOpportunity: 'none', effectType: 'correct_silence', goldEpisodes: [
      { narrative: '猫生病，用户半夜带猫去宠物医院，折腾到三点。', quote: '我家猫昨天吐了，半夜带它去了宠物医院，折腾到三点', confidence: 1 },
    ] },
    { intent: 'support preference', text: '我难受的时候你别急着给建议，先听我说完就好。', memoryOpportunity: 'none', effectType: 'correct_silence', gold: [
      { predicate: 'support.when_distressed', value: 'listen', rawValue: '别急着给建议，先听我说完', quote: '别急着给建议，先听我说完' },
    ] },
  ] },
  { id: 's4', dayOffset: 21, turns: [
    { intent: 'recall a detail from three weeks ago', text: '猫现在好多了，能吃东西了。', memoryOpportunity: 'positive', effectType: 'continuity', recallEvidence: {
      // All three are read verbatim out of s3t0's human-verified episode
      // narrative, 『猫生病，用户半夜带猫去宠物医院，折腾到三点。』, and none of
      // them occurs in this turn's own user text. Graded by how far a reply could
      // get without the record: a clock reading cannot be guessed, a pet being
      // taken to hospital at night is how this story goes, and 折腾 is what one
      // says to anyone who has had a hard week.
      strong: ['三点'],
      medium: ['半夜'],
      weak: ['折腾'],
    } },
    { intent: 'recurring theme', text: '又加班到十点。这个项目好像永远做不完。', memoryOpportunity: 'none', effectType: 'correct_silence' },
    { intent: 'contradiction — supersede territory', text: '关于简短这点我改主意了，聊正事的时候你多讲一点，我需要细节。', memoryOpportunity: 'positive', effectType: 'preference', gold: [
      { predicate: 'communication.verbosity', value: 'long', rawValue: '聊正事的时候你多讲一点，我需要细节', quote: '聊正事的时候你多讲一点，我需要细节' },
    ], counterfactual: [
      { predicate: 'communication.verbosity', value: 'short', rawValue: '回答始终简短', quote: '关于简短' },
    ] },
    { intent: 'contradiction restated plainly', text: '我说的简短那个偏好不算数了。以后回答长一点没关系，尤其是我问工作的事。', memoryOpportunity: 'positive', effectType: 'preference', gold: [
      { predicate: 'communication.verbosity', value: 'long', rawValue: '以后回答长一点没关系，尤其是我问工作的事', quote: '以后回答长一点没关系，尤其是我问工作的事' },
    ] },
  ] },
  { id: 's5', dayOffset: 30, turns: [
    { intent: 'recurring theme again', text: '项目又延期了。我这两个月好像一直在赶同一个东西。', memoryOpportunity: 'positive', effectType: 'continuity' },
    { intent: 'a good day must not be personality change', text: '今天挺开心的，下午把方案过了，晚上去看了场演出。', memoryOpportunity: 'none', effectType: 'correct_silence' },
    { intent: 'contradiction third session', text: '再确认一次：回答的长度上我不需要简短了，详细一点更好。', memoryOpportunity: 'positive', effectType: 'preference' },
  ] },
];

/** New probes turn “memory works” into observable behaviour instead of a name-only metric. */
export const PROBES: SessionScript[] = [{ id: 'probes', dayOffset: 35, turns: [
  // No cue, so addressing by name is a stylistic choice. Recorded once as a
  // hard gate this turn reported a ceiling of zero; it is now reported and not
  // gated.
  { intent: 'name use only when natural', text: '我想继续聊聊最近的状态。', memoryOpportunity: 'positive', effectType: 'name', nameExpectation: 'may_use', counterfactual: [
    { predicate: 'identity.name', value: '周然', rawValue: '周然', quote: '我想继续' },
  ] },
  // An explicit question about the name. The same record answers it, but here a
  // reply that does not say the name is a memory failure, because there is
  // nothing stylistic about refusing to answer a direct question.
  { intent: 'explicit identity recall', text: '你还记得我叫什么吗？', memoryOpportunity: 'positive', effectType: 'name', nameExpectation: 'must_use' },
  { intent: 'language preference', text: 'Can you help me make a plan for this week?', memoryOpportunity: 'positive', effectType: 'language' },
  { intent: 'boundary remains silent', text: '我最近总觉得有点烦。', memoryOpportunity: 'negative', effectType: 'boundary' },
  { intent: 'detailed work planning', text: '我需要梳理一下这周的工作安排。', memoryOpportunity: 'positive', effectType: 'preference' },
  { intent: 'unrelated no opportunity', text: '今天晚饭吃什么好？', memoryOpportunity: 'none', effectType: 'correct_silence' },
] }];
