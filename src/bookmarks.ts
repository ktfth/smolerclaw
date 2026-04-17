/**
 * Bookmark system — save, organize, and search web links and references.
 *
 * Features:
 *   - Save URLs with title, tags, and description
 *   - Auto-extract #hashtags from description
 *   - Search by keyword, tag, or domain
 *   - List by tag with counts
 *   - Persistent via vault (atomic writes)
 */

import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { atomicWriteFile } from './vault'

// ─── Types ──────────────────────────────────────────────────

export interface Bookmark {
  id: string
  url: string
  title: string
  description: string
  tags: string[]
  domain: string
  createdAt: string
  updatedAt: string
}

// ─── Storage ────────────────────────────────────────────────

let _dataDir = ''
let _bookmarks: Bookmark[] = []

const DATA_FILE = () => join(_dataDir, 'bookmarks.json')

function save(): void {
  atomicWriteFile(DATA_FILE(), JSON.stringify(_bookmarks, null, 2))
}

function load(): void {
  const file = DATA_FILE()
  if (!existsSync(file)) {
    _bookmarks = []
    return
  }
  try {
    _bookmarks = JSON.parse(readFileSync(file, 'utf-8'))
  } catch {
    _bookmarks = []
  }
}

// ─── Init ───────────────────────────────────────────────────

export function initBookmarks(dataDir: string): void {
  _dataDir = dataDir
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true })
  load()
}

// ─── CRUD ───────────────────────────────────────────────────

/**
 * Save a new bookmark.
 */
export function saveBookmark(
  url: string,
  title: string,
  options: { tags?: string[]; description?: string } = {},
): Bookmark {
  const now = new Date().toISOString()
  const description = options.description?.trim() ?? ''

  // Auto-extract #hashtags from description
  const hashTags = description.match(/#(\w+)/g)?.map((t) => t.slice(1).toLowerCase()) ?? []
  const manualTags = (options.tags ?? []).map((t) => t.toLowerCase())
  const allTags = [...new Set([...manualTags, ...hashTags])]

  const bookmark: Bookmark = {
    id: genId(),
    url: url.trim(),
    title: title.trim(),
    description,
    tags: allTags,
    domain: extractDomain(url),
    createdAt: now,
    updatedAt: now,
  }

  _bookmarks = [..._bookmarks, bookmark]
  save()
  return bookmark
}

/**
 * Update an existing bookmark.
 */
export function updateBookmark(
  id: string,
  updates: { url?: string; title?: string; description?: string; tags?: string[] },
): Bookmark | null {
  const found = _bookmarks.find((b) => b.id === id)
  if (!found) return null

  const description = updates.description?.trim() ?? found.description
  const hashTags = description.match(/#(\w+)/g)?.map((t) => t.slice(1).toLowerCase()) ?? []
  const existingTags = updates.tags?.map((t) => t.toLowerCase()) ?? found.tags
  const allTags = [...new Set([...existingTags, ...hashTags])]

  const url = updates.url?.trim() ?? found.url

  _bookmarks = _bookmarks.map((b) =>
    b.id === id
      ? {
          ...b,
          url,
          title: updates.title?.trim() ?? b.title,
          description,
          tags: allTags,
          domain: extractDomain(url),
          updatedAt: new Date().toISOString(),
        }
      : b,
  )
  save()
  return _bookmarks.find((b) => b.id === id) ?? null
}

/**
 * Delete a bookmark by ID.
 */
export function deleteBookmark(id: string): boolean {
  const idx = _bookmarks.findIndex((b) => b.id === id)
  if (idx === -1) return false
  _bookmarks = [..._bookmarks.slice(0, idx), ..._bookmarks.slice(idx + 1)]
  save()
  return true
}

/**
 * Get a bookmark by ID.
 */
export function getBookmark(id: string): Bookmark | null {
  return _bookmarks.find((b) => b.id === id) ?? null
}

// ─── Search ─────────────────────────────────────────────────

/**
 * Search bookmarks by keyword, tag, or domain.
 * - #tag → tag search
 * - @domain → domain search
 * - plain text → matches title, description, url, tags
 */
export function searchBookmarks(query: string): Bookmark[] {
  const lower = query.toLowerCase().trim()
  if (!lower) return [..._bookmarks]

  // Tag search
  if (lower.startsWith('#')) {
    const tag = lower.slice(1)
    return _bookmarks.filter((b) => b.tags.some((t) => t.includes(tag)))
      .sort(byUpdatedDesc)
  }

  // Domain search
  if (lower.startsWith('@')) {
    const domain = lower.slice(1)
    return _bookmarks.filter((b) => b.domain.includes(domain))
      .sort(byUpdatedDesc)
  }

  // Full-text search
  return _bookmarks.filter((b) =>
    b.title.toLowerCase().includes(lower) ||
    b.description.toLowerCase().includes(lower) ||
    b.url.toLowerCase().includes(lower) ||
    b.tags.some((t) => t.includes(lower)),
  ).sort(byUpdatedDesc)
}

/**
 * List bookmarks, most recent first.
 */
export function listBookmarks(limit = 20): Bookmark[] {
  return [..._bookmarks]
    .sort(byUpdatedDesc)
    .slice(0, limit)
}

/**
 * Get all unique tags with counts.
 */
export function getBookmarkTags(): Array<{ tag: string; count: number }> {
  const tagMap = new Map<string, number>()
  for (const bk of _bookmarks) {
    for (const tag of bk.tags) {
      tagMap.set(tag, (tagMap.get(tag) ?? 0) + 1)
    }
  }
  return [...tagMap.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count)
}

/**
 * Get bookmarks grouped by domain.
 */
export function getBookmarksByDomain(): Array<{ domain: string; count: number }> {
  const domainMap = new Map<string, number>()
  for (const bk of _bookmarks) {
    if (bk.domain) {
      domainMap.set(bk.domain, (domainMap.get(bk.domain) ?? 0) + 1)
    }
  }
  return [...domainMap.entries()]
    .map(([domain, count]) => ({ domain, count }))
    .sort((a, b) => b.count - a.count)
}

/**
 * Total bookmark count.
 */
export function getBookmarkCount(): number {
  return _bookmarks.length
}

// ─── Formatting ─────────────────────────────────────────────

export function formatBookmarkList(bookmarks: Bookmark[]): string {
  if (bookmarks.length === 0) return 'Nenhum bookmark encontrado.'

  const lines = bookmarks.map((b) => {
    const tags = b.tags.length > 0 ? ` [${b.tags.map((t) => `#${t}`).join(' ')}]` : ''
    const desc = b.description
      ? `\n    ${b.description.length > 80 ? b.description.slice(0, 80) + '...' : b.description}`
      : ''
    return `  ${b.title}${tags}\n    ${b.url}${desc}  {${b.id}}`
  })

  return `Bookmarks (${bookmarks.length}):\n${lines.join('\n\n')}`
}

export function formatBookmarkDetail(bookmark: Bookmark): string {
  const created = new Date(bookmark.createdAt).toLocaleDateString('pt-BR')
  const updated = new Date(bookmark.updatedAt).toLocaleDateString('pt-BR')
  const tags = bookmark.tags.length > 0 ? `Tags: ${bookmark.tags.map((t) => `#${t}`).join(' ')}` : ''
  const dates = created === updated
    ? `Criado: ${created}`
    : `Criado: ${created} | Atualizado: ${updated}`
  const desc = bookmark.description ? `\n${bookmark.description}` : ''

  return `--- Bookmark {${bookmark.id}} ---\n${bookmark.title}\n${bookmark.url}${desc}\n\nDominio: ${bookmark.domain}\n${tags}\n${dates}`
}

export function formatBookmarkTags(): string {
  const tags = getBookmarkTags()
  if (tags.length === 0) return 'Nenhuma tag.'
  const lines = tags.map((t) => `  #${t.tag} (${t.count})`)
  return `Tags de bookmarks:\n${lines.join('\n')}`
}

export function formatBookmarkDomains(): string {
  const domains = getBookmarksByDomain()
  if (domains.length === 0) return 'Nenhum dominio.'
  const lines = domains.map((d) => `  ${d.domain} (${d.count})`)
  return `Dominios:\n${lines.join('\n')}`
}

// ─── Helpers ────────────────────────────────────────────────

function genId(): string {
  return randomUUID().slice(0, 8)
}

function extractDomain(url: string): string {
  try {
    const parsed = new URL(url)
    return parsed.hostname.replace(/^www\./, '')
  } catch {
    // Not a valid URL — extract best effort
    const match = url.match(/(?:https?:\/\/)?(?:www\.)?([^/\s]+)/)
    return match?.[1] ?? ''
  }
}

function byUpdatedDesc(a: Bookmark, b: Bookmark): number {
  return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
}
