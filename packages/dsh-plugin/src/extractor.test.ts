import { describe, expect, it } from 'vitest';

import { extractionPrompt, parseExtractionItems, sourceSpanForUniqueQuote } from './extractor.js';

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

  it('preserves grounded episode structure and renders registry contracts', () => {
    const extracted = parseExtractionItems([{
      kind: 'episode',
      narrative: '我和猫咪一起去了医院。',
      quote: '和猫咪一起去了医院',
      participants: [{ role: 'user', entityRef: 'user-1' }, { role: 'companion' }],
      emotionalArc: [{ atTurn: 2, labels: ['担心'], intensity: 0.7, source: 'user_expressed' }],
      userReaction: '我松了一口气',
      responseRef: 'turn-2',
    }], '我和猫咪一起去了医院，我松了一口气。', 'message-2');
    expect(extracted[0]).toMatchObject({
      kind: 'episode',
      candidate: {
        participants: [{ role: 'user', entityRef: 'user-1' }, { role: 'companion' }],
        emotionalArc: [{ atTurn: 2, labels: ['担心'], intensity: 0.7, source: 'user_expressed' }],
        userReaction: '我松了一口气',
        responseRef: 'turn-2',
      },
    });
    expect(extractionPrompt([{
      key: 'identity.location', valueKind: 'text', enumValues: [], cardinality: 'single',
      requiresEntityRef: true,
      qualifierSchema: { type: 'object', properties: { context: { type: 'string', enum: ['work'] } }, additionalProperties: false },
      description: 'where the user is located',
    }])).toContain('entityRef required');
    expect(extractionPrompt([{
      key: 'identity.location', valueKind: 'text', enumValues: [], cardinality: 'single',
      requiresEntityRef: true,
      qualifierSchema: { type: 'object', properties: { context: { type: 'string', enum: ['work'] } }, additionalProperties: false },
      description: 'where the user is located',
    }])).toContain('where the user is located');
  });
});
