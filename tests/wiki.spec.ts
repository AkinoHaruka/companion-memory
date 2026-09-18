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

  it('rebuilds search and graph from canonical pages without SQLite', async () => {
    const index = await WikiIndex.open('ignored-path'); const now = new Date().toISOString()
    const profile = { path: 'wiki/entities/user.md' as const, type: 'entity' as const, title: '用户画像', description: '稳定用户信息', body: '支持 [[supports::沟通偏好]]。', sources: ['session-1'], tags: [], timestamp: now, confidence: 1, status: 'confirmed' as const, consent: true, locked: true }
    const preference = { path: 'wiki/concepts/communication.md' as const, type: 'concept' as const, title: '沟通偏好', description: '简洁直接', body: '用户喜欢简洁直接。', sources: ['session-1'], tags: [], timestamp: now, confidence: 0.9, status: 'confirmed' as const, consent: true, locked: false }
    const profilePage = { ...profile, id: wikiPageId(profile.path), version: 1, updatedAt: now }
    const preferencePage = { ...preference, id: wikiPageId(preference.path), version: 1, updatedAt: now }
    index.rebuild([profilePage, preferencePage], []); expect(index.search('简洁直接')[0]?.page.title).toBe('沟通偏好'); expect(index.graph(profilePage.id, 1).edges[0]?.targetPageId).toBe(preferencePage.id); index.close()
  })

  it('rejects nested Wiki paths', () => { expect(() => parseWikiMarkdown('---\ntype: concept\ntitle: Nested\n---\n\nbody', 'wiki/concepts/nested/page.md')).toThrow(/one typed directory/) })
})
