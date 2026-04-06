/**
 * M365 Composite Actions — multi-command operations that combine
 * data from multiple M365 services in parallel.
 *
 * These are the "intelligent wrapper" features that go beyond
 * what the m365 CLI can do on its own.
 */

import { listEmails, listEvents, formatEmailList, formatEventList } from './outlook'
import { listTodoTasks, formatTodoList } from './todo'
import type { M365Briefing, M365Digest } from './types'

/**
 * M365 Briefing — parallel fetch of unread emails, today's calendar, and pending todos.
 * Returns structured data for Claude to summarize.
 */
export async function m365Briefing(
  options: { fresh?: boolean } = {},
): Promise<{ success: boolean; data: M365Briefing | null; formatted: string }> {
  const fresh = options.fresh ?? false

  const [emailsResult, eventsResult, todosResult] = await Promise.all([
    listEmails({ top: 10, fresh }),
    listEvents({ fresh }),
    listTodoTasks(undefined, { fresh }),
  ])

  const unreadEmails = emailsResult.success && emailsResult.data
    ? emailsResult.data.filter((e) => !e.isRead)
    : []

  const todayEvents = eventsResult.success && eventsResult.data
    ? eventsResult.data
    : []

  const pendingTodos = todosResult.success && todosResult.data
    ? todosResult.data.filter((t) => t.status !== 'completed')
    : []

  const briefing: M365Briefing = {
    unreadEmails,
    todayEvents,
    pendingTodos,
    timestamp: Date.now(),
  }

  // Build formatted output
  const sections: string[] = ['=== M365 Briefing ===', '']

  // Emails section
  if (!emailsResult.success) {
    sections.push(`Emails: Error - ${emailsResult.error}`)
  } else if (unreadEmails.length === 0) {
    sections.push('Emails: Inbox clear')
  } else {
    sections.push(`Emails: ${unreadEmails.length} unread`)
    sections.push(formatEmailList(unreadEmails))
  }
  sections.push('')

  // Calendar section
  if (!eventsResult.success) {
    sections.push(`Calendar: Error - ${eventsResult.error}`)
  } else if (todayEvents.length === 0) {
    sections.push('Calendar: No events today')
  } else {
    sections.push(`Calendar: ${todayEvents.length} events`)
    sections.push(formatEventList(todayEvents))
  }
  sections.push('')

  // To Do section
  if (!todosResult.success) {
    sections.push(`To Do: Error - ${todosResult.error}`)
  } else if (pendingTodos.length === 0) {
    sections.push('To Do: All clear')
  } else {
    sections.push(`To Do: ${pendingTodos.length} pending`)
    sections.push(formatTodoList(pendingTodos))
  }

  sections.push('')
  sections.push('=====================')

  return {
    success: true,
    data: briefing,
    formatted: sections.join('\n'),
  }
}

/**
 * M365 Digest — weekly activity summary.
 * Fetches recent activity metrics across services.
 */
export async function m365Digest(): Promise<{ success: boolean; formatted: string }> {
  const [emailsResult, eventsResult, todosResult] = await Promise.all([
    listEmails({ top: 50, fresh: true }),
    listEvents({ fresh: true }),
    listTodoTasks(undefined, { fresh: true }),
  ])

  const emailCount = emailsResult.success && emailsResult.data
    ? emailsResult.data.length
    : 0

  const eventCount = eventsResult.success && eventsResult.data
    ? eventsResult.data.length
    : 0

  const completedTasks = todosResult.success && todosResult.data
    ? todosResult.data.filter((t) => t.status === 'completed').length
    : 0

  const pendingTasks = todosResult.success && todosResult.data
    ? todosResult.data.filter((t) => t.status !== 'completed').length
    : 0

  const lines = [
    '=== M365 Weekly Digest ===',
    '',
    `Emails received: ${emailCount}`,
    `Calendar events: ${eventCount}`,
    `Tasks completed: ${completedTasks}`,
    `Tasks pending: ${pendingTasks}`,
    '',
    '==========================',
  ]

  return { success: true, formatted: lines.join('\n') }
}

/**
 * M365 Search — unified search across emails and files.
 */
export async function m365Search(
  query: string,
): Promise<{ success: boolean; formatted: string }> {
  if (!query.trim()) {
    return { success: false, formatted: 'Error: search query is required.' }
  }

  // Search emails by subject/body
  const emailsResult = await listEmails({ top: 50, fresh: true })

  const matchingEmails = emailsResult.success && emailsResult.data
    ? emailsResult.data.filter((e) => {
        const q = query.toLowerCase()
        return (
          e.subject.toLowerCase().includes(q) ||
          e.bodyPreview.toLowerCase().includes(q) ||
          e.from.toLowerCase().includes(q)
        )
      })
    : []

  const lines = [`=== M365 Search: "${query}" ===`, '']

  if (matchingEmails.length > 0) {
    lines.push(`Emails: ${matchingEmails.length} matches`)
    lines.push(formatEmailList(matchingEmails))
  } else {
    lines.push('Emails: no matches')
  }

  lines.push('')
  lines.push('==============================')

  return { success: true, formatted: lines.join('\n') }
}
