/**
 * GWS Claude Tool Schemas — tool definitions that let Claude
 * interact with Google Workspace services directly in conversation.
 */

import type Anthropic from '@anthropic-ai/sdk'
import { isGwsConnected } from './auth'
import { listGmailMessages, getGmailMessage, sendGmailMessage, formatGmailList } from './gmail'
import { listCalendarEvents, createCalendarEvent, formatCalendarEventList } from './calendar'
import { listDriveFiles, searchDriveFiles, formatDriveFileList } from './drive'
import { gwsBriefing } from './composite'

// ─── Tool Schemas ───────────────────────────────────────────

export const GWS_TOOLS: Anthropic.Tool[] = [
  {
    name: 'gws_list_emails',
    description:
      'List recent inbox emails from Gmail via Google Workspace CLI. Returns subject, sender, date, and snippet. ' +
      'Requires GWS CLI login via /gws login.',
    input_schema: {
      type: 'object' as const,
      properties: {
        maxResults: { type: 'number', description: 'Number of emails to fetch (default: 20, max: 50)' },
        fresh: { type: 'boolean', description: 'Skip cache and fetch fresh data' },
      },
      required: [],
    },
  },
  {
    name: 'gws_read_email',
    description: 'Read a specific Gmail email by ID. Returns full body and metadata.',
    input_schema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'Email ID (from gws_list_emails)' },
      },
      required: ['id'],
    },
  },
  {
    name: 'gws_send_email',
    description: 'Send an email via Gmail.',
    input_schema: {
      type: 'object' as const,
      properties: {
        to: { type: 'string', description: 'Recipient email address' },
        subject: { type: 'string', description: 'Email subject' },
        body: { type: 'string', description: 'Email body text' },
        cc: { type: 'string', description: 'CC email address (optional)' },
      },
      required: ['to', 'subject', 'body'],
    },
  },
  {
    name: 'gws_list_events',
    description: 'List today\'s calendar events from Google Calendar.',
    input_schema: {
      type: 'object' as const,
      properties: {
        fresh: { type: 'boolean', description: 'Skip cache and fetch fresh data' },
      },
      required: [],
    },
  },
  {
    name: 'gws_create_event',
    description: 'Create a calendar event in Google Calendar.',
    input_schema: {
      type: 'object' as const,
      properties: {
        summary: { type: 'string', description: 'Event title' },
        start: { type: 'string', description: 'Start datetime (ISO 8601)' },
        end: { type: 'string', description: 'End datetime (ISO 8601)' },
        location: { type: 'string', description: 'Event location (optional)' },
        description: { type: 'string', description: 'Event description (optional)' },
      },
      required: ['summary', 'start', 'end'],
    },
  },
  {
    name: 'gws_list_files',
    description: 'List files in Google Drive.',
    input_schema: {
      type: 'object' as const,
      properties: {
        folderId: { type: 'string', description: 'Folder ID (optional, defaults to root)' },
        fresh: { type: 'boolean', description: 'Skip cache and fetch fresh data' },
      },
      required: [],
    },
  },
  {
    name: 'gws_search_files',
    description: 'Search files in Google Drive by name.',
    input_schema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'Search query (file name)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'gws_briefing',
    description:
      'Get a combined Google Workspace briefing: unread Gmail messages, today\'s Calendar events, ' +
      'and recent Drive files. Fetches all data in parallel.',
    input_schema: {
      type: 'object' as const,
      properties: {
        fresh: { type: 'boolean', description: 'Skip cache and fetch fresh data' },
      },
      required: [],
    },
  },
]

// ─── Tool Executor ──────────────────────────────────────────

/**
 * Execute a GWS tool call. Returns null if the tool name doesn't match.
 */
export async function executeGwsTool(
  name: string,
  input: Record<string, unknown>,
): Promise<string | null> {
  if (!name.startsWith('gws_')) return null

  // Check auth first
  const connected = await isGwsConnected()
  if (!connected) {
    return 'Not connected to Google Workspace. Run /gws login to authenticate.'
  }

  switch (name) {
    case 'gws_list_emails': {
      const maxResults = typeof input.maxResults === 'number' ? input.maxResults : undefined
      const fresh = input.fresh === true
      const result = await listGmailMessages({ maxResults, fresh })
      if (!result.success) return `Error: ${result.error}`
      return formatGmailList(result.data ?? [])
    }

    case 'gws_read_email': {
      const id = String(input.id ?? '')
      if (!id) return 'Error: email ID is required.'
      const result = await getGmailMessage(id)
      if (!result.success) return `Error: ${result.error}`
      const email = result.data
      if (!email) return 'Error: email not found.'
      return [
        `From: ${email.from}`,
        `To: ${email.to.join(', ')}`,
        email.cc.length ? `CC: ${email.cc.join(', ')}` : '',
        `Subject: ${email.subject}`,
        `Date: ${email.date}`,
        `Attachments: ${email.hasAttachments ? 'Yes' : 'No'}`,
        '',
        email.body,
      ].filter(Boolean).join('\n')
    }

    case 'gws_send_email': {
      const to = String(input.to ?? '')
      const subject = String(input.subject ?? '')
      const body = String(input.body ?? '')
      if (!to || !subject || !body) return 'Error: to, subject, and body are required.'
      const result = await sendGmailMessage({
        to,
        subject,
        body,
        cc: input.cc ? String(input.cc) : undefined,
      })
      if (!result.success) return `Error: ${result.error}`
      return 'Email sent successfully.'
    }

    case 'gws_list_events': {
      const fresh = input.fresh === true
      const result = await listCalendarEvents({ fresh })
      if (!result.success) return `Error: ${result.error}`
      return formatCalendarEventList(result.data ?? [])
    }

    case 'gws_create_event': {
      const summary = String(input.summary ?? '')
      const start = String(input.start ?? '')
      const end = String(input.end ?? '')
      if (!summary || !start || !end) return 'Error: summary, start, and end are required.'
      const result = await createCalendarEvent({
        summary,
        start,
        end,
        location: input.location ? String(input.location) : undefined,
        description: input.description ? String(input.description) : undefined,
      })
      if (!result.success) return `Error: ${result.error}`
      return 'Event created successfully.'
    }

    case 'gws_list_files': {
      const folderId = input.folderId ? String(input.folderId) : undefined
      const fresh = input.fresh === true
      const result = await listDriveFiles(folderId, { fresh })
      if (!result.success) return `Error: ${result.error}`
      return formatDriveFileList(result.data ?? [])
    }

    case 'gws_search_files': {
      const query = String(input.query ?? '')
      if (!query) return 'Error: search query is required.'
      const result = await searchDriveFiles(query)
      if (!result.success) return `Error: ${result.error}`
      return formatDriveFileList(result.data ?? [])
    }

    case 'gws_briefing': {
      const fresh = input.fresh === true
      const result = await gwsBriefing({ fresh })
      return result.formatted
    }

    default:
      return null
  }
}
