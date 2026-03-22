import {
  existsSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  statSync,
  realpathSync,
} from 'node:fs'
import { resolve, relative, join, sep, dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import type Anthropic from '@anthropic-ai/sdk'
import { getShell, hasRipgrep, shouldExclude, SEARCH_EXCLUDES, IS_WINDOWS } from './platform'
import { UndoStack } from './undo'
import { type Plugin, executePlugin } from './plugins'
import { openApp, openFile, openUrl, getRunningApps, getSystemInfo, getOutlookEvents } from './windows'
import { fetchNews, type NewsCategory } from './news'
import { addTask, completeTask, listTasks, formatTaskList, parseTime } from './tasks'
import { saveMemo, searchMemos, listMemos, deleteMemo, formatMemoList, formatMemoDetail } from './memos'
import { openEmailDraft, formatDraftPreview, type EmailDraft } from './email'
import {
  addPerson, findPerson, listPeople, updatePerson, removePerson,
  logInteraction, getInteractions, delegateTask, updateDelegation,
  getDelegations, getPendingFollowUps, markFollowUpDone,
  formatPeopleList, formatPersonDetail, formatDelegationList, formatFollowUps,
  generatePeopleDashboard,
  type PersonGroup, type InteractionType,
} from './people'

// Global undo stack shared across tool calls
export const undoStack = new UndoStack()

// Registered plugins (set from index.ts at startup)
let _plugins: Plugin[] = []
export function registerPlugins(plugins: Plugin[]): void {
  _plugins = plugins
}

// ─── Tool Definitions ────────────────────────────────────────

export const TOOLS: Anthropic.Tool[] = [
  {
    name: 'read_file',
    description:
      'Read file contents. For large files, use offset/limit to read specific line ranges.',
    input_schema: {
      type: 'object' as const,
      properties: {
        path: { type: 'string', description: 'File path (relative or absolute)' },
        offset: {
          type: 'number',
          description: 'Start reading from this line number (1-based). Optional.',
        },
        limit: {
          type: 'number',
          description: 'Max lines to read. Optional, defaults to 500.',
        },
      },
      required: ['path'],
    },
  },
  {
    name: 'write_file',
    description: 'Create a new file or completely overwrite an existing file.',
    input_schema: {
      type: 'object' as const,
      properties: {
        path: { type: 'string', description: 'File path to write' },
        content: { type: 'string', description: 'Full file content' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'edit_file',
    description:
      'Make a precise edit to a file. Finds old_text and replaces it with new_text. ' +
      'The old_text must match exactly (including whitespace). ' +
      'Use this instead of write_file when modifying existing files — it preserves the rest of the file.',
    input_schema: {
      type: 'object' as const,
      properties: {
        path: { type: 'string', description: 'File path to edit' },
        old_text: {
          type: 'string',
          description: 'Exact text to find (must be unique in the file)',
        },
        new_text: { type: 'string', description: 'Replacement text' },
      },
      required: ['path', 'old_text', 'new_text'],
    },
  },
  {
    name: 'search_files',
    description:
      'Search file contents using a regex pattern (like grep). ' +
      'Returns matching lines with file paths and line numbers.',
    input_schema: {
      type: 'object' as const,
      properties: {
        pattern: { type: 'string', description: 'Regex pattern to search for' },
        path: {
          type: 'string',
          description: 'Directory to search in. Defaults to cwd.',
        },
        include: {
          type: 'string',
          description: 'Glob pattern to filter files, e.g. "*.ts" or "*.py"',
        },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'find_files',
    description:
      'Find files by name pattern (glob). Returns matching file paths.',
    input_schema: {
      type: 'object' as const,
      properties: {
        pattern: {
          type: 'string',
          description: 'Glob pattern, e.g. "**/*.ts", "src/**/test*"',
        },
        path: { type: 'string', description: 'Base directory. Defaults to cwd.' },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'list_directory',
    description: 'List files and directories with type indicators and sizes.',
    input_schema: {
      type: 'object' as const,
      properties: {
        path: { type: 'string', description: 'Directory to list. Defaults to cwd.' },
      },
      required: [],
    },
  },
  {
    name: 'run_command',
    description:
      'Run a shell command. Use for: git operations, running tests, installing packages, ' +
      'building projects, or any CLI task. Commands run in the current working directory.',
    input_schema: {
      type: 'object' as const,
      properties: {
        command: { type: 'string', description: 'Shell command to execute' },
        timeout: {
          type: 'number',
          description: 'Timeout in seconds. Default 30, max 120.',
        },
      },
      required: ['command'],
    },
  },
  {
    name: 'fetch_url',
    description:
      'Fetch the content of a URL. Use for: reading documentation, checking APIs, ' +
      'downloading config files, or verifying endpoints. Returns the response body as text. ' +
      'For HTML pages, returns a text-only extraction (no tags).',
    input_schema: {
      type: 'object' as const,
      properties: {
        url: { type: 'string', description: 'The URL to fetch' },
        method: {
          type: 'string',
          description: 'HTTP method. Default GET.',
          enum: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD'],
        },
        headers: {
          type: 'object',
          description: 'Optional request headers as key-value pairs.',
        },
        body: {
          type: 'string',
          description: 'Optional request body (for POST/PUT/PATCH).',
        },
      },
      required: ['url'],
    },
  },
]

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
      'Fetch current news headlines. Categories: business, tech, finance, brazil, world. ' +
      'Returns headlines grouped by category with source attribution.',
    input_schema: {
      type: 'object' as const,
      properties: {
        category: {
          type: 'string',
          description: 'News category to filter. Omit for all categories.',
          enum: ['business', 'tech', 'finance', 'brazil', 'world'],
        },
      },
      required: [],
    },
  },
]

// ─── Task/Reminder Tools (cross-platform) ──────────────────

export const TASK_TOOLS: Anthropic.Tool[] = [
  {
    name: 'create_task',
    description:
      'Create a task or reminder for the user. If a time is provided, a notification ' +
      'will fire at that time. Supports natural-language times like "18h", "em 30 minutos", "amanha 9h".',
    input_schema: {
      type: 'object' as const,
      properties: {
        title: { type: 'string', description: 'Task description (e.g. "buscar pao")' },
        time: { type: 'string', description: 'When to remind. E.g. "18h", "18:30", "em 30 minutos", "amanha 9h". Optional.' },
      },
      required: ['title'],
    },
  },
  {
    name: 'complete_task',
    description: 'Mark a task as done by its ID or partial title match.',
    input_schema: {
      type: 'object' as const,
      properties: {
        reference: { type: 'string', description: 'Task ID or partial title to match' },
      },
      required: ['reference'],
    },
  },
  {
    name: 'list_tasks',
    description: 'List all pending tasks and reminders. Shows title, due time, and ID.',
    input_schema: {
      type: 'object' as const,
      properties: {
        show_done: { type: 'boolean', description: 'Include completed tasks. Default false.' },
      },
      required: [],
    },
  },
]

// ─── People Management Tools (cross-platform) ──────────────

export const PEOPLE_TOOLS: Anthropic.Tool[] = [
  {
    name: 'add_person',
    description:
      'Register a person (team member, family, or contact). ' +
      'Groups: equipe (work team), familia (family/home), contato (other contacts).',
    input_schema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'Person name' },
        group: { type: 'string', enum: ['equipe', 'familia', 'contato'], description: 'Group: equipe, familia, or contato' },
        role: { type: 'string', description: 'Role or relationship (e.g. "dev frontend", "esposa", "fornecedor"). Optional.' },
        contact: { type: 'string', description: 'Phone, email, or other contact info. Optional.' },
      },
      required: ['name', 'group'],
    },
  },
  {
    name: 'find_person_info',
    description:
      'Look up a person by name or ID. Returns their profile, recent interactions, and pending delegated tasks.',
    input_schema: {
      type: 'object' as const,
      properties: {
        name_or_id: { type: 'string', description: 'Person name (partial match) or ID' },
      },
      required: ['name_or_id'],
    },
  },
  {
    name: 'list_people',
    description: 'List all registered people, optionally filtered by group.',
    input_schema: {
      type: 'object' as const,
      properties: {
        group: { type: 'string', enum: ['equipe', 'familia', 'contato'], description: 'Filter by group. Optional.' },
      },
      required: [],
    },
  },
  {
    name: 'log_interaction',
    description:
      'Log an interaction with a person. Types: conversa, email, reuniao, ligacao, mensagem, delegacao, entrega, outro. ' +
      'Optionally set a follow-up date for a reminder.',
    input_schema: {
      type: 'object' as const,
      properties: {
        person: { type: 'string', description: 'Person name or ID' },
        type: { type: 'string', enum: ['conversa', 'email', 'reuniao', 'ligacao', 'mensagem', 'delegacao', 'entrega', 'outro'], description: 'Interaction type' },
        summary: { type: 'string', description: 'What was discussed or happened' },
        follow_up: { type: 'string', description: 'When to follow up (e.g. "em 3 dias", "amanha", "25/03"). Optional.' },
      },
      required: ['person', 'type', 'summary'],
    },
  },
  {
    name: 'delegate_to_person',
    description:
      'Delegate/assign a task to a person with optional due date. ' +
      'Use to track what you asked someone to do.',
    input_schema: {
      type: 'object' as const,
      properties: {
        person: { type: 'string', description: 'Person name or ID' },
        task: { type: 'string', description: 'What they need to do' },
        due_date: { type: 'string', description: 'Due date (e.g. "sexta", "em 3 dias", "28/03"). Optional.' },
      },
      required: ['person', 'task'],
    },
  },
  {
    name: 'update_delegation_status',
    description: 'Update the status of a delegated task. Statuses: pendente, em_andamento, concluido.',
    input_schema: {
      type: 'object' as const,
      properties: {
        delegation_id: { type: 'string', description: 'Delegation ID' },
        status: { type: 'string', enum: ['pendente', 'em_andamento', 'concluido'], description: 'New status' },
        notes: { type: 'string', description: 'Optional notes about the update' },
      },
      required: ['delegation_id', 'status'],
    },
  },
  {
    name: 'get_people_dashboard',
    description:
      'Show the people management dashboard: summary of team/family/contacts, ' +
      'overdue follow-ups, overdue delegations, and recent interactions.',
    input_schema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  },
]

// ─── Memo Tools (cross-platform) ────────────────────────────

export const MEMO_TOOLS: Anthropic.Tool[] = [
  {
    name: 'save_memo',
    description:
      'Save a note/memo to the user\'s personal knowledge base. ' +
      'Use #hashtags in the content to auto-tag. ' +
      'Use when the user says "anota", "lembra disso", "salva isso", or shares important information.',
    input_schema: {
      type: 'object' as const,
      properties: {
        content: { type: 'string', description: 'The memo content. Use #tags for categorization.' },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional additional tags (without #). Auto-extracted #tags from content are always included.',
        },
      },
      required: ['content'],
    },
  },
  {
    name: 'search_memos',
    description:
      'Search the user\'s memos by keyword or tag. ' +
      'Use #tag to search by tag only. Use plain text for content search. ' +
      'Use when the user asks "o que eu anotei sobre...", "qual era aquela nota...", etc.',
    input_schema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'Search query. Use #tag for tag search, or plain text for content search.' },
      },
      required: ['query'],
    },
  },
]

// ─── Email Tool (cross-platform) ────────────────────────────

export const EMAIL_TOOL: Anthropic.Tool = {
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
}

/** get_news tool definition (cross-platform, extracted for reference by name) */
const NEWS_TOOL = WINDOWS_TOOLS.find((t) => t.name === 'get_news')!

let _windowsToolsRegistered = false

/** Register Windows tools and task tools. Idempotent. */
export function registerWindowsTools(): void {
  if (_windowsToolsRegistered) return
  _windowsToolsRegistered = true

  if (IS_WINDOWS) {
    TOOLS.push(...WINDOWS_TOOLS)
  } else {
    // Add get_news on all platforms (it's network-only)
    TOOLS.push(NEWS_TOOL)
  }

  // Task, people, memo, and email tools are cross-platform
  TOOLS.push(...TASK_TOOLS)
  TOOLS.push(...PEOPLE_TOOLS)
  TOOLS.push(...MEMO_TOOLS)
  TOOLS.push(EMAIL_TOOL)
}

// ─── Tool Execution ──────────────────────────────────────────

const MAX_OUTPUT = 50_000

export async function executeTool(
  name: string,
  input: Record<string, unknown>,
): Promise<string> {
  try {
    switch (name) {
      case 'read_file':
        return toolReadFile(input)
      case 'write_file':
        return toolWriteFile(input)
      case 'edit_file':
        return toolEditFile(input)
      case 'search_files':
        return await toolSearchFiles(input)
      case 'find_files':
        return await toolFindFiles(input)
      case 'list_directory':
        return toolListDirectory(input)
      case 'run_command':
        return await toolRunCommand(input)
      case 'fetch_url':
        return await toolFetchUrl(input)
      // Windows / business tools
      case 'open_application':
        return await openApp(input.name as string, input.argument as string | undefined)
      case 'open_file_default':
        return await openFile(input.path as string)
      case 'open_url_browser':
        return await openUrl(input.url as string)
      case 'get_running_apps':
        return await getRunningApps()
      case 'get_system_info':
        return await getSystemInfo()
      case 'get_calendar_events':
        return await getOutlookEvents()
      case 'get_news': {
        const cat = input.category as NewsCategory | undefined
        return await fetchNews(cat ? [cat] : undefined)
      }
      // Task/reminder tools
      case 'create_task': {
        const title = input.title as string
        if (!title?.trim()) return 'Error: title is required.'
        const timeStr = input.time as string | undefined
        const dueTime = timeStr ? parseTime(timeStr) : undefined
        const task = addTask(title, dueTime || undefined)
        const dueInfo = dueTime
          ? ` — lembrete: ${dueTime.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`
          : ''
        return `Tarefa criada: "${task.title}"${dueInfo}  [${task.id}]`
      }
      case 'complete_task': {
        const ref = input.reference as string
        if (!ref?.trim()) return 'Error: reference is required.'
        const task = completeTask(ref)
        return task ? `Concluida: "${task.title}"` : `Tarefa nao encontrada: "${ref}"`
      }
      case 'list_tasks': {
        const showDone = (input.show_done as boolean) || false
        const tasks = listTasks(showDone)
        return formatTaskList(tasks)
      }
      // People management tools
      case 'add_person': {
        const name = input.name as string
        if (!name?.trim()) return 'Error: name is required.'
        const group = input.group as PersonGroup
        const validGroups: PersonGroup[] = ['equipe', 'familia', 'contato']
        if (!validGroups.includes(group)) return 'Error: group must be equipe, familia, or contato.'
        const person = addPerson(name, group, input.role as string, input.contact as string)
        return `Pessoa adicionada: ${person.name} (${group}) [${person.id}]`
      }
      case 'find_person_info': {
        const ref = input.name_or_id as string
        if (!ref?.trim()) return 'Error: name_or_id is required.'
        const person = findPerson(ref)
        if (!person) return `Pessoa nao encontrada: "${ref}"`
        return formatPersonDetail(person)
      }
      case 'list_people': {
        const group = input.group as PersonGroup | undefined
        const people = listPeople(group)
        return formatPeopleList(people)
      }
      case 'log_interaction': {
        const personRef = input.person as string
        if (!personRef?.trim()) return 'Error: person is required.'
        const type = input.type as InteractionType
        const summary = input.summary as string
        if (!summary?.trim()) return 'Error: summary is required.'
        const followUpStr = input.follow_up as string | undefined
        const followUpDate = followUpStr ? parseFuzzyDate(followUpStr) : undefined
        const interaction = logInteraction(personRef, type, summary, followUpDate || undefined)
        if (!interaction) return `Pessoa nao encontrada: "${personRef}"`
        const fuMsg = followUpDate ? ` — follow-up: ${followUpDate.toLocaleDateString('pt-BR')}` : ''
        return `Interacao registrada: ${type} com ${personRef}${fuMsg}`
      }
      case 'delegate_to_person': {
        const personRef = input.person as string
        if (!personRef?.trim()) return 'Error: person is required.'
        const task = input.task as string
        if (!task?.trim()) return 'Error: task is required.'
        const dueDateStr = input.due_date as string | undefined
        const dueDate = dueDateStr ? parseFuzzyDate(dueDateStr) : undefined
        const delegation = delegateTask(personRef, task, dueDate || undefined)
        if (!delegation) return `Pessoa nao encontrada: "${personRef}"`
        const dueMsg = dueDate ? ` — prazo: ${dueDate.toLocaleDateString('pt-BR')}` : ''
        return `Tarefa delegada para ${personRef}: "${task}"${dueMsg} [${delegation.id}]`
      }
      case 'update_delegation_status': {
        const id = input.delegation_id as string
        if (!id?.trim()) return 'Error: delegation_id is required.'
        const status = input.status as 'pendente' | 'em_andamento' | 'concluido'
        const result = updateDelegation(id, status, input.notes as string)
        if (!result) return `Delegacao nao encontrada: "${id}"`
        return `Delegacao atualizada: "${result.task}" -> ${status}`
      }
      case 'get_people_dashboard':
        return generatePeopleDashboard()
      // Memo tools
      case 'save_memo': {
        const content = input.content as string
        if (!content?.trim()) return 'Error: content is required.'
        const tags = (input.tags as string[]) || []
        const memo = saveMemo(content, tags)
        const tagStr = memo.tags.length > 0 ? ` [${memo.tags.map((t) => '#' + t).join(' ')}]` : ''
        return `Memo salvo${tagStr}  {${memo.id}}`
      }
      case 'search_memos': {
        const query = input.query as string
        if (!query?.trim()) return formatMemoList(listMemos())
        const results = searchMemos(query)
        return formatMemoList(results)
      }
      // Email tool
      case 'draft_email': {
        const to = input.to as string
        const subject = input.subject as string
        const body = input.body as string
        if (!to?.trim() || !subject?.trim() || !body?.trim()) {
          return 'Error: to, subject, and body are required.'
        }
        const draft: EmailDraft = { to, subject, body, cc: input.cc as string }
        const preview = formatDraftPreview(draft)
        const result = await openEmailDraft(draft)
        return `${preview}\n\n${result}`
      }
      default: {
        // Check plugins
        const plugin = _plugins.find((p) => p.name === name)
        if (plugin) return await executePlugin(plugin, input)
        return `Error: unknown tool "${name}"`
      }
    }
  } catch (err) {
    return `Error: ${err instanceof Error ? err.message : String(err)}`
  }
}

// ─── Security ───────────────────────────────────────────────

const MAX_FILE_SIZE = 10 * 1024 * 1024 // 10 MB

/**
 * Atomic write: write to temp file then rename.
 * Prevents corruption from crash/power loss mid-write.
 */
function atomicWrite(filePath: string, content: string): void {
  const tmp = join(dirname(filePath), `.tinyclaw-${randomUUID().slice(0, 8)}.tmp`)
  writeFileSync(tmp, content)
  renameSync(tmp, filePath)
}

function guardPath(filePath: string): string | null {
  const resolved = resolve(filePath)
  const cwd = process.cwd()
  if (resolved !== cwd && !resolved.startsWith(cwd + sep)) {
    return `Error: path outside working directory is not permitted: ${resolved}`
  }
  // Follow symlinks and re-check containment
  try {
    if (existsSync(resolved)) {
      const real = realpathSync(resolved)
      if (real !== cwd && !real.startsWith(cwd + sep)) {
        return `Error: symlink target is outside working directory: ${real}`
      }
    }
  } catch {
    // File doesn't exist yet (write_file creating new file) — that's OK
  }
  return null
}

/** Validate that a required string input is present and non-empty */
function requireString(input: Record<string, unknown>, key: string): string | null {
  const val = input[key]
  if (typeof val !== 'string' || val.trim().length === 0) {
    return `Error: '${key}' is required and must be a non-empty string.`
  }
  return null
}

// ─── Implementations ─────────────────────────────────────────

function toolReadFile(input: Record<string, unknown>): string {
  const pathValErr = requireString(input, 'path')
  if (pathValErr) return pathValErr
  const path = resolve(input.path as string)
  const pathErr = guardPath(path)
  if (pathErr) return pathErr
  if (!existsSync(path)) return `Error: file not found: ${path}`

  // Check file size before reading
  const size = statSync(path).size
  if (size > MAX_FILE_SIZE) {
    return `Error: file too large (${formatSize(size)}). Max is ${formatSize(MAX_FILE_SIZE)}.`
  }

  const content = readFileSync(path, 'utf-8')
  const lines = content.split('\n')
  const offset = Math.max(1, (input.offset as number) || 1)
  const limit = Math.min(2000, (input.limit as number) || 500)

  const slice = lines.slice(offset - 1, offset - 1 + limit)
  const numbered = slice.map((l, i) => `${String(offset + i).padStart(4)}  ${l}`)

  let result = numbered.join('\n')
  const remaining = lines.length - (offset - 1 + limit)
  if (remaining > 0) {
    result += `\n... (${remaining} more lines, total ${lines.length})`
  }
  return truncate(result)
}

function toolWriteFile(input: Record<string, unknown>): string {
  const pathValErr = requireString(input, 'path')
  if (pathValErr) return pathValErr
  const path = resolve(input.path as string)
  const pathErr = guardPath(path)
  if (pathErr) return pathErr
  const content = input.content as string
  const existed = existsSync(path)
  undoStack.saveState(path)
  atomicWrite(path, content)
  const lines = content.split('\n').length
  return `${existed ? 'Updated' : 'Created'}: ${path} (${lines} lines)`
}

function toolEditFile(input: Record<string, unknown>): string {
  const pathValErr = requireString(input, 'path')
  if (pathValErr) return pathValErr
  const path = resolve(input.path as string)
  const pathErr = guardPath(path)
  if (pathErr) return pathErr
  if (!existsSync(path)) return `Error: file not found: ${path}`

  const content = readFileSync(path, 'utf-8')
  const oldText = input.old_text as string
  const newText = input.new_text as string

  const count = content.split(oldText).length - 1
  if (count === 0) {
    return 'Error: old_text not found in file. Make sure it matches exactly, including whitespace and indentation.'
  }
  if (count > 1) {
    return `Error: old_text found ${count} times. It must be unique. Include more surrounding context.`
  }

  undoStack.saveState(path)
  // Use split/join instead of String.replace to avoid $& back-reference issues
  const updated = content.split(oldText).join(newText)
  atomicWrite(path, updated)

  const oldLines = oldText.split('\n').length
  const newLines = newText.split('\n').length
  return `Edited: ${path} (replaced ${oldLines} lines with ${newLines} lines)`
}

// ─── search_files: ripgrep → pure-Bun fallback ─────────────

async function toolSearchFiles(input: Record<string, unknown>): Promise<string> {
  const patternErr = requireString(input, 'pattern')
  if (patternErr) return patternErr
  const pattern = input.pattern as string
  const dir = resolve((input.path as string) || '.')
  const pathErr = guardPath(dir)
  if (pathErr) return pathErr
  const include = input.include as string | undefined

  if (await hasRipgrep()) {
    return searchWithRipgrep(pattern, dir, include)
  }
  return searchWithBun(pattern, dir, include)
}

async function searchWithRipgrep(
  pattern: string,
  dir: string,
  include?: string,
): Promise<string> {
  const args = ['rg', '--no-heading', '--line-number', '--color=never']
  if (include) args.push('--glob', include)
  for (const ex of SEARCH_EXCLUDES) {
    args.push('--glob', `!${ex}`)
  }
  args.push('-e', pattern, dir)

  const proc = Bun.spawn(args, { stdout: 'pipe', stderr: 'pipe' })
  const stdout = await new Response(proc.stdout).text()
  const stderr = await new Response(proc.stderr).text()
  await proc.exited

  if (!stdout.trim() && !stderr.trim()) return 'No matches found.'
  if (stderr.trim() && !stdout.trim()) return `Error: ${stderr.trim()}`

  return formatSearchResults(stdout, dir)
}

async function searchWithBun(
  pattern: string,
  dir: string,
  include?: string,
): Promise<string> {
  let regex: RegExp
  try {
    regex = new RegExp(pattern)
  } catch (err) {
    return `Error: invalid regex pattern: ${err instanceof Error ? err.message : pattern}`
  }
  const fileGlob = include || '**/*'
  const glob = new Bun.Glob(fileGlob)
  const results: string[] = []
  let fileCount = 0
  const MAX_FILES = 5000

  for await (const entry of glob.scan({ cwd: dir, onlyFiles: true })) {
    if (shouldExclude(entry)) continue
    if (++fileCount > MAX_FILES) {
      results.push(`... (stopped after scanning ${MAX_FILES} files)`)
      break
    }

    const fullPath = join(dir, entry)
    try {
      const content = readFileSync(fullPath, 'utf-8')
      const lines = content.split('\n')
      for (let i = 0; i < lines.length; i++) {
        if (regex.test(lines[i])) {
          results.push(`${entry}:${i + 1}:${lines[i]}`)
          if (results.length >= 100) break
        }
      }
    } catch {
      // Skip binary or unreadable files
    }
    if (results.length >= 100) break
  }

  if (results.length === 0) return 'No matches found.'

  let result = results.slice(0, 100).join('\n')
  if (results.length > 100) {
    result += `\n... (showing first 100 matches)`
  }
  return truncate(result)
}

// ─── find_files: Bun.Glob (cross-platform) ─────────────────

async function toolFindFiles(input: Record<string, unknown>): Promise<string> {
  const patternErr = requireString(input, 'pattern')
  if (patternErr) return patternErr
  const pattern = input.pattern as string
  const dir = resolve((input.path as string) || '.')
  const pathErr = guardPath(dir)
  if (pathErr) return pathErr

  const glob = new Bun.Glob(pattern)
  const matches: string[] = []

  for await (const entry of glob.scan({ cwd: dir, onlyFiles: true })) {
    if (shouldExclude(entry)) continue
    matches.push(entry)
    if (matches.length >= 200) break
  }

  if (matches.length === 0) return 'No files found.'

  let result = matches.join('\n')
  if (matches.length >= 200) {
    result += '\n... (showing first 200 files)'
  }
  return result
}

// ─── list_directory ─────────────────────────────────────────

function toolListDirectory(input: Record<string, unknown>): string {
  const dir = resolve((input.path as string) || '.')
  const pathErr = guardPath(dir)
  if (pathErr) return pathErr
  if (!existsSync(dir)) return `Error: not found: ${dir}`

  const entries = readdirSync(dir, { withFileTypes: true })
  const lines = entries
    .sort((a, b) => {
      if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1
      return a.name.localeCompare(b.name)
    })
    .map((e) => {
      if (e.isDirectory()) return `d  ${e.name}/`
      try {
        const stat = statSync(join(dir, e.name))
        const size = formatSize(stat.size)
        return `f  ${e.name}  ${size}`
      } catch {
        return `f  ${e.name}`
      }
    })

  return lines.join('\n')
}

// ─── run_command: cross-platform shell ──────────────────────

async function toolRunCommand(input: Record<string, unknown>): Promise<string> {
  const cmdErr = requireString(input, 'command')
  if (cmdErr) return cmdErr
  const cmd = input.command as string
  const timeoutSec = Math.min(120, Math.max(5, (input.timeout as number) || 30))

  const shell = getShell()
  const proc = Bun.spawn([...shell, cmd], {
    stdout: 'pipe',
    stderr: 'pipe',
    cwd: process.cwd(),
  })

  const timer = setTimeout(() => proc.kill(), timeoutSec * 1000)
  // Drain both pipes concurrently to avoid deadlock (HIGH-1 fix)
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  const exitCode = await proc.exited
  clearTimeout(timer)

  let result = ''
  if (stdout.trim()) result += stdout.trim()
  if (stderr.trim()) {
    result += (result ? '\n' : '') + 'STDERR:\n' + stderr.trim()
  }
  if (exitCode !== 0) {
    result += (result ? '\n' : '') + `Exit code: ${exitCode}`
  }

  return truncate(result || '(no output)')
}

// ─── fetch_url: HTTP client ─────────────────────────────────

async function toolFetchUrl(input: Record<string, unknown>): Promise<string> {
  const url = input.url as string
  const method = (input.method as string) || 'GET'
  const headers = (input.headers as Record<string, string>) || {}
  const body = input.body as string | undefined

  // URL validation
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    return 'Error: URL must start with http:// or https://'
  }

  // SSRF protection: block private/internal hostnames
  const ssrfErr = checkSsrf(url)
  if (ssrfErr) return ssrfErr

  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 30_000)

    const resp = await fetch(url, {
      method,
      redirect: 'manual', // prevent redirect-based SSRF
      headers: {
        'User-Agent': 'tinyclaw/1.0',
        'Accept': 'text/html, application/json, text/plain, */*',
        ...headers,
      },
      body: body && method !== 'GET' && method !== 'HEAD' ? body : undefined,
      signal: controller.signal,
    })
    clearTimeout(timeout)

    // Handle redirects manually (max 5 hops, re-check SSRF on each)
    if (resp.status >= 300 && resp.status < 400) {
      const location = resp.headers.get('location')
      if (!location) return `Status: ${resp.status} (redirect with no location header)`
      const redirErr = checkSsrf(location)
      if (redirErr) return `Redirect blocked: ${redirErr}`
      return `Status: ${resp.status} -> Redirect to: ${location}\n(Use fetch_url on the redirect target if needed)`
    }

    const status = `${resp.status} ${resp.statusText}`
    const contentType = resp.headers.get('content-type') || ''

    if (method === 'HEAD') {
      const headerLines = [...resp.headers.entries()]
        .map(([k, v]) => `${k}: ${v}`)
        .join('\n')
      return `Status: ${status}\n${headerLines}`
    }

    // Check content-length before reading body
    const contentLength = resp.headers.get('content-length')
    if (contentLength && Number(contentLength) > MAX_OUTPUT * 2) {
      return `Status: ${status}\n\nError: response body too large (${contentLength} bytes). Max is ${MAX_OUTPUT * 2} bytes.`
    }

    const text = await resp.text()

    // For HTML, extract readable text (strip tags)
    if (contentType.includes('text/html')) {
      const clean = stripHtml(text)
      return truncate(`Status: ${status}\n\n${clean}`)
    }

    return truncate(`Status: ${status}\n\n${text}`)
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      return 'Error: Request timed out after 30 seconds.'
    }
    return `Error: ${err instanceof Error ? err.message : String(err)}`
  }
}

/**
 * Block SSRF: reject URLs pointing to private/internal networks.
 */
function checkSsrf(urlStr: string): string | null {
  try {
    const parsed = new URL(urlStr)
    const host = parsed.hostname.toLowerCase()

    // Block non-HTTP schemes
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return `Error: protocol ${parsed.protocol} is not allowed.`
    }

    // Block private/reserved hostnames
    const blockedHostnames = [
      'localhost', '127.0.0.1', '::1', '0.0.0.0',
      '::ffff:127.0.0.1', '::ffff:0.0.0.0',
    ]
    if (blockedHostnames.includes(host)) {
      return 'Error: requests to localhost are blocked for security.'
    }
    if (host.endsWith('.local') || host.endsWith('.internal')) {
      return 'Error: requests to internal hostnames are blocked.'
    }
    // Block cloud metadata endpoints
    if (host === 'metadata.google.internal' || host === 'metadata.gcp.internal') {
      return 'Error: requests to cloud metadata endpoints are blocked.'
    }

    // Block private IP ranges (decimal notation)
    const parts = host.split('.').map(Number)
    if (parts.length === 4 && parts.every((n) => !isNaN(n) && n >= 0 && n <= 255)) {
      if (parts[0] === 10) return 'Error: requests to private IPs (10.x) are blocked.'
      if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return 'Error: requests to private IPs (172.16-31.x) are blocked.'
      if (parts[0] === 192 && parts[1] === 168) return 'Error: requests to private IPs (192.168.x) are blocked.'
      if (parts[0] === 169 && parts[1] === 254) return 'Error: requests to link-local/metadata IPs are blocked.'
      if (parts[0] === 0) return 'Error: requests to 0.x IPs are blocked.'
    }

    // Block IPv6-mapped IPv4 (::ffff:x.x.x.x)
    if (host.startsWith('::ffff:') || host.startsWith('[::ffff:')) {
      return 'Error: requests to IPv6-mapped IPv4 addresses are blocked.'
    }
  } catch {
    return 'Error: invalid URL.'
  }
  return null
}

/**
 * Strip HTML tags and extract readable text.
 * Simple heuristic — not a full parser.
 */
function stripHtml(html: string): string {
  let text = html
    // Remove script and style blocks
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, '')
    .replace(/<header[^>]*>[\s\S]*?<\/header>/gi, '')
    .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, '')
    // Convert block elements to newlines
    .replace(/<\/(p|div|h[1-6]|li|tr|br|hr)[^>]*>/gi, '\n')
    .replace(/<(br|hr)[^>]*\/?>/gi, '\n')
    // Strip remaining tags
    .replace(/<[^>]+>/g, ' ')
    // Decode common HTML entities
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    // Collapse whitespace
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()

  return text
}

// ─── Helpers ─────────────────────────────────────────────────

function formatSearchResults(stdout: string, baseDir: string): string {
  const cwd = process.cwd()
  const cwdPrefix = cwd + sep
  const baseDirPrefix = baseDir + sep
  const lines = stdout.trim().split('\n')
  const relativized = lines.map((line) => {
    if (line.startsWith(cwdPrefix)) return '.' + line.slice(cwd.length).replace(/\\/g, '/')
    if (line.startsWith(baseDirPrefix)) return '.' + line.slice(baseDir.length).replace(/\\/g, '/')
    return line
  })

  const count = relativized.length
  let result = relativized.slice(0, 100).join('\n')
  if (count > 100) result += `\n... (${count - 100} more matches)`
  return truncate(result)
}

function truncate(s: string): string {
  if (s.length <= MAX_OUTPUT) return s
  return s.slice(0, MAX_OUTPUT) + '\n... (output truncated)'
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}K`
  return `${(bytes / (1024 * 1024)).toFixed(1)}M`
}

/**
 * Parse fuzzy date strings: "amanha", "em 3 dias", "sexta", "28/03", etc.
 */
function parseFuzzyDate(input: string): Date | null {
  const text = input.toLowerCase().trim()
  const now = new Date()

  if (text === 'hoje') return now

  if (text === 'amanha' || text === 'amanhã') {
    const d = new Date(now)
    d.setDate(d.getDate() + 1)
    return d
  }

  // "em X dias"
  const daysMatch = text.match(/em\s+(\d+)\s*dias?/)
  if (daysMatch) {
    const d = new Date(now)
    d.setDate(d.getDate() + parseInt(daysMatch[1]))
    return d
  }

  // "em X semanas"
  const weeksMatch = text.match(/em\s+(\d+)\s*semanas?/)
  if (weeksMatch) {
    const d = new Date(now)
    d.setDate(d.getDate() + parseInt(weeksMatch[1]) * 7)
    return d
  }

  // Day of week: "segunda", "terca", "quarta", "quinta", "sexta", "sabado", "domingo"
  const weekdays: Record<string, number> = {
    domingo: 0, segunda: 1, terca: 2, terça: 2, quarta: 3,
    quinta: 4, sexta: 5, sabado: 6, sábado: 6,
  }
  for (const [name, dayNum] of Object.entries(weekdays)) {
    if (text.includes(name)) {
      const d = new Date(now)
      const diff = (dayNum - d.getDay() + 7) % 7 || 7
      d.setDate(d.getDate() + diff)
      return d
    }
  }

  // "DD/MM" or "DD/MM/YYYY"
  const dateMatch = text.match(/(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\s*/)
  if (dateMatch) {
    const day = parseInt(dateMatch[1])
    const month = parseInt(dateMatch[2]) - 1
    const year = dateMatch[3]
      ? parseInt(dateMatch[3]) + (dateMatch[3].length === 2 ? 2000 : 0)
      : now.getFullYear()
    const d = new Date(year, month, day)
    if (!isNaN(d.getTime())) return d
  }

  // Try parseTime from tasks (handles "18h", "em 30 min", etc.)
  return parseTime(text)
}
