/**
 * Notes — one store for what used to be three: memos (free text), links
 * (bookmarks) and references (the assistant's reference materials).
 *
 * SQLite (bun:sqlite) is the source of truth: writes are transactional, so a
 * crash can never leave a half-written JSON array behind. Legacy JSON files
 * are imported once and renamed to *.migrated.json, never deleted.
 */
import { Database } from 'bun:sqlite'
import { existsSync, mkdirSync, readFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { logger } from './core/logger'

// ─── Types ──────────────────────────────────────────────────

export const NOTE_KINDS = ['memo', 'link', 'reference'] as const
export type NoteKind = (typeof NOTE_KINDS)[number]

export interface Note {
  id: string
  kind: NoteKind
  title: string
  body: string
  url: string | null
  category: string | null
  tags: string[]
  createdAt: string
  updatedAt: string
}

export interface NewNote {
  kind: NoteKind
  body: string
  title?: string
  url?: string
  category?: string
  tags?: readonly string[]
}

export interface NotePatch {
  title?: string
  body?: string
  url?: string
  category?: string
  tags?: readonly string[]
}

export interface NoteQuery {
  kind?: NoteKind
  category?: string
  limit?: number
}

// ─── Storage ────────────────────────────────────────────────

const DB_FILE = 'notes.db'
const DEFAULT_LIMIT = 30

let _db: Database | null = null

const SCHEMA = `
CREATE TABLE IF NOT EXISTS notes (
  id         TEXT PRIMARY KEY,
  kind       TEXT NOT NULL CHECK (kind IN ('memo', 'link', 'reference')),
  title      TEXT NOT NULL DEFAULT '',
  body       TEXT NOT NULL DEFAULT '',
  url        TEXT,
  category   TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS note_tags (
  note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  tag     TEXT NOT NULL,
  PRIMARY KEY (note_id, tag)
);
CREATE INDEX IF NOT EXISTS idx_note_tags_tag ON note_tags(tag);
CREATE INDEX IF NOT EXISTS idx_notes_kind ON notes(kind, updated_at);
CREATE TABLE IF NOT EXISTS migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL);
`

interface NoteRow {
  id: string
  kind: NoteKind
  title: string
  body: string
  url: string | null
  category: string | null
  created_at: string
  updated_at: string
  tags: string | null
}

function db(): Database {
  if (!_db) throw new Error('notes not initialized')
  return _db
}

export function initNotes(dataDir: string): void {
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true })
  _db?.close()
  _db = new Database(join(dataDir, DB_FILE), { create: true, strict: true })
  _db.exec('PRAGMA foreign_keys = ON;')
  _db.exec(SCHEMA)
  migrateLegacyJson(dataDir)
}

/** Close the database (tests, shutdown). */
export function closeNotes(): void {
  _db?.close()
  _db = null
}

// ─── Helpers ────────────────────────────────────────────────

const SELECT = `
SELECT n.*, (SELECT group_concat(tag, ' ') FROM note_tags t WHERE t.note_id = n.id) AS tags
FROM notes n`

function toNote(row: NoteRow): Note {
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    body: row.body,
    url: row.url,
    category: row.category,
    tags: row.tags ? row.tags.split(' ').sort() : [],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

/** Explicit tags plus #hashtags found in the text, lowercased and deduplicated. */
export function collectTags(explicit: readonly string[], ...texts: string[]): string[] {
  const fromText = texts.flatMap((t) => t.match(/#([\p{L}\p{N}_-]+)/gu)?.map((m) => m.slice(1)) ?? [])
  return [...new Set([...explicit, ...fromText].map((t) => t.trim().replace(/^#/, '').replace(/\s+/g, '-').toLowerCase()).filter(Boolean))]
}

function writeTags(id: string, tags: readonly string[]): void {
  db().query('DELETE FROM note_tags WHERE note_id = ?').run(id)
  const insert = db().query('INSERT OR IGNORE INTO note_tags (note_id, tag) VALUES (?, ?)')
  for (const tag of tags) insert.run(id, tag)
}

function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return ''
  }
}

// ─── CRUD ───────────────────────────────────────────────────

export function addNote(input: NewNote): Note {
  const now = new Date().toISOString()
  const id = randomUUID().slice(0, 8)
  const title = input.title?.trim() ?? ''
  const body = input.body.trim()
  db().transaction(() => {
    db().query(
      `INSERT INTO notes (id, kind, title, body, url, category, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, input.kind, title, body, input.url?.trim() || null, input.category?.trim().toLowerCase() || null, now, now)
    writeTags(id, collectTags(input.tags ?? [], title, body))
  })()
  return getNote(id) as Note
}

export function getNote(id: string): Note | null {
  const row = db().query(`${SELECT} WHERE n.id = ?`).get(id) as NoteRow | null
  return row ? toNote(row) : null
}

export function updateNote(id: string, patch: NotePatch): Note | null {
  const current = getNote(id)
  if (!current) return null
  const next = {
    title: patch.title?.trim() ?? current.title,
    body: patch.body?.trim() ?? current.body,
    // An explicit empty string clears the field.
    url: patch.url !== undefined ? patch.url.trim() || null : current.url,
    category: patch.category !== undefined ? patch.category.trim().toLowerCase() || null : current.category,
  }
  db().transaction(() => {
    db().query('UPDATE notes SET title = ?, body = ?, url = ?, category = ?, updated_at = ? WHERE id = ?')
      .run(next.title, next.body, next.url, next.category, new Date().toISOString(), id)
    if (patch.tags !== undefined || patch.body !== undefined || patch.title !== undefined) {
      const explicit = patch.tags ?? current.tags
      writeTags(id, collectTags(explicit, next.title, next.body))
    }
  })()
  return getNote(id)
}

export function deleteNote(id: string): boolean {
  return db().query('DELETE FROM notes WHERE id = ?').run(id).changes > 0
}

export function listNotes(query: NoteQuery = {}): Note[] {
  const where: string[] = []
  const params: (string | number)[] = []
  if (query.kind) { where.push('n.kind = ?'); params.push(query.kind) }
  if (query.category) { where.push('n.category = ?'); params.push(query.category.toLowerCase()) }
  const clause = where.length ? ` WHERE ${where.join(' AND ')}` : ''
  params.push(query.limit ?? DEFAULT_LIMIT)
  const rows = db().query(`${SELECT}${clause} ORDER BY n.updated_at DESC LIMIT ?`).all(...params) as NoteRow[]
  return rows.map(toNote)
}

/**
 * Search. `#tag` matches a tag, `@x` matches a category or a link's domain,
 * anything else matches title, body or URL (case-insensitive, all words).
 */
export function searchNotes(text: string, query: NoteQuery = {}): Note[] {
  const q = text.trim()
  const candidates = listNotes({ ...query, limit: Number.MAX_SAFE_INTEGER })
  const limit = query.limit ?? DEFAULT_LIMIT
  if (!q) return candidates.slice(0, limit)

  if (q.startsWith('#')) {
    const tag = q.slice(1).toLowerCase()
    return candidates.filter((n) => n.tags.includes(tag)).slice(0, limit)
  }
  if (q.startsWith('@')) {
    const target = q.slice(1).toLowerCase()
    return candidates
      .filter((n) => n.category === target || (n.url !== null && domainOf(n.url).includes(target)))
      .slice(0, limit)
  }
  const words = q.toLowerCase().split(/\s+/)
  return candidates
    .filter((n) => {
      const haystack = `${n.title}\n${n.body}\n${n.url ?? ''}\n${n.tags.join(' ')}`.toLowerCase()
      return words.every((w) => haystack.includes(w))
    })
    .slice(0, limit)
}

export function noteTags(kind?: NoteKind): Array<{ tag: string; count: number }> {
  const sql = `SELECT t.tag AS tag, COUNT(*) AS count FROM note_tags t JOIN notes n ON n.id = t.note_id
    ${kind ? 'WHERE n.kind = ?' : ''} GROUP BY t.tag ORDER BY count DESC, tag ASC`
  return (kind ? db().query(sql).all(kind) : db().query(sql).all()) as Array<{ tag: string; count: number }>
}

export function noteCategories(kind?: NoteKind): Array<{ category: string; count: number }> {
  const sql = `SELECT category, COUNT(*) AS count FROM notes WHERE category IS NOT NULL
    ${kind ? 'AND kind = ?' : ''} GROUP BY category ORDER BY count DESC, category ASC`
  return (kind ? db().query(sql).all(kind) : db().query(sql).all()) as Array<{ category: string; count: number }>
}

// ─── Formatting ─────────────────────────────────────────────

const KIND_LABEL: Record<NoteKind, string> = { memo: 'memo', link: 'link', reference: 'referência' }

export function formatNoteList(notes: readonly Note[]): string {
  if (notes.length === 0) return 'Nenhuma nota encontrada.'
  return notes
    .map((n) => {
      const head = n.title || n.body.split('\n')[0].slice(0, 80)
      const url = n.url ? ` <${n.url}>` : ''
      const category = n.category ? ` @${n.category}` : ''
      // Tags already visible as #hashtags in the headline are not repeated.
      const extra = n.tags.filter((t) => !head.toLowerCase().includes(`#${t}`))
      const tags = extra.length ? ` ${extra.map((t) => `#${t}`).join(' ')}` : ''
      return `  [${n.id}] (${KIND_LABEL[n.kind]}) ${head}${url}${category}${tags}`
    })
    .join('\n')
}

export function formatNoteDetail(n: Note): string {
  const lines = [`[${n.id}] ${KIND_LABEL[n.kind]}${n.title ? ` — ${n.title}` : ''}`]
  if (n.url) lines.push(`URL: ${n.url}`)
  if (n.category) lines.push(`Categoria: ${n.category}`)
  if (n.tags.length) lines.push(`Tags: ${n.tags.map((t) => `#${t}`).join(' ')}`)
  lines.push(`Atualizado: ${new Date(n.updatedAt).toLocaleString('pt-BR')}`)
  if (n.body) lines.push('', n.body)
  return lines.join('\n')
}

export function formatNoteTags(kind?: NoteKind): string {
  const tags = noteTags(kind)
  if (tags.length === 0) return 'Nenhuma tag.'
  return tags.map((t) => `  #${t.tag} (${t.count})`).join('\n')
}

/** Reference notes summarised for the chat system prompt. */
export function buildReferenceContext(): string {
  const refs = listNotes({ kind: 'reference', limit: 200 })
  if (refs.length === 0) return ''
  const byCategory = new Map<string, Note[]>()
  for (const n of refs) {
    const key = n.category ?? 'geral'
    byCategory.set(key, [...(byCategory.get(key) ?? []), n])
  }
  const lines = ['--- Materiais do Assistente ---']
  for (const [category, items] of byCategory) {
    lines.push(`\n[${category}]`)
    for (const n of items) {
      const flat = n.body.replace(/\n/g, ' ')
      const preview = flat.length > 200 ? `${flat.slice(0, 200)}...` : flat
      const tags = n.tags.length ? ` [${n.tags.map((t) => `#${t}`).join(' ')}]` : ''
      lines.push(`  • ${n.title}: ${preview}${tags}`)
    }
  }
  return lines.join('\n')
}

/**
 * Every note as pretty JSON, for the vault's git backup: diffable text instead
 * of a binary database. Null when the store is not initialized.
 */
export function exportNotesSnapshot(): string | null {
  if (!_db) return null
  return JSON.stringify(listNotes({ limit: Number.MAX_SAFE_INTEGER }).reverse(), null, 2)
}

// ─── Legacy migration ───────────────────────────────────────

interface LegacyRecord {
  id?: unknown
  content?: unknown
  title?: unknown
  url?: unknown
  description?: unknown
  category?: unknown
  tags?: unknown
  createdAt?: unknown
  updatedAt?: unknown
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])

const LEGACY_SOURCES: ReadonlyArray<{ file: string; toNote: (r: LegacyRecord) => NewNote | null }> = [
  { file: 'memos.json', toNote: (r) => (str(r.content) ? { kind: 'memo', body: str(r.content), tags: strs(r.tags) } : null) },
  {
    file: 'bookmarks.json',
    toNote: (r) => (str(r.url)
      ? { kind: 'link', url: str(r.url), title: str(r.title), body: str(r.description), tags: strs(r.tags) }
      : null),
  },
  {
    file: 'materials.json',
    toNote: (r) => (str(r.title) || str(r.content)
      ? { kind: 'reference', title: str(r.title), body: str(r.content), category: str(r.category) || 'geral', tags: strs(r.tags) }
      : null),
  },
]

/**
 * Import memos.json, bookmarks.json and materials.json once. Original ids and
 * timestamps are kept. Each file is imported in one transaction and renamed to
 * *.migrated.json only after its rows are committed.
 */
function migrateLegacyJson(dataDir: string): void {
  for (const source of LEGACY_SOURCES) {
    const name = `legacy:${source.file}`
    if (db().query('SELECT 1 FROM migrations WHERE name = ?').get(name)) continue
    const path = join(dataDir, source.file)
    if (!existsSync(path)) continue

    let records: LegacyRecord[]
    try {
      const parsed: unknown = JSON.parse(readFileSync(path, 'utf-8'))
      if (!Array.isArray(parsed)) logger.warn('Legacy notes file is not an array; nothing imported', { file: source.file })
      records = Array.isArray(parsed) ? parsed : []
    } catch (err) {
      // Leave an unreadable file untouched for manual recovery.
      logger.warn('Legacy notes file is unreadable; skipped', { file: source.file, error: err })
      continue
    }

    db().transaction(() => {
      const insert = db().query(
        `INSERT INTO notes (id, kind, title, body, url, category, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      const taken = db().query('SELECT 1 FROM notes WHERE id = ?')
      for (const record of records) {
        const note = source.toNote(record)
        if (!note) continue
        // Ids from the three legacy files share one key space: a collision gets a fresh id, never a dropped note.
        const legacyId = str(record.id)
        let id = legacyId && !taken.get(legacyId) ? legacyId : randomUUID().slice(0, 8)
        while (taken.get(id)) id = randomUUID().slice(0, 8)
        const created = str(record.createdAt) || new Date().toISOString()
        const title = note.title?.trim() ?? ''
        const body = note.body.trim()
        insert.run(id, note.kind, title, body, note.url?.trim() || null,
          note.category?.trim().toLowerCase() || null, created, str(record.updatedAt) || created)
        writeTags(id, collectTags(note.tags ?? [], title, body))
      }
      db().query('INSERT INTO migrations (name, applied_at) VALUES (?, ?)').run(name, new Date().toISOString())
    })()
    try {
      renameSync(path, path.replace(/\.json$/, '.migrated.json'))
    } catch (err) {
      // Rows are committed and the migration recorded; a locked file only stays in place.
      logger.warn('Could not rename migrated notes file', { file: source.file, error: err })
    }
  }
}
