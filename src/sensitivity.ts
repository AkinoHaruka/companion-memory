/* oxlint-disable @stylistic/max-len */
/** Deterministic sensitivity classification shared by canonical memory and raw L0 evidence.
 *
 * Classification only ever tightens a caller-supplied baseline. Callers decide separately whether a
 * loosening is authorized; this module never loosens.
 */

import type { MemoryDisclosure, MemorySensitivity } from './types.ts'

/** Cue set that forces a sensitive classification for recognised private content. */
export const sensitiveClaimCue = /密码|口令|验证码|令牌|密钥|秘钥|私钥|访问令牌|token|api[-_ ]?key|secret|private key|ssh key|credential|password|health|medical|diagnos|disease|illness|病|疾病|诊断|医疗|药物|处方|癌|抑郁|创伤|sexual|intimate|sex|银行|银行卡|账户|信用卡|工资|薪资|收入|债务|贷款|财务|financial|秘密|私密|隐私|保密|不能告诉|出轨|婚姻冲突|家庭冲突|relationship conflict|affair|divorce|身份证|身份证件|护照|驾驶证|驾照|社保|医保|地址|住址|家庭住址|电话号码|手机号|email|邮箱/i
/** Personal claims about protected identity, belief or health; topic mentions alone do not match. */
const sensitivePersonalAttributeClaimCues: readonly RegExp[] = [
  /\b(?:i\s*(?:am|['’]m)|my\s+(?:partner|spouse|husband|wife|child|son|daughter|parent|mother|father|sibling|brother|sister|friend)\s+(?:is|identifies as))\s+(?:an?\s+)?(?:gay|lesbian|bisexual|pansexual|queer|asexual|heterosexual|straight|transgender|trans|nonbinary|non-binary|intersex|black|white|asian|hispanic|latino|latina|arab|indigenous|native american|disabled|autistic|neurodivergent|deaf|blind|muslim|christian|jewish|hindu|buddhist|sikh|catholic|protestant|atheist|agnostic|conservative|liberal|progressive|socialist|communist|democrat|republican|libertarian|anarchist)\s+(?:man|woman|person|individual)\b/i,
  /\b(?:(?:i\s*(?:am|['’]m)|i\s+identify\s+as|i\s+consider\s+myself)|my\s+(?:partner|spouse|husband|wife|child|son|daughter|parent|mother|father|sibling|brother|sister|friend)\s+(?:is|identifies as))\s+(?:an?\s+)?(?:gay|lesbian|bisexual|pansexual|queer|asexual|heterosexual|straight|transgender|trans|nonbinary|non-binary|intersex|woman|man|female|male|black|white|asian|hispanic|latino|latina|arab|indigenous|native american|disabled|autistic|neurodivergent|deaf|blind|muslim|christian|jewish|hindu|buddhist|sikh|catholic|protestant|atheist|agnostic|undocumented|refugee|asylum seeker|conservative|liberal|progressive|socialist|communist|democrat|republican|libertarian|anarchist)\b(?=\s*(?:[.!?,;:]|$|and\b|but\b|because\b|while\b|who\b|which\b))/i,
  /\bmy\s+(?:sexual orientation|gender identity|religion|religious beliefs|faith|political views|political beliefs|political affiliation|race|ethnicity|ethnic background|immigration status|disability status)\s+(?:is|are)\b/i,
  /\b(?:i\s+(?:am|['’]m)\s+pregnant|my\s+(?:pregnancy|fertility|infertility|miscarriage|abortion|reproductive health|contraception|birth control|menopause)\b|i\s+(?:had|experienced)\s+(?:a\s+)?(?:miscarriage|abortion)\b)/i,
  /\bmy\s+(?:partner|spouse|husband|wife|girlfriend|boyfriend|child|son|daughter)\s+(?:is|was|might be|could be|became)\s+pregnant\b/i,
  /\bi\s+(?:follow|practice)\s+(?:islam|christianity|judaism|hinduism|buddhism|sikhism|catholicism|protestantism|taoism)\b/i,
  /\bi\s+(?:voted|vote)\s+for\b[^.!?\n]{0,50}\b(?:party|candidate|president|senator|governor|mayor|election|ballot)\b/i,
  /\bi\s+support\s+(?:the\s+)?[a-z0-9-]{2,30}\s+party\b/i,
  /\bi\s+identify\s+as\s+(?:a\s+)?(?:conservative|liberal|progressive|socialist|communist|democrat|republican|libertarian|anarchist)\b/i,
  /\bi\s+(?:have|was diagnosed with|am diagnosed with)\s+(?:adhd|attention deficit hyperactivity disorder|autism|bipolar disorder|hiv|ptsd|epilepsy)\b/i,
  /(?:我|本人)(?:是|属于|自我认同为|认同自己是)(?:一名|一个|一位)?(?:同性恋|双性恋|泛性恋|酷儿|无性恋|异性恋|跨性别者?|非二元性别者?|间性人|女性|男性|穆斯林|基督徒|犹太教徒|印度教徒|佛教徒|锡克教徒|天主教徒|新教徒|无神论者|不可知论者|残障人士|残疾人|自闭症患者|难民|寻求庇护者|无证移民|汉族|满族|蒙古族|回族|藏族|维吾尔族|苗族|彝族|壮族|少数民族|华人|黑人|白人|保守派|自由派|进步派|社会主义者|共产主义者|民主党人|共和党人|无政府主义者)(?:者)?(?=\s*(?:[。！？、，；]|$|并且|但是|而且|且))/i,
  /我(?:的)?(?:伴侣|配偶|妻子|丈夫|孩子|儿子|女儿|父亲|母亲|兄弟|姐妹|朋友)(?:是|认同自己是)(?:一名|一个|一位)?(?:同性恋|双性恋|泛性恋|酷儿|无性恋|异性恋|跨性别者?|非二元性别者?|间性人|女性|男性|穆斯林|基督徒|犹太教徒|印度教徒|佛教徒|锡克教徒|天主教徒|新教徒|无神论者|不可知论者|残障人士|残疾人|自闭症患者|难民|寻求庇护者|无证移民|汉族|满族|蒙古族|回族|藏族|维吾尔族|苗族|彝族|壮族|少数民族|华人|黑人|白人)(?:者)?(?=\s*(?:[。！？、，；]|$|并且|但是|而且|且))/i,
  /(?:我的|本人(?:的)?)\s*(?:性取向|性别认同|宗教信仰|宗教|信仰|政治立场|政治观点|政治倾向|种族|族裔|民族|移民身份|残障状况)(?:是|为)\s*[^。！？\n]{1,40}/i,
  /我(?:怀孕了|妊娠|流产|堕胎|不孕|(?:曾经|以前|经历过)(?:一次)?(?:流产|堕胎))|我的(?:妊娠|怀孕|生育|不孕|流产|堕胎|避孕|绝经)/i,
  /我(?:的)?(?:伴侣|配偶|妻子|丈夫|女朋友|男朋友|孩子|儿子|女儿)(?:怀孕|妊娠|流产|堕胎|不孕)/i,
  /我(?:信仰|信奉)(?:伊斯兰教|基督教|犹太教|印度教|佛教|锡克教|天主教|新教|道教)/i,
  /我(?:患有|确诊为|被诊断为)(?:ADHD|注意力缺陷多动障碍|多动症|自闭症|双相障碍|艾滋病|创伤后应激障碍|癫痫)/i,
  /我(?:投票给|支持)[^。！？\n]{0,16}(?:党|政党|候选人)/i,
]
/** Cue set for identifier-shaped claims, which warrant only a provisional classification. */
// oxlint-disable-next-line sonarjs/duplicates-in-character-class -- ASCII identifier ranges; no character is repeated
export const identifierLikeClaimCue = /(?:\d[\s-]?){8,}|(?:\+?86[\s-]?)?1[3-9]\d{9}|(?:地址|住址|居住在|住在|门牌|street address|home address)[^。！？\n]{0,48}(?:路|街|巷|弄|号|室|栋|单元|小区|road|street|avenue)\s*\d*|(?:编号|号码|账号|帐号|账户|卡号|会员号|工号|\b(?:account|identifier|id)\b)\s*[:：#]?\s*[A-Za-z0-9][A-Za-z0-9 _-]{3,}|[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i

/**
 * Classify one claim, tightening the caller's baseline when a cue matches.
 * @param content The text to classify.
 * @param requested The caller's baseline, returned unchanged when no cue matches.
 * @returns The effective sensitivity, never weaker than the caller's baseline.
 */
export function classifyMemorySensitivity(content: string, requested: MemorySensitivity = 'normal'): MemorySensitivity {
  const normalizedContent = content.normalize('NFKC')
  if (sensitiveClaimCue.test(normalizedContent) || sensitivePersonalAttributeClaimCues.some(cue => cue.test(normalizedContent))) return 'sensitive'
  if (identifierLikeClaimCue.test(normalizedContent)) return requested === 'sensitive' ? 'sensitive' : 'provisional_sensitive'
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

/**
 * Map a decided sensitivity to the one raw-text disclosure policy it permits.
 * @param sensitivity The decided memory sensitivity.
 * @returns The single permitted raw-text disclosure policy.
 */
export function disclosureForSensitivity(sensitivity: MemorySensitivity): MemoryDisclosure {
  if (sensitivity === 'normal') return 'normal'
  if (sensitivity === 'provisional_sensitive') return 'user_explicit_only'
  return 'never_explicit'
}
