/**
 * Task/reminder system with scheduled Windows notifications.
 * Tasks are stored as JSON in the data directory.
 * A background timer checks every 30s for due tasks and fires
 * Windows toast notifications via PowerShell.
 */

import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { IS_WINDOWS } from './platform'
import { atomicWriteFile } from './vault'

// ─── Types ──────────────────────────────────────────────────

export interface Task {
  id: string
  title: string
  dueAt: string | null      // ISO 8601 datetime, null = no reminder
  createdAt: string          // ISO 8601 datetime
  done: boolean
  notified: boolean          // whether the notification was already sent
}

// ─── Storage ────────────────────────────────────────────────

let _dataDir = ''
let _tasks: Task[] = []
let _checkTimer: ReturnType<typeof setInterval> | null = null
let _onNotify: ((task: Task) => void) | null = null

const TASKS_FILE = () => join(_dataDir, 'tasks.json')

function save(): void {
  atomicWriteFile(TASKS_FILE(), JSON.stringify(_tasks, null, 2))
}

function load(): void {
  const file = TASKS_FILE()
  if (!existsSync(file)) {
    _tasks = []
    return
  }
  try {
    _tasks = JSON.parse(readFileSync(file, 'utf-8'))
  } catch {
    _tasks = []
  }
}

// ─── Public API ─────────────────────────────────────────────

/**
 * Initialize the task system. Must be called once at startup.
 * @param dataDir Directory to store tasks.json
 * @param onNotify Callback when a task notification fires
 */
export function initTasks(dataDir: string, onNotify: (task: Task) => void): void {
  _dataDir = dataDir
  _onNotify = onNotify
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true })
  load()

  // Start background checker (every 30 seconds) for in-process notifications
  if (_checkTimer) clearInterval(_checkTimer)
  _checkTimer = setInterval(checkDueTasks, 30_000)

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
export function addTask(title: string, dueAt?: Date): Task {
  const task: Task = {
    id: generateId(),
    title: title.trim(),
    dueAt: dueAt ? dueAt.toISOString() : null,
    createdAt: new Date().toISOString(),
    done: false,
    notified: false,
  }
  _tasks = [..._tasks, task]
  save()

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
  const lower = idOrTitle.toLowerCase()
  const task = _tasks.find(
    (t) => t.id === idOrTitle || t.title.toLowerCase().includes(lower),
  )
  if (!task || task.done) return null

  _tasks = _tasks.map((t) =>
    t.id === task.id ? { ...t, done: true } : t,
  )
  save()

  // Remove the scheduled Windows task
  if (task.dueAt && IS_WINDOWS) {
    removeWindowsTask(task.id).catch(() => {})
  }

  return _tasks.find((t) => t.id === task.id) || null
}

/**
 * Remove a task by ID or partial title.
 */
export function removeTask(idOrTitle: string): boolean {
  const lower = idOrTitle.toLowerCase()
  const idx = _tasks.findIndex(
    (t) => t.id === idOrTitle || t.title.toLowerCase().includes(lower),
  )
  if (idx === -1) return false

  const task = _tasks[idx]
  _tasks = [..._tasks.slice(0, idx), ..._tasks.slice(idx + 1)]
  save()

  // Remove the scheduled Windows task
  if (task.dueAt && IS_WINDOWS) {
    removeWindowsTask(task.id).catch(() => {})
  }

  return true
}

/**
 * List all tasks, optionally filtering by done status.
 */
export function listTasks(showDone = false): Task[] {
  return showDone ? [..._tasks] : _tasks.filter((t) => !t.done)
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

function checkDueTasks(): void {
  const now = new Date()
  let changed = false

  for (const task of _tasks) {
    if (task.done || task.notified || !task.dueAt) continue

    const due = new Date(task.dueAt)
    if (isNaN(due.getTime())) continue

    // Fire if due time has passed (within the last 5 minutes)
    const diffMs = now.getTime() - due.getTime()
    if (diffMs >= 0 && diffMs < 5 * 60_000) {
      // Mark as notified
      _tasks = _tasks.map((t) =>
        t.id === task.id ? { ...t, notified: true } : t,
      )
      changed = true

      // Fire Windows toast notification
      fireNotification(task)

      // Call the callback for TUI display
      _onNotify?.(task)
    }
  }

  if (changed) save()
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

/** Sanitize a string for safe embedding in a PowerShell single-quoted string. */
function psSingleQuoteEscape(s: string): string {
  return s.replace(/'/g, "''")
}

/**
 * Fire a Windows toast notification for a task.
 * Uses PowerShell's BurntToast or built-in toast via .NET.
 */
async function fireNotification(task: Task): Promise<void> {
  if (!IS_WINDOWS) return

  // XML-encode title to prevent injection via XML special chars
  const title = xmlEncode(task.title)
  const cmd = [
    '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null',
    '[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null',
    `$template = '<toast><visual><binding template="ToastText02"><text id="1">smolerclaw - Lembrete</text><text id="2">${title}</text></binding></visual><audio src="ms-winsoundevent:Notification.Default"/></toast>'`,
    '$xml = New-Object Windows.Data.Xml.Dom.XmlDocument',
    '$xml.LoadXml($template)',
    `$toast = [Windows.UI.Notifications.ToastNotification]::new($xml)`,
    `[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('smolerclaw').Show($toast)`,
  ].join('; ')

  try {
    const proc = Bun.spawn(
      ['powershell', '-NoProfile', '-NonInteractive', '-Command', cmd],
      { stdout: 'pipe', stderr: 'pipe' },
    )
    const timer = setTimeout(() => proc.kill(), 10_000)
    await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])
    await proc.exited
    clearTimeout(timer)
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
  const title = xmlEncode(task.title).replace(/"/g, '""')
  const toastPs = [
    '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null;',
    '[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null;',
    `$x = New-Object Windows.Data.Xml.Dom.XmlDocument;`,
    `$x.LoadXml('<toast><visual><binding template=""ToastText02""><text id=""1"">smolerclaw</text><text id=""2"">${title}</text></binding></visual><audio src=""ms-winsoundevent:Notification.Reminder""/></toast>');`,
    `[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('smolerclaw').Show([Windows.UI.Notifications.ToastNotification]::new($x))`,
  ].join(' ')

  try {
    const proc = Bun.spawn([
      'schtasks', '/Create',
      '/TN', taskName,
      '/SC', 'ONCE',
      '/SD', startDate,
      '/ST', startTime,
      '/TR', `powershell -NoProfile -WindowStyle Hidden -Command "${toastPs}"`,
      '/F',  // force overwrite if exists
    ], { stdout: 'pipe', stderr: 'pipe' })
    await proc.exited
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
    const proc = Bun.spawn([
      'schtasks', '/Delete', '/TN', taskName, '/F',
    ], { stdout: 'pipe', stderr: 'pipe' })
    await proc.exited
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
  for (const task of _tasks) {
    if (task.done || task.notified || !task.dueAt) continue
    const due = new Date(task.dueAt)
    if (isNaN(due.getTime()) || due.getTime() <= now) continue

    // Check if the scheduled task exists
    try {
      const proc = Bun.spawn([
        'schtasks', '/Query', '/TN', `${TASK_PREFIX}${task.id}`,
      ], { stdout: 'pipe', stderr: 'pipe' })
      const code = await proc.exited
      if (code !== 0) {
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
