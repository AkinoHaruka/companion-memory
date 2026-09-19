/* oxlint-disable @stylistic/max-len */

import { createHash } from 'node:crypto'
import type { MemoryCategory, MemoryItem, MemoryKind, MemorySensitivity, SensitivityChange } from './types.ts'
import { lexicalScore } from './recall.ts'

/** Supported page families in the companion Wiki. */
export type WikiPageType = 'source' | 'entity' | 'concept' | 'episode' | 'emotion' | 'relationship' | 'synthesis' | 'other'
/** Lifecycle state for canonical Wiki pages. */
export type WikiPageStatus = 'candidate' | 'confirmed' | 'superseded'
/** Reason a canonical page was superseded by another page. */
export type WikiSupersessionReason = 'correction' | 'temporal_transition' | 'manual_supersede' | 'forget'
/** Precision of an asserted validity start when the exact transition is unknown. */
export type WikiValidFromPrecision = 'exact' | 'month' | 'season' | 'approximate'
/** Evidence status independent from the page lifecycle status. */
export type WikiEpistemicStatus = 'explicit_user' | 'confirmed_user' | 'management_edit' | 'inferred' | 'system_normalized'
/** Lifecycle state for one raw source. */
export type WikiSourceStatus = 'uploaded' | 'ingested' | 'failed'

/** Canonical Wiki record. The authoritative copy lives in storage-domain. */
export interface WikiPage {
  readonly id: string
  readonly path: string
  readonly type: WikiPageType
  readonly title: string
  readonly description: string
  readonly body: string
  readonly sources: readonly string[]
  readonly tags: readonly string[]
  readonly timestamp: string
  /** Explicit source observation time; legacy pages use `timestamp` when absent. */
  readonly observedAt?: string
  /** Time the canonical record was written; optional for legacy pages. */
  readonly recordedAt?: string
  readonly confidence: number
  readonly sensitivity?: MemorySensitivity
  readonly sensitivityHistory?: readonly SensitivityChange[]
  readonly usagePolicy?: 'normal' | 'suppressed'
  readonly suppressedAt?: string
  readonly suppressionReason?: string
  readonly status: WikiPageStatus
  readonly consent: boolean
  readonly validUntil?: string
  /** Start of the asserted validity interval; never backfilled from guesses. */
  readonly validFrom?: string | null
  /** End of the asserted validity interval; `[validFrom, validTo)`. */
  readonly validTo?: string | null
  readonly validFromPrecision?: WikiValidFromPrecision
  readonly temporalNote?: string
  readonly supersededBy?: string
  readonly supersedes?: readonly string[]
  readonly supersessionReason?: WikiSupersessionReason
  readonly epistemicStatus?: WikiEpistemicStatus
  readonly authority?: readonly string[]
  readonly locked: boolean
  readonly version: number
  readonly updatedAt: string
  readonly category?: MemoryCategory
  readonly kind?: MemoryKind
}

/** Model-produced page proposal that is not canonical until explicitly confirmed. */
export interface WikiCandidate {
  readonly id: string
  readonly proposedPath: string
  readonly page: WikiPage
  readonly sourceConversations: readonly string[]
  readonly createdAt: string
  readonly status: 'candidate' | 'rejected' | 'accepted' | 'pending_conflict'
  readonly conflictPageId?: string
}

/** Raw source tracked by the incremental ingest state machine. */
export interface WikiSource {
  readonly id: string
  readonly ref: string
  readonly kind: 'session' | 'manual'
  readonly sha256: string
  readonly status: WikiSourceStatus
  readonly error?: string
  readonly observedAt: string
  readonly ingestedAt?: string
}

export type WikiRelationType = 'related_to' | 'supports' | 'contradicts' | 'refines' | 'derived_from' | 'evidenced_by'
export interface WikiEdge { readonly sourcePageId: string; readonly targetTitle: string; readonly targetPageId?: string; readonly relationType?: WikiRelationType; readonly targetKind?: 'page' | 'session' }
export interface WikiGraphNode { readonly id: string; readonly title: string; readonly type: string; readonly layer?: 'L0' | 'L2' }
export interface WikiRelation { readonly targetTitle: string; readonly relationType: WikiRelationType }
export interface WikiSearchResult { readonly page: WikiPage; readonly score: number; readonly hop: number }
export type ParsedWikiPage = Omit<WikiPage, 'id' | 'version' | 'updatedAt'> & { readonly fileVersion?: number; readonly fileUpdatedAt?: string }

const PAGE_FOLDERS: Record<WikiPageType, string> = { source: 'sources', entity: 'entities', concept: 'concepts', episode: 'episodes', emotion: 'emotions', relationship: 'relationships', synthesis: 'synthesis', other: 'other' }
const FOLDER_TYPES: Record<string, WikiPageType> = Object.fromEntries(Object.entries(PAGE_FOLDERS).map(([type, folder]) => [folder, type as WikiPageType])) as Record<string, WikiPageType>
const WIKILINK_RE = /\[\[([^\]\n]+)\]\]/g
/** Maximum graph expansion supported by the first-version Wiki recall gate. */
export const WIKI_GRAPH_MAX_HOPS = 2

/**
 * In-memory derived search/graph index. It is rebuilt from canonical pages
 * after every durable domain load/write; no SQLite or fixed filesystem path is
 * part of the plugin API.
 */
export class WikiIndex {
  readonly path = 'storage-domain:riko_memory'
  private pages: WikiPage[] = []
  private sources: WikiSource[] = []

  /** Open a derived index; the argument is accepted for migration-compatible callers but never opened. */
  static async open(_ignoredPath?: string): Promise<WikiIndex> { return new WikiIndex() }
  /** Release derived memory only; storage-domain owns durability. */
  close(): void { this.pages = []; this.sources = [] }

  /** Rebuild search and graph views from authoritative records. */
  rebuild(pages: readonly WikiPage[], sources: readonly WikiSource[]): void {
    this.pages = pages.map(clonePage)
    this.sources = sources.map(source => ({ ...source }))
  }

  /** List canonical page summaries. */
  listPages(options: { status?: WikiPageStatus; type?: WikiPageType } = {}): Array<Pick<WikiPage, 'id' | 'path' | 'title' | 'type' | 'description' | 'status' | 'consent' | 'observedAt' | 'recordedAt' | 'validFrom' | 'validTo' | 'validUntil' | 'locked' | 'confidence' | 'version' | 'updatedAt'>> {
    return this.pages
      .filter(page => (options.status === undefined || page.status === options.status) && (options.type === undefined || page.type === options.type))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.title.localeCompare(b.title))
      .map(page => ({
        id: page.id, path: page.path, title: page.title, type: page.type, description: page.description,
        status: page.status, consent: page.consent,
        ...(page.observedAt === undefined ? {} : { observedAt: page.observedAt }),
        ...(page.recordedAt === undefined ? {} : { recordedAt: page.recordedAt }),
        ...(page.validFrom === undefined ? {} : { validFrom: page.validFrom }),
        ...(page.validTo === undefined ? {} : { validTo: page.validTo }),
        ...(page.validUntil === undefined ? {} : { validUntil: page.validUntil }),
        locked: page.locked, confidence: page.confidence, version: page.version, updatedAt: page.updatedAt,
      }))
  }

  /** Return graph nodes and resolved wikilink edges. */
  graph(rootPageId?: string, maxHop = 1): { nodes: WikiGraphNode[]; edges: WikiEdge[] } {
    const byTitle = new Map(this.pages.map(page => [normalizeTitle(page.title), page.id]))
    const edges: WikiEdge[] = []
    for (const page of this.pages) {
      for (const relation of parseWikiRelations(page.body)) {
        const targetPageId = byTitle.get(normalizeTitle(relation.targetTitle))
        if (targetPageId === undefined) continue
        edges.push({ sourcePageId: page.id, targetTitle: relation.targetTitle, targetPageId, ...(relation.relationType === 'related_to' ? {} : { relationType: relation.relationType }) })
      }
    }
    const nodes = this.pages.map(page => ({ id: page.id, title: page.title, type: page.type }))
    if (rootPageId === undefined) return { nodes, edges }
    const adjacency = new Map<string, Set<string>>()
    for (const edge of edges) {
      if (edge.targetPageId === undefined) continue
      const source = adjacency.get(edge.sourcePageId) ?? new Set<string>(); source.add(edge.targetPageId); adjacency.set(edge.sourcePageId, source)
      const target = adjacency.get(edge.targetPageId) ?? new Set<string>(); target.add(edge.sourcePageId); adjacency.set(edge.targetPageId, target)
    }
    const included = new Set([rootPageId]); let frontier = [rootPageId]
    for (let hop = 0; hop < Math.max(0, Math.min(maxHop, WIKI_GRAPH_MAX_HOPS)) && frontier.length > 0; hop += 1) {
      const next: string[] = []
      for (const id of frontier) for (const neighbor of adjacency.get(id) ?? []) if (!included.has(neighbor)) { included.add(neighbor); next.push(neighbor) }
      frontier = next
    }
    return { nodes: nodes.filter(node => included.has(node.id)), edges: edges.filter(edge => edge.targetPageId !== undefined && included.has(edge.sourcePageId) && included.has(edge.targetPageId)) }
  }

  /** Search the derived index with bounded token scoring and CJK substring fallback. */
  search(query: string, maxResults = 20, maxHop = 0): WikiSearchResult[] {
    if (query.trim().length === 0) return []
    const base = this.pages.map((page) => {
      const haystack = `${page.title}\n${page.description}\n${page.body}`.toLocaleLowerCase()
      const score = lexicalScore(query, haystack)
      return { page, score, hop: 0 }
    }).filter(result => result.score > 0).sort((a, b) => b.score - a.score || b.page.updatedAt.localeCompare(a.page.updatedAt)).slice(0, Math.max(1, maxResults))
    if (maxHop <= 0 || base.length === 0) return base
    const nearby = new Set<string>()
    for (const result of base) for (const node of this.graph(result.page.id, maxHop).nodes) nearby.add(node.id)
    const existing = new Set(base.map(result => result.page.id))
    return [...base, ...this.pages.filter(page => nearby.has(page.id) && !existing.has(page.id)).map(page => ({ page, score: 0, hop: 1 }))]
  }

  /** Return the current source metadata view. */
  listSources(): WikiSource[] { return this.sources.map(source => ({ ...source })) }
  /** The storage-domain schema version for this derived projection. */
  schemaVersion(): number { return 2 }
}

export function wikiPageId(path: string): string { return createHash('sha256').update(normalizeWikiPath(path)).digest('hex').slice(0, 24) }
export function wikiSourceId(kind: WikiSource['kind'], ref: string): string { return createHash('sha256').update(`${kind}\n${ref}`).digest('hex').slice(0, 24) }

/** Normalize a model-provided path and reject filesystem escapes. */
export function normalizeWikiPath(value: string): string {
  const normalized = value.trim().replaceAll('\\', '/')
  if (!normalized.startsWith('wiki/') || normalized.includes('\0') || normalized.includes('..') || normalized.startsWith('/')) throw new Error(`Wiki path must stay under wiki/: ${value}`)
  const path = posixNormalize(normalized)
  if (path === 'wiki' || !path.endsWith('.md')) throw new Error(`Wiki path must be a Markdown page: ${value}`)
  const parts = path.split('/'); const folder = parts[1] ?? ''
  if (parts.length !== 3 || folder.length === 0 || !(folder in FOLDER_TYPES)) throw new Error(`Wiki page must use one typed directory: ${value}`)
  return path
}

export function pageFolder(type: WikiPageType): string { return PAGE_FOLDERS[type] }
export function pageSlug(title: string, fallback: string): string {
  const normalized = title.normalize('NFKC').trim().toLowerCase().replace(/[^\p{Letter}\p{Number}]+/gu, '-').replace(/^-+|-+$/g, '')
  return (normalized || fallback).slice(0, 96)
}
export function parseWikilinks(body: string): string[] { return parseWikiRelations(body).map(relation => relation.targetTitle) }
export function parseWikiRelations(body: string): WikiRelation[] {
  const relations: WikiRelation[] = []
  for (const match of body.matchAll(WIKILINK_RE)) {
    const raw = match[1]?.trim(); if (!raw) continue
    const separator = raw.indexOf('::'); const relationType = separator > 0 ? normalizeRelationType(raw.slice(0, separator)) : 'related_to'
    const targetTitle = (separator > 0 ? raw.slice(separator + 2) : raw).trim(); if (!targetTitle) continue
    if (!relations.some(relation => relation.targetTitle === targetTitle && relation.relationType === relationType)) relations.push({ targetTitle, relationType })
  }
  return relations
}

/** Parse the controlled frontmatter form accepted by the Wiki state machine. */
export function parseWikiMarkdown(markdown: string, fallbackPath: string): ParsedWikiPage {
  const normalizedPath = normalizeWikiPath(fallbackPath); const lines = markdown.replaceAll('\r\n', '\n').split('\n')
  if (lines[0] !== '---') throw new Error(`Wiki page lacks frontmatter: ${fallbackPath}`)
  const end = lines.indexOf('---', 1); if (end < 0) throw new Error(`Wiki page frontmatter is not closed: ${fallbackPath}`)
  const metadata = parseFrontmatter(lines.slice(1, end)); const folder = normalizedPath.split('/')[1] ?? 'other'; const folderType = FOLDER_TYPES[folder] ?? 'other'; const type = normalizePageType(metadata.type, folderType)
  if (type !== folderType) throw new Error(`Wiki page type ${type} does not match directory ${folder}`)
  const title = stringValue(metadata.title) || titleFromPath(normalizedPath); const body = lines.slice(end + 1).join('\n').trim(); const category = normalizeCategory(metadata.category); const kind = normalizeKind(metadata.kind); const sensitivity = normalizeSensitivity(metadata.sensitivity); const fileVersion = positiveInteger(metadata.version); const fileUpdatedAt = stringValue(metadata.updated_at)
  const observedAt = stringValue(metadata.observed_at); const recordedAt = stringValue(metadata.recorded_at); const validFrom = nullableString(metadata.valid_from); const validTo = nullableString(metadata.valid_to); const validUntil = stringValue(metadata.valid_until); const supersededBy = stringValue(metadata.superseded_by); const supersedes = metadata.supersedes === undefined ? undefined : listValue(metadata.supersedes); const authority = metadata.authority === undefined ? undefined : listValue(metadata.authority); const validFromPrecision = normalizeValidFromPrecision(metadata.valid_from_precision); const temporalNote = metadata.temporal_note === undefined ? undefined : stringValue(metadata.temporal_note); const supersessionReason = normalizeSupersessionReason(metadata.supersession_reason); const epistemicStatus = normalizeEpistemicStatus(metadata.epistemic_status)
  return { path: normalizedPath, type, title, description: stringValue(metadata.description), body, sources: listValue(metadata.sources), tags: listValue(metadata.tags), timestamp: stringValue(metadata.timestamp) || new Date(0).toISOString(), ...(observedAt ? { observedAt } : {}), ...(recordedAt ? { recordedAt } : {}), confidence: clampNumber(metadata.confidence, 0.5), ...(sensitivity === undefined ? {} : { sensitivity }), status: normalizeStatus(metadata.status), consent: booleanValue(metadata.consent), ...(validFrom !== undefined ? { validFrom } : {}), ...(validTo !== undefined ? { validTo } : {}), ...(validUntil ? { validUntil } : {}), ...(validFromPrecision === undefined ? {} : { validFromPrecision }), ...(temporalNote === undefined ? {} : { temporalNote }), ...(supersededBy ? { supersededBy } : {}), ...(supersedes === undefined ? {} : { supersedes }), ...(supersessionReason === undefined ? {} : { supersessionReason }), ...(epistemicStatus === undefined ? {} : { epistemicStatus }), ...(authority === undefined ? {} : { authority }), locked: booleanValue(metadata.locked), ...(fileVersion === undefined ? {} : { fileVersion }), ...(fileUpdatedAt ? { fileUpdatedAt } : {}), ...(category === undefined ? {} : { category }), ...(kind === undefined ? {} : { kind }) }
}

/** Render one page as canonical, deterministic Markdown for export/debug views. */
export function renderWikiMarkdown(page: Omit<WikiPage, 'id' | 'version' | 'updatedAt'> & Partial<Pick<WikiPage, 'version' | 'updatedAt'>>): string {
  const lines = ['---', `type: ${page.type}`, `title: ${yamlScalar(page.title)}`, `description: ${yamlScalar(page.description)}`, 'sources:', ...page.sources.map(source => `  - ${yamlScalar(source)}`), 'tags:', ...page.tags.map(tag => `  - ${yamlScalar(tag)}`), `timestamp: ${yamlScalar(page.timestamp)}`, ...(page.observedAt === undefined ? [] : [`observed_at: ${yamlScalar(page.observedAt)}`]), ...(page.recordedAt === undefined ? [] : [`recorded_at: ${yamlScalar(page.recordedAt)}`]), `confidence: ${page.confidence.toFixed(3)}`, ...(page.sensitivity === undefined ? [] : [`sensitivity: ${page.sensitivity}`]), `status: ${page.status}`, `consent: ${String(page.consent)}`, ...(page.validFrom === undefined ? [] : [page.validFrom === null ? 'valid_from: null' : `valid_from: ${yamlScalar(page.validFrom)}`]), ...(page.validTo === undefined ? [] : [page.validTo === null ? 'valid_to: null' : `valid_to: ${yamlScalar(page.validTo)}`]), ...(page.validFromPrecision === undefined ? [] : [`valid_from_precision: ${page.validFromPrecision}`]), ...(page.temporalNote === undefined ? [] : [`temporal_note: ${yamlScalar(page.temporalNote)}`]), ...(page.supersededBy === undefined ? [] : [`superseded_by: ${yamlScalar(page.supersededBy)}`]), ...(page.supersedes === undefined ? [] : ['supersedes:', ...page.supersedes.map(id => `  - ${yamlScalar(id)}`)]), ...(page.supersessionReason === undefined ? [] : [`supersession_reason: ${page.supersessionReason}`]), ...(page.epistemicStatus === undefined ? [] : [`epistemic_status: ${page.epistemicStatus}`]), ...(page.authority === undefined ? [] : ['authority:', ...page.authority.map(value => `  - ${yamlScalar(value)}`)]), ...(page.validUntil === undefined ? [] : [`valid_until: ${yamlScalar(page.validUntil)}`]), `locked: ${String(page.locked)}`, `version: ${String(page.version ?? 1)}`, `updated_at: ${yamlScalar(page.updatedAt ?? page.timestamp)}`, ...(page.category === undefined ? [] : [`category: ${page.category}`]), ...(page.kind === undefined ? [] : [`kind: ${page.kind}`]), '---', '', page.body.trim(), '']
  return lines.join('\n')
}

export function pageFromMemory(item: MemoryItem, now = new Date().toISOString()): WikiPage {
  const type: WikiPageType = item.kind === 'emotion' ? 'emotion' : item.kind === 'event' ? 'episode' : item.kind === 'fact' ? 'entity' : 'concept'; const title = item.content.length > 72 ? `${item.content.slice(0, 72)}…` : item.content; const path = `wiki/${pageFolder(type)}/${pageSlug(title, item.id)}.md`
  return { id: wikiPageId(path), path, type, title, description: item.content, body: `# 记忆\n\n${item.content}\n\n来源会话：${item.sourceConversations.map(value => `[[${value}]]`).join('、')}`, sources: [...item.sourceConversations], tags: [item.category, item.kind], timestamp: item.observedAt, observedAt: item.observedAt, ...(item.recordedAt === undefined ? {} : { recordedAt: item.recordedAt }), confidence: item.confidence, sensitivity: item.sensitivity, status: item.status === 'superseded' ? 'superseded' : item.status, consent: item.consent, ...(item.validFrom === undefined ? {} : { validFrom: item.validFrom }), ...(item.validTo === undefined ? {} : { validTo: item.validTo }), ...(item.validUntil === undefined ? {} : { validUntil: item.validUntil }), locked: item.status === 'confirmed', version: 1, updatedAt: now, category: item.category, kind: item.kind }
}

export function memoryFromPage(page: WikiPage): MemoryItem | undefined {
  if (page.category === undefined || page.kind === undefined) return undefined; const content = page.description || page.body
  return { id: contentHash(`${page.category}\n${content.trim()}`).slice(0, 24), kind: page.kind, category: page.category, content, confidence: page.confidence, status: page.status, sourceConversations: [...page.sources], observedAt: page.observedAt ?? page.timestamp, ...(page.recordedAt === undefined ? {} : { recordedAt: page.recordedAt }), ...(page.validFrom === undefined ? {} : { validFrom: page.validFrom }), ...(page.validTo === undefined ? {} : { validTo: page.validTo }), ...(page.validUntil === undefined ? {} : { validUntil: page.validUntil }), sensitivity: page.sensitivity ?? 'normal', consent: page.consent }
}
export function contentHash(value: string): string { return createHash('sha256').update(value).digest('hex') }

function clonePage(page: WikiPage): WikiPage { return { ...page, sources: [...page.sources], tags: [...page.tags], ...(page.supersedes === undefined ? {} : { supersedes: [...page.supersedes] }), ...(page.authority === undefined ? {} : { authority: [...page.authority] }) } }
function parseFrontmatter(lines: readonly string[]): Record<string, string | string[]> { const result: Record<string, string | string[]> = {}; let currentList: string[] | undefined; let currentKey: string | undefined; for (const line of lines) { const list = /^\s*-\s*(.*)$/.exec(line); if (list && currentKey) { currentList ??= []; currentList.push(unquote(list[1] ?? '')); result[currentKey] = currentList; continue } const entry = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line); if (!entry) continue; const key = entry[1] ?? ''; currentKey = key; const value = entry[2] ?? ''; if (!value) { currentList = []; result[key] = currentList } else { currentList = undefined; result[key] = unquote(value) } } return result }
function stringValue(value: string | string[] | undefined): string { return typeof value === 'string' ? value : '' }
function nullableString(value: string | string[] | undefined): string | null | undefined { if (value === undefined) return undefined; if (Array.isArray(value)) return undefined; return value.trim().toLowerCase() === 'null' || value.trim() === '' ? null : value }
function listValue(value: string | string[] | undefined): string[] { return Array.isArray(value) ? [...value] : typeof value === 'string' && value ? [value] : [] }
function booleanValue(value: string | string[] | undefined): boolean { return value === 'true' || value === 'yes' }
function clampNumber(value: string | string[] | undefined, fallback: number): number { const number = typeof value === 'string' ? Number(value) : NaN; return Number.isFinite(number) ? Math.min(1, Math.max(0, number)) : fallback }
function positiveInteger(value: string | string[] | undefined): number | undefined { const number = typeof value === 'string' ? Number(value) : NaN; return Number.isInteger(number) && number > 0 ? number : undefined }
function normalizePageType(value: unknown, fallback: WikiPageType): WikiPageType { return value === 'source' || value === 'entity' || value === 'concept' || value === 'episode' || value === 'emotion' || value === 'relationship' || value === 'synthesis' || value === 'other' ? value : fallback }
function normalizeStatus(value: unknown): WikiPageStatus { return value === 'confirmed' || value === 'superseded' ? value : 'candidate' }
function normalizeCategory(value: unknown): MemoryCategory | undefined { return value === 'traits_roles' || value === 'interaction_rules' || value === 'key_experiences' || value === 'promises_goals' || value === 'emotions' ? value : undefined }
function normalizeKind(value: unknown): MemoryKind | undefined { return value === 'fact' || value === 'preference' || value === 'event' || value === 'boundary' || value === 'emotion' ? value : undefined }
function normalizeSensitivity(value: unknown): MemorySensitivity | undefined { return value === 'normal' || value === 'provisional_sensitive' || value === 'sensitive' ? value : undefined }
function normalizeValidFromPrecision(value: unknown): WikiValidFromPrecision | undefined { return value === 'exact' || value === 'month' || value === 'season' || value === 'approximate' ? value : undefined }
function normalizeSupersessionReason(value: unknown): WikiSupersessionReason | undefined { return value === 'correction' || value === 'temporal_transition' || value === 'manual_supersede' || value === 'forget' ? value : undefined }
function normalizeEpistemicStatus(value: unknown): WikiEpistemicStatus | undefined { return value === 'explicit_user' || value === 'confirmed_user' || value === 'management_edit' || value === 'inferred' || value === 'system_normalized' ? value : undefined }
function titleFromPath(path: string): string { const file = path.split('/').pop() ?? 'untitled.md'; return file.slice(0, -3).replaceAll('-', ' ') }
function normalizeTitle(value: string): string { return value.trim().toLocaleLowerCase() }
function yamlScalar(value: string): string { return value.length === 0 ? '""' : /^[A-Za-z0-9._:/+-]+$/.test(value) ? value : JSON.stringify(value) }
function unquote(value: string): string { const trimmed = value.trim(); return trimmed.length >= 2 && ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) ? trimmed.slice(1, -1) : trimmed }
function normalizeRelationType(value: string): WikiRelationType { return value === 'supports' || value === 'contradicts' || value === 'refines' || value === 'derived_from' || value === 'evidenced_by' ? value : 'related_to' }
function posixNormalize(value: string): string { const parts: string[] = []; for (const part of value.split('/')) { if (!part || part === '.') continue; if (part === '..') { parts.pop(); continue } parts.push(part) } return parts.join('/') }
