/**
 * Morning routine — auto-detect first use of the day and show briefing.
 * Stores last-run date to avoid repeating.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { getDateTimeInfo, getOutlookEvents } from './windows'
import { listTasks, formatTaskList } from './tasks'
import { getPendingFollowUps, getDelegations, formatFollowUps, formatDelegationList } from './people'
import { IS_WINDOWS } from './platform'
import { getProjectBriefingSummary } from './projects'

let _dataDir = ''
const LAST_RUN_FILE = () => join(_dataDir, 'last-morning.txt')

/**
 * Check if this is the first run of the day.
 */
export function isFirstRunToday(dataDir: string): boolean {
  _dataDir = dataDir
  const file = LAST_RUN_FILE()
  const today = new Date().toISOString().split('T')[0]

  if (!existsSync(file)) return true

  try {
    const lastDate = readFileSync(file, 'utf-8').trim()
    return lastDate !== today
  } catch {
    return true
  }
}

/**
 * Mark today as "briefing shown".
 */
export function markMorningDone(): void {
  const today = new Date().toISOString().split('T')[0]
  writeFileSync(LAST_RUN_FILE(), today)
}

/**
 * Generate a complete morning briefing.
 */
export async function generateMorningBriefing(): Promise<string> {
  const sections: string[] = []

  const hour = new Date().getHours()
  const greeting = hour < 12 ? 'BOM DIA' : hour < 18 ? 'BOA TARDE' : 'BOA NOITE'

  sections.push('==============================')
  sections.push(`  ${greeting}! Briefing do dia`)
  sections.push('==============================\n')

  // Date & time
  const dateInfo = await getDateTimeInfo()
  sections.push(dateInfo)

  // Today's tasks
  const tasks = listTasks()
  const todayTasks = tasks.filter((t) => {
    if (!t.dueAt) return false
    const due = new Date(t.dueAt)
    const today = new Date()
    return due.toDateString() === today.toDateString()
  })
  if (todayTasks.length > 0) {
    sections.push('\n--- Tarefas do dia ---')
    sections.push(formatTaskList(todayTasks))
  }

  // Pending follow-ups
  const followUps = getPendingFollowUps()
  if (followUps.length > 0) {
    sections.push('\n--- Follow-ups pendentes ---')
    sections.push(formatFollowUps(followUps))
  }

  // Overdue delegations
  const delegations = getDelegations()
  const overdue = delegations.filter((d) => d.status === 'atrasado')
  if (overdue.length > 0) {
    sections.push('\n--- Delegacoes atrasadas ---')
    sections.push(formatDelegationList(overdue))
  }

  // Project summary
  const projectSummary = getProjectBriefingSummary()
  if (projectSummary) {
    sections.push(`\n${projectSummary}`)
  }

  // Calendar (Windows only)
  if (IS_WINDOWS) {
    const events = await getOutlookEvents()
    if (events.ok) {
      sections.push('\n--- Agenda ---')
      sections.push(events.text)
    }
  }

  // Pending tasks count
  const allPending = listTasks()
  if (allPending.length > 0 && todayTasks.length !== allPending.length) {
    sections.push(`\n${allPending.length} tarefa(s) pendente(s) no total. Use /tarefas para ver todas.`)
  }

  sections.push('\n==============================')
  return sections.join('\n')
}
