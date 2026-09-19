/* oxlint-disable @stylistic/max-len */
import { describe, expect, it } from 'vitest'
import { WikiIndex, parseWikiMarkdown, parseWikiRelations, parseWikilinks, renderWikiMarkdown, wikiPageId } from '../src/wiki.ts'

describe('native derived Wiki index', () => {
  it('parses controlled frontmatter and wikilinks', () => {
    const markdown = ['---', 'type: concept', 'title: 沟通偏好', 'description: 用户喜欢简洁直接的回答', 'sources:', '  - session-1', 'timestamp: 2026-09-09T00:00:00.000Z', 'confidence: 0.9', 'status: confirmed', 'consent: true', 'locked: true', '---', '', '应避免连续追问，并参考 [[用户画像]]。'].join('\n')
    const page = parseWikiMarkdown(markdown, 'wiki/concepts/communication.md')
    expect(page.status).toBe('confirmed'); expect(page.sources).toEqual(['session-1']); expect(parseWikilinks(page.body)).toEqual(['用户画像'])
    expect(parseWikiRelations('[[supports::用户画像]] [[用户画像]]')).toEqual([{ relationType: 'supports', targetTitle: '用户画像' }, { relationType: 'related_to', targetTitle: '用户画像' }])
    expect(renderWikiMarkdown({ ...page, version: 1, updatedAt: new Date().toISOString() })).toContain('[[用户画像]]')
  })

  it('round-trips explicit temporal fields without inventing validity dates', () => {
    const page = parseWikiMarkdown(['---', 'type: entity', 'title: 居住地', 'description: 杭州', 'timestamp: 2026-01-10T00:00:00.000Z', 'observed_at: 2026-01-10T00:00:00.000Z', 'recorded_at: 2026-01-11T00:00:00.000Z', 'valid_from: 2026-01-10T00:00:00.000Z', 'valid_to: null', 'status: confirmed', 'consent: true', 'locked: true', '---', '', '杭州'].join('\n'), 'wiki/entities/home.md')
    expect(page.validFrom).toBe('2026-01-10T00:00:00.000Z'); expect(page.validTo).toBeNull(); expect(page.observedAt).toContain('2026-01-10')
    const rendered = renderWikiMarkdown({ ...page, version: 2, updatedAt: '2026-01-11T00:00:00.000Z' }); expect(rendered).toContain('valid_from: 2026-01-10T00:00:00.000Z'); expect(rendered).toContain('valid_to: null')
  })

  it('round-trips supersession lineage and reason without changing the page id', () => {
    const page = parseWikiMarkdown(['---', 'type: entity', 'title: 居住地', 'description: 上海', 'timestamp: 2026-01-10T00:00:00.000Z', 'status: superseded', 'superseded_by: hangzhou', 'supersedes:', '  - older-home', 'supersession_reason: temporal_transition', 'consent: true', 'locked: true', '---', '', '上海'].join('\n'), 'wiki/entities/home.md')
    const rendered = renderWikiMarkdown({ ...page, version: 2, updatedAt: '2026-01-11T00:00:00.000Z' })
    const roundTripped = parseWikiMarkdown(rendered, page.path)
    expect(wikiPageId(roundTripped.path)).toBe(wikiPageId(page.path)); expect(roundTripped.supersededBy).toBe('hangzhou'); expect(roundTripped.supersedes).toEqual(['older-home']); expect(roundTripped.supersessionReason).toBe('temporal_transition')
  })

  it('round-trips uncertain month and season precision without inventing a day', () => {
    const month = parseWikiMarkdown(['---', 'type: entity', 'title: 居住地', 'description: 杭州', 'timestamp: 2026-09-19T00:00:00.000Z', 'valid_from: 2025-08', 'valid_from_precision: month', 'temporal_note: 大约去年夏天', 'consent: true', 'locked: true', '---', '', '杭州'].join('\n'), 'wiki/entities/home.md')
    const season = parseWikiMarkdown(['---', 'type: entity', 'title: 居住地', 'description: 杭州', 'timestamp: 2026-09-19T00:00:00.000Z', 'valid_from: 2025', 'valid_from_precision: season', 'temporal_note: 约在夏季', 'consent: true', 'locked: true', '---', '', '杭州'].join('\n'), 'wiki/entities/home.md')
    const monthRoundTrip = parseWikiMarkdown(renderWikiMarkdown(month), month.path); const seasonRoundTrip = parseWikiMarkdown(renderWikiMarkdown(season), season.path)
    expect(monthRoundTrip.validFrom).toBe('2025-08'); expect(monthRoundTrip.validFromPrecision).toBe('month'); expect(monthRoundTrip.temporalNote).toBe('大约去年夏天'); expect(renderWikiMarkdown(monthRoundTrip)).not.toContain('2025-08-01')
    expect(seasonRoundTrip.validFrom).toBe('2025'); expect(seasonRoundTrip.validFromPrecision).toBe('season'); expect(seasonRoundTrip.temporalNote).toBe('约在夏季'); expect(renderWikiMarkdown(seasonRoundTrip)).not.toContain('2025-01-01')
  })

  it('keeps legacy timestamp pages readable without parsing observedAt', () => {
    const page = parseWikiMarkdown(['---', 'type: concept', 'title: 旧页面', 'description: 兼容旧格式', 'timestamp: 2026-01-10T00:00:00.000Z', 'updated_at: 2026-01-11T00:00:00.000Z', 'consent: true', 'locked: false', '---', '', '旧内容'].join('\n'), 'wiki/concepts/legacy.md')
    expect(page.timestamp).toBe('2026-01-10T00:00:00.000Z'); expect(page.fileUpdatedAt).toBe('2026-01-11T00:00:00.000Z'); expect(page.observedAt).toBeUndefined(); expect(renderWikiMarkdown(page)).not.toContain('observed_at:')
  })

  it('round-trips epistemic status without upgrading absent values', () => {
    const explicit = parseWikiMarkdown(['---', 'type: concept', 'title: 沟通偏好', 'description: 简洁', 'timestamp: 2026-09-19T00:00:00.000Z', 'epistemic_status: explicit_user', 'authority:', '  - user:confirmed', 'consent: true', 'locked: true', '---', '', '简洁'].join('\n'), 'wiki/concepts/communication.md')
    const unknown = parseWikiMarkdown(['---', 'type: concept', 'title: 未知状态', 'description: 未知', 'timestamp: 2026-09-19T00:00:00.000Z', 'consent: true', 'locked: false', '---', '', '未知'].join('\n'), 'wiki/concepts/unknown.md')
    const roundTripped = parseWikiMarkdown(renderWikiMarkdown(explicit), explicit.path)
    expect(roundTripped.epistemicStatus).toBe('explicit_user'); expect(roundTripped.authority).toEqual(['user:confirmed']); expect(unknown.epistemicStatus).toBeUndefined(); expect(unknown.authority).toBeUndefined()
  })

  it('rebuilds search and graph from canonical pages without SQLite', async () => {
    const index = await WikiIndex.open('ignored-path'); const now = new Date().toISOString()
    const profile = { path: 'wiki/entities/user.md' as const, type: 'entity' as const, title: '用户画像', description: '稳定用户信息', body: '支持 [[supports::沟通偏好]]。', sources: ['session-1'], tags: [], timestamp: now, confidence: 1, status: 'confirmed' as const, consent: true, locked: true }
    const preference = { path: 'wiki/concepts/communication.md' as const, type: 'concept' as const, title: '沟通偏好', description: '简洁直接', body: '用户喜欢简洁直接。', sources: ['session-1'], tags: [], timestamp: now, confidence: 0.9, status: 'confirmed' as const, consent: true, locked: false }
    const profilePage = { ...profile, id: wikiPageId(profile.path), version: 1, updatedAt: now }
    const preferencePage = { ...preference, id: wikiPageId(preference.path), version: 1, updatedAt: now }
    index.rebuild([profilePage, preferencePage], []); expect(index.search('简洁直接')[0]?.page.title).toBe('沟通偏好'); expect(index.graph(profilePage.id, 1).edges[0]?.targetPageId).toBe(preferencePage.id); index.close()
  })

  it('caps graph traversal at two hops even when hop=8 is requested', async () => {
    const index = await WikiIndex.open('ignored-path'); const now = new Date().toISOString()
    const pages = ([
      ['root', '[[one]]'], ['one', '[[two]]'], ['two', '[[three]]'], ['three', '内容'],
    ] as const).map(([title, body]) => { const type = 'concept' as const; const path = `wiki/${type === 'concept' ? 'concepts' : 'other'}/${title}.md`; return { id: wikiPageId(path), path, type, title, description: title, body, sources: [], tags: [], timestamp: now, confidence: 1, status: 'confirmed' as const, consent: true, locked: true, version: 1, updatedAt: now } })
    index.rebuild(pages, []); const graph = index.graph(pages[0]?.id, 8); expect(graph.nodes.map(node => node.title)).toEqual(['root', 'one', 'two']); expect(graph.nodes.some(node => node.title === 'three')).toBe(false); index.close()
  })

  it('rejects nested Wiki paths', () => { expect(() => parseWikiMarkdown('---\ntype: concept\ntitle: Nested\n---\n\nbody', 'wiki/concepts/nested/page.md')).toThrow(/one typed directory/) })
})
