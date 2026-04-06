/**
 * M365 TUI Command Handler — handles /m365 namespace commands.
 *
 * All M365 commands are accessed via /m365 <subcommand>.
 */

import { m365Login, m365Logout, getM365Status, formatM365Status, getConsentUrl } from './auth'
import { checkM365Installed } from './executor'
import { cacheClear, cacheStats } from './cache'
import { listEmails, getEmail, sendEmail, listEvents, createEvent, listContacts } from './outlook'
import { formatEmailList, formatEventList, formatContactList } from './outlook'
import { listTodoTasks, listTodoLists, createTodo, completeTodo } from './todo'
import { formatTodoList, formatTodoLists } from './todo'
import { listFiles, formatFileList } from './onedrive'
import { listNotebooks, listPages, formatNotebookList, formatPageList } from './onenote'
import { m365Briefing, m365Digest, m365Search } from './composite'

export interface M365CommandContext {
  showSystem: (msg: string) => void
  showError: (msg: string) => void
}

/**
 * Handle a /m365 command. Returns true if handled.
 */
export async function handleM365Command(
  args: string[],
  ctx: M365CommandContext,
): Promise<boolean> {
  const sub = args[0]?.toLowerCase() ?? 'help'
  const subArgs = args.slice(1)

  // Check if m365 CLI is installed (except for help)
  if (sub !== 'help') {
    const installed = await checkM365Installed()
    if (!installed) {
      ctx.showError(
        'M365 CLI not found.\n' +
        'Run: bun install\n' +
        'Docs: https://pnp.github.io/cli-microsoft365/',
      )
      return true
    }
  }

  switch (sub) {
    // ── Auth ────────────────────────────────────────────
    case 'login': {
      const appId = subArgs[0] || undefined
      ctx.showSystem('Starting M365 login...')
      const result = await m365Login((text) => ctx.showSystem(text), appId)
      ctx.showSystem(result)
      return true
    }

    case 'logout': {
      const result = await m365Logout()
      ctx.showSystem(result)
      return true
    }

    case 'status': {
      const info = await getM365Status()
      ctx.showSystem(formatM365Status(info))
      return true
    }

    case 'consent': {
      const url = getConsentUrl()
      ctx.showSystem(
        'Open this URL in your browser to grant permissions:\n\n' +
        url + '\n\n' +
        'After consenting, run /m365 login again.',
      )
      return true
    }

    // ── Cache ───────────────────────────────────────────
    case 'refresh': {
      cacheClear()
      ctx.showSystem('M365 cache cleared.')
      return true
    }

    case 'cache': {
      const stats = cacheStats()
      ctx.showSystem(`Cache: ${stats.size} entries\n${stats.keys.map((k) => `  ${k}`).join('\n') || '  (empty)'}`)
      return true
    }

    // ── Emails ──────────────────────────────────────────
    case 'emails': {
      const fresh = subArgs.includes('--fresh')
      const top = parseNumberArg(subArgs, '--top') ?? 20
      ctx.showSystem('Fetching emails...')
      const result = await listEmails({ top, fresh })
      if (!result.success) {
        if (result.error?.includes('Access is denied')) {
          ctx.showError('Access denied. Run /m365 consent to grant email permissions, then /m365 login again.')
        } else {
          ctx.showError(result.error ?? 'Failed to fetch emails.')
        }
        return true
      }
      ctx.showSystem(formatEmailList(result.data ?? []))
      return true
    }

    case 'email': {
      const action = subArgs[0]?.toLowerCase()
      if (action === 'read' && subArgs[1]) {
        ctx.showSystem('Fetching email...')
        const result = await getEmail(subArgs[1])
        if (!result.success) {
          ctx.showError(result.error ?? 'Failed to fetch email.')
          return true
        }
        const email = result.data
        if (!email) {
          ctx.showError('Email not found.')
          return true
        }
        ctx.showSystem([
          `From: ${email.from}`,
          `To: ${email.to.join(', ')}`,
          email.cc.length ? `CC: ${email.cc.join(', ')}` : '',
          `Subject: ${email.subject}`,
          `Date: ${email.receivedDateTime}`,
          '',
          email.body,
        ].filter(Boolean).join('\n'))
        return true
      }

      if (action === 'send') {
        const to = parseStringArg(subArgs, '--to')
        const subject = parseStringArg(subArgs, '--subject')
        const body = parseStringArg(subArgs, '--body')
        if (!to || !subject || !body) {
          ctx.showError('Usage: /m365 email send --to <email> --subject <text> --body <text>')
          return true
        }
        ctx.showSystem('Sending email...')
        const result = await sendEmail({ to, subject, body })
        ctx.showSystem(result.success ? 'Email sent.' : `Error: ${result.error}`)
        return true
      }

      ctx.showError('Usage: /m365 email read <id> | /m365 email send --to ... --subject ... --body ...')
      return true
    }

    // ── Calendar ────────────────────────────────────────
    case 'calendar': {
      const action = subArgs[0]?.toLowerCase()
      if (action === 'add') {
        const subject = parseStringArg(subArgs, '--subject')
        const start = parseStringArg(subArgs, '--start')
        const end = parseStringArg(subArgs, '--end')
        const location = parseStringArg(subArgs, '--location')
        if (!subject || !start || !end) {
          ctx.showError('Usage: /m365 calendar add --subject <text> --start <datetime> --end <datetime>')
          return true
        }
        ctx.showSystem('Creating event...')
        const result = await createEvent({ subject, start, end, location: location ?? undefined })
        ctx.showSystem(result.success ? 'Event created.' : `Error: ${result.error}`)
        return true
      }

      const fresh = subArgs.includes('--fresh')
      ctx.showSystem('Fetching calendar...')
      const result = await listEvents({ fresh })
      if (!result.success) {
        ctx.showError(result.error ?? 'Failed to fetch calendar.')
        return true
      }
      ctx.showSystem(formatEventList(result.data ?? []))
      return true
    }

    // ── Contacts ────────────────────────────────────────
    case 'contacts': {
      const fresh = subArgs.includes('--fresh')
      ctx.showSystem('Fetching contacts...')
      const result = await listContacts({ fresh })
      if (!result.success) {
        ctx.showError(result.error ?? 'Failed to fetch contacts.')
        return true
      }
      ctx.showSystem(formatContactList(result.data ?? []))
      return true
    }

    // ── To Do ───────────────────────────────────────────
    case 'todo': {
      const action = subArgs[0]?.toLowerCase()

      if (action === 'lists') {
        ctx.showSystem('Fetching To Do lists...')
        const result = await listTodoLists()
        if (!result.success) {
          ctx.showError(result.error ?? 'Failed to fetch lists.')
          return true
        }
        ctx.showSystem(formatTodoLists(result.data ?? []))
        return true
      }

      if (action === 'add') {
        const title = subArgs.slice(1).join(' ')
        if (!title) {
          ctx.showError('Usage: /m365 todo add <task title>')
          return true
        }
        ctx.showSystem('Creating task...')
        const result = await createTodo({ title })
        ctx.showSystem(result.success ? 'Task created.' : `Error: ${result.error}`)
        return true
      }

      if (action === 'done' && subArgs[1]) {
        ctx.showSystem('Completing task...')
        const result = await completeTodo(subArgs[1])
        ctx.showSystem(result.success ? 'Task completed.' : `Error: ${result.error}`)
        return true
      }

      // Default: list tasks
      const fresh = subArgs.includes('--fresh')
      ctx.showSystem('Fetching tasks...')
      const result = await listTodoTasks(undefined, { fresh })
      if (!result.success) {
        ctx.showError(result.error ?? 'Failed to fetch tasks.')
        return true
      }
      ctx.showSystem(formatTodoList(result.data ?? []))
      return true
    }

    // ── OneDrive ────────────────────────────────────────
    case 'onedrive': {
      const action = subArgs[0]?.toLowerCase()
      const fresh = subArgs.includes('--fresh')

      if (action === 'get' && subArgs[1]) {
        ctx.showSystem(`Fetching file info: ${subArgs[1]}...`)
        // For now just list the folder
        const result = await listFiles(subArgs[1], { fresh })
        if (!result.success) {
          ctx.showError(result.error ?? 'Failed to fetch file.')
          return true
        }
        ctx.showSystem(formatFileList(result.data ?? []))
        return true
      }

      const folder = action && action !== '--fresh' ? action : undefined
      ctx.showSystem('Fetching OneDrive files...')
      const result = await listFiles(folder, { fresh })
      if (!result.success) {
        ctx.showError(result.error ?? 'Failed to fetch files.')
        return true
      }
      ctx.showSystem(formatFileList(result.data ?? []))
      return true
    }

    // ── OneNote ─────────────────────────────────────────
    case 'onenote': {
      const action = subArgs[0]?.toLowerCase()

      if (action === 'pages' && subArgs[1]) {
        const notebook = subArgs.slice(1).join(' ')
        ctx.showSystem(`Fetching pages from "${notebook}"...`)
        const result = await listPages(notebook)
        if (!result.success) {
          ctx.showError(result.error ?? 'Failed to fetch pages.')
          return true
        }
        ctx.showSystem(formatPageList(result.data ?? []))
        return true
      }

      ctx.showSystem('Fetching notebooks...')
      const result = await listNotebooks()
      if (!result.success) {
        ctx.showError(result.error ?? 'Failed to fetch notebooks.')
        return true
      }
      ctx.showSystem(formatNotebookList(result.data ?? []))
      return true
    }

    // ── Composite Actions ───────────────────────────────
    case 'briefing': {
      const fresh = subArgs.includes('--fresh')
      ctx.showSystem('Building M365 briefing...')
      const result = await m365Briefing({ fresh })
      ctx.showSystem(result.formatted)
      return true
    }

    case 'digest': {
      ctx.showSystem('Building M365 weekly digest...')
      const result = await m365Digest()
      ctx.showSystem(result.formatted)
      return true
    }

    case 'search': {
      const query = subArgs.join(' ')
      if (!query) {
        ctx.showError('Usage: /m365 search <query>')
        return true
      }
      ctx.showSystem(`Searching M365 for "${query}"...`)
      const result = await m365Search(query)
      ctx.showSystem(result.formatted)
      return true
    }

    // ── Help ────────────────────────────────────────────
    case 'help':
    default: {
      ctx.showSystem(M365_HELP)
      return true
    }
  }
}

// ─── Help Text ──────────────────────────────────────────────

const M365_HELP = `
=== Microsoft 365 Commands ===

Auth:
  /m365 login [appId]      Connect (device code flow)
  /m365 consent            Grant API permissions
  /m365 status             Connection status
  /m365 logout             Disconnect
  /m365 refresh            Clear cache

Email:
  /m365 emails             List inbox emails
  /m365 email read <id>    Read specific email
  /m365 email send --to <email> --subject <text> --body <text>

Calendar:
  /m365 calendar           List events
  /m365 calendar add --subject <text> --start <dt> --end <dt>

Contacts:
  /m365 contacts           List contacts

To Do:
  /m365 todo               List tasks
  /m365 todo add <title>   Create task
  /m365 todo done <id>     Complete task
  /m365 todo lists         List task lists

OneDrive:
  /m365 onedrive [folder]  List files
  /m365 onedrive get <path>

OneNote:
  /m365 onenote            List notebooks
  /m365 onenote pages <nb> List pages

Composite:
  /m365 briefing           Emails + calendar + todos
  /m365 digest             Weekly activity summary
  /m365 search <query>     Search across services

Flags: --fresh (skip cache)
===============================
`.trim()

// ─── Helpers ────────────────────────────────────────────────

function parseStringArg(args: string[], flag: string): string | null {
  const idx = args.indexOf(flag)
  if (idx === -1 || idx >= args.length - 1) return null
  return args[idx + 1]
}

function parseNumberArg(args: string[], flag: string): number | null {
  const val = parseStringArg(args, flag)
  if (val === null) return null
  const n = parseInt(val, 10)
  return Number.isNaN(n) ? null : n
}
