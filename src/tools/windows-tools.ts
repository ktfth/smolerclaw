/**
 * Windows-specific tool schemas and registration.
 */
import type Anthropic from '@anthropic-ai/sdk'

// ─── Windows / Business Tools (added at runtime if on Windows) ──

export const WINDOWS_TOOLS: Anthropic.Tool[] = [
  {
    name: 'open_application',
    description:
      'Open a Windows application by name. Available apps: excel, word, powerpoint, outlook, ' +
      'onenote, teams, edge, chrome, firefox, calculator, notepad, terminal, explorer, ' +
      'vscode, cursor, paint, snip, settings, taskmanager.',
    input_schema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'App name (e.g. "excel", "outlook", "teams")' },
        argument: { type: 'string', description: 'Optional argument (e.g. file path to open in the app)' },
      },
      required: ['name'],
    },
  },
  {
    name: 'open_file_default',
    description:
      'Open a file with its default Windows application. E.g. .xlsx opens in Excel, .pdf in the PDF reader.',
    input_schema: {
      type: 'object' as const,
      properties: {
        path: { type: 'string', description: 'File path to open' },
      },
      required: ['path'],
    },
  },
  {
    name: 'open_url_browser',
    description: 'Open a URL in the default web browser.',
    input_schema: {
      type: 'object' as const,
      properties: {
        url: { type: 'string', description: 'URL to open' },
      },
      required: ['url'],
    },
  },
  {
    name: 'get_running_apps',
    description: 'List currently running Windows applications with memory usage. Read-only, non-destructive.',
    input_schema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  },
  {
    name: 'get_system_info',
    description: 'Get Windows system resource summary: CPU, RAM, disk, uptime, battery. Read-only.',
    input_schema: {
      type: 'object' as const,
      properties: {},
      required: [],
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
  {
    name: 'get_news',
    description:
      'Fetch current news headlines. Categories: business, tech, finance, brazil, world, security. ' +
      'Returns headlines grouped by category with source attribution.',
    input_schema: {
      type: 'object' as const,
      properties: {
        category: {
          type: 'string',
          description: 'News category to filter. Omit for all categories.',
          enum: ['business', 'tech', 'finance', 'brazil', 'world', 'security'],
        },
      },
      required: [],
    },
  },
]

// ─── Windows Agent Tools (Windows-only) ─────────────────

export const AGENT_TOOLS: Anthropic.Tool[] = [
  {
    name: 'execute_powershell_script',
    description:
      'Execute a PowerShell script on the local machine. The script runs in a temp .ps1 file with -ExecutionPolicy Bypass (scoped). ' +
      'Safety guards block dangerous operations (Defender, System32, formatting). ' +
      'Returns stdout, stderr, exit code, and duration. ' +
      'Use for: automation, system queries, batch operations, registry reads, scheduled tasks.',
    input_schema: {
      type: 'object' as const,
      properties: {
        script: {
          type: 'string',
          description: 'The PowerShell script to execute. Multi-line supported.',
        },
      },
      required: ['script'],
    },
  },
  {
    name: 'analyze_screen_context',
    description:
      'Get detailed information about the user\'s current screen: foreground window (what they are looking at), ' +
      'all visible windows with PIDs, memory usage, and titles. Use to understand the user\'s current context. Read-only.',
    input_schema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  },
  {
    name: 'read_clipboard_content',
    description:
      'Read the current clipboard content. Auto-detects text or image. ' +
      'For images, performs OCR using Windows.Media.Ocr to extract text. ' +
      'Use when the user says "le o que copiei", "o que tem no clipboard", "cola isso", etc. Read-only.',
    input_schema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  },
]

// ─── Notification Tools (Windows-only) ───────────────────

export const NOTIFICATION_TOOLS: Anthropic.Tool[] = [
  {
    name: 'send_notification',
    description:
      'Send a Windows toast notification to the user. Displays a system notification with title and message. ' +
      'Use when you need to alert the user about: task completions, reminders, important events, ' +
      'or when the user asks "me avisa quando terminar", "notifica quando...", etc.',
    input_schema: {
      type: 'object' as const,
      properties: {
        title: {
          type: 'string',
          description: 'Notification title (short, max ~50 chars).',
        },
        message: {
          type: 'string',
          description: 'Notification message/body.',
        },
      },
      required: ['title', 'message'],
    },
  },
]

/** get_news tool definition (cross-platform, extracted for reference by name) */
export const NEWS_TOOL = WINDOWS_TOOLS.find((t) => t.name === 'get_news')!
