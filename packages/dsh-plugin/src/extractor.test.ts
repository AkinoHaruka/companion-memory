import { describe, expect, it } from 'vitest';

import { parseExtractionItems, sourceSpanForUniqueQuote } from './extractor.js';

describe('extractor source spans', () => {
  it('uses UTF-8 byte offsets for a Chinese source quote', () => {
    expect(sourceSpanForUniqueQuote('猫现在好多了，能吃东西了。', '能吃东西')).toEqual({
      startOffset: 21,
      endOffset: 33,
      quote: '能吃东西',
    });
  });

  it('rejects invented, blank, and ambiguous quotes before Rust admission', () => {
    expect(sourceSpanForUniqueQuote('猫很好，猫很好', '猫很好')).toBeUndefined();
    expect(sourceSpanForUniqueQuote('猫很好', '狗')).toBeUndefined();
    expect(sourceSpanForUniqueQuote('猫很好', '  ')).toBeUndefined();
  });

  it('shares episode and pending parsing with the Oracle normal arm', () => {
    const extracted = parseExtractionItems([
      { kind: 'episode', narrative: '猫曾经半夜去了宠物医院。', quote: '半夜去了宠物医院', confidence: 0.9 },
      { kind: 'runtime_state', reason: 'transient mood' },
    ], '我家猫半夜去了宠物医院，今天好多了。', 'message-1');
    expect(extracted[0]).toMatchObject({
      kind: 'episode',
      candidate: { id: 'message-1-episode-0', narrative: '猫曾经半夜去了宠物医院。' },
    });
    expect(extracted[1]).toEqual({ kind: 'runtime_state', reason: 'transient mood' });
  });
});
