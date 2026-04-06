/**
 * GWS Gmail — email listing, reading, and sending.
 *
 * Wraps gws CLI Gmail commands with caching and typed results.
 * Uses the gws command pattern: gws gmail users messages <method>
 */

import { executeGws } from './executor'
import { gwsCacheGet, gwsCacheSet } from './cache'
import type {
  GwsEmail, GwsEmailDetail, GwsSendEmailParams, GwsResult,
} from './types'

// ─── Helpers ────────────────────────────────────────────────

function str(val: unknown, fallback = ''): string {
  if (val === undefined || val === null) return fallback
  return String(val)
}

/** Extract header value from Gmail headers array */
function getHeader(headers: unknown[], name: string): string {
  if (!Array.isArray(headers)) return ''
  const header = headers.find((h) => {
    if (typeof h === 'object' && h) {
      return (h as Record<string, unknown>).name === name
    }
    return false
  })
  if (header && typeof header === 'object') {
    return str((header as Record<string, unknown>).value)
  }
  return ''
}

// ─── Emails ─────────────────────────────────────────────────

/**
 * List recent inbox emails.
 */
export async function listGmailMessages(
  options: { maxResults?: number; fresh?: boolean } = {},
): Promise<GwsResult<GwsEmail[]>> {
  const cacheKey = 'gmail:messages:list'

  if (!options.fresh) {
    const cached = gwsCacheGet<GwsEmail[]>(cacheKey)
    if (cached) {
      return { success: true, data: cached, error: null, raw: '', duration: 0 }
    }
  }

  const maxResults = options.maxResults ?? 20

  const result = await executeGws<Record<string, unknown>>([
    'gmail', 'users', 'messages', 'list',
    '--params', JSON.stringify({
      userId: 'me',
      maxResults,
      labelIds: ['INBOX'],
    }),
  ])

  if (!result.success) {
    return result as unknown as GwsResult<GwsEmail[]>
  }

  const messages = result.data && typeof result.data === 'object' && 'messages' in result.data
    ? (result.data as Record<string, unknown>).messages as unknown[]
    : Array.isArray(result.data) ? result.data : []

  if (!messages || messages.length === 0) {
    const empty: GwsEmail[] = []
    gwsCacheSet(cacheKey, empty, 'gmail')
    return { success: true, data: empty, error: null, raw: result.raw, duration: result.duration }
  }

  // Fetch details for each message (batch via individual gets)
  const emails: GwsEmail[] = []
  const ids = messages.slice(0, maxResults).map((m) => {
    if (typeof m === 'object' && m) return str((m as Record<string, unknown>).id)
    return ''
  }).filter(Boolean)

  // Fetch up to 20 in parallel
  const details = await Promise.all(
    ids.map((id) =>
      executeGws<Record<string, unknown>>([
        'gmail', 'users', 'messages', 'get',
        '--params', JSON.stringify({ userId: 'me', id, format: 'metadata', metadataHeaders: ['From', 'Subject', 'Date'] }),
      ]),
    ),
  )

  for (const detail of details) {
    if (!detail.success || !detail.data) continue
    const d = detail.data as Record<string, unknown>
    const payload = d.payload as Record<string, unknown> | undefined
    const headers = payload?.headers as unknown[] ?? []
    const labelIds = Array.isArray(d.labelIds) ? d.labelIds as string[] : []

    emails.push({
      id: str(d.id),
      threadId: str(d.threadId),
      subject: getHeader(headers, 'Subject') || '(no subject)',
      from: getHeader(headers, 'From'),
      date: getHeader(headers, 'Date'),
      snippet: str(d.snippet),
      isUnread: labelIds.includes('UNREAD'),
      labelIds,
    })
  }

  gwsCacheSet(cacheKey, emails, 'gmail')
  return { success: true, data: emails, error: null, raw: result.raw, duration: result.duration }
}

/**
 * Get a specific email by ID.
 */
export async function getGmailMessage(id: string): Promise<GwsResult<GwsEmailDetail>> {
  const result = await executeGws<Record<string, unknown>>([
    'gmail', 'users', 'messages', 'get',
    '--params', JSON.stringify({ userId: 'me', id, format: 'full' }),
  ])

  if (!result.success || !result.data) {
    return result as unknown as GwsResult<GwsEmailDetail>
  }

  const d = result.data as Record<string, unknown>
  const payload = d.payload as Record<string, unknown> | undefined
  const headers = payload?.headers as unknown[] ?? []
  const labelIds = Array.isArray(d.labelIds) ? d.labelIds as string[] : []

  // Extract body from parts
  const body = extractBody(payload)

  const toHeader = getHeader(headers, 'To')
  const ccHeader = getHeader(headers, 'Cc')

  const detail: GwsEmailDetail = {
    id: str(d.id),
    threadId: str(d.threadId),
    subject: getHeader(headers, 'Subject') || '(no subject)',
    from: getHeader(headers, 'From'),
    to: toHeader ? toHeader.split(',').map((s) => s.trim()) : [],
    cc: ccHeader ? ccHeader.split(',').map((s) => s.trim()) : [],
    date: getHeader(headers, 'Date'),
    body,
    isUnread: labelIds.includes('UNREAD'),
    hasAttachments: hasAttachmentParts(payload),
  }

  return { success: true, data: detail, error: null, raw: result.raw, duration: result.duration }
}

/**
 * Send an email via Gmail using the gws +send helper.
 */
export async function sendGmailMessage(params: GwsSendEmailParams): Promise<GwsResult<string>> {
  // Use the +send helper for simplified email sending
  const args = [
    'gmail', '+send',
    '--params', JSON.stringify({
      userId: 'me',
      to: params.to,
      subject: params.subject,
      body: params.body,
      ...(params.cc ? { cc: params.cc } : {}),
    }),
  ]

  return executeGws<string>(args)
}

/**
 * Format email list for TUI display.
 */
export function formatGmailList(emails: GwsEmail[]): string {
  if (emails.length === 0) return 'Nenhum email encontrado.'

  const lines = ['--- Gmail ---']
  for (const email of emails) {
    const unread = email.isUnread ? '*' : ' '
    const idShort = email.id ? email.id.slice(-6) : '------'
    const date = email.date
      ? new Date(email.date).toLocaleDateString('pt-BR', {
          day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
        })
      : ''
    const snippet = email.snippet?.slice(0, 60) ?? ''
    lines.push(`${unread} [${idShort}] ${date} | ${email.from}`)
    lines.push(`  ${email.subject}`)
    if (snippet) lines.push(`  ${snippet}...`)
  }
  lines.push(`--- ${emails.filter((e) => e.isUnread).length} nao lidos ---`)
  return lines.join('\n')
}

// ─── Body Extraction ────────────────────────────────────────

function extractBody(payload: Record<string, unknown> | undefined): string {
  if (!payload) return ''

  // Direct body
  const body = payload.body as Record<string, unknown> | undefined
  if (body?.data) {
    return decodeBase64Url(str(body.data))
  }

  // Multipart — look for text/plain first, then text/html
  const parts = payload.parts as unknown[] | undefined
  if (!parts) return ''

  for (const part of parts) {
    if (typeof part !== 'object' || !part) continue
    const p = part as Record<string, unknown>
    if (p.mimeType === 'text/plain') {
      const partBody = p.body as Record<string, unknown> | undefined
      if (partBody?.data) return decodeBase64Url(str(partBody.data))
    }
  }

  // Fallback to text/html
  for (const part of parts) {
    if (typeof part !== 'object' || !part) continue
    const p = part as Record<string, unknown>
    if (p.mimeType === 'text/html') {
      const partBody = p.body as Record<string, unknown> | undefined
      if (partBody?.data) return decodeBase64Url(str(partBody.data))
    }
  }

  return ''
}

function hasAttachmentParts(payload: Record<string, unknown> | undefined): boolean {
  if (!payload) return false
  const parts = payload.parts as unknown[] | undefined
  if (!parts) return false
  return parts.some((p) => {
    if (typeof p !== 'object' || !p) return false
    return (p as Record<string, unknown>).filename !== ''
  })
}

function decodeBase64Url(encoded: string): string {
  try {
    const base64 = encoded.replace(/-/g, '+').replace(/_/g, '/')
    return atob(base64)
  } catch {
    return encoded
  }
}
