/**
 * Persistent memo/note system — a personal knowledge base.
 * Memos are tagged, searchable, and auto-consulted by the AI.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// ─── Types ──────────────────────────────────────────────────

export interface Memo {
  id: string
  content: string
  tags: string[]
  createdAt: string
  updatedAt: string
}

// ─── Storage ────────────────────────────────────────────────

let _dataDir = ''
let _memos: Memo[] = []

const DATA_FILE = () => join(_dataDir, 'memos.json')

function save(): void {
  writeFileSync(DATA_FILE(), JSON.stringify(_memos, null, 2))
}

function load(): void {
  const file = DATA_FILE()
  if (!existsSync(file)) {
    _memos = []
    return
  }
  try {
    _memos = JSON.parse(readFileSync(file, 'utf-8'))
  } catch {
    _memos = []
  }
}

// ─── Init ───────────────────────────────────────────────────

export function initMemos(dataDir: string): void {
  _dataDir = dataDir
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true })
  load()
}

// ─── CRUD ───────────────────────────────────────────────────

export function saveMemo(content: string, tags: string[] = []): Memo {
  const now = new Date().toISOString()

  // Auto-extract tags from #hashtags in content
  const hashTags = content.match(/#(\w+)/g)?.map((t) => t.slice(1).toLowerCase()) || []
  const allTags = [...new Set([...tags.map((t) => t.toLowerCase()), ...hashTags])]

  const memo: Memo = {
    id: genId(),
    content: content.trim(),
    tags: allTags,
    createdAt: now,
    updatedAt: now,
  }
  _memos = [..._memos, memo]
  save()
  return memo
}

export function updateMemo(id: string, content: string): Memo | null {
  const found = _memos.find((m) => m.id === id)
  if (!found) return null

  const hashTags = content.match(/#(\w+)/g)?.map((t) => t.slice(1).toLowerCase()) || []
  const allTags = [...new Set([...found.tags, ...hashTags])]

  _memos = _memos.map((m) =>
    m.id === id
      ? { ...m, content: content.trim(), tags: allTags, updatedAt: new Date().toISOString() }
      : m,
  )
  save()
  return _memos.find((m) => m.id === id) || null
}

export function deleteMemo(id: string): boolean {
  const idx = _memos.findIndex((m) => m.id === id)
  if (idx === -1) return false
  _memos = [..._memos.slice(0, idx), ..._memos.slice(idx + 1)]
  save()
  return true
}

// ─── Search ─────────────────────────────────────────────────

/**
 * Search memos by keyword or tag.
 * Matches against content and tags (case-insensitive).
 */
export function searchMemos(query: string): Memo[] {
  const lower = query.toLowerCase().trim()
  if (!lower) return [..._memos]

  // Check if query is a tag search (starts with #)
  const isTagSearch = lower.startsWith('#')
  const searchTerm = isTagSearch ? lower.slice(1) : lower

  return _memos.filter((m) => {
    if (isTagSearch) {
      return m.tags.some((t) => t.includes(searchTerm))
    }
    return (
      m.content.toLowerCase().includes(searchTerm) ||
      m.tags.some((t) => t.includes(searchTerm))
    )
  }).sort((a, b) =>
    new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
  )
}

/**
 * Get all memos, most recent first.
 */
export function listMemos(limit = 20): Memo[] {
  return [..._memos]
    .reverse() // newest insertion last → first after reverse
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
    .slice(0, limit)
}

/**
 * Get all unique tags with count.
 */
export function getMemoTags(): Array<{ tag: string; count: number }> {
  const tagMap = new Map<string, number>()
  for (const memo of _memos) {
    for (const tag of memo.tags) {
      tagMap.set(tag, (tagMap.get(tag) || 0) + 1)
    }
  }
  return [...tagMap.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count)
}

// ─── Formatting ─────────────────────────────────────────────

export function formatMemoList(memos: Memo[]): string {
  if (memos.length === 0) return 'Nenhum memo encontrado.'

  const lines = memos.map((m) => {
    const date = new Date(m.updatedAt).toLocaleDateString('pt-BR', {
      day: '2-digit', month: '2-digit',
    })
    const tags = m.tags.length > 0 ? ` [${m.tags.map((t) => `#${t}`).join(' ')}]` : ''
    const preview = m.content.length > 80
      ? m.content.slice(0, 80).replace(/\n/g, ' ') + '...'
      : m.content.replace(/\n/g, ' ')
    return `  [${date}] ${preview}${tags}  {${m.id}}`
  })

  return `Memos (${memos.length}):\n${lines.join('\n')}`
}

export function formatMemoDetail(memo: Memo): string {
  const created = new Date(memo.createdAt).toLocaleDateString('pt-BR')
  const updated = new Date(memo.updatedAt).toLocaleDateString('pt-BR')
  const tags = memo.tags.length > 0 ? `Tags: ${memo.tags.map((t) => `#${t}`).join(' ')}` : ''
  const dates = created === updated ? `Criado: ${created}` : `Criado: ${created} | Atualizado: ${updated}`

  return `--- Memo {${memo.id}} ---\n${memo.content}\n\n${tags}\n${dates}`
}

export function formatMemoTags(): string {
  const tags = getMemoTags()
  if (tags.length === 0) return 'Nenhuma tag.'
  const lines = tags.map((t) => `  #${t.tag} (${t.count})`)
  return `Tags:\n${lines.join('\n')}`
}

// ─── Helpers ────────────────────────────────────────────────

function genId(): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789'
  let id = ''
  for (let i = 0; i < 6; i++) {
    id += chars[Math.floor(Math.random() * chars.length)]
  }
  return id
}
