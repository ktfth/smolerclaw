/**
 * Pure rendering and parsing of the vault's Markdown. No I/O here: sync.ts
 * decides what to write, this module decides what it looks like.
 */
import { parse as parseYaml } from 'yaml'
import type { Note, NoteKind } from '../notes'
import type { Task } from '../tasks'
import { OWNED_FOLDER } from './paths'

export const NOTES_DIR = 'Notas'
export const INBOX_DIR = 'Inbox'
export const JOURNAL_DIR = 'Diário'
export const TASKS_FILE = 'Tarefas.md'
export const PANEL_FILE = 'Painel.md'

const KIND_DIR: Record<NoteKind, string> = { memo: 'memo', link: 'link', reference: 'referência' }
const PANEL_TASKS = 15
const PANEL_NOTES = 10

// ─── Dates (local time: the vault is read by a person) ──────

const pad = (n: number): string => String(n).padStart(2, '0')

export function localDate(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

export function localTime(d: Date): string {
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

const MONTHS = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro']
const WEEKDAYS = ['domingo', 'segunda-feira', 'terça-feira', 'quarta-feira', 'quinta-feira', 'sexta-feira', 'sábado']

/** "24 de novembro de 2026" */
export function longDate(d: Date): string {
  return `${d.getDate()} de ${MONTHS[d.getMonth()]} de ${d.getFullYear()}`
}

/** "segunda-feira, 24 de novembro de 2026" */
export function weekdayDate(d: Date): string {
  return `${WEEKDAYS[d.getDay()]}, ${longDate(d)}`
}

/** "3 de abril de 2026 às 16:31"; an unparseable stamp is shown as stored. */
function longDateTime(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : `${longDate(d)} às ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** "03/04/2026" */
function shortDate(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`
}

function dueLabel(iso: string): string {
  const d = new Date(iso)
  return `📅 ${localDate(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

// ─── Names and paths ────────────────────────────────────────

/** File-system and wikilink safe slug; keeps accents, drops what Obsidian or Windows reject. */
export function slugify(text: string, fallback = 'nota'): string {
  const slug = text
    .normalize('NFC')
    .toLowerCase()
    .replace(/[\u0000-\u001f\\/:*?"<>|#^[\]{}%`]/g, ' ')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[.-]+|[.-]+$/g, '')
    .slice(0, 60)
    .replace(/[.-]+$/, '')
  // Windows refuses device names as file or directory names.
  return /^(con|prn|aux|nul|com\d|lpt\d)$/.test(slug) ? `${slug}_` : slug || fallback
}

/** Note bodies are compared and rendered with LF only. */
export function normalizeBody(body: string): string {
  return body.replace(/\r\n/g, '\n').trim()
}

export function noteTitle(note: Note): string {
  const firstLine = note.body.split('\n').find((l) => l.trim())?.replace(/^#+\s*/, '').trim() ?? ''
  return note.title.trim() || firstLine || note.url || note.id
}

const TITLE_MAX = 80
const FILE_TITLE_MAX = 60
const INLINE_TAG = /(^|\s)#[\p{L}\p{N}_/-]+/gu

/** Cut at a word boundary and mark the cut, so a title never ends mid-word. */
function clip(text: string, max: number): string {
  if (text.length <= max) return text
  const cut = text.slice(0, max - 1)
  const space = cut.lastIndexOf(' ')
  return `${(space > max / 2 ? cut.slice(0, space) : cut).replace(/[\s,;:.-]+$/, '')}…`
}

/** Title fit to read: inline #tags dropped (they live in the tags property), long text cut cleanly. */
export function displayTitle(note: Note): string {
  const full = noteTitle(note)
  const clean = full.replace(INLINE_TAG, '$1').replace(/\s+/g, ' ').trim()
  return clip(clean || full, TITLE_MAX)
}

/** Readable file name: the title as written, minus what Obsidian or Windows reject. */
function fileTitle(note: Note): string {
  const name = displayTitle(note)
    .replace(/…$/, '')
    .replace(/\s*:\s*/g, ' - ')
    .replace(/[\u0000-\u001f\\/*?"<>|#^[\]{}%`]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s]+|[.\s]+$/g, '')
  const clipped = clip(name, FILE_TITLE_MAX).replace(/…$/, '').trim()
  return /^(con|prn|aux|nul|com\d|lpt\d)$/i.test(clipped) ? `${clipped}_` : clipped || 'nota'
}

function noteDir(note: Note): string[] {
  const parts = [NOTES_DIR, KIND_DIR[note.kind]]
  if (note.kind === 'reference') parts.push(slugify(note.category ?? 'geral', 'geral'))
  return parts
}

/** Where a note lands the first time it is exported. Later exports keep the file where it is. */
export function defaultNotePath(note: Note): string {
  return [...noteDir(note), `${fileTitle(note)} (${note.id}).md`].join('/')
}

/**
 * True for the slug names older versions exported ("ideia-de-projeto-<id>.md")
 * in the note's default folder: those may be renamed to the readable name.
 * Anything else was chosen by the person and stays put.
 */
export function isLegacyNotePath(rel: string, note: Note): boolean {
  const dir = noteDir(note).join('/')
  const base = rel.startsWith(`${dir}/`) ? rel.slice(dir.length + 1) : ''
  return base.endsWith(`-${note.id}.md`) && !/[\s/A-Z]/.test(base)
}

/** Wikilink target for an owned file: the basename is unique thanks to the id suffix. */
function wikiTarget(rel: string): string {
  return rel.replace(/\.md$/, '').split('/').pop() ?? rel
}

// ─── Frontmatter ────────────────────────────────────────────

/** JSON scalars and flow arrays are valid YAML, so serialising is trivial and unambiguous. */
function renderFrontmatter(fields: Record<string, unknown>): string {
  return ['---', ...Object.entries(fields).map(([k, v]) => `${k}: ${JSON.stringify(v)}`), '---'].join('\n')
}

export interface ParsedFile {
  fields: Record<string, unknown>
  body: string
}

const FRONTMATTER = /^---\n(?:([\s\S]*?)\n)?---[ \t]*(?:\n|$)([\s\S]*)$/

/** Split frontmatter from body. Returns null when the frontmatter is not valid YAML. */
export function parseFile(text: string): ParsedFile | null {
  // Notepad and friends prepend a BOM, which would hide the frontmatter.
  const normalized = text.replace(/^﻿/, '').replace(/\r\n/g, '\n')
  const match = FRONTMATTER.exec(normalized)
  if (!match) return { fields: {}, body: trimBody(normalized) }
  let fields: unknown
  try {
    fields = match[1] ? parseYaml(match[1]) : {}
  } catch {
    return null
  }
  const record = fields && typeof fields === 'object' && !Array.isArray(fields) ? (fields as Record<string, unknown>) : {}
  return { fields: record, body: trimBody(match[2]) }
}

function trimBody(body: string): string {
  return body.replace(/^\n+/, '').replace(/\s+$/, '')
}

export function fieldText(fields: Record<string, unknown>, key: string): string | null {
  const v = fields[key]
  return typeof v === 'string' ? v : typeof v === 'number' ? String(v) : null
}

/** Obsidian writes tags as a list, but people type "a, b" too. */
export function fieldTags(fields: Record<string, unknown>): string[] {
  const v = fields.tags
  if (Array.isArray(v)) return v.filter((t): t is string => typeof t === 'string')
  if (typeof v === 'string') return v.split(/[,\s]+/).filter(Boolean)
  return []
}

export function fieldFlag(fields: Record<string, unknown>, key: string): boolean {
  return fields[key] === true
}

// ─── Notes ──────────────────────────────────────────────────

const KIND_LABEL: Record<NoteKind, string> = { memo: '🗒️ memo', link: '🔗 link', reference: '📚 referência' }

/**
 * Separates the generated header from the note's own text. Everything below
 * it is the note; the header above is rebuilt on every export.
 */
export const CONTENT_MARK = '%% ↓ Texto da nota: edite daqui para baixo. O cabeçalho acima é gerado pelo smolerclaw. %%'

/** Escape text so it reads as typed in a heading or callout, never as Markdown syntax. */
function escapeInline(text: string): string {
  return text.replace(/\s+/g, ' ').trim().replace(/[\\`*_[\]|<>#~=%$]/g, '\\$&')
}

function linkLine(note: Note): string | null {
  if (!note.url) return null
  if (!/^(https?|mailto):/i.test(note.url)) return `> Endereço: ${escapeInline(note.url)}`
  const target = note.url.replace(/[\s<>]/g, (c) => encodeURIComponent(c))
  const label = note.title.trim() ? escapeInline(note.title) : 'abrir link'
  return `> Abrir: [${label}](<${target}>)`
}

function noteHeader(note: Note): string[] {
  const meta = [KIND_LABEL[note.kind]]
  if (note.kind === 'reference' && note.category) meta.push(`categoria ${escapeInline(note.category)}`)
  meta.push(`criada em ${longDateTime(note.createdAt)}`)
  const edited = new Date(note.updatedAt).getTime() - new Date(note.createdAt).getTime() > 60_000
  if (edited) meta.push(`atualizada em ${longDateTime(note.updatedAt)}`)
  const link = linkLine(note)
  // A note that already opens with its own "# title" keeps it; a second one would only repeat it.
  const ownHeading = /^#\s/.test(normalizeBody(note.body))
  const heading = ownHeading ? [] : [`# ${escapeInline(displayTitle(note))}`, '']
  return [...heading, `> ${meta.join(' · ')}`, ...(link ? ['>', link] : [])]
}

/** Empty optional fields are left out: a missing key means "unchanged" on pull. */
function noteFields(note: Note): Record<string, unknown> {
  const optional = { title: note.title.trim() || null, url: note.url, category: note.category }
  return {
    id: note.id,
    kind: note.kind,
    ...Object.fromEntries(Object.entries(optional).filter(([, v]) => v)),
    tags: note.tags,
    created: note.createdAt,
    updated: note.updatedAt,
  }
}

export function renderNote(note: Note): string {
  const body = normalizeBody(note.body)
  const content = body ? `${CONTENT_MARK}\n\n${body}` : CONTENT_MARK
  return `${renderFrontmatter(noteFields(note))}\n\n${noteHeader(note).join('\n')}\n\n${content}\n`
}

/**
 * The "# title" line of the generated header, as typed (escapes undone), or
 * null when the file has no header (an older export or an Inbox file).
 */
export function noteHeading(body: string): string | null {
  const lines = body.split('\n')
  const mark = lines.findIndex((l) => l.trim() === CONTENT_MARK)
  if (mark < 0) return null
  const heading = lines.slice(0, mark).find((l) => /^#\s/.test(l))
  return heading ? heading.replace(/^#\s+/, '').replace(/\\(.)/g, '$1').trim() : null
}

/** The note's own text from a parsed file body: the generated header is dropped. */
export function noteBody(body: string): string {
  const lines = body.split('\n')
  const mark = lines.findIndex((l) => l.trim() === CONTENT_MARK)
  return mark < 0 ? body : trimBody(lines.slice(mark + 1).join('\n'))
}


// ─── Tasks ──────────────────────────────────────────────────

const TASK_LINE = /^\s*[-*] \[([ xX])\] (.*)$/
const ID_MARK = /\s*%%id:([A-Za-z0-9_-]+)%%\s*$/
const DUE_MARK = /\s*📅\s*(\d{4})-(\d{2})-(\d{2})(?:\s+(\d{2}):(\d{2}))?\s*$/u
const DEFAULT_DUE_HOUR = 9

export interface TaskLine {
  checked: boolean
  title: string
  id: string | null
  /** Local due time from a trailing "📅 YYYY-MM-DD [HH:MM]", if any. */
  due: Date | null
}

function parseDue(text: string): Date | null {
  const m = DUE_MARK.exec(text)
  if (!m) return null
  const [, y, mo, d, h, mi] = m
  const due = new Date(Number(y), Number(mo) - 1, Number(d), h ? Number(h) : DEFAULT_DUE_HOUR, mi ? Number(mi) : 0)
  return Number.isNaN(due.getTime()) ? null : due
}

function sortTasks(tasks: readonly Task[]): Task[] {
  return [...tasks].sort((a, b) =>
    (a.dueAt ?? '￿').localeCompare(b.dueAt ?? '￿') || a.createdAt.localeCompare(b.createdAt),
  )
}

export function taskText(task: Task): string {
  return task.dueAt ? `${task.title} ${dueLabel(task.dueAt)}` : task.title
}

export function renderTasks(pending: readonly Task[]): string {
  const lines = sortTasks(pending).map((t) => `- [ ] ${taskText(t)} %%id:${t.id}%%`)
  return [
    '# Tarefas',
    '',
    '> Marque `[x]` para concluir. Uma linha nova `- [ ] ...` vira tarefa. Aplicado no próximo `obsidian_sync`.',
    '',
    ...(lines.length ? lines : ['_Nenhuma tarefa pendente._']),
    '',
  ].join('\n')
}

export function parseTasks(text: string): TaskLine[] {
  return text.replace(/\r\n/g, '\n').split('\n').flatMap((line) => {
    const match = TASK_LINE.exec(line)
    if (!match) return []
    const id = ID_MARK.exec(match[2])?.[1] ?? null
    const rest = match[2].replace(ID_MARK, '')
    const title = rest.replace(DUE_MARK, '').trim()
    return title || id ? [{ checked: match[1] !== ' ', title, id, due: parseDue(rest) }] : []
  })
}

// ─── Panel ──────────────────────────────────────────────────

export interface PanelInput {
  pending: readonly Task[]
  recent: ReadonlyArray<{ note: Note; path: string }>
  today: string
}

export function renderPanel(input: PanelInput): string {
  const tasks = sortTasks(input.pending).slice(0, PANEL_TASKS).map((t) => `- ${taskText(t)}`)
  const notes = input.recent
    .slice(0, PANEL_NOTES)
    .map(({ note, path }) => `- [[${wikiTarget(path)}|${displayTitle(note).replace(/[[\]|]/g, ' ')}]] · ${KIND_LABEL[note.kind]} · ${shortDate(note.createdAt)}`)
  return [
    '# Painel smolerclaw',
    '',
    `## Tarefas pendentes (${input.pending.length})`,
    '',
    ...(tasks.length ? tasks : ['_Nenhuma._']),
    '',
    `Lista completa: [[${OWNED_FOLDER}/Tarefas|Tarefas]]`,
    '',
    '## Notas recentes',
    '',
    ...(notes.length ? notes : ['_Nenhuma._']),
    '',
    '## Atividade de hoje',
    '',
    `![[${OWNED_FOLDER}/${JOURNAL_DIR}/${input.today}]]`,
    '',
  ].join('\n')
}
