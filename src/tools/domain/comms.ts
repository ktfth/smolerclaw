import type Anthropic from '@anthropic-ai/sdk'
import { openEmailDraft, formatDraftPreview, type EmailDraft } from '../../email'
import { getOutlookEvents } from '../../windows'
import { sendNotification } from '../../windows-agent'
import { bindTools, ok, fail, requireText, optionalText, type ToolHandler } from '../../core/result'

const SCHEMAS: Anthropic.Tool[] = [
  {
    name: 'draft_email',
    description:
      'Create an email draft and open it in Outlook (Windows) or the default mail client. ' +
      'The user can review and send manually. ' +
      'Use when the user says "escreve um email", "manda um email", "rascunho de email", etc.',
    input_schema: {
      type: 'object' as const,
      properties: {
        to: { type: 'string', description: 'Recipient email address' },
        subject: { type: 'string', description: 'Email subject line' },
        body: { type: 'string', description: 'Email body text' },
        cc: { type: 'string', description: 'CC recipients (optional)' },
      },
      required: ['to', 'subject', 'body'],
    },
  },
  {
    name: 'send_notification',
    description:
      'Send a Windows toast notification to the user. Displays a system notification with title and message. ' +
      'Use when you need to alert the user about: task completions, reminders, important events, ' +
      'or when the user asks "me avisa quando terminar", "notifica quando...", etc.',
    input_schema: {
      type: 'object' as const,
      properties: {
        title: { type: 'string', description: 'Notification title (short, max ~50 chars).' },
        message: { type: 'string', description: 'Notification message/body.' },
      },
      required: ['title', 'message'],
    },
  },
  {
    name: 'get_calendar_events',
    description: 'Get today\'s Outlook calendar events. Read-only. Returns event times and subjects.',
    input_schema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  },
]

const HANDLERS: Record<string, ToolHandler> = {
  draft_email: async (input) => {
    const to = requireText(input, 'to')
    const subject = requireText(input, 'subject')
    const body = requireText(input, 'body')
    if (!to || !subject || !body) return fail('to, subject, and body are required.')
    const draft: EmailDraft = { to, subject, body, cc: optionalText(input, 'cc') }
    const opened = await openEmailDraft(draft)
    const text = `${formatDraftPreview(draft)}\n\n${opened.text}`
    return opened.ok ? ok(text) : fail(text)
  },
  send_notification: async (input) => {
    const title = requireText(input, 'title')
    const message = requireText(input, 'message')
    if (!title || !message) return fail('title and message are required.')
    const result = await sendNotification(title, message)
    return result.success
      ? ok(`Notificação enviada: "${title}"`)
      : fail(`Erro ao enviar notificação: ${result.error}`)
  },
  get_calendar_events: () => getOutlookEvents(),
}

export const COMMS_TOOLS = bindTools(SCHEMAS, HANDLERS, ['get_calendar_events'])
