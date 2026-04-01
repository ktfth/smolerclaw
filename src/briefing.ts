/**
 * Daily briefing — morning summary combining calendar, system, and news.
 * Includes Time & Load Balancer for persona-aware context routing.
 */
import { logger } from './core/logger'

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { getDateTimeInfo, getOutlookEvents, getSystemInfo } from './windows'
import { fetchNews } from './news'
import { IS_WINDOWS } from './platform'
import { listProjects, getGitSummary, type Project } from './projects'

// ─── Calendar Detection ─────────────────────────────────────

export type DayType = 'weekday' | 'weekend'
export type WorkloadState = 'spillover' | 'clear'
export type PersonaMode = 'productivity' | 'spillover_alert' | 'sharpen_or_relax'

export interface TimeContext {
  dayType: DayType
  workloadState: WorkloadState
  persona: PersonaMode
  urgentTasks: SpilloverTask[]
  overdueTasks: SpilloverTask[]
  pendingCommits: PendingCommit[]
}

export interface SpilloverTask {
  id: string
  title: string
  dueAt: string | null
  isOverdue: boolean
}

export interface PendingCommit {
  projectName: string
  projectPath: string
  uncommittedChanges: boolean
  unpushedCommits: number
}

/**
 * Detect if today is a weekend (Saturday=6 or Sunday=0).
 * Uses local timezone via JavaScript's native Date.
 */
export function isWeekend(): boolean {
  const day = new Date().getDay()
  return day === 0 || day === 6
}

/**
 * Detect if today is a weekday (Monday-Friday).
 */
export function isWeekday(): boolean {
  return !isWeekend()
}

/**
 * Get the current day type.
 */
export function getDayType(): DayType {
  return isWeekend() ? 'weekend' : 'weekday'
}

// ─── Spillover Work Detection ───────────────────────────────

/**
 * Check for spillover work: urgent/overdue tasks and uncommitted git changes.
 * Scans tasks.json and monitored projects for pending work.
 */
export async function checkSpilloverWork(dataDir: string): Promise<{
  hasSpillover: boolean
  urgentTasks: SpilloverTask[]
  overdueTasks: SpilloverTask[]
  pendingCommits: PendingCommit[]
}> {
  const urgentTasks: SpilloverTask[] = []
  const overdueTasks: SpilloverTask[] = []
  const pendingCommits: PendingCommit[] = []

  const now = new Date()
  const todayEnd = new Date(now)
  todayEnd.setHours(23, 59, 59, 999)

  // Check tasks.json for urgent/overdue tasks
  const tasksFile = join(dataDir, 'tasks.json')
  if (existsSync(tasksFile)) {
    try {
      const tasks: Array<{
        id: string
        title: string
        dueAt: string | null
        done: boolean
      }> = JSON.parse(readFileSync(tasksFile, 'utf-8'))

      for (const task of tasks) {
        if (task.done) continue

        if (task.dueAt) {
          const dueDate = new Date(task.dueAt)
          const isOverdue = dueDate < now
          const isUrgent = !isOverdue && dueDate <= todayEnd

          if (isOverdue) {
            overdueTasks.push({
              id: task.id,
              title: task.title,
              dueAt: task.dueAt,
              isOverdue: true,
            })
          } else if (isUrgent) {
            urgentTasks.push({
              id: task.id,
              title: task.title,
              dueAt: task.dueAt,
              isOverdue: false,
            })
          }
        }
      }
    } catch (err) {
      logger.debug('Failed to parse task for spillover check', { error: err })
    }
  }

  // Check active projects for uncommitted/unpushed work
  const projects = listProjects(true) // active only
  for (const project of projects.slice(0, 5)) { // limit to 5 projects
    const pending = await checkProjectGitStatus(project)
    if (pending) {
      pendingCommits.push(pending)
    }
  }

  const hasSpillover = urgentTasks.length > 0 ||
    overdueTasks.length > 0 ||
    pendingCommits.length > 0

  return { hasSpillover, urgentTasks, overdueTasks, pendingCommits }
}

/**
 * Check a project's git status for uncommitted changes or unpushed commits.
 */
async function checkProjectGitStatus(project: Project): Promise<PendingCommit | null> {
  if (!existsSync(join(project.path, '.git'))) return null

  try {
    // Check for uncommitted changes
    const statusProc = Bun.spawn(['git', 'status', '--porcelain'], {
      cwd: project.path,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const statusOut = await new Response(statusProc.stdout).text()
    await statusProc.exited
    const uncommittedChanges = statusOut.trim().length > 0

    // Check for unpushed commits
    const aheadProc = Bun.spawn(
      ['git', 'rev-list', '--count', '@{u}..HEAD'],
      { cwd: project.path, stdout: 'pipe', stderr: 'pipe' },
    )
    const aheadOut = await new Response(aheadProc.stdout).text()
    const aheadCode = await aheadProc.exited
    const unpushedCommits = aheadCode === 0 ? parseInt(aheadOut.trim()) || 0 : 0

    if (uncommittedChanges || unpushedCommits > 0) {
      return {
        projectName: project.name,
        projectPath: project.path,
        uncommittedChanges,
        unpushedCommits,
      }
    }
  } catch (err) {
    logger.debug('Git status check failed for project', { error: err })
  }

  return null
}

// ─── Persona / Context Routing ──────────────────────────────

/**
 * Determine the persona mode based on day type and workload state.
 */
export function determinePersona(dayType: DayType, hasSpillover: boolean): PersonaMode {
  if (dayType === 'weekday') {
    return 'productivity'
  }

  // Weekend
  if (hasSpillover) {
    return 'spillover_alert'
  }

  return 'sharpen_or_relax'
}

/**
 * Get the full time context for the current moment.
 */
export async function getTimeContext(dataDir: string): Promise<TimeContext> {
  const dayType = getDayType()
  const spillover = await checkSpilloverWork(dataDir)
  const persona = determinePersona(dayType, spillover.hasSpillover)

  return {
    dayType,
    workloadState: spillover.hasSpillover ? 'spillover' : 'clear',
    persona,
    urgentTasks: spillover.urgentTasks,
    overdueTasks: spillover.overdueTasks,
    pendingCommits: spillover.pendingCommits,
  }
}

// ─── Briefing Generation ────────────────────────────────────

/**
 * Generate persona-aware greeting based on time context.
 */
function generatePersonaGreeting(context: TimeContext): string {
  const dayNames = ['Domingo', 'Segunda', 'Terca', 'Quarta', 'Quinta', 'Sexta', 'Sabado']
  const dayName = dayNames[new Date().getDay()]

  switch (context.persona) {
    case 'productivity':
      return `=== BRIEFING DIARIO === ${dayName}\nModo: Produtividade Total`

    case 'spillover_alert':
      return `=== BRIEFING DIARIO === ${dayName}\n⚠ Trabalho escorrido detectado.`

    case 'sharpen_or_relax':
      return `=== BRIEFING DIARIO === ${dayName}\nModo: Sharpen or Relax`
  }
}

/**
 * Generate spillover work section for the briefing.
 */
function generateSpilloverSection(context: TimeContext): string {
  const lines: string[] = []

  if (context.overdueTasks.length > 0) {
    lines.push('\n--- Tarefas Atrasadas ---')
    for (const task of context.overdueTasks.slice(0, 5)) {
      const due = task.dueAt ? new Date(task.dueAt).toLocaleDateString('pt-BR') : ''
      lines.push(`  ⚠ ${task.title} (venceu ${due})`)
    }
  }

  if (context.urgentTasks.length > 0) {
    lines.push('\n--- Tarefas Urgentes (Hoje) ---')
    for (const task of context.urgentTasks.slice(0, 5)) {
      const due = task.dueAt ? new Date(task.dueAt).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : ''
      lines.push(`  ! ${task.title} (${due})`)
    }
  }

  if (context.pendingCommits.length > 0) {
    lines.push('\n--- Git Pendente ---')
    for (const pending of context.pendingCommits) {
      const parts: string[] = []
      if (pending.uncommittedChanges) parts.push('uncommitted')
      if (pending.unpushedCommits > 0) parts.push(`${pending.unpushedCommits} unpushed`)
      lines.push(`  ${pending.projectName}: ${parts.join(', ')}`)
    }
  }

  return lines.join('\n')
}

/**
 * Generate weekend options section.
 */
function generateWeekendOptions(context: TimeContext): string {
  if (context.persona !== 'sharpen_or_relax') return ''

  return `
--- Fim de Semana Livre ---

  [A] Amolar o Machado
      Estudo de arquitetura, refatoracao, melhoria do CLI

  [B] Descompressao Criativa
      Projetos paralelos sem prazo, foco pessoal/familia`
}

/**
 * Generate timebox suggestion for spillover work.
 */
function generateTimeboxSuggestion(context: TimeContext): string {
  if (context.persona !== 'spillover_alert') return ''

  const totalItems = context.overdueTasks.length +
    context.urgentTasks.length +
    context.pendingCommits.length

  const suggestedMinutes = Math.min(90, totalItems * 15)

  return `
--- Sugestao: Timebox ---
Liquidar pendencias em ${suggestedMinutes} minutos.
Depois: descanso merecido.`
}

/**
 * Generate a daily briefing with date, calendar, system, and top news.
 * Now includes Time & Load Balancer persona awareness.
 */
export async function generateBriefing(dataDir?: string): Promise<string> {
  const sections: string[] = []

  // Get time context if dataDir is provided
  let context: TimeContext | null = null
  if (dataDir) {
    context = await getTimeContext(dataDir)
    sections.push(generatePersonaGreeting(context))
  } else {
    sections.push('=== BRIEFING DIARIO ===')
  }

  // Date & time
  const dateInfo = await getDateTimeInfo()
  sections.push(dateInfo)

  // Spillover work section (if applicable)
  if (context && context.workloadState === 'spillover') {
    const spilloverSection = generateSpilloverSection(context)
    if (spilloverSection) sections.push(spilloverSection)

    // Timebox suggestion for weekend spillover
    const timeboxSuggestion = generateTimeboxSuggestion(context)
    if (timeboxSuggestion) sections.push(timeboxSuggestion)
  }

  // Weekend options (if no spillover)
  if (context) {
    const weekendOptions = generateWeekendOptions(context)
    if (weekendOptions) sections.push(weekendOptions)
  }

  // Calendar (Windows only, non-blocking)
  if (IS_WINDOWS) {
    try {
      const events = await getOutlookEvents()
      sections.push(`\n--- Agenda ---\n${events}`)
    } catch {
      sections.push('\n--- Agenda ---\nOutlook nao disponivel.')
    }
  }

  // System status
  if (IS_WINDOWS) {
    try {
      const sys = await getSystemInfo()
      sections.push(`\n--- Sistema ---\n${sys}`)
    } catch (err) {
      logger.debug('System info unavailable for briefing', { error: err })
    }
  }

  // Top news — reduced for weekends to encourage relaxation
  const newsLimit = context?.persona === 'sharpen_or_relax' ? 2 : 3
  try {
    const news = await fetchNews(['finance', 'business', 'tech'], newsLimit)
    sections.push(`\n${news}`)
  } catch {
    sections.push('\n--- Noticias ---\nFalha ao carregar noticias.')
  }

  sections.push('\n======================')
  return sections.join('\n')
}
