/**
 * GWS Composite Actions — multi-command operations that combine
 * data from multiple Google Workspace services in parallel.
 *
 * Includes the dashboard panel builder for TUI display.
 */

import { listGmailMessages, formatGmailList } from './gmail'
import { listCalendarEvents, formatCalendarEventList } from './calendar'
import { listDriveFiles, formatDriveFileList } from './drive'
import { t } from '../i18n'
import type { GwsBriefing } from './types'

/**
 * GWS Briefing — parallel fetch of unread emails, today's calendar, and recent Drive files.
 * Returns structured data for Claude to summarize.
 */
export async function gwsBriefing(
  options: { fresh?: boolean } = {},
): Promise<{ success: boolean; data: GwsBriefing | null; formatted: string }> {
  const fresh = options.fresh ?? false

  const [emailsResult, eventsResult, filesResult] = await Promise.all([
    listGmailMessages({ maxResults: 10, fresh }),
    listCalendarEvents({ fresh }),
    listDriveFiles(undefined, { fresh }),
  ])

  const unreadEmails = emailsResult.success && emailsResult.data
    ? emailsResult.data.filter((e) => e.isUnread)
    : []

  const todayEvents = eventsResult.success && eventsResult.data
    ? eventsResult.data
    : []

  const recentFiles = filesResult.success && filesResult.data
    ? filesResult.data.slice(0, 10)
    : []

  const briefing: GwsBriefing = {
    unreadEmails,
    todayEvents,
    recentFiles,
    timestamp: Date.now(),
  }

  // Build formatted output
  const sections: string[] = [`=== ${t('gws.briefing_title')} ===`, '']

  // Gmail
  if (!emailsResult.success) {
    sections.push(`${t('gws.gmail')}: ${t('gws.error', { msg: emailsResult.error ?? '' })}`)
  } else if (unreadEmails.length === 0) {
    sections.push(`${t('gws.gmail')}: ${t('gws.inbox_clear')}`)
  } else {
    sections.push(`${t('gws.gmail')}: ${t('gws.unread', { count: unreadEmails.length })}`)
    sections.push(formatGmailList(unreadEmails))
  }
  sections.push('')

  // Agenda
  if (!eventsResult.success) {
    sections.push(`${t('gws.agenda')}: ${t('gws.error', { msg: eventsResult.error ?? '' })}`)
  } else if (todayEvents.length === 0) {
    sections.push(`${t('gws.agenda')}: ${t('gws.no_events_today')}`)
  } else {
    sections.push(`${t('gws.agenda')}: ${t('gws.events', { count: todayEvents.length })}`)
    sections.push(formatCalendarEventList(todayEvents))
  }
  sections.push('')

  // Drive
  if (!filesResult.success) {
    sections.push(`${t('gws.drive')}: ${t('gws.error', { msg: filesResult.error ?? '' })}`)
  } else if (recentFiles.length === 0) {
    sections.push(`${t('gws.drive')}: ${t('gws.no_recent_files')}`)
  } else {
    sections.push(`${t('gws.drive')}: ${t('gws.recent_files', { count: recentFiles.length })}`)
    sections.push(formatDriveFileList(recentFiles))
  }

  sections.push('')
  sections.push('=================================')

  return {
    success: true,
    data: briefing,
    formatted: sections.join('\n'),
  }
}

/**
 * GWS Dashboard — builds a multi-panel layout for the TUI dashboard.
 *
 * Returns an array of panel objects that can be passed to the TUI
 * ViewManager.enterDashboardMode() for side-by-side display.
 */
export async function gwsDashboard(
  options: { fresh?: boolean } = {},
): Promise<{
  success: boolean
  panels: Array<{ id: string; title: string; content: string[] }>
  formatted: string
}> {
  const fresh = options.fresh ?? false

  const [emailsResult, eventsResult, filesResult] = await Promise.all([
    listGmailMessages({ maxResults: 15, fresh }),
    listCalendarEvents({ fresh }),
    listDriveFiles(undefined, { fresh }),
  ])

  // Painel Gmail
  const gmailLines: string[] = []
  if (!emailsResult.success) {
    gmailLines.push(t('gws.error', { msg: emailsResult.error ?? '' }))
  } else {
    const emails = emailsResult.data ?? []
    const unread = emails.filter((e) => e.isUnread)
    gmailLines.push(t('gws.unread_total', { unread: unread.length, total: emails.length }))
    gmailLines.push('')
    for (const email of emails.slice(0, 10)) {
      const marker = email.isUnread ? '*' : ' '
      const date = email.date
        ? new Date(email.date).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
        : ''
      gmailLines.push(`${marker} ${date} ${email.from.slice(0, 20)}`)
      gmailLines.push(`  ${email.subject.slice(0, 40)}`)
    }
  }

  // Painel Agenda
  const calLines: string[] = []
  if (!eventsResult.success) {
    calLines.push(t('gws.error', { msg: eventsResult.error ?? '' }))
  } else {
    const events = eventsResult.data ?? []
    calLines.push(t('gws.events_today', { count: events.length }))
    calLines.push('')
    for (const event of events) {
      const start = event.start
        ? new Date(event.start).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
        : '??:??'
      const end = event.end
        ? new Date(event.end).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
        : '??:??'
      calLines.push(`${start}-${end} ${event.summary.slice(0, 35)}`)
      if (event.location) calLines.push(`  @ ${event.location.slice(0, 30)}`)
    }
    if (events.length === 0) {
      calLines.push(t('gws.no_events'))
    }
  }

  // Painel Drive
  const driveLines: string[] = []
  if (!filesResult.success) {
    driveLines.push(t('gws.error', { msg: filesResult.error ?? '' }))
  } else {
    const files = filesResult.data ?? []
    driveLines.push(t('gws.items', { count: files.length }))
    driveLines.push('')
    for (const file of files.slice(0, 10)) {
      const isFolder = file.mimeType === 'application/vnd.google-apps.folder'
      const icon = isFolder ? '[P]' : '[A]'
      const date = file.modifiedTime
        ? new Date(file.modifiedTime).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' })
        : ''
      driveLines.push(`${icon} ${file.name.slice(0, 35)}  ${date}`)
    }
    if (files.length === 0) {
      driveLines.push(t('gws.no_files'))
    }
  }

  const panels = [
    { id: 'gws-gmail', title: t('gws.gmail'), content: gmailLines },
    { id: 'gws-calendar', title: t('gws.agenda'), content: calLines },
    { id: 'gws-drive', title: t('gws.drive'), content: driveLines },
  ]

  // Also build a text-only formatted version
  const formatted = [
    `=== ${t('gws.panel_title')} ===`,
    `  ${t('gws.press_any_key')}`,
    '',
    `[ ${t('gws.gmail')} ]`,
    ...gmailLines.map((l) => `  ${l}`),
    '',
    `[ ${t('gws.agenda')} ]`,
    ...calLines.map((l) => `  ${l}`),
    '',
    `[ ${t('gws.drive')} ]`,
    ...driveLines.map((l) => `  ${l}`),
    '',
    '================================',
  ].join('\n')

  return { success: true, panels, formatted }
}

/**
 * GWS Search — unified search across Gmail and Drive.
 */
export async function gwsSearch(
  query: string,
): Promise<{ success: boolean; formatted: string }> {
  if (!query.trim()) {
    return { success: false, formatted: 'Error: search query is required.' }
  }

  const [emailsResult, filesResult] = await Promise.all([
    listGmailMessages({ maxResults: 30, fresh: true }),
    (async () => {
      const { searchDriveFiles } = await import('./drive')
      return searchDriveFiles(query)
    })(),
  ])

  const matchingEmails = emailsResult.success && emailsResult.data
    ? emailsResult.data.filter((e) => {
        const q = query.toLowerCase()
        return (
          e.subject.toLowerCase().includes(q) ||
          e.snippet.toLowerCase().includes(q) ||
          e.from.toLowerCase().includes(q)
        )
      })
    : []

  const matchingFiles = filesResult.success && filesResult.data
    ? filesResult.data
    : []

  const lines = [`=== GWS Search: "${query}" ===`, '']

  if (matchingEmails.length > 0) {
    lines.push(`Gmail: ${matchingEmails.length} matches`)
    lines.push(formatGmailList(matchingEmails))
  } else {
    lines.push('Gmail: no matches')
  }

  lines.push('')

  if (matchingFiles.length > 0) {
    lines.push(`Drive: ${matchingFiles.length} matches`)
    lines.push(formatDriveFileList(matchingFiles))
  } else {
    lines.push('Drive: no matches')
  }

  lines.push('')
  lines.push('==============================')

  return { success: true, formatted: lines.join('\n') }
}
