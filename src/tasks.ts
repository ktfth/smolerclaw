/**
 * Task/reminder system with scheduled Windows notifications.
 * Tasks live in the shared SQLite store, with no copy kept in memory: the
 * TUI, the MCP server and the Obsidian mirror can all change them without
 * overwriting each other. A background timer checks every 30s for due tasks
 * and fires Windows toast notifications via PowerShell.
 *
 * REFACTORED: All PowerShell execution now goes through windows-executor.ts
 */

import { existsSync, readFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { IS_WINDOWS } from './platform'
import { logger } from './core/logger'
import { ensureSchema, hasSchema, migrateOnce, openStore, store } from './core/store'
import {
  showToast,
  executeSchtasks,
  psDoubleQuoteEscape,
} from './utils/windows-executor'

// ─── Types ──────────────────────────────────────────────────

export interface Task {
  id: string
  title: string
  dueAt: string | null      // ISO 8601 datetime, null = no reminder
  createdAt: string          // ISO 8601 datetime
  done: boolean
  notified: boolean          // whether the notification was already sent
  projectId: string | null   // linked project, null = personal / unlinked
}

// ─── Storage ────────────────────────────────────────────────

const CHECK_INTERVAL_MS = 30_000
/** A reminder fires only within this long after its due time. */
const NOTIFY_WINDOW_MS = 5 * 60_000
const LEGACY_FILE = 'tasks.json'
const OPEN_REMINDERS = 'WHERE done = 0 AND notified = 0 AND due_at IS NOT NULL'

let _checkTimer: ReturnType<typeof setInterval> | null = null
let _onNotify: ((task: Task) => void) | null = null

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tasks (
  id         TEXT PRIMARY KEY,
  title      TEXT NOT NULL,
  due_at     TEXT,
  created_at TEXT NOT NULL,
  done       INTEGER NOT NULL DEFAULT 0 CHECK (done IN (0, 1)),
  notified   INTEGER NOT NULL DEFAULT 0 CHECK (notified IN (0, 1)),
  project_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_tasks_due ON tasks(done, notified, due_at);
`

interface TaskRow {
  id: string
  title: string
  due_at: string | null
  created_at: string
  done: number
  notified: number
  project_id: string | null
}

function toTask(row: TaskRow): Task {
  return {
    id: row.id,
    title: row.title,
    dueAt: row.due_at,
    createdAt: row.created_at,
    done: row.done === 1,
    notified: row.notified === 1,
    projectId: row.project_id ?? null,
  }
}

/** Rows in insertion order, like the JSON array they replace. */
function selectTasks(where = '', ...params: string[]): Task[] {
  return (store().query(`SELECT * FROM tasks ${where} ORDER BY rowid`).all(...params) as TaskRow[]).map(toTask)
}

function insertTask(task: Task): void {
  store().query(
    'INSERT INTO tasks (id, title, due_at, created_at, done, notified, project_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(task.id, task.title, task.dueAt, task.createdAt, task.done ? 1 : 0, task.notified ? 1 : 0, task.projectId)
}

/** First task matching the id or containing the text in its title. */
function findTask(idOrTitle: string): Task | undefined {
  const lower = idOrTitle.toLowerCase()
  return selectTasks().find((t) => t.id === idOrTitle || t.title.toLowerCase().includes(lower))
}

// ─── Public API ─────────────────────────────────────────────

/**
 * Initialize the task system. Must be called once at startup.
 * @param dataDir Directory holding the shared store
 * @param onNotify Callback when a task notification fires
 */
export function initTasks(dataDir: string, onNotify: (task: Task) => void): void {
  _onNotify = onNotify
  openStore(dataDir)
  ensureSchema('tasks', SCHEMA)
  addProjectColumn()
  migrateLegacyJson(dataDir)

  // Start background checker for in-process notifications
  if (_checkTimer) clearInterval(_checkTimer)
  _checkTimer = setInterval(() => checkDueTasks(), CHECK_INTERVAL_MS)

  // Sync pending reminders with Windows Task Scheduler so they fire
  // even if smolerclaw is not running
  syncScheduledTasks().catch(() => {})
}

/**
 * Stop the background timer (call on exit).
 */
export function stopTasks(): void {
  if (_checkTimer) {
    clearInterval(_checkTimer)
    _checkTimer = null
  }
}

/**
 * Add a new task with optional due time.
 */
export function addTask(title: string, dueAt?: Date, projectId?: string): Task {
  const task: Task = {
    id: generateId(),
    title: title.trim(),
    dueAt: dueAt ? dueAt.toISOString() : null,
    createdAt: new Date().toISOString(),
    done: false,
    notified: false,
    projectId: projectId ?? null,
  }
  insertTask(task)

  // Schedule a Windows Task Scheduler job so the reminder fires
  // even if smolerclaw is not running
  if (dueAt && IS_WINDOWS) {
    scheduleWindowsTask(task).catch(() => {})
  }

  return task
}

/**
 * Mark a task as done by ID or partial title match.
 */
export function completeTask(idOrTitle: string): Task | null {
  const task = findTask(idOrTitle)
  if (!task || task.done) return null

  // Conditional update: if another process completed it first, nothing changes here.
  const changes = store().query('UPDATE tasks SET done = 1 WHERE id = ? AND done = 0').run(task.id).changes
  if (changes === 0) return null

  // Remove the scheduled Windows task
  if (task.dueAt && IS_WINDOWS) {
    removeWindowsTask(task.id).catch(() => {})
  }

  return { ...task, done: true }
}

/**
 * Remove a task by ID or partial title.
 */
export function removeTask(idOrTitle: string): boolean {
  const task = findTask(idOrTitle)
  if (!task) return false
  if (store().query('DELETE FROM tasks WHERE id = ?').run(task.id).changes === 0) return false

  // Remove the scheduled Windows task
  if (task.dueAt && IS_WINDOWS) {
    removeWindowsTask(task.id).catch(() => {})
  }

  return true
}

/**
 * List tasks, optionally including done ones and limited to one project.
 */
export function listTasks(showDone = false, projectId?: string): Task[] {
  const clauses = [showDone ? '' : 'done = 0', projectId ? 'project_id = ?' : ''].filter(Boolean)
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''
  return projectId ? selectTasks(where, projectId) : selectTasks(where)
}

/**
 * Every task as pretty JSON, for the vault's git backup. Null when the store
 * is not initialized.
 */
export function exportTasksSnapshot(): string | null {
  if (!hasSchema('tasks')) return null
  return JSON.stringify(listTasks(true), null, 2)
}

/**
 * Format tasks for display.
 */
export function formatTaskList(tasks: Task[]): string {
  if (tasks.length === 0) return 'Nenhuma tarefa pendente.'

  const lines = tasks.map((t) => {
    const status = t.done ? '[x]' : '[ ]'
    const due = t.dueAt ? ` (${formatDueTime(t.dueAt)})` : ''
    return `  ${status} ${t.title}${due}  [${t.id}]`
  })

  return `Tarefas (${tasks.length}):\n${lines.join('\n')}`
}

/**
 * Parse a natural-language time reference into a Date.
 * Supports: "18h", "18:30", "14h30", "amanha 9h", "em 30 minutos"
 */
export function parseTime(input: string): Date | null {
  const now = new Date()
  const text = input.toLowerCase().trim()

  // "em X minutos" / "em X horas"
  const inMatch = text.match(/em\s+(\d+)\s*(min|minutos?|h|horas?)/)
  if (inMatch) {
    const amount = parseInt(inMatch[1])
    const unit = inMatch[2].startsWith('h') ? 'hours' : 'minutes'
    const result = new Date(now)
    if (unit === 'hours') {
      result.setHours(result.getHours() + amount)
    } else {
      result.setMinutes(result.getMinutes() + amount)
    }
    return result
  }

  // Check for "amanha" prefix
  let targetDate = new Date(now)
  if (text.includes('amanha') || text.includes('amanhã')) {
    targetDate.setDate(targetDate.getDate() + 1)
  }

  // "18h", "18h30", "18:30", "9h", "09:00"
  const timeMatch = text.match(/(\d{1,2})\s*[h:]\s*(\d{2})?/)
  if (timeMatch) {
    const hours = parseInt(timeMatch[1])
    const minutes = parseInt(timeMatch[2] || '0')
    if (hours >= 0 && hours <= 23 && minutes >= 0 && minutes <= 59) {
      targetDate.setHours(hours, minutes, 0, 0)

      // If the time is already past today (and no "amanha"), set to tomorrow
      if (targetDate <= now && !text.includes('amanha') && !text.includes('amanhã')) {
        targetDate.setDate(targetDate.getDate() + 1)
      }

      return targetDate
    }
  }

  return null
}

// ─── Background Checker ─────────────────────────────────────

/**
 * Every running process checks; only the one whose update flips `notified`
 * fires the reminder, so two processes never show it twice. Exported for
 * tests, which pass their own toast.
 */
export function checkDueTasks(toast: (task: Task) => void = fireNotification): void {
  if (!hasSchema('tasks')) return
  try {
    const now = Date.now()
    const claim = store().query('UPDATE tasks SET notified = 1 WHERE id = ? AND notified = 0')
    for (const task of selectTasks(OPEN_REMINDERS)) {
      const due = new Date(task.dueAt as string).getTime()
      if (isNaN(due)) continue

      // Fire if due time has passed (within the notification window)
      const diffMs = now - due
      if (diffMs < 0 || diffMs >= NOTIFY_WINDOW_MS) continue
      if (claim.run(task.id).changes === 0) continue

      // Fire Windows toast notification
      toast(task)

      // Call the callback for TUI display
      _onNotify?.({ ...task, notified: true })
    }
  } catch (err) {
    // A busy or closed store must not crash the timer; the next tick retries.
    logger.warn('Task reminder check failed', { error: err })
  }
}

/** XML-encode a string for safe embedding in XML attributes/text. */
function xmlEncode(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

/**
 * Fire a Windows toast notification for a task.
 * Uses windows-executor's showToast for consistent handling.
 */
async function fireNotification(task: Task): Promise<void> {
  if (!IS_WINDOWS) return

  try {
    await showToast('smolerclaw - Lembrete', task.title, { timeout: 10_000 })
  } catch {
    // Best effort — notification failure should not crash
  }
}

// ─── Windows Task Scheduler Integration ─────────────────────

const TASK_PREFIX = 'smolerclaw-reminder-'

/**
 * Create a Windows Scheduled Task that fires a toast notification at the due time.
 * Uses schtasks.exe — works without admin rights for the current user.
 */
async function scheduleWindowsTask(task: Task): Promise<void> {
  if (!task.dueAt) return

  const due = new Date(task.dueAt)
  if (isNaN(due.getTime()) || due.getTime() <= Date.now()) return

  const taskName = `${TASK_PREFIX}${task.id}`

  // Format date/time for schtasks: MM/DD/YYYY and HH:MM
  const startDate = [
    String(due.getMonth() + 1).padStart(2, '0'),
    String(due.getDate()).padStart(2, '0'),
    String(due.getFullYear()),
  ].join('/')
  const startTime = [
    String(due.getHours()).padStart(2, '0'),
    String(due.getMinutes()).padStart(2, '0'),
  ].join(':')

  // PowerShell command that shows a toast notification
  // XML-encode title and escape for PowerShell double-quoted string
  const title = psDoubleQuoteEscape(xmlEncode(task.title))
  const toastPs = [
    '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null;',
    '[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null;',
    `$x = New-Object Windows.Data.Xml.Dom.XmlDocument;`,
    `$x.LoadXml('<toast><visual><binding template=""ToastText02""><text id=""1"">smolerclaw</text><text id=""2"">${title}</text></binding></visual><audio src=""ms-winsoundevent:Notification.Reminder""/></toast>');`,
    `[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('smolerclaw').Show([Windows.UI.Notifications.ToastNotification]::new($x))`,
  ].join(' ')

  try {
    await executeSchtasks('Create', taskName, [
      '/SC', 'ONCE',
      '/SD', startDate,
      '/ST', startTime,
      '/TR', `powershell -NoProfile -WindowStyle Hidden -Command "${toastPs}"`,
      '/F',  // force overwrite if exists
    ])
  } catch {
    // Best effort — scheduler failure should not block task creation
  }
}

/**
 * Remove a scheduled Windows task by task ID.
 */
async function removeWindowsTask(taskId: string): Promise<void> {
  const taskName = `${TASK_PREFIX}${taskId}`
  try {
    await executeSchtasks('Delete', taskName, ['/F'])
  } catch {
    // Ignore — task may not exist
  }
}

/**
 * Sync existing tasks with Task Scheduler on startup.
 * Ensures pending reminders are scheduled even after a restart.
 */
async function syncScheduledTasks(): Promise<void> {
  if (!IS_WINDOWS) return

  const now = Date.now()
  for (const task of selectTasks(OPEN_REMINDERS)) {
    if (task.done || task.notified || !task.dueAt) continue
    const due = new Date(task.dueAt)
    if (isNaN(due.getTime()) || due.getTime() <= now) continue

    // Check if the scheduled task exists
    try {
      const result = await executeSchtasks('Query', `${TASK_PREFIX}${task.id}`)
      if (result.exitCode !== 0) {
        // Task doesn't exist in scheduler — recreate it
        await scheduleWindowsTask(task)
      }
    } catch {
      await scheduleWindowsTask(task)
    }
  }
}

// ─── Helpers ────────────────────────────────────────────────

function generateId(): string {
  return randomUUID().slice(0, 8)
}

function formatDueTime(isoDate: string): string {
  const date = new Date(isoDate)
  if (isNaN(date.getTime())) return '?'

  const now = new Date()
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const target = new Date(date.getFullYear(), date.getMonth(), date.getDate())

  const time = date.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })

  if (target.getTime() === today.getTime()) {
    return `hoje ${time}`
  }

  const tomorrow = new Date(today)
  tomorrow.setDate(tomorrow.getDate() + 1)
  if (target.getTime() === tomorrow.getTime()) {
    return `amanha ${time}`
  }

  const dateStr = date.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' })
  return `${dateStr} ${time}`
}

// ─── Legacy migration ───────────────────────────────────────

function legacyTask(value: unknown): Task | null {
  if (!value || typeof value !== 'object') return null
  const r = value as Record<string, unknown>
  const title = typeof r.title === 'string' ? r.title.trim() : ''
  if (!title) return null
  const dueAt = typeof r.dueAt === 'string' && !isNaN(Date.parse(r.dueAt)) ? r.dueAt : null
  return {
    id: typeof r.id === 'string' ? r.id : '',
    title,
    dueAt,
    createdAt: typeof r.createdAt === 'string' ? r.createdAt : new Date().toISOString(),
    done: r.done === true,
    notified: r.notified === true,
    projectId: null,
  }
}

/** Stores created before project links lack the column; add it once. */
function addProjectColumn(): void {
  migrateOnce('tasks-project-id', (db) => {
    const columns = db.query('PRAGMA table_info(tasks)').all() as { name: string }[]
    if (!columns.some((c) => c.name === 'project_id')) db.run('ALTER TABLE tasks ADD COLUMN project_id TEXT')
  })
}

/**
 * Import tasks.json once, keeping ids and order. The file is renamed to
 * tasks.migrated.json only after its rows are committed, never deleted.
 */
function migrateLegacyJson(dataDir: string): void {
  const name = `legacy:${LEGACY_FILE}`
  if (store().query('SELECT 1 FROM migrations WHERE name = ?').get(name)) return
  const path = join(dataDir, LEGACY_FILE)
  if (!existsSync(path)) return

  let records: unknown[]
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf-8'))
    if (!Array.isArray(parsed)) logger.warn('Legacy tasks file is not an array; nothing imported', { file: LEGACY_FILE })
    records = Array.isArray(parsed) ? parsed : []
  } catch (err) {
    // Leave an unreadable file untouched for manual recovery.
    logger.warn('Legacy tasks file is unreadable; skipped', { file: LEGACY_FILE, error: err })
    return
  }

  const applied = migrateOnce(name, (db) => {
    const taken = db.query('SELECT 1 FROM tasks WHERE id = ?')
    for (const record of records) {
      const task = legacyTask(record)
      if (!task) continue
      // A missing or repeated id gets a fresh one, never a dropped task.
      let id = task.id && !taken.get(task.id) ? task.id : generateId()
      while (taken.get(id)) id = generateId()
      insertTask({ ...task, id })
    }
  })
  if (!applied) return
  try {
    renameSync(path, path.replace(/\.json$/, '.migrated.json'))
  } catch (err) {
    // Rows are committed and the migration recorded; a locked file only stays in place.
    logger.warn('Could not rename migrated tasks file', { file: LEGACY_FILE, error: err })
  }
}
