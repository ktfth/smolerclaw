/**
 * Vault synchronisation. SQLite stays the source of truth:
 *  - push() projects notes and tasks into Markdown, idempotently, and never
 *    overwrites a file the person edited (its hash no longer matches).
 *  - pull() brings those edits back: note edits, Inbox files, ticked tasks.
 * Deleting a file in Obsidian never deletes data; `deletar: true` does.
 */
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { addNote, deleteNote, getNote, listNotes, updateNote, NOTE_KINDS, type Note, type NotePatch } from '../notes'
import { addTask, completeTask, listTasks, type Task } from '../tasks'
import { isInside, ownedPath, type VaultRoot } from './paths'
import {
  INBOX_DIR, NOTES_DIR, PANEL_FILE, TASKS_FILE,
  defaultNotePath, fieldFlag, fieldTags, fieldText, localDate, normalizeBody, parseFile, parseTasks,
  renderNote, renderPanel, renderTasks, type TaskLine,
} from './markdown'

const MANIFEST_FILE = '.smolerclaw-sync.json'
const CONFLICT_FILE = /\.conflito(-[\d-]+)?\.md$/
const IMPORTING_PREFIX = '.importando-'
const ALL = Number.MAX_SAFE_INTEGER
/** Obsidian saves while you type: an Inbox file must sit still this long before import. */
export const INBOX_SETTLE_MS = 30_000

interface ManifestEntry {
  path: string
  hash: string
}

/** Keys: `note:<id>`, `tasks`, `panel`. Hash = sha256 of the content smolerclaw last wrote. */
type Manifest = Readonly<Record<string, ManifestEntry>>

export interface PushReport {
  written: string[]
  removed: string[]
  /** Files edited in Obsidian and not pulled yet: left untouched. */
  pending: string[]
  errors: string[]
}

export interface PullReport {
  updated: string[]
  created: string[]
  deleted: string[]
  completed: string[]
  tasksCreated: string[]
  conflicts: string[]
  errors: string[]
}

export interface VaultStatus {
  root: string
  tracked: number
  pendingEdits: string[]
  inbox: string[]
  conflicts: string[]
}

export interface PullOptions {
  now?: Date
  inboxSettleMs?: number
}

// ─── I/O helpers ────────────────────────────────────────────

const sha = (text: string): string => createHash('sha256').update(text).digest('hex')
const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err))

function readText(abs: string): string | null {
  try {
    return readFileSync(abs, 'utf-8')
  } catch {
    return null
  }
}

/** Write via temp file + rename so Obsidian never reads a half-written note. */
function writeAtomic(abs: string, content: string): void {
  const tmp = join(dirname(abs), `.smolerclaw-${randomUUID().slice(0, 8)}.tmp`)
  writeFileSync(tmp, content)
  try {
    renameSync(tmp, abs)
  } catch (err) {
    // Typically EBUSY/EPERM while Obsidian holds the file; do not leave the temp file behind.
    try { unlinkSync(tmp) } catch { /* already gone */ }
    throw err
  }
}

function loadManifest(vr: VaultRoot): Manifest {
  const text = readText(join(vr.root, MANIFEST_FILE))
  if (!text) return {}
  try {
    const parsed = JSON.parse(text) as { files?: Record<string, ManifestEntry> }
    return parsed.files && typeof parsed.files === 'object' ? parsed.files : {}
  } catch {
    // A lost manifest only costs re-adoption: identical files are adopted, edited ones wait for pull.
    return {}
  }
}

function saveManifest(vr: VaultRoot, before: Manifest, after: Manifest, errors: string[]): void {
  const next = JSON.stringify({ version: 1, files: after }, null, 2)
  if (next === JSON.stringify({ version: 1, files: before }, null, 2)) return
  try {
    writeAtomic(ownedPath(vr, MANIFEST_FILE), next)
  } catch (err) {
    errors.push(`${MANIFEST_FILE}: ${errorText(err)}`)
  }
}

interface ListOptions {
  recursive: boolean
  conflicts?: boolean
}

/** Markdown files under an owned directory. Symlinks and junctions are never followed. */
function listMarkdown(vr: VaultRoot, relDir: string, opts: ListOptions, errors: string[]): string[] {
  const abs = join(vr.root, ...relDir.split('/'))
  try {
    if (!existsSync(abs) || !isInside(vr.root, realpathSync.native(abs))) return []
    return readdirSync(abs, { withFileTypes: true }).flatMap((entry) => {
      if (entry.name.startsWith('.') || entry.isSymbolicLink()) return []
      const rel = `${relDir}/${entry.name}`
      if (entry.isDirectory()) return opts.recursive ? listMarkdown(vr, rel, opts, errors) : []
      if (!entry.isFile() || !entry.name.endsWith('.md')) return []
      return CONFLICT_FILE.test(entry.name) === Boolean(opts.conflicts) ? [rel] : []
    })
  } catch (err) {
    errors.push(`${relDir}: ${errorText(err)}`)
    return []
  }
}

/**
 * Note id → owned path, found by frontmatter so renames and moves in Obsidian
 * are respected. A copied file carries the same id: the tracked path wins and
 * the duplicate is reported instead of silently taking over.
 */
function scanNotes(vr: VaultRoot, files: Manifest, errors: string[]): Map<string, string> {
  const found = new Map<string, string>()
  for (const rel of listMarkdown(vr, NOTES_DIR, { recursive: true }, errors)) {
    const text = readText(ownedPath(vr, rel))
    const id = text === null ? null : fieldText(parseFile(text)?.fields ?? {}, 'id')
    if (!id) continue
    const seen = found.get(id)
    if (!seen) {
      found.set(id, rel)
      continue
    }
    const keep = files[`note:${id}`]?.path === rel ? rel : seen
    found.set(id, keep)
    errors.push(`id duplicado ${id}: ${seen} e ${rel} (usando ${keep})`)
  }
  return found
}

// ─── Push ───────────────────────────────────────────────────

export function push(vr: VaultRoot, now = new Date()): PushReport {
  const before = loadManifest(vr)
  const files: Record<string, ManifestEntry> = { ...before }
  const report: PushReport = { written: [], removed: [], pending: [], errors: [] }

  const writeOwned = (key: string, relOf: () => string, content: string): void => {
    let rel = key
    try {
      rel = relOf()
      const abs = ownedPath(vr, rel)
      const current = readText(abs)
      const wanted = sha(content)
      if (current !== null) {
        const actual = sha(current)
        const ours = files[key] ? files[key].hash === actual : actual === wanted
        if (!ours) {
          report.pending.push(rel)
          return
        }
        if (actual === wanted) {
          files[key] = { path: rel, hash: wanted }
          return
        }
      }
      writeAtomic(abs, content)
      files[key] = { path: rel, hash: wanted }
      report.written.push(rel)
    } catch (err) {
      report.errors.push(`${rel}: ${errorText(err)}`)
    }
  }

  let scanned: Map<string, string> | null = null
  const locate = (note: Note): string => {
    const known = files[`note:${note.id}`]?.path
    if (known && existsSync(ownedPath(vr, known))) return known
    scanned ??= scanNotes(vr, before, report.errors)
    return scanned.get(note.id) ?? known ?? defaultNotePath(note)
  }

  try {
    const notes = listNotes({ limit: ALL })
    const live = new Set(notes.map((n) => `note:${n.id}`))
    for (const note of notes) writeOwned(`note:${note.id}`, () => locate(note), renderNote(note))

    for (const [key, entry] of Object.entries(files)) {
      if (!key.startsWith('note:') || live.has(key)) continue
      // Deleted in smolerclaw: remove the file only if it is still exactly what we wrote.
      try {
        const abs = ownedPath(vr, entry.path)
        const current = readText(abs)
        if (current !== null && sha(current) === entry.hash) {
          unlinkSync(abs)
          report.removed.push(entry.path)
        }
      } catch (err) {
        report.errors.push(`${entry.path}: ${errorText(err)}`)
      }
      delete files[key]
    }

    const pending = listTasks(false)
    writeOwned('tasks', () => TASKS_FILE, renderTasks(pending))
    const recent = notes.slice(0, 10).map((note) => ({ note, path: files[`note:${note.id}`]?.path ?? defaultNotePath(note) }))
    writeOwned('panel', () => PANEL_FILE, renderPanel({ pending, recent, today: localDate(now) }))
  } finally {
    // Whatever was written must be recorded, or the next run mistakes our own files for edits.
    saveManifest(vr, before, files, report.errors)
  }
  return report
}

// ─── Pull ───────────────────────────────────────────────────

function conflictPath(vr: VaultRoot, rel: string, now: Date): string {
  const base = rel.replace(/\.md$/, '')
  const plain = `${base}.conflito.md`
  if (!existsSync(ownedPath(vr, plain))) return plain
  return `${base}.conflito-${localDate(now)}-${now.getTime()}.md`
}

function keepAsConflict(vr: VaultRoot, rel: string, text: string, now: Date, report: PullReport): void {
  const copy = conflictPath(vr, rel, now)
  writeAtomic(ownedPath(vr, copy), text)
  report.conflicts.push(copy)
}

/** Fields the person changed, as a patch. Missing keys keep the stored value; null clears. */
function notePatch(note: Note, fields: Record<string, unknown>, body: string): NotePatch {
  const patch: { -readonly [K in keyof NotePatch]: NotePatch[K] } = {}
  if (normalizeBody(body) !== normalizeBody(note.body)) patch.body = body
  const title = fieldText(fields, 'title')
  if ('title' in fields && (title ?? '') !== note.title) patch.title = title ?? ''
  for (const key of ['url', 'category'] as const) {
    if (!(key in fields)) continue
    const value = fieldText(fields, key) ?? ''
    if (value !== (note[key] ?? '')) patch[key] = value
  }
  const tags = fieldTags(fields).map((t) => t.toLowerCase())
  if ('tags' in fields && tags.join(' ') !== note.tags.join(' ')) patch.tags = tags
  return patch
}

function pullNotes(vr: VaultRoot, files: Record<string, ManifestEntry>, report: PullReport, now: Date): void {
  for (const [id, rel] of scanNotes(vr, files, report.errors)) {
    try {
      const abs = ownedPath(vr, rel)
      const text = readText(abs)
      if (text === null) continue
      const key = `note:${id}`
      if (files[key]?.hash === sha(text)) continue

      const parsed = parseFile(text)
      if (!parsed) {
        report.errors.push(`${rel}: frontmatter inválido`)
        continue
      }
      const note = getNote(id)
      if (!note) continue
      if (!files[key] && text === renderNote(note)) {
        files[key] = { path: rel, hash: sha(text) }
        continue
      }

      // Stale file (database changed since export): never apply it, deletion included.
      const stale = fieldText(parsed.fields, 'updated') !== note.updatedAt
      if (stale) {
        keepAsConflict(vr, rel, text, now, report)
      } else if (fieldFlag(parsed.fields, 'deletar')) {
        deleteNote(id)
        unlinkSync(abs)
        delete files[key]
        report.deleted.push(rel)
        continue
      } else {
        const patch = notePatch(note, parsed.fields, parsed.body)
        if (Object.keys(patch).length) {
          updateNote(id, patch)
          report.updated.push(rel)
        }
      }
      // Mark the file as ours again so push rewrites it in canonical form.
      files[key] = { path: rel, hash: sha(text) }
    } catch (err) {
      report.errors.push(`${rel}: ${errorText(err)}`)
    }
  }
}

function inboxTitle(rel: string): string {
  return (rel.split('/').pop() ?? '').replace(/\.md$/, '')
}

/**
 * Inbox files become notes. The file is first renamed to a hidden name, so a
 * failure after the note is created can never import it twice.
 */
function pullInbox(vr: VaultRoot, report: PullReport, now: Date, settleMs: number): void {
  for (const rel of listMarkdown(vr, INBOX_DIR, { recursive: false }, report.errors)) {
    try {
      const abs = ownedPath(vr, rel)
      if (settleMs > 0 && now.getTime() - statSync(abs).mtimeMs < settleMs) continue
      const parsed = parseFile(readText(abs) ?? '')
      if (!parsed) {
        report.errors.push(`${rel}: frontmatter inválido`)
        continue
      }
      const kindField = fieldText(parsed.fields, 'kind')
      const kind = NOTE_KINDS.find((k) => k === kindField) ?? 'memo'
      const url = fieldText(parsed.fields, 'url') ?? undefined
      if (kind === 'link' && !url) {
        report.errors.push(`${rel}: link sem url`)
        continue
      }
      // An empty file is probably still being written; leave it for the next sync.
      if (!parsed.body && kind !== 'link') continue

      const claimed = join(dirname(abs), `${IMPORTING_PREFIX}${randomUUID().slice(0, 8)}.md`)
      renameSync(abs, claimed)
      let note: Note
      try {
        note = addNote({
          kind,
          body: parsed.body,
          url,
          title: fieldText(parsed.fields, 'title') ?? inboxTitle(rel),
          category: fieldText(parsed.fields, 'category') ?? (kind === 'reference' ? 'geral' : undefined),
          tags: fieldTags(parsed.fields),
        })
      } catch (err) {
        renameSync(claimed, abs)
        throw err
      }
      try { unlinkSync(claimed) } catch { /* hidden leftover is never re-imported */ }
      report.created.push(`${rel} → ${note.id}`)
    } catch (err) {
      report.errors.push(`${rel}: ${errorText(err)}`)
    }
  }
}

/** True when a line changes something pull cannot apply (rename, new due date, ticked new line). */
function unsupportedTaskEdit(line: TaskLine, pending: ReadonlyMap<string, Task>): boolean {
  if (!line.id) return line.checked
  const task = pending.get(line.id)
  if (!task) return false
  const dueChanged = (line.due?.getTime() ?? null) !== (task.dueAt ? Math.floor(new Date(task.dueAt).getTime() / 60_000) * 60_000 : null)
  return line.title !== task.title || dueChanged
}

function pullTasks(vr: VaultRoot, files: Record<string, ManifestEntry>, report: PullReport, now: Date): void {
  const rel = files.tasks?.path ?? TASKS_FILE
  let text: string | null
  try {
    text = readText(ownedPath(vr, rel))
  } catch (err) {
    report.errors.push(`${rel}: ${errorText(err)}`)
    return
  }
  if (text === null || files.tasks?.hash === sha(text)) return

  const pending = new Map(listTasks(false).map((t) => [t.id, t]))
  const lines = parseTasks(text)
  const listed = new Set(lines.flatMap((l) => (l.id ? [l.id] : [])))
  let unsupported = [...pending.keys()].some((id) => !listed.has(id))

  // One line at a time: a failure must not undo or repeat the lines already applied.
  for (const line of lines) {
    try {
      if (unsupportedTaskEdit(line, pending)) unsupported = true
      if (line.id && line.checked && pending.has(line.id)) {
        const done = completeTask(line.id)
        if (done) report.completed.push(done.title)
      } else if (!line.id && !line.checked && line.title) {
        report.tasksCreated.push(addTask(line.title, line.due ?? undefined).title)
      }
    } catch (err) {
      report.errors.push(`${rel}: "${line.title}": ${errorText(err)}`)
    }
  }
  // Edits we cannot apply would vanish when push regenerates the file: keep them beside it.
  if (unsupported) {
    try {
      keepAsConflict(vr, rel, text, now, report)
    } catch (err) {
      report.errors.push(`${rel}: ${errorText(err)}`)
    }
  }
  files.tasks = { path: rel, hash: sha(text) }
}

export function pull(vr: VaultRoot, options: PullOptions = {}): PullReport {
  const now = options.now ?? new Date()
  const before = loadManifest(vr)
  const files: Record<string, ManifestEntry> = { ...before }
  const report: PullReport = { updated: [], created: [], deleted: [], completed: [], tasksCreated: [], conflicts: [], errors: [] }
  try {
    pullNotes(vr, files, report, now)
    pullInbox(vr, report, now, options.inboxSettleMs ?? INBOX_SETTLE_MS)
    pullTasks(vr, files, report, now)
  } finally {
    saveManifest(vr, before, files, report.errors)
  }
  return report
}

/** Pull edits first, then project the result. */
export function sync(vr: VaultRoot, options: PullOptions = {}): { pull: PullReport; push: PushReport } {
  const pulled = pull(vr, options)
  return { pull: pulled, push: push(vr, options.now) }
}

// ─── Status ─────────────────────────────────────────────────

export function status(vr: VaultRoot): VaultStatus & { errors: string[] } {
  const errors: string[] = []
  const files = loadManifest(vr)
  const pendingEdits = Object.values(files).flatMap((entry) => {
    const text = readText(join(vr.root, ...entry.path.split('/')))
    return text !== null && sha(text) !== entry.hash ? [entry.path] : []
  })
  const conflicts = [
    ...listMarkdown(vr, NOTES_DIR, { recursive: true, conflicts: true }, errors),
    ...listMarkdown(vr, '.', { recursive: false, conflicts: true }, errors).map((p) => p.replace(/^\.\//, '')),
  ]
  const inbox = listMarkdown(vr, INBOX_DIR, { recursive: false }, errors)
  return { root: vr.root, tracked: Object.keys(files).length, pendingEdits, inbox, conflicts, errors }
}
