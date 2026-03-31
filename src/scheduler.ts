/**
 * Scheduler module — Windows Task Scheduler integration for persistent reminders.
 *
 * Provides:
 *   - Create scheduled jobs that persist via Windows Task Scheduler
 *   - Jobs fire even when smolerclaw is not running
 *   - Support for one-time and recurring schedules (daily, weekly)
 *   - Toast notifications or command execution
 *
 * Uses schtasks.exe — works without admin rights for the current user.
 *
 * REFACTORED: All PowerShell/schtasks execution goes through windows-executor.ts
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { IS_WINDOWS } from './platform'
import { atomicWriteFile } from './vault'
import {
  executeSchtasks,
  showToast,
  executePowerShell,
  psDoubleQuoteEscape,
} from './utils/windows-executor'

// ─── Types ──────────────────────────────────────────────────

export type ScheduleType = 'once' | 'daily' | 'weekly'
export type JobAction = 'toast' | 'command' | 'workflow'

export interface ScheduledJob {
  id: string
  name: string
  /** Schedule type: once, daily, weekly */
  scheduleType: ScheduleType
  /** Time in HH:MM format */
  time: string
  /** Date in DD/MM/YYYY format (for 'once') or day of week (for 'weekly') */
  dateOrDay?: string
  /** Action type */
  action: JobAction
  /** Message for toast, or command/workflow name */
  target: string
  /** Whether the job is active */
  enabled: boolean
  /** Windows Task Scheduler task name */
  taskName: string
  /** ISO datetime when created */
  createdAt: string
  /** ISO datetime when last modified */
  updatedAt: string
  /** ISO datetime when last executed (tracked locally) */
  lastRun?: string
}

type SchedulerCallback = (msg: string) => void

// ─── State ──────────────────────────────────────────────────

let _dataDir = ''
let _jobs: ScheduledJob[] = []
let _onNotify: SchedulerCallback | null = null

const DATA_FILE = () => join(_dataDir, 'scheduler.json')
const TASK_PREFIX = 'Smolerclaw_'

// ─── Public API ─────────────────────────────────────────────

/**
 * Initialize the scheduler module. Must be called once at startup.
 * @param dataDir Directory to store scheduler.json
 * @param onNotify Callback for notifications (optional)
 */
export function initScheduler(dataDir: string, onNotify?: SchedulerCallback): void {
  _dataDir = dataDir
  _onNotify = onNotify ?? null
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true })
  load()

  // Sync jobs with Windows Task Scheduler on startup
  if (IS_WINDOWS) {
    syncScheduledJobs().catch(() => {})
  }
}

/**
 * Schedule a new job.
 * @param name Human-readable name
 * @param scheduleType once, daily, or weekly
 * @param time Time in HH:MM format
 * @param action toast, command, or workflow
 * @param target Message for toast, or command/workflow to execute
 * @param dateOrDay Date (DD/MM/YYYY) for once, or day name for weekly
 */
export async function scheduleJob(
  name: string,
  scheduleType: ScheduleType,
  time: string,
  action: JobAction,
  target: string,
  dateOrDay?: string,
): Promise<ScheduledJob> {
  const id = generateId()
  const taskName = `${TASK_PREFIX}${id}`

  const job: ScheduledJob = {
    id,
    name: name.trim(),
    scheduleType,
    time,
    dateOrDay,
    action,
    target: target.trim(),
    enabled: true,
    taskName,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }

  // Create Windows scheduled task
  if (IS_WINDOWS) {
    await createWindowsTask(job)
  }

  _jobs = [..._jobs, job]
  save()

  return job
}

/**
 * Remove a scheduled job by ID or name match.
 */
export async function removeJob(idOrName: string): Promise<boolean> {
  const lower = idOrName.toLowerCase()
  const idx = _jobs.findIndex(
    (j) => j.id === idOrName || j.name.toLowerCase().includes(lower),
  )
  if (idx === -1) return false

  const job = _jobs[idx]

  // Remove from Windows Task Scheduler and script
  if (IS_WINDOWS) {
    await deleteWindowsTask(job.taskName, job.id)
  }

  _jobs = [..._jobs.slice(0, idx), ..._jobs.slice(idx + 1)]
  save()

  return true
}

/**
 * Enable a disabled job.
 */
export async function enableJob(idOrName: string): Promise<ScheduledJob | null> {
  const job = findJob(idOrName)
  if (!job || job.enabled) return null

  // Recreate Windows task
  if (IS_WINDOWS) {
    await createWindowsTask(job)
  }

  _jobs = _jobs.map((j) =>
    j.id === job.id
      ? { ...j, enabled: true, updatedAt: new Date().toISOString() }
      : j,
  )
  save()

  return _jobs.find((j) => j.id === job.id) ?? null
}

/**
 * Disable a job (removes from Task Scheduler but keeps in local storage).
 */
export async function disableJob(idOrName: string): Promise<ScheduledJob | null> {
  const job = findJob(idOrName)
  if (!job || !job.enabled) return null

  // Remove from Windows Task Scheduler (but keep script for re-enable)
  if (IS_WINDOWS) {
    await deleteWindowsTask(job.taskName, undefined)
  }

  _jobs = _jobs.map((j) =>
    j.id === job.id
      ? { ...j, enabled: false, updatedAt: new Date().toISOString() }
      : j,
  )
  save()

  return _jobs.find((j) => j.id === job.id) ?? null
}

/**
 * List all scheduled jobs.
 */
export function listJobs(includeDisabled = false): ScheduledJob[] {
  return includeDisabled ? [..._jobs] : _jobs.filter((j) => j.enabled)
}

/**
 * Get a job by ID or name match.
 */
export function getJob(idOrName: string): ScheduledJob | null {
  return findJob(idOrName)
}

/**
 * Run a job immediately (for testing).
 */
export async function runJobNow(idOrName: string): Promise<string> {
  const job = findJob(idOrName)
  if (!job) return 'Agendamento nao encontrado.'

  if (IS_WINDOWS) {
    const result = await executeSchtasks('Run', job.taskName)
    if (result.exitCode !== 0) {
      return `Erro ao executar: ${result.stderr}`
    }
  }

  // Update lastRun
  _jobs = _jobs.map((j) =>
    j.id === job.id
      ? { ...j, lastRun: new Date().toISOString() }
      : j,
  )
  save()

  return `Agendamento "${job.name}" executado.`
}

/**
 * Format jobs for display.
 */
export function formatJobList(jobs: ScheduledJob[]): string {
  if (jobs.length === 0) return 'Nenhum agendamento encontrado.'

  const lines = jobs.map((j) => {
    const status = j.enabled ? 'ativo' : 'desativado'
    const schedule = formatSchedule(j)
    const actionIcon = j.action === 'toast' ? 'msg' : j.action === 'command' ? 'cmd' : 'wf'
    return `  [${j.id}] ${j.name} — ${schedule} [${actionIcon}] (${status})`
  })

  return `Agendamentos (${jobs.length}):\n${lines.join('\n')}`
}

/**
 * Format a single job for detailed display.
 */
export function formatJobDetail(job: ScheduledJob): string {
  const lines = [
    `=== ${job.name} ===`,
    `ID: ${job.id}`,
    `Tipo: ${job.scheduleType}`,
    `Horario: ${job.time}`,
  ]

  if (job.dateOrDay) {
    lines.push(`Data/Dia: ${job.dateOrDay}`)
  }

  lines.push(
    `Acao: ${job.action}`,
    `Alvo: ${job.target}`,
    `Status: ${job.enabled ? 'ativo' : 'desativado'}`,
    `Tarefa Windows: ${job.taskName}`,
    `Criado: ${formatDateTime(job.createdAt)}`,
  )

  if (job.lastRun) {
    lines.push(`Ultima execucao: ${formatDateTime(job.lastRun)}`)
  }

  return lines.join('\n')
}

/**
 * Parse time string (HH:MM or natural language).
 * Supports: "14:00", "14h", "14h30", "2pm"
 */
export function parseScheduleTime(input: string): string | null {
  const text = input.toLowerCase().trim()

  // HH:MM format
  const colonMatch = text.match(/^(\d{1,2}):(\d{2})$/)
  if (colonMatch) {
    const h = parseInt(colonMatch[1])
    const m = parseInt(colonMatch[2])
    if (h >= 0 && h <= 23 && m >= 0 && m <= 59) {
      return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
    }
  }

  // HHh or HHhMM format (e.g., "14h", "14h30")
  const brMatch = text.match(/^(\d{1,2})h(\d{2})?$/)
  if (brMatch) {
    const h = parseInt(brMatch[1])
    const m = parseInt(brMatch[2] || '0')
    if (h >= 0 && h <= 23 && m >= 0 && m <= 59) {
      return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
    }
  }

  // 12-hour format (e.g., "2pm", "2:30pm")
  const ampmMatch = text.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/)
  if (ampmMatch) {
    let h = parseInt(ampmMatch[1])
    const m = parseInt(ampmMatch[2] || '0')
    const isPm = ampmMatch[3] === 'pm'

    if (h === 12) h = isPm ? 12 : 0
    else if (isPm) h += 12

    if (h >= 0 && h <= 23 && m >= 0 && m <= 59) {
      return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
    }
  }

  return null
}

/**
 * Parse date string for "once" schedules.
 * Supports: "DD/MM/YYYY", "DD/MM", "hoje", "amanha"
 */
export function parseScheduleDate(input: string): string | null {
  const text = input.toLowerCase().trim()
  const now = new Date()

  // "hoje"
  if (text === 'hoje' || text === 'today') {
    return formatDateForSchtasks(now)
  }

  // "amanha"
  if (text === 'amanha' || text === 'amanhã' || text === 'tomorrow') {
    const tomorrow = new Date(now)
    tomorrow.setDate(tomorrow.getDate() + 1)
    return formatDateForSchtasks(tomorrow)
  }

  // DD/MM/YYYY
  const fullMatch = text.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/)
  if (fullMatch) {
    const d = parseInt(fullMatch[1])
    const m = parseInt(fullMatch[2])
    const y = parseInt(fullMatch[3])
    if (d >= 1 && d <= 31 && m >= 1 && m <= 12 && y >= 2024) {
      return `${String(m).padStart(2, '0')}/${String(d).padStart(2, '0')}/${y}`
    }
  }

  // DD/MM (assume current year)
  const shortMatch = text.match(/^(\d{1,2})[/.-](\d{1,2})$/)
  if (shortMatch) {
    const d = parseInt(shortMatch[1])
    const m = parseInt(shortMatch[2])
    if (d >= 1 && d <= 31 && m >= 1 && m <= 12) {
      return `${String(m).padStart(2, '0')}/${String(d).padStart(2, '0')}/${now.getFullYear()}`
    }
  }

  return null
}

/**
 * Parse day of week for "weekly" schedules.
 * Supports Portuguese and English day names.
 */
export function parseWeekDay(input: string): string | null {
  const text = input.toLowerCase().trim()

  const dayMap: Record<string, string> = {
    // Portuguese
    'dom': 'SUN', 'domingo': 'SUN',
    'seg': 'MON', 'segunda': 'MON', 'segunda-feira': 'MON',
    'ter': 'TUE', 'terca': 'TUE', 'terça': 'TUE', 'terca-feira': 'TUE', 'terça-feira': 'TUE',
    'qua': 'WED', 'quarta': 'WED', 'quarta-feira': 'WED',
    'qui': 'THU', 'quinta': 'THU', 'quinta-feira': 'THU',
    'sex': 'FRI', 'sexta': 'FRI', 'sexta-feira': 'FRI',
    'sab': 'SAT', 'sabado': 'SAT', 'sábado': 'SAT',
    // English
    'sun': 'SUN', 'sunday': 'SUN',
    'mon': 'MON', 'monday': 'MON',
    'tue': 'TUE', 'tuesday': 'TUE',
    'wed': 'WED', 'wednesday': 'WED',
    'thu': 'THU', 'thursday': 'THU',
    'fri': 'FRI', 'friday': 'FRI',
    'sat': 'SAT', 'saturday': 'SAT',
  }

  return dayMap[text] ?? null
}

// ─── Windows Task Scheduler Integration ─────────────────────

/**
 * Create a Windows scheduled task for a job.
 */
async function createWindowsTask(job: ScheduledJob): Promise<void> {
  // Build the command that will be executed
  const command = buildTaskCommand(job)

  // Build schtasks arguments
  const args: string[] = []

  switch (job.scheduleType) {
    case 'once':
      args.push('/SC', 'ONCE')
      if (job.dateOrDay) {
        args.push('/SD', job.dateOrDay)
      }
      break
    case 'daily':
      args.push('/SC', 'DAILY')
      break
    case 'weekly':
      args.push('/SC', 'WEEKLY')
      if (job.dateOrDay) {
        args.push('/D', job.dateOrDay)
      }
      break
  }

  args.push('/ST', job.time)
  args.push('/TR', command)
  args.push('/F') // Force overwrite if exists

  try {
    await executeSchtasks('Create', job.taskName, args)
  } catch {
    // Best effort — scheduler failure should not block job creation
  }
}

/**
 * Delete a Windows scheduled task and its associated script.
 */
async function deleteWindowsTask(taskName: string, jobId?: string): Promise<void> {
  try {
    await executeSchtasks('Delete', taskName, ['/F'])
  } catch {
    // Ignore — task may not exist
  }

  // Clean up the script file if jobId is provided
  if (jobId) {
    deleteToastScript(jobId)
  }
}

/**
 * Get the scripts directory for storing toast notification scripts.
 * Creates the directory if it doesn't exist.
 */
function getScriptsDir(): string {
  const scriptsDir = join(_dataDir, 'scripts')
  if (!existsSync(scriptsDir)) mkdirSync(scriptsDir, { recursive: true })
  return scriptsDir
}

/**
 * Create a PowerShell script file for toast notification.
 * This avoids encoding issues with special characters when passing inline commands.
 */
function createToastScript(jobId: string, title: string, body: string): string {
  const scriptsDir = getScriptsDir()
  const scriptPath = join(scriptsDir, `toast_${jobId}.ps1`)

  // Use proper UTF-8 encoding in the script
  const script = `# Toast notification script for smolerclaw
# Job ID: ${jobId}
# Generated: ${new Date().toISOString()}

[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null

$title = '${title.replace(/'/g, "''")}'
$body = '${body.replace(/'/g, "''")}'

$template = @"
<toast>
  <visual>
    <binding template="ToastText02">
      <text id="1">$title</text>
      <text id="2">$body</text>
    </binding>
  </visual>
  <audio src="ms-winsoundevent:Notification.Reminder"/>
</toast>
"@

$xml = New-Object Windows.Data.Xml.Dom.XmlDocument
$xml.LoadXml($template)
$toast = [Windows.UI.Notifications.ToastNotification]::new($xml)
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('smolerclaw').Show($toast)
`

  // Write with UTF-8 BOM for PowerShell compatibility
  const utf8Bom = Buffer.from([0xEF, 0xBB, 0xBF])
  const content = Buffer.concat([utf8Bom, Buffer.from(script, 'utf-8')])
  writeFileSync(scriptPath, content)

  return scriptPath
}

/**
 * Delete the toast script for a job.
 */
function deleteToastScript(jobId: string): void {
  const scriptPath = join(getScriptsDir(), `toast_${jobId}.ps1`)
  try {
    if (existsSync(scriptPath)) unlinkSync(scriptPath)
  } catch {
    // Best effort
  }
}

/**
 * Build the command string for a scheduled task.
 * For toast notifications, creates a script file to handle UTF-8 properly.
 */
function buildTaskCommand(job: ScheduledJob): string {
  if (job.action === 'toast') {
    // Create a script file for the toast notification
    const scriptPath = createToastScript(job.id, 'smolerclaw', job.target)
    return `powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "${scriptPath}"`
  } else if (job.action === 'command') {
    // Execute a command directly
    return job.target
  } else {
    // Workflow — create a script for the notification
    const scriptPath = createToastScript(job.id, 'smolerclaw', `Workflow: ${job.target}`)
    return `powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "${scriptPath}"`
  }
}

/**
 * Sync local jobs with Windows Task Scheduler on startup.
 */
async function syncScheduledJobs(): Promise<void> {
  if (!IS_WINDOWS) return

  for (const job of _jobs) {
    if (!job.enabled) continue

    try {
      const result = await executeSchtasks('Query', job.taskName)
      if (result.exitCode !== 0) {
        // Task doesn't exist in scheduler — recreate it
        await createWindowsTask(job)
      }
    } catch {
      await createWindowsTask(job)
    }
  }
}

// ─── Cleanup ────────────────────────────────────────────────

/**
 * Stop the scheduler and clean up resources.
 * Note: Does NOT remove Windows scheduled tasks — they persist.
 */
export function stopScheduler(): void {
  // Currently no background processes to stop
  // Windows Task Scheduler handles execution independently
}

/**
 * Remove all scheduled jobs (including from Windows Task Scheduler).
 */
export async function clearAllJobs(): Promise<string> {
  let removed = 0

  for (const job of _jobs) {
    if (IS_WINDOWS) {
      await deleteWindowsTask(job.taskName, job.id)
    }
    removed++
  }

  _jobs = []
  save()

  return `${removed} agendamento(s) removido(s).`
}

// ─── Internal Helpers ───────────────────────────────────────

function load(): void {
  const file = DATA_FILE()
  if (!existsSync(file)) {
    _jobs = []
    return
  }
  try {
    _jobs = JSON.parse(readFileSync(file, 'utf-8'))
  } catch {
    _jobs = []
  }
}

function save(): void {
  atomicWriteFile(DATA_FILE(), JSON.stringify(_jobs, null, 2))
}

function generateId(): string {
  return randomUUID().slice(0, 8)
}

function findJob(idOrName: string): ScheduledJob | null {
  const lower = idOrName.toLowerCase()
  return _jobs.find(
    (j) => j.id === idOrName || j.name.toLowerCase().includes(lower),
  ) ?? null
}

function formatSchedule(job: ScheduledJob): string {
  switch (job.scheduleType) {
    case 'once':
      return job.dateOrDay ? `${job.dateOrDay} ${job.time}` : `uma vez ${job.time}`
    case 'daily':
      return `diario ${job.time}`
    case 'weekly':
      return job.dateOrDay ? `${dayNamePt(job.dateOrDay)} ${job.time}` : `semanal ${job.time}`
  }
}

function dayNamePt(day: string): string {
  const map: Record<string, string> = {
    'SUN': 'dom', 'MON': 'seg', 'TUE': 'ter', 'WED': 'qua',
    'THU': 'qui', 'FRI': 'sex', 'SAT': 'sab',
  }
  return map[day] ?? day
}

function formatDateTime(iso: string): string {
  try {
    return new Date(iso).toLocaleString('pt-BR', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    })
  } catch {
    return iso
  }
}

function formatDateForSchtasks(date: Date): string {
  // schtasks uses MM/DD/YYYY format
  return [
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
    String(date.getFullYear()),
  ].join('/')
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
