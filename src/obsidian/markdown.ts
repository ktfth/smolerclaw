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
  return note.title.trim() || firstLine.slice(0, 80) || note.url || note.id
}

/** Where a note lands the first time it is exported. Later exports keep the file where it is. */
export function defaultNotePath(note: Note): string {
  const parts = [NOTES_DIR, KIND_DIR[note.kind]]
  if (note.kind === 'reference') parts.push(slugify(note.category ?? 'geral', 'geral'))
  parts.push(`${slugify(noteTitle(note))}-${note.id}.md`)
  return parts.join('/')
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

export function renderNote(note: Note): string {
  const fields = {
    id: note.id,
    kind: note.kind,
    title: note.title,
    url: note.url,
    category: note.category,
    tags: note.tags,
    created: note.createdAt,
    updated: note.updatedAt,
  }
  return `${renderFrontmatter(fields)}\n\n${normalizeBody(note.body)}\n`
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
    .map(({ note, path }) => `- [[${wikiTarget(path)}|${noteTitle(note).replace(/[[\]|]/g, ' ')}]] · ${KIND_DIR[note.kind]}`)
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
