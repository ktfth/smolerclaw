/**
 * M365 Claude Tool Schemas — tool definitions that let Claude
 * interact with Microsoft 365 services directly in conversation.
 */

import type Anthropic from '@anthropic-ai/sdk'
import { isM365Connected } from './auth'
import { listEmails, getEmail, sendEmail, listEvents, createEvent, listContacts } from './outlook'
import { listTodoTasks, createTodo, completeTodo } from './todo'
import { listFiles } from './onedrive'
import { listNotebooks } from './onenote'
import { m365Briefing } from './composite'
import { formatEmailList, formatEventList, formatContactList } from './outlook'
import { formatTodoList } from './todo'
import { formatFileList } from './onedrive'
import { formatNotebookList } from './onenote'

// ─── Tool Schemas ───────────────────────────────────────────

export const M365_TOOLS: Anthropic.Tool[] = [
  {
    name: 'm365_list_emails',
    description:
      'List recent inbox emails from Microsoft 365. Returns subject, sender, date, and preview. ' +
      'Requires M365 CLI login via /m365 login.',
    input_schema: {
      type: 'object' as const,
      properties: {
        top: { type: 'number', description: 'Number of emails to fetch (default: 20, max: 50)' },
        fresh: { type: 'boolean', description: 'Skip cache and fetch fresh data' },
      },
      required: [],
    },
  },
  {
    name: 'm365_read_email',
    description: 'Read a specific email by ID from Microsoft 365. Returns full body and metadata.',
    input_schema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'Email ID (from m365_list_emails)' },
      },
      required: ['id'],
    },
  },
  {
    name: 'm365_send_email',
    description: 'Send an email via Microsoft 365.',
    input_schema: {
      type: 'object' as const,
      properties: {
        to: { type: 'string', description: 'Recipient email address' },
        subject: { type: 'string', description: 'Email subject' },
        body: { type: 'string', description: 'Email body text' },
        cc: { type: 'string', description: 'CC email address (optional)' },
        importance: { type: 'string', description: 'low, normal, or high (default: normal)' },
      },
      required: ['to', 'subject', 'body'],
    },
  },
  {
    name: 'm365_list_events',
    description: 'List calendar events from Microsoft 365 Outlook.',
    input_schema: {
      type: 'object' as const,
      properties: {
        fresh: { type: 'boolean', description: 'Skip cache and fetch fresh data' },
      },
      required: [],
    },
  },
  {
    name: 'm365_create_event',
    description: 'Create a calendar event in Microsoft 365 Outlook.',
    input_schema: {
      type: 'object' as const,
      properties: {
        subject: { type: 'string', description: 'Event title' },
        start: { type: 'string', description: 'Start datetime (ISO 8601)' },
        end: { type: 'string', description: 'End datetime (ISO 8601)' },
        location: { type: 'string', description: 'Event location (optional)' },
        body: { type: 'string', description: 'Event description (optional)' },
      },
      required: ['subject', 'start', 'end'],
    },
  },
  {
    name: 'm365_list_todos',
    description: 'List tasks from Microsoft To Do.',
    input_schema: {
      type: 'object' as const,
      properties: {
        listId: { type: 'string', description: 'To Do list ID (optional, uses default list)' },
        fresh: { type: 'boolean', description: 'Skip cache and fetch fresh data' },
      },
      required: [],
    },
  },
  {
    name: 'm365_create_todo',
    description: 'Create a task in Microsoft To Do.',
    input_schema: {
      type: 'object' as const,
      properties: {
        title: { type: 'string', description: 'Task title' },
        listId: { type: 'string', description: 'To Do list ID (optional)' },
        dueDateTime: { type: 'string', description: 'Due date (ISO 8601, optional)' },
        importance: { type: 'string', description: 'low, normal, or high (default: normal)' },
      },
      required: ['title'],
    },
  },
  {
    name: 'm365_complete_todo',
    description: 'Mark a Microsoft To Do task as completed.',
    input_schema: {
      type: 'object' as const,
      properties: {
        taskId: { type: 'string', description: 'Task ID' },
        listId: { type: 'string', description: 'To Do list ID (optional)' },
      },
      required: ['taskId'],
    },
  },
  {
    name: 'm365_list_files',
    description: 'List files in OneDrive.',
    input_schema: {
      type: 'object' as const,
      properties: {
        folder: { type: 'string', description: 'Folder path (optional, defaults to root)' },
        fresh: { type: 'boolean', description: 'Skip cache and fetch fresh data' },
      },
      required: [],
    },
  },
  {
    name: 'm365_briefing',
    description:
      'Get a combined Microsoft 365 briefing: unread emails, today\'s calendar events, ' +
      'and pending To Do tasks. Fetches all data in parallel.',
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
 * Execute an M365 tool call. Returns null if the tool name doesn't match.
 */
export async function executeM365Tool(
  name: string,
  input: Record<string, unknown>,
): Promise<string | null> {
  if (!name.startsWith('m365_')) return null

  // Check auth first
  const connected = await isM365Connected()
  if (!connected) {
    return 'Not connected to Microsoft 365. Run /m365 login to authenticate.'
  }

  switch (name) {
    case 'm365_list_emails': {
      const top = typeof input.top === 'number' ? input.top : undefined
      const fresh = input.fresh === true
      const result = await listEmails({ top, fresh })
      if (!result.success) return `Error: ${result.error}`
      return formatEmailList(result.data ?? [])
    }

    case 'm365_read_email': {
      const id = String(input.id ?? '')
      if (!id) return 'Error: email ID is required.'
      const result = await getEmail(id)
      if (!result.success) return `Error: ${result.error}`
      const email = result.data
      if (!email) return 'Error: email not found.'
      return [
        `From: ${email.from}`,
        `To: ${email.to.join(', ')}`,
        email.cc.length ? `CC: ${email.cc.join(', ')}` : '',
        `Subject: ${email.subject}`,
        `Date: ${email.receivedDateTime}`,
        `Importance: ${email.importance}`,
        `Attachments: ${email.hasAttachments ? 'Yes' : 'No'}`,
        '',
        email.body,
      ].filter(Boolean).join('\n')
    }

    case 'm365_send_email': {
      const to = String(input.to ?? '')
      const subject = String(input.subject ?? '')
      const body = String(input.body ?? '')
      if (!to || !subject || !body) return 'Error: to, subject, and body are required.'
      const result = await sendEmail({
        to,
        subject,
        body,
        cc: input.cc ? String(input.cc) : undefined,
        importance: (input.importance as 'low' | 'normal' | 'high') ?? undefined,
      })
      if (!result.success) return `Error: ${result.error}`
      return 'Email sent successfully.'
    }

    case 'm365_list_events': {
      const fresh = input.fresh === true
      const result = await listEvents({ fresh })
      if (!result.success) return `Error: ${result.error}`
      return formatEventList(result.data ?? [])
    }

    case 'm365_create_event': {
      const subject = String(input.subject ?? '')
      const start = String(input.start ?? '')
      const end = String(input.end ?? '')
      if (!subject || !start || !end) return 'Error: subject, start, and end are required.'
      const result = await createEvent({
        subject,
        start,
        end,
        location: input.location ? String(input.location) : undefined,
        body: input.body ? String(input.body) : undefined,
      })
      if (!result.success) return `Error: ${result.error}`
      return 'Event created successfully.'
    }

    case 'm365_list_todos': {
      const listId = input.listId ? String(input.listId) : undefined
      const fresh = input.fresh === true
      const result = await listTodoTasks(listId, { fresh })
      if (!result.success) return `Error: ${result.error}`
      return formatTodoList(result.data ?? [])
    }

    case 'm365_create_todo': {
      const title = String(input.title ?? '')
      if (!title) return 'Error: title is required.'
      const result = await createTodo({
        title,
        listId: input.listId ? String(input.listId) : undefined,
        dueDateTime: input.dueDateTime ? String(input.dueDateTime) : undefined,
        importance: (input.importance as 'low' | 'normal' | 'high') ?? undefined,
      })
      if (!result.success) return `Error: ${result.error}`
      return 'Task created successfully.'
    }

    case 'm365_complete_todo': {
      const taskId = String(input.taskId ?? '')
      if (!taskId) return 'Error: taskId is required.'
      const result = await completeTodo(
        taskId,
        input.listId ? String(input.listId) : undefined,
      )
      if (!result.success) return `Error: ${result.error}`
      return 'Task marked as completed.'
    }

    case 'm365_list_files': {
      const folder = input.folder ? String(input.folder) : undefined
      const fresh = input.fresh === true
      const result = await listFiles(folder, { fresh })
      if (!result.success) return `Error: ${result.error}`
      return formatFileList(result.data ?? [])
    }

    case 'm365_briefing': {
      const fresh = input.fresh === true
      const result = await m365Briefing({ fresh })
      return result.formatted
    }

    default:
      return null
  }
}
