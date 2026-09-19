/* oxlint-disable @stylistic/max-len */
/** Deterministic sensitivity classification shared by canonical memory and raw L0 evidence.
 *
 * Classification only ever tightens a caller-supplied baseline. Callers decide separately whether a
 * loosening is authorized; this module never loosens.
 */

import type { MemorySensitivity } from './types.ts'

/** Cue set that forces a sensitive classification for recognised private content. */
export const sensitiveClaimCue = /密码|口令|验证码|令牌|密钥|秘钥|私钥|访问令牌|token|api[-_ ]?key|secret|private key|ssh key|credential|password|health|medical|diagnos|disease|illness|病|疾病|诊断|医疗|药物|处方|癌|抑郁|创伤|sexual|intimate|sex|银行|银行卡|账户|信用卡|工资|薪资|收入|债务|贷款|财务|financial|秘密|私密|隐私|保密|不能告诉|出轨|婚姻冲突|家庭冲突|relationship conflict|affair|divorce|身份证|身份证件|护照|驾驶证|驾照|社保|医保|地址|住址|家庭住址|电话号码|手机号|email|邮箱/i
/** Cue set for identifier-shaped claims, which warrant only a provisional classification. */
// oxlint-disable-next-line sonarjs/duplicates-in-character-class -- ASCII identifier ranges; no character is repeated
export const identifierLikeClaimCue = /(?:\d[\s-]?){8,}|(?:\+?86[\s-]?)?1[3-9]\d{9}|(?:地址|住址|居住在|住在|门牌|street address|home address)[^。！？\n]{0,48}(?:路|街|巷|弄|号|室|栋|单元|小区|road|street|avenue)\s*\d*|(?:编号|号码|账号|帐号|账户|卡号|会员号|工号|account|identifier|id)\s*[:：#]?\s*[A-Za-z0-9][A-Za-z0-9 _-]{3,}|[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i

/**
 * Classify one claim, tightening the caller's baseline when a cue matches.
 * @param content The text to classify.
 * @param requested The caller's baseline, returned unchanged when no cue matches.
 * @returns The effective sensitivity, never weaker than the caller's baseline.
 */
export function classifyMemorySensitivity(content: string, requested: MemorySensitivity = 'normal'): MemorySensitivity {
  if (sensitiveClaimCue.test(content)) return 'sensitive'
  if (identifierLikeClaimCue.test(content)) return requested === 'sensitive' ? 'sensitive' : 'provisional_sensitive'
  return requested
}

/**
 * Classify one raw L0 evidence line. Ordinary conversation stays normal; recognised private content tightens.
 * @param text The user-origin evidence text.
 * @returns The effective sensitivity for that line.
 */
export function classifyEvidenceSensitivity(text: string): MemorySensitivity { return classifyMemorySensitivity(text) }

/**
 * Validate a candidate classification at a persistence boundary.
 * @param value A candidate value from configuration, a model proposal or durable state.
 * @returns The validated sensitivity.
 * @throws When the value is not one of the three supported states; callers persist the fail-closed value instead.
 */
export function normalizeEvidenceSensitivity(value: unknown): MemorySensitivity {
  if (value === 'normal' || value === 'provisional_sensitive' || value === 'sensitive') return value
  throw new Error('evidence sensitivity must be normal, provisional_sensitive or sensitive')
}
