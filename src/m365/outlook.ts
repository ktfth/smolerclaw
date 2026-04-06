/**
 * M365 Outlook — emails, calendar events, and contacts.
 *
 * Wraps m365 CLI Outlook commands with caching and typed results.
 * Uses the actual m365 CLI command names and Graph API response shapes.
 */

import { executeM365 } from './executor'
import { cacheGet, cacheSet } from './cache'
import type {
  M365Email, M365EmailDetail, M365SendEmailParams,
  M365Event, M365CreateEventParams,
  M365Contact, M365Result,
} from './types'

// ─── Helpers ────────────────────────────────────────────────

/** Safely extract a string from a Graph API email address object or string */
function extractEmail(from: unknown): string {
  if (!from) return '(unknown)'
  if (typeof from === 'string') return from
  if (typeof from === 'object') {
    const obj = from as Record<string, unknown>
    const ea = obj.emailAddress as Record<string, unknown> | undefined
    if (ea) return `${ea.name ?? ''} <${ea.address ?? ''}>`.trim()
  }
  return String(from)
}

/** Safely get a string field, returning fallback if missing */
function str(val: unknown, fallback = ''): string {
  if (val === undefined || val === null) return fallback
  return String(val)
}

// ─── Emails ─────────────────────────────────────────────────

/**
 * List recent inbox emails.
 */
export async function listEmails(
  options: { top?: number; fresh?: boolean } = {},
): Promise<M365Result<M365Email[]>> {
  const cacheKey = 'outlook:message:list'

  if (!options.fresh) {
    const cached = cacheGet<M365Email[]>(cacheKey)
    if (cached) {
      return { success: true, data: cached, error: null, raw: '', duration: 0 }
    }
  }

  const result = await executeM365<unknown[]>([
    'outlook', 'message', 'list',
    '--folderName', 'inbox',
  ])

  if (result.success && result.data) {
    // Normalize Graph API response to our types
    const emails: M365Email[] = result.data.map((raw: unknown) => {
      const r = raw as Record<string, unknown>
      return {
        id: str(r.id, ''),
        subject: str(r.subject, '(no subject)'),
        from: extractEmail(r.from),
        receivedDateTime: str(r.receivedDateTime),
        isRead: r.isRead === true,
        bodyPreview: str(r.bodyPreview),
        importance: str(r.importance, 'normal'),
      }
    })
    cacheSet(cacheKey, emails, 'emails')
    return { success: true, data: emails, error: null, raw: result.raw, duration: result.duration }
  }

  return result as M365Result<M365Email[]>
}

/**
 * Get a specific email by ID.
 */
export async function getEmail(id: string): Promise<M365Result<M365EmailDetail>> {
  const result = await executeM365<Record<string, unknown>>(['outlook', 'message', 'get', '--id', id])

  if (result.success && result.data) {
    const r = result.data
    const toRecipients = Array.isArray(r.toRecipients)
      ? (r.toRecipients as unknown[]).map(extractEmail)
      : []
    const ccRecipients = Array.isArray(r.ccRecipients)
      ? (r.ccRecipients as unknown[]).map(extractEmail)
      : []
    const body = typeof r.body === 'object' && r.body
      ? str((r.body as Record<string, unknown>).content)
      : str(r.bodyPreview)

    const detail: M365EmailDetail = {
      id: str(r.id),
      subject: str(r.subject, '(no subject)'),
      from: extractEmail(r.from),
      to: toRecipients,
      cc: ccRecipients,
      receivedDateTime: str(r.receivedDateTime),
      isRead: r.isRead === true,
      body,
      importance: str(r.importance, 'normal'),
      hasAttachments: r.hasAttachments === true,
    }
    return { success: true, data: detail, error: null, raw: result.raw, duration: result.duration }
  }

  return result as unknown as M365Result<M365EmailDetail>
}

/**
 * Send an email.
 */
export async function sendEmail(params: M365SendEmailParams): Promise<M365Result<string>> {
  const args = [
    'outlook', 'mail', 'send',
    '--to', params.to,
    '--subject', params.subject,
    '--bodyContents', params.body,
  ]

  if (params.cc) {
    args.push('--cc', params.cc)
  }
  if (params.importance && params.importance !== 'normal') {
    args.push('--importance', params.importance)
  }

  return executeM365<string>(args, { jsonOutput: false })
}

/**
 * Format email list for TUI display.
 */
export function formatEmailList(emails: M365Email[]): string {
  if (emails.length === 0) return 'No emails found.'

  const lines = ['--- Inbox ---']
  for (const email of emails) {
    const read = email.isRead ? ' ' : '*'
    const idShort = email.id ? email.id.slice(-6) : '------'
    const date = email.receivedDateTime
      ? new Date(email.receivedDateTime).toLocaleDateString('pt-BR', {
          day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
        })
      : ''
    const preview = email.bodyPreview?.slice(0, 60) ?? ''
    lines.push(`${read} [${idShort}] ${date} | ${email.from}`)
    lines.push(`  ${email.subject}`)
    if (preview) lines.push(`  ${preview}...`)
  }
  lines.push(`--- ${emails.filter((e) => !e.isRead).length} unread ---`)
  return lines.join('\n')
}

// ─── Calendar ───────────────────────────────────────────────

/**
 * List calendar events.
 */
export async function listEvents(
  options: { fresh?: boolean } = {},
): Promise<M365Result<M365Event[]>> {
  const cacheKey = 'outlook:event:list'

  if (!options.fresh) {
    const cached = cacheGet<M365Event[]>(cacheKey)
    if (cached) {
      return { success: true, data: cached, error: null, raw: '', duration: 0 }
    }
  }

  const result = await executeM365<unknown[]>(['outlook', 'event', 'list'])

  if (result.success && result.data) {
    const events: M365Event[] = result.data.map((raw: unknown) => {
      const r = raw as Record<string, unknown>
      const start = typeof r.start === 'object' && r.start
        ? str((r.start as Record<string, unknown>).dateTime)
        : str(r.start)
      const end = typeof r.end === 'object' && r.end
        ? str((r.end as Record<string, unknown>).dateTime)
        : str(r.end)
      return {
        id: str(r.id),
        subject: str(r.subject, '(no subject)'),
        start,
        end,
        location: typeof r.location === 'object' && r.location
          ? str((r.location as Record<string, unknown>).displayName)
          : str(r.location),
        organizer: extractEmail(r.organizer),
        isAllDay: r.isAllDay === true,
        status: str(r.showAs ?? r.status, ''),
      }
    })
    cacheSet(cacheKey, events, 'calendar')
    return { success: true, data: events, error: null, raw: result.raw, duration: result.duration }
  }

  return result as M365Result<M365Event[]>
}

/**
 * Create a calendar event.
 */
export async function createEvent(params: M365CreateEventParams): Promise<M365Result<string>> {
  const args = [
    'outlook', 'event', 'add',
    '--subject', params.subject,
    '--startDateTime', params.start,
    '--endDateTime', params.end,
  ]

  if (params.location) args.push('--location', params.location)
  if (params.body) args.push('--bodyContents', params.body)
  if (params.isAllDay) args.push('--isAllDay')

  return executeM365<string>(args, { jsonOutput: false })
}

/**
 * Format event list for TUI display.
 */
export function formatEventList(events: M365Event[]): string {
  if (events.length === 0) return 'No events found.'

  const lines = ['--- Calendar ---']
  for (const event of events) {
    const start = event.start
      ? new Date(event.start).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
      : '??:??'
    const end = event.end
      ? new Date(event.end).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
      : '??:??'
    const loc = event.location ? ` @ ${event.location}` : ''
    lines.push(`  ${start}-${end} ${event.subject}${loc}`)
  }
  lines.push('----------------')
  return lines.join('\n')
}

// ─── Contacts ───────────────────────────────────────────────

/**
 * List contacts.
 */
export async function listContacts(
  options: { fresh?: boolean } = {},
): Promise<M365Result<M365Contact[]>> {
  const cacheKey = 'outlook:contact:list'

  if (!options.fresh) {
    const cached = cacheGet<M365Contact[]>(cacheKey)
    if (cached) {
      return { success: true, data: cached, error: null, raw: '', duration: 0 }
    }
  }

  const result = await executeM365<unknown[]>(['outlook', 'contact', 'list'])

  if (result.success && result.data) {
    const contacts: M365Contact[] = result.data.map((raw: unknown) => {
      const r = raw as Record<string, unknown>
      return {
        id: str(r.id),
        displayName: str(r.displayName, '(unnamed)'),
        emailAddresses: Array.isArray(r.emailAddresses)
          ? (r.emailAddresses as unknown[]).map((e) => {
              if (typeof e === 'string') return e
              if (typeof e === 'object' && e) return str((e as Record<string, unknown>).address)
              return ''
            }).filter(Boolean)
          : [],
        phoneNumbers: Array.isArray(r.phones)
          ? (r.phones as unknown[]).map((p) => {
              if (typeof p === 'string') return p
              if (typeof p === 'object' && p) return str((p as Record<string, unknown>).number)
              return ''
            }).filter(Boolean)
          : [],
        company: r.companyName ? str(r.companyName) : null,
        jobTitle: r.jobTitle ? str(r.jobTitle) : null,
      }
    })
    cacheSet(cacheKey, contacts, 'contacts')
    return { success: true, data: contacts, error: null, raw: result.raw, duration: result.duration }
  }

  return result as M365Result<M365Contact[]>
}

/**
 * Format contact list for TUI display.
 */
export function formatContactList(contacts: M365Contact[]): string {
  if (contacts.length === 0) return 'No contacts found.'

  const lines = ['--- Contacts ---']
  for (const c of contacts) {
    const email = c.emailAddresses[0] ?? ''
    const role = c.jobTitle ? ` (${c.jobTitle})` : ''
    lines.push(`  ${c.displayName}${role} - ${email}`)
  }
  lines.push('----------------')
  return lines.join('\n')
}
