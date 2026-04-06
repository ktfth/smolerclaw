/**
 * GWS TUI Command Handler — handles /gws namespace commands.
 *
 * All Google Workspace commands are accessed via /gws <subcommand>.
 */

import { gwsSetup, gwsSetupGuided, gwsLogin, gwsLogout, getGwsStatus, formatGwsStatus, hasClientSecret, getClientSecretPath } from './auth'
import { checkGwsInstalled, resetCredentialCache } from './executor'
import { gwsCacheClear, gwsCacheStats } from './cache'
import { listGmailMessages, getGmailMessage, sendGmailMessage, formatGmailList } from './gmail'
import { listCalendarEvents, createCalendarEvent, formatCalendarEventList } from './calendar'
import { listDriveFiles, searchDriveFiles, formatDriveFileList } from './drive'
import { gwsBriefing, gwsDashboard, gwsSearch } from './composite'

export interface GwsCommandContext {
  showSystem: (msg: string) => void
  showError: (msg: string) => void
  enterDashboard?: (panels: Array<{ id: string; title: string; content: string[] }>) => void
}

/**
 * Handle a /gws command. Returns true if handled.
 */
export async function handleGwsCommand(
  args: string[],
  ctx: GwsCommandContext,
): Promise<boolean> {
  const sub = args[0]?.toLowerCase() ?? 'help'
  const subArgs = args.slice(1)

  // Check if gws CLI is installed (except for help)
  if (sub !== 'help') {
    const installed = await checkGwsInstalled()
    if (!installed) {
      ctx.showError(
        'Google Workspace CLI not found.\n' +
        'Run: npm install -g @googleworkspace/cli\n' +
        'Docs: https://github.com/googleworkspace/cli',
      )
      return true
    }
  }

  switch (sub) {
    // ── Auth ────────────────────────────────────────────
    case 'setup': {
      ctx.showSystem('Starting Google Workspace setup...')
      const result = await gwsSetup((text) => ctx.showSystem(text))
      ctx.showSystem(result)
      return true
    }

    case 'setup-guide': {
      ctx.showSystem('Starting guided Google Workspace setup...')
      const result = await gwsSetupGuided((text) => ctx.showSystem(text))
      ctx.showSystem(result)
      return true
    }

    case 'check': {
      // Reset cache so newly placed file is detected
      resetCredentialCache()
      const hasSecret = hasClientSecret()
      const secretPath = getClientSecretPath()
      if (hasSecret) {
        ctx.showSystem(`✓ client_secret.json found at ${secretPath}\nCredentials will be injected automatically.\nRun /gws login to authenticate.`)
      } else {
        ctx.showError(`✗ client_secret.json not found.\nExpected at: ${secretPath}\nRun /gws setup-guide for instructions.`)
      }
      return true
    }

    case 'login': {
      const scopes = subArgs[0] || undefined
      ctx.showSystem('Starting Google Workspace login...')
      const result = await gwsLogin((text) => ctx.showSystem(text), scopes)
      ctx.showSystem(result)
      return true
    }

    case 'logout': {
      const result = await gwsLogout()
      ctx.showSystem(result)
      return true
    }

    case 'status': {
      ctx.showSystem('Checking Google Workspace status...')
      const info = await getGwsStatus()
      ctx.showSystem(formatGwsStatus(info))
      return true
    }

    // ── Cache ───────────────────────────────────────────
    case 'refresh': {
      gwsCacheClear()
      ctx.showSystem('GWS cache cleared.')
      return true
    }

    case 'cache': {
      const stats = gwsCacheStats()
      ctx.showSystem(`Cache: ${stats.size} entries\n${stats.keys.map((k) => `  ${k}`).join('\n') || '  (empty)'}`)
      return true
    }

    // ── Gmail ───────────────────────────────────────────
    case 'emails':
    case 'gmail': {
      const action = subArgs[0]?.toLowerCase()

      if (action === 'read' && subArgs[1]) {
        ctx.showSystem('Fetching email...')
        const result = await getGmailMessage(subArgs[1])
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
          `Date: ${email.date}`,
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
          ctx.showError('Usage: /gws gmail send --to <email> --subject <text> --body <text>')
          return true
        }
        ctx.showSystem('Sending email...')
        const result = await sendGmailMessage({ to, subject, body })
        ctx.showSystem(result.success ? 'Email sent.' : `Error: ${result.error}`)
        return true
      }

      // Default: list emails
      const fresh = subArgs.includes('--fresh')
      const maxResults = parseNumberArg(subArgs, '--top') ?? 20
      ctx.showSystem('Fetching emails...')
      const result = await listGmailMessages({ maxResults, fresh })
      if (!result.success) {
        ctx.showError(result.error ?? 'Failed to fetch emails.')
        return true
      }
      ctx.showSystem(formatGmailList(result.data ?? []))
      return true
    }

    // ── Calendar ────────────────────────────────────────
    case 'calendar': {
      const action = subArgs[0]?.toLowerCase()
      if (action === 'add') {
        const summary = parseStringArg(subArgs, '--summary')
        const start = parseStringArg(subArgs, '--start')
        const end = parseStringArg(subArgs, '--end')
        const location = parseStringArg(subArgs, '--location')
        if (!summary || !start || !end) {
          ctx.showError('Usage: /gws calendar add --summary <text> --start <datetime> --end <datetime>')
          return true
        }
        ctx.showSystem('Creating event...')
        const result = await createCalendarEvent({ summary, start, end, location: location ?? undefined })
        ctx.showSystem(result.success ? 'Event created.' : `Error: ${result.error}`)
        return true
      }

      const fresh = subArgs.includes('--fresh')
      ctx.showSystem('Fetching calendar...')
      const result = await listCalendarEvents({ fresh })
      if (!result.success) {
        ctx.showError(result.error ?? 'Failed to fetch calendar.')
        return true
      }
      ctx.showSystem(formatCalendarEventList(result.data ?? []))
      return true
    }

    // ── Drive ───────────────────────────────────────────
    case 'drive': {
      const action = subArgs[0]?.toLowerCase()

      if (action === 'search' && subArgs[1]) {
        const query = subArgs.slice(1).join(' ')
        ctx.showSystem(`Searching Drive for "${query}"...`)
        const result = await searchDriveFiles(query)
        if (!result.success) {
          ctx.showError(result.error ?? 'Failed to search Drive.')
          return true
        }
        ctx.showSystem(formatDriveFileList(result.data ?? []))
        return true
      }

      const fresh = subArgs.includes('--fresh')
      const folderId = action && action !== '--fresh' ? action : undefined
      ctx.showSystem('Fetching Drive files...')
      const result = await listDriveFiles(folderId, { fresh })
      if (!result.success) {
        ctx.showError(result.error ?? 'Failed to fetch Drive files.')
        return true
      }
      ctx.showSystem(formatDriveFileList(result.data ?? []))
      return true
    }

    // ── Composite Actions ───────────────────────────────
    case 'briefing': {
      const fresh = subArgs.includes('--fresh')
      ctx.showSystem('Building Google Workspace briefing...')
      const result = await gwsBriefing({ fresh })
      ctx.showSystem(result.formatted)
      return true
    }

    case 'dashboard':
    case 'panel': {
      const fresh = subArgs.includes('--fresh')
      ctx.showSystem('Building Google Workspace dashboard...')
      const result = await gwsDashboard({ fresh })

      // If the TUI supports dashboard panels, use them
      if (ctx.enterDashboard) {
        ctx.enterDashboard(result.panels)
      } else {
        // Fallback to text display
        ctx.showSystem(result.formatted)
      }
      return true
    }

    case 'search': {
      const query = subArgs.join(' ')
      if (!query) {
        ctx.showError('Usage: /gws search <query>')
        return true
      }
      ctx.showSystem(`Searching Google Workspace for "${query}"...`)
      const result = await gwsSearch(query)
      ctx.showSystem(result.formatted)
      return true
    }

    // ── Help ────────────────────────────────────────────
    case 'help':
    default: {
      ctx.showSystem(GWS_HELP)
      return true
    }
  }
}

// ─── Help Text ──────────────────────────────────────────────

const GWS_HELP = `
=== Google Workspace Commands ===

Auth:
  /gws setup               First-time setup (auto, falls back to guided)
  /gws setup-guide         Guided setup: enable APIs via gcloud + OAuth instructions
  /gws check               Check if client_secret.json is in place
  /gws login [scopes]      Connect (e.g. gmail,calendar,drive)
  /gws status              Connection status
  /gws logout              Disconnect
  /gws refresh             Clear cache

Gmail:
  /gws emails              List inbox emails
  /gws gmail read <id>     Read specific email
  /gws gmail send --to <email> --subject <text> --body <text>

Calendar:
  /gws calendar            List today's events
  /gws calendar add --summary <text> --start <dt> --end <dt>

Drive:
  /gws drive [folderId]    List files
  /gws drive search <query>

Composite:
  /gws briefing            Gmail + Calendar + Drive summary
  /gws dashboard           Multi-panel overview
  /gws search <query>      Search across Gmail and Drive

Flags: --fresh (skip cache), --top N (limit)
=================================
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
