/**
 * The conversation script.
 *
 * Shared by the run and the A/B so both play identical material. Kept in one
 * place because a difference between the two scripts would make their results
 * incomparable, and the A/B exists to be comparable.
 */

import type { SessionScript } from './runner.js';

/** The person the companion is remembering. */
export const SUBJECT = 'linyue';

/**
 * The sessions, in order.
 *
 * Deliberately not a flat character. The material is chosen so the checks
 * downstream have something to fail on:
 *
 * - a stated constraint in one session and a contradiction of it later, so
 *   supersede has work to do;
 * - one intense evening and a good week, so a transient mood has a chance to be
 *   mistaken for a durable fact;
 * - a detail mentioned once early and returned to much later, so recall has to
 *   survive a large vocabulary gap;
 * - one turn with nothing durable in it at all, so an empty extraction is
 *   exercised rather than assumed.
 */
export const SESSIONS: SessionScript[] = [
  {
    id: 's1',
    dayOffset: 0,
    turns: [
      {
        intent: 'identity + language preference',
        text: '你好，我叫林越。以后我们用中文聊吧，我英文不太行。',
      },
      {
        intent: 'communication preference',
        text: '我比较喜欢简短直接的回答，别绕弯子，也不用一直问我感受。',
      },
      {
        intent: 'boundary',
        text: '有个事想说一下：别跟我提前任，那个话题我现在还不想碰。',
      },
    ],
  },
  {
    id: 's2',
    dayOffset: 3,
    turns: [
      {
        intent: 'transient state — must NOT become a fact',
        text: '今天特别累，开了一天会，脑子都是糊的。',
      },
      {
        intent: 'durable goal',
        text: '我最近在准备考一个证，十一月的考试，压力挺大的。',
      },
      {
        intent: 'nothing durable — must extract nothing',
        text: '嗯，今天天气还不错。',
      },
    ],
  },
  {
    id: 's3',
    dayOffset: 9,
    turns: [
      {
        intent: 'episode with emotion',
        text: '我家猫昨天吐了，半夜带它去了宠物医院，折腾到三点。今天上班完全是梦游状态。',
      },
      {
        intent: 'support preference',
        text: '我难受的时候你别急着给建议，先听我说完就好。',
      },
    ],
  },
  {
    id: 's4',
    dayOffset: 21,
    turns: [
      {
        intent: 'recall a detail from three weeks ago',
        text: '猫现在好多了，能吃东西了。',
      },
      {
        intent: 'recurring theme',
        text: '又加班到十点。这个项目好像永远做不完。',
      },
      {
        intent: 'contradiction — supersede territory',
        text: '关于简短这点我改主意了，聊正事的时候你多讲一点，我需要细节。',
      },
      {
        intent: 'contradiction restated more plainly',
        text: '我说的简短那个偏好不算数了。以后回答长一点没关系，尤其是我问工作的事。',
      },
    ],
  },
  {
    id: 's5',
    dayOffset: 30,
    turns: [
      {
        intent: 'recurring theme again, different session',
        text: '项目又延期了。我这两个月好像一直在赶同一个东西。',
      },
      {
        intent: 'a good day — must not be read as a personality change',
        text: '今天挺开心的，下午把方案过了，晚上去看了场演出。',
      },
      {
        intent: 'contradiction, third session',
        text: '再确认一次：回答的长度上我不需要简短了，详细一点更好。',
      },
    ],
  },
];

/** Days between the run's start and the dream pass. */
export const NOW = '2026-06-01T20:00:00Z';