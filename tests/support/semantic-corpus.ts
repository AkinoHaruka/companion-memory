/**
 * Semantic-gain corpus for dense recall ablation.
 *
 * Design constraints, each of which is load-bearing:
 * 1. The query is a paraphrase of the target fact with **zero lexical overlap** — the CJK
 *    bigrams produced by `lexicalTokens(query)` must not appear in the target text — so the
 *    lexical channel cannot rank the target and any hit is attributable to vector semantics.
 * 2. Every scenario seeds 1 target + 9 same-domain hard negatives, so the eligible dense pool
 *    (10) exceeds `DEFAULT_DENSE_CANDIDATE_CAP` (8) and the vector rank actually selects.
 *    The original Appendix F corpus pools only 1-2 eligible documents per query, which makes
 *    top-K equal whole-pool injection and provider quality irrelevant (measured: hash and
 *    BGE produce identical metrics there).
 * 3. Distractors are hard negatives from the same domain as the query's intent, so whole-pool
 *    injection would read as noise; only correct ranking reads as gain.
 */
import { lexicalScore } from '../../src/recall.ts'

export interface SemanticScenario {
  readonly id: string
  readonly topic: string
  readonly target: { readonly title: string; readonly content: string }
  readonly query: string
  readonly distractors: readonly { readonly title: string; readonly content: string }[]
}

export const semanticCorpus: readonly SemanticScenario[] = [
  {
    id: 'S.01',
    topic: 'exercise habit paraphrase',
    target: { title: '清晨江边慢跑', content: '那位住江边的钢琴老师每天天亮就沿江慢跑五公里，坚持了三年，下雨也撑伞出门。' },
    query: '你记得我朋友平时的锻炼方式吗？',
    distractors: [
      { title: '阳台侍兰', content: '退休的裁缝师傅每天傍晚在阳台侍弄兰花，一年只开两次。' },
      { title: '河边垂钓', content: '开面馆的表哥每逢周日闭店，带孩子们去河边钓鲫鱼。' },
      { title: '错版邮票', content: '中学同窗痴迷集邮，为了一张错版票跑遍三个城市的邮市。' },
      { title: '陶艺拉坯', content: '邻居家的姑娘周末去陶艺工作室拉坯，作品摆满窗台。' },
      { title: '毛笔夜课', content: '开书店的老板每晚打烊后练半小时毛笔字，笔锋越发沉稳。' },
      { title: '石桌棋局', content: '棋友每晚在公园石桌旁下两盘象棋，雷打不动。' },
      { title: '黄油消耗', content: '表姐迷上烘焙，家里的黄油消耗得比米还快。' },
      { title: '饭后太极', content: '外婆每天饭后在楼下打一套太极，动作缓慢舒展。' },
      { title: '夜行消食', content: '同事小赵每晚沿着江岸散步一个钟头消食。' },
    ],
  },
  {
    id: 'S.02',
    topic: 'brew taste paraphrase',
    target: { title: '研磨偏好', content: '那位爱喝手冲的姑娘总把研磨度调粗两格，说浓苦会盖住果酸。' },
    query: '你记得她冲泡饮品时对味道的要求吗？',
    distractors: [
      { title: '奶茶去冰', content: '室友点奶茶永远去冰三分糖，冬天也照点。' },
      { title: '浓茶提神', content: '加班的同事泡茶要浓到发涩，说淡了没精神。' },
      { title: '豆浆无糖', content: '楼下早餐铺的豆浆老板从不加糖，喝了二十年。' },
      { title: '气泡水控', content: '那位健身的教练只喝气泡水，冰箱里囤了整箱。' },
      { title: '奶咖党', content: '同学的咖啡必定加奶不加糖，说是口感顺滑。' },
      { title: '怕苦爱甜', content: '侄女怕苦，巧克力和药都要挑甜的牌子。' },
      { title: '柠檬水癖', content: '那位驾车跑长途的舅舅保温杯里永远是柠檬水。' },
      { title: '忌口清单', content: '表嫂对香菜过敏，点菜前都要嘱咐一遍。' },
      { title: '酒量浅', content: '部门主管酒量极浅，半杯啤酒就上脸，应酬全靠茶代。' },
    ],
  },
  {
    id: 'S.03',
    topic: 'pet quirk paraphrase',
    target: { title: '煤球的怪癖', content: '那只黑白花的小猫最怕吹风机的声音，一响就钻进床底下不出来。' },
    query: '你记得我家宠物胆小怕吵的毛病吗？',
    distractors: [
      { title: '握手小狗', content: '楼下的金毛会握手打滚，是小区的明星。' },
      { title: '仓鼠越狱', content: '侄子的仓鼠三天两头越狱，笼门得用夹子别住。' },
      { title: '龟龟冬眠', content: '班级饲养的乌龟一入冬就蜷在沙里，开春才醒。' },
      { title: '学舌鹦鹉', content: '邻居养的鹦鹉会学门铃响，骗了整层楼的人。' },
      { title: '缸中造景', content: '同事的鱼缸造景翻新过四次，水草比鱼还贵。' },
      { title: '啃线兔', content: '表妹的兔子专咬数据线，已经报销了三条充电线。' },
      { title: '怕黄爪', content: '朋友家的橘猫见了黄瓜立刻弹开，视频拍过好几段。' },
      { title: '定时遛狗', content: '对门的爷爷遛狗比闹钟还准，早六晚九各一趟。' },
      { title: '吠快递', content: '我家的土狗对快递员格外警惕，敲门声一响就叫。' },
    ],
  },
  {
    id: 'S.04',
    topic: 'music taste paraphrase',
    target: { title: '老歌情结', content: '那位弹贝斯的朋友只收藏上个世纪的黑胶，新发行的唱片一概不碰。' },
    query: '你记得他挑选音乐的标准是什么吗？',
    distractors: [
      { title: '片单周末', content: '室友每个周末看一部老电影，片单记了满满一本。' },
      { title: '纪录片迷', content: '那位学历史的同学只追纪录片，正剧一集不看。' },
      { title: '跑调歌王', content: '聚会上表哥唱歌必跑调，但每次都第一个抢麦。' },
      { title: '不碰综艺', content: '同事不追任何综艺，说剧情都是剧本。' },
      { title: '通勤播客', content: '地铁上那位戴耳机的姑娘把播客当连续剧听。' },
      { title: '抢票党', content: '表弟抢演唱会门票从不失手，手速是练出来的。' },
      { title: '戏腔入迷', content: '爷爷是老戏迷，收音机里常年放着京剧。' },
      { title: '理智追星', content: '堂妹追星只买专辑不看八卦，墙上贴着行程表。' },
      { title: '解谜专精', content: '那位学数学的舍友游戏只玩解谜类，通关率极高。' },
    ],
  },
  {
    id: 'S.05',
    topic: 'exam countdown ritual paraphrase',
    target: { title: '倒计时纸条', content: '那位备考的表弟书桌玻璃板下压着一张手写的倒计时纸条，每过一天就划掉一格。' },
    query: '你记得他给自己定的考前提醒办法吗？',
    distractors: [
      { title: '错题本', content: '同学把错题抄成三本合集，考前只翻错题本。' },
      { title: '晨读英语', content: '表姐每天天不亮就起来念英语，楼道里都有回声。' },
      { title: '图书馆占座', content: '那届考研的学长凌晨去图书馆排队占座。' },
      { title: '番茄钟', content: '舍友用番茄钟管理作业，二十五分钟一响就休息。' },
      { title: '彩签笔记', content: '同桌的笔记按颜色分类，荧光贴满页边。' },
      { title: '护眼台灯', content: '妈妈给书桌换了护眼台灯，说熬夜费眼睛。' },
      { title: '静音耳塞', content: '自习室里人手一副静音耳塞，隔壁翻书声都听不见。' },
      { title: '冲刺计划', content: '班长把冲刺安排贴在黑板边上，精确到每节课。' },
      { title: '排名贴墙', content: '那位复读的远房哥哥把历次模拟考的名次表贴在墙上。' },
    ],
  },
]

/** Structural guard: the query must not lexically match its own target, or the experiment is void. */
export function semanticPairIsParaphrase(scenario: SemanticScenario): boolean {
  return lexicalScore(scenario.query, scenario.target.content) === 0
}
