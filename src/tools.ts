import {
  existsSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  statSync,
  realpathSync,
} from 'node:fs'
import { resolve, relative, join, sep } from 'node:path'
import { randomUUID } from 'node:crypto'
import type Anthropic from '@anthropic-ai/sdk'
import {
  atomicWriteFile, getVaultStatus, formatVaultStatus,
  initShadowBackup, performBackup, syncBackupToRemote,
  isVaultInitialized,
} from './vault'
import { getShell, hasRipgrep, shouldExclude, SEARCH_EXCLUDES, IS_WINDOWS } from './platform'
import { UndoStack } from './undo'
import { type Plugin, executePlugin } from './plugins'
import { openApp, openFile, openUrl, getRunningApps, getSystemInfo, getOutlookEvents } from './windows'
import { fetchNews, type NewsCategory } from './news'
import { addTask, completeTask, listTasks, formatTaskList, parseTime } from './tasks'
import { saveMemo, searchMemos, listMemos, deleteMemo, formatMemoList, formatMemoDetail } from './memos'
import { openEmailDraft, formatDraftPreview, type EmailDraft } from './email'
import { startPomodoro, stopPomodoro, pomodoroStatus } from './pomodoro'
import { addTransaction, getMonthSummary, getRecentTransactions } from './finance'
import { logDecision, searchDecisions, listDecisions, formatDecisionList, formatDecisionDetail } from './decisions'
import {
  runWorkflow, listWorkflows, getWorkflow, createWorkflow, deleteWorkflow,
  updateWorkflow, duplicateWorkflow, addStepToWorkflow, removeStepFromWorkflow,
  formatWorkflowList, formatWorkflowDetail,
  type WorkflowStep,
} from './workflows'
import {
  openInvestigation, collectEvidence, addFinding, closeInvestigation,
  getInvestigation, listInvestigations, searchInvestigations, generateReport,
  formatInvestigationList, formatInvestigationDetail, formatEvidenceDetail,
  type InvestigationType, type InvestigationStatus, type EvidenceSource,
} from './investigate'
import {
  addPerson, findPerson, listPeople, updatePerson, removePerson,
  logInteraction, getInteractions, delegateTask, updateDelegation,
  getDelegations, getPendingFollowUps, markFollowUpDone,
  formatPeopleList, formatPersonDetail, formatDelegationList, formatFollowUps,
  generatePeopleDashboard,
  type PersonGroup, type InteractionType,
} from './people'
import {
  saveMaterial, searchMaterials, listMaterials, deleteMaterial, updateMaterial,
  getMaterial, formatMaterialList, formatMaterialDetail, formatMaterialCategories,
} from './materials'
import {
  addNewsFeed, removeNewsFeed, disableNewsFeed, enableNewsFeed, listNewsFeeds,
} from './news'
import {
  queryMemory, buildIndex, getIndexStats, formatQueryResults,
  isMemoryInitialized,
} from './memory'
import {
  executePowerShellScript, analyzeScriptSafety, analyzeScreenContext,
  readClipboardContent, type ScriptResult,
} from './windows-agent'
import {
  setActiveProject, getActiveProject, clearActiveProject,
  addProject, getProject, listProjects, removeProject,
  startSession, endSession, getOpenSession,
  addOpportunity, updateOpportunityStatus, listOpportunities, removeOpportunity,
  generateWorkReport, autoDetectProject,
  formatProjectList, formatProjectDetail, formatOpportunityList,
} from './projects'
import {
  benchmark, saveBaseline, resetBaseline,
  compareToBaseline, listBaselines, removeBaseline,
  formatBaselineList,
} from './pitwall'
import {
  buildDependencyGraph, calculateBlastRadius, planRefactor,
  formatBlastRadius, formatRefactorPlan,
} from './services/dependency-graph'
import {
  analyzeTradeoffs, correlateIncident, logIncident,
  listTradeoffs, listIncidents, searchIncidents, searchTradeoffs, getTradeoff,
  formatTradeoffList, formatIncidentList, formatIncidentDetail,
  DEFAULT_CRITERIA,
  type TradeoffContext, type TradeoffOption, type TradeoffCriterion,
} from './services/decision-engine'
import {
  observeEvent, runSelfReflection, updateLivingManual,
  searchLivingManual, generateOptimalUsageTutorial,
  getRecentInsights, getBufferStats,
  formatReflectionResult, formatInsightList,
  type ObservedEvent, type LivingManualEntry,
} from './services/docs-engine'
import {
  analyzeTaskImpact, createPlan, addPlanStep, submitPlanForApproval,
  approvePlan, rejectPlan, canExecute, startExecution, completeStep,
  reportBlockedStep, abandonPlan, getCurrentPlan, getPlanHistory,
  formatPlanAsDraft, formatPlanStatus,
  isAgencyEngineInitialized,
  type PlanStep, type Plan, type ImpactAnalysis,
} from './services/agency-engine'

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

// ─── Tier 2 Tools ───────────────────────────────────────────

export const TIER2_TOOLS: Anthropic.Tool[] = [
  {
    name: 'record_transaction',
    description:
      'Record a financial transaction (income or expense). ' +
      'Use when user mentions spending, receiving money, or financial tracking.',
    input_schema: {
      type: 'object' as const,
      properties: {
        type: { type: 'string', enum: ['entrada', 'saida'], description: 'Transaction type: entrada (income) or saida (expense)' },
        amount: { type: 'number', description: 'Amount in BRL (always positive)' },
        category: { type: 'string', description: 'Category (e.g. alimentacao, transporte, salario, freelance)' },
        description: { type: 'string', description: 'Description of the transaction' },
      },
      required: ['type', 'amount', 'category', 'description'],
    },
  },
  {
    name: 'financial_summary',
    description: 'Show monthly financial summary with income, expenses, and balance by category.',
    input_schema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  },
  {
    name: 'log_decision',
    description:
      'Record an important decision with context and rationale. ' +
      'Use when the user says "decidi", "optei por", "escolhi", or discusses a major choice.',
    input_schema: {
      type: 'object' as const,
      properties: {
        title: { type: 'string', description: 'Decision title (short)' },
        context: { type: 'string', description: 'Why this decision was needed' },
        chosen: { type: 'string', description: 'What was decided' },
        alternatives: { type: 'string', description: 'What was considered but rejected. Optional.' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Tags for categorization. Optional.' },
      },
      required: ['title', 'context', 'chosen'],
    },
  },
  {
    name: 'search_decisions',
    description: 'Search past decisions by keyword or tag.',
    input_schema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'Search query' },
      },
      required: ['query'],
    },
  },
]

// ─── Investigation Tools ─────────────────────────────────────

export const INVESTIGATE_TOOLS: Anthropic.Tool[] = [
  {
    name: 'open_investigation',
    description:
      'Start a new investigation to systematically collect evidence. ' +
      'Types: bug (malfunction), feature (material for building), test (test scenarios), audit (code review), incident (runtime issue). ' +
      'Use when the user says "investiga", "analisa", "diagnostica", "verifica", or needs structured evidence collection.',
    input_schema: {
      type: 'object' as const,
      properties: {
        title: { type: 'string', description: 'Investigation title (short, descriptive)' },
        type: { type: 'string', enum: ['bug', 'feature', 'test', 'audit', 'incident'], description: 'Investigation type' },
        hypothesis: { type: 'string', description: 'Initial theory or goal to investigate. Optional.' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Tags for categorization. Optional.' },
      },
      required: ['title', 'type'],
    },
  },
  {
    name: 'collect_evidence',
    description:
      'Add a piece of evidence to an active investigation. ' +
      'Sources: file (file content), command (command output), log (log entries), diff (code changes), url (web content), observation (manual note). ' +
      'Use after reading files, running commands, or observing behavior to build the investigation record.',
    input_schema: {
      type: 'object' as const,
      properties: {
        investigation: { type: 'string', description: 'Investigation ID or title (partial match)' },
        source: { type: 'string', enum: ['file', 'command', 'log', 'diff', 'url', 'observation'], description: 'Evidence source type' },
        label: { type: 'string', description: 'Short description of this evidence' },
        content: { type: 'string', description: 'The evidence data (file content, command output, observation text, etc.)' },
        path: { type: 'string', description: 'File path or URL associated with this evidence. Optional.' },
      },
      required: ['investigation', 'source', 'label', 'content'],
    },
  },
  {
    name: 'add_finding',
    description:
      'Record a conclusion or insight derived from collected evidence. ' +
      'Severity: critical, high, medium, low, info. ' +
      'Link to evidence IDs that support this finding.',
    input_schema: {
      type: 'object' as const,
      properties: {
        investigation: { type: 'string', description: 'Investigation ID or title' },
        severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low', 'info'], description: 'Finding severity' },
        title: { type: 'string', description: 'Finding title (short)' },
        description: { type: 'string', description: 'Detailed description of the finding' },
        evidence_ids: { type: 'array', items: { type: 'string' }, description: 'IDs of evidence supporting this finding. Optional.' },
      },
      required: ['investigation', 'severity', 'title', 'description'],
    },
  },
  {
    name: 'close_investigation',
    description:
      'Close an investigation with a summary and recommendations. ' +
      'Use after all evidence is collected and findings are recorded.',
    input_schema: {
      type: 'object' as const,
      properties: {
        investigation: { type: 'string', description: 'Investigation ID or title' },
        summary: { type: 'string', description: 'Final summary of the investigation' },
        recommendations: { type: 'string', description: 'Action items and next steps. Optional.' },
      },
      required: ['investigation', 'summary'],
    },
  },
  {
    name: 'investigation_status',
    description:
      'View the current state of an investigation: evidence collected, findings, and progress. ' +
      'Use to check progress or review before closing.',
    input_schema: {
      type: 'object' as const,
      properties: {
        investigation: { type: 'string', description: 'Investigation ID or title' },
      },
      required: ['investigation'],
    },
  },
  {
    name: 'investigation_report',
    description:
      'Generate a full structured report (markdown) for an investigation. ' +
      'Includes all evidence, findings, summary, and recommendations.',
    input_schema: {
      type: 'object' as const,
      properties: {
        investigation: { type: 'string', description: 'Investigation ID or title' },
      },
      required: ['investigation'],
    },
  },
  {
    name: 'list_investigations',
    description:
      'List all investigations, optionally filtered by status or type.',
    input_schema: {
      type: 'object' as const,
      properties: {
        status: { type: 'string', enum: ['aberta', 'em_andamento', 'concluida', 'arquivada'], description: 'Filter by status. Optional.' },
        type: { type: 'string', enum: ['bug', 'feature', 'test', 'audit', 'incident'], description: 'Filter by type. Optional.' },
        query: { type: 'string', description: 'Search by keyword. Optional.' },
      },
      required: [],
    },
  },
]

// ─── Material Tools (cross-platform) ──────────────────────

export const MATERIAL_TOOLS: Anthropic.Tool[] = [
  {
    name: 'save_material',
    description:
      'Save reference material to the assistant\'s persistent knowledge base. ' +
      'Materials are categorized documents, guides, procedures, or reference info that persists across sessions. ' +
      'Use when the user says "salva esse material", "guarda essa referencia", "adiciona ao conhecimento", etc. ' +
      'Categories: procedimento, referencia, guia, template, contato, projeto, tecnico, geral.',
    input_schema: {
      type: 'object' as const,
      properties: {
        title: { type: 'string', description: 'Title of the material' },
        content: { type: 'string', description: 'Full content. Use #tags for categorization.' },
        category: {
          type: 'string',
          description: 'Category (e.g. procedimento, referencia, guia, template, contato, projeto, tecnico, geral). Default: geral.',
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional additional tags (without #).',
        },
      },
      required: ['title', 'content'],
    },
  },
  {
    name: 'search_materials',
    description:
      'Search the assistant\'s material knowledge base by keyword, tag (#tag), or category (@category). ' +
      'Use when answering questions that may be covered by saved materials, or when user asks about reference docs.',
    input_schema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'Search query. Use #tag for tag search, @category for category search, or plain text.' },
      },
      required: ['query'],
    },
  },
  {
    name: 'list_materials',
    description: 'List all saved materials, optionally filtered by category.',
    input_schema: {
      type: 'object' as const,
      properties: {
        category: { type: 'string', description: 'Filter by category. Optional.' },
        limit: { type: 'number', description: 'Max results. Default 30.' },
      },
      required: [],
    },
  },
  {
    name: 'update_material',
    description: 'Update an existing material by ID. Can change title, content, category, or tags.',
    input_schema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'Material ID' },
        title: { type: 'string', description: 'New title. Optional.' },
        content: { type: 'string', description: 'New content. Optional.' },
        category: { type: 'string', description: 'New category. Optional.' },
        tags: { type: 'array', items: { type: 'string' }, description: 'New tags. Optional.' },
      },
      required: ['id'],
    },
  },
  {
    name: 'delete_material',
    description: 'Delete a material by ID.',
    input_schema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'Material ID' },
      },
      required: ['id'],
    },
  },
]

// ─── Vault Tools (cross-platform) ───────────────────────

export const VAULT_TOOLS: Anthropic.Tool[] = [
  {
    name: 'vault_status',
    description:
      'Show the integrity status of all data files: checksum verification, sizes, last backup time. ' +
      'Use when the user asks about data health, backup status, or says "esta tudo salvo?", "meus dados estao seguros?".',
    input_schema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  },
  {
    name: 'vault_backup',
    description:
      'Perform a manual backup of all data to the shadow backup repository. ' +
      'Use when the user says "faz backup", "salva tudo", "sync".',
    input_schema: {
      type: 'object' as const,
      properties: {
        message: { type: 'string', description: 'Optional commit message for the backup.' },
      },
      required: [],
    },
  },
  {
    name: 'sync_cloud_context',
    description:
      'Push the backup to a configured remote repository (if set up). ' +
      'Use when the user says "manda pro cloud", "sync remoto", "push backup".',
    input_schema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  },
  {
    name: 'vault_init_backup',
    description:
      'Initialize the shadow backup system (creates a local git repo for data versioning). ' +
      'Run once to enable automatic backups.',
    input_schema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  },
]

// ─── Project Management Tools (cross-platform) ─────────

export const PROJECT_TOOLS: Anthropic.Tool[] = [
  {
    name: 'set_active_project',
    description:
      'Set which project the assistant should focus on. Auto-detects from the current directory if not registered. ' +
      'Use when the user says "estou trabalhando no projeto X", "muda pro projeto Y", or starts work.',
    input_schema: {
      type: 'object' as const,
      properties: {
        name_or_id: { type: 'string', description: 'Project name, ID, or "auto" to detect from current directory.' },
      },
      required: ['name_or_id'],
    },
  },
  {
    name: 'report_work_progress',
    description:
      'Generate a work progress report with git commits, time tracked, and tasks completed. ' +
      'Outputs a structured Markdown document. ' +
      'Use when the user says "relatorio", "como estou no projeto", "resumo do trabalho", "progress report".',
    input_schema: {
      type: 'object' as const,
      properties: {
        project: { type: 'string', description: 'Project name/ID. Defaults to active project.' },
        period: { type: 'string', enum: ['today', 'week', 'month'], description: 'Report period. Default: today.' },
        lang: { type: 'string', enum: ['pt', 'en'], description: 'Report language. Default: pt.' },
        save_to_file: { type: 'string', description: 'Optional file path to save the report. If omitted, returns as text.' },
      },
      required: [],
    },
  },
  {
    name: 'manage_work_session',
    description:
      'Start or stop a work session timer for time tracking. ' +
      'Use when the user says "comecei a trabalhar", "parei de trabalhar", "timer", etc.',
    input_schema: {
      type: 'object' as const,
      properties: {
        action: { type: 'string', enum: ['start', 'stop', 'status'], description: 'Start, stop, or check session status.' },
        notes: { type: 'string', description: 'Optional notes for the session.' },
      },
      required: ['action'],
    },
  },
  {
    name: 'add_project',
    description:
      'Register a new project for tracking. ' +
      'Use when the user mentions a new project or wants to track a directory.',
    input_schema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'Project name' },
        path: { type: 'string', description: 'Filesystem path to the project root' },
        description: { type: 'string', description: 'Brief project description. Optional.' },
        tech_stack: { type: 'array', items: { type: 'string' }, description: 'Technologies used. Optional.' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Tags for categorization. Optional.' },
      },
      required: ['name', 'path'],
    },
  },
  {
    name: 'list_projects',
    description: 'List all registered projects with their status and tech stack.',
    input_schema: {
      type: 'object' as const,
      properties: {
        active_only: { type: 'boolean', description: 'Show only active projects. Default false.' },
      },
      required: [],
    },
  },
  {
    name: 'fetch_opportunities',
    description:
      'List pending opportunities/tasks filtered by tech stack or priority. ' +
      'Use when the user asks "tem alguma demanda nova?", "oportunidades", "o que tem pra fazer?".',
    input_schema: {
      type: 'object' as const,
      properties: {
        status: { type: 'string', enum: ['nova', 'em_analise', 'aceita', 'recusada', 'concluida'], description: 'Filter by status. Optional.' },
        tech: { type: 'array', items: { type: 'string' }, description: 'Filter by required tech. Optional.' },
      },
      required: [],
    },
  },
  {
    name: 'add_opportunity',
    description:
      'Register a new task/opportunity/demand for tracking. ' +
      'Use when the user mentions a potential project, job lead, or new demand.',
    input_schema: {
      type: 'object' as const,
      properties: {
        title: { type: 'string', description: 'Opportunity title' },
        description: { type: 'string', description: 'Details about the opportunity' },
        source: { type: 'string', description: 'Where this came from (e.g. "LinkedIn", "email", "contato direto")' },
        tech_required: { type: 'array', items: { type: 'string' }, description: 'Technologies required. Optional.' },
        priority: { type: 'string', enum: ['alta', 'media', 'baixa'], description: 'Priority level. Default: media.' },
        deadline: { type: 'string', description: 'Deadline if any (e.g. "30/04", "em 2 semanas"). Optional.' },
      },
      required: ['title', 'description', 'source'],
    },
  },
  {
    name: 'update_opportunity_status',
    description: 'Update the status of an opportunity.',
    input_schema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'Opportunity ID' },
        status: { type: 'string', enum: ['nova', 'em_analise', 'aceita', 'recusada', 'concluida'], description: 'New status' },
      },
      required: ['id', 'status'],
    },
  },
]

// ─── Pit Wall Tools (cross-platform) ────────────────────

export const PITWALL_TOOLS: Anthropic.Tool[] = [
  {
    name: 'pitwall_benchmark',
    description:
      'Benchmark a local script or command — captures wall-clock time, child process peak memory, and CPU overhead. ' +
      'Compares against saved baseline and alerts on regressions > 10%. ' +
      'Use when the user says "benchmark", "mede a performance", "testa a velocidade", "pit wall".',
    input_schema: {
      type: 'object' as const,
      properties: {
        command: { type: 'string', description: 'Shell command to benchmark (e.g. "bun run build", "bun test").' },
        key: { type: 'string', description: 'Unique label for this benchmark. Auto-derived from command if omitted.' },
        iterations: { type: 'number', description: 'Number of runs (uses median). Default 1, max 10.' },
        warmup: { type: 'boolean', description: 'Run one warmup iteration before measuring (discarded). Default false.' },
        cwd: { type: 'string', description: 'Working directory. Defaults to cwd.' },
      },
      required: ['command'],
    },
  },
  {
    name: 'pitwall_save_baseline',
    description:
      'Benchmark a command and save results as the performance baseline for future comparisons. ' +
      'Default: 3 runs with warmup. Use "reset" to replace (not blend) an existing baseline.',
    input_schema: {
      type: 'object' as const,
      properties: {
        command: { type: 'string', description: 'Command to benchmark and save as baseline.' },
        key: { type: 'string', description: 'Benchmark label. Auto-derived from command if omitted.' },
        iterations: { type: 'number', description: 'Number of runs to measure. Default 3.' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Tags for this baseline (e.g. "build", "test").' },
        reset: { type: 'boolean', description: 'If true, replaces existing baseline entirely. Default false (blends).' },
        cwd: { type: 'string', description: 'Working directory. Defaults to cwd.' },
      },
      required: ['command'],
    },
  },
  {
    name: 'pitwall_status',
    description:
      'List all saved performance baselines with their metrics, spread, and age. ' +
      'Use when the user asks "quais baselines tenho?", "pit wall status", "mostra as metricas".',
    input_schema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  },
  {
    name: 'pitwall_remove_baseline',
    description: 'Remove a saved performance baseline by its key.',
    input_schema: {
      type: 'object' as const,
      properties: {
        key: { type: 'string', description: 'The script key of the baseline to remove.' },
      },
      required: ['key'],
    },
  },
]

// ─── Blast Radius Tools (cross-platform) ────────────────

export const BLAST_RADIUS_TOOLS: Anthropic.Tool[] = [
  {
    name: 'analyze_blast_radius',
    description:
      'Analyze the blast radius of changing a TypeScript file — shows all modules that import it (directly and transitively). ' +
      'Use when the user says "blast radius", "impacto da mudanca", "quem depende de", "o que quebra se mudar".',
    input_schema: {
      type: 'object' as const,
      properties: {
        file: { type: 'string', description: 'Path to the target file to analyze (relative or absolute).' },
        project_dir: { type: 'string', description: 'Root directory of the TypeScript project. Defaults to cwd.' },
      },
      required: ['file'],
    },
  },
  {
    name: 'plan_refactor',
    description:
      'Generate a safe refactor order for updating dependents of a TypeScript file. ' +
      'Returns a numbered sequence: change the target first, then update dependents bottom-up. ' +
      'Use when the user says "plano de refatoracao", "ordem de atualizacao", "como refatorar seguro".',
    input_schema: {
      type: 'object' as const,
      properties: {
        file: { type: 'string', description: 'Path to the target file being refactored.' },
        project_dir: { type: 'string', description: 'Root directory of the TypeScript project. Defaults to cwd.' },
      },
      required: ['file'],
    },
  },
]

// ─── Decision Engine Tools (cross-platform) ─────────────

export const DECISION_ENGINE_TOOLS: Anthropic.Tool[] = [
  {
    name: 'evaluate_architecture_tradeoffs',
    description:
      'Analyze trade-offs between architectural options using a weighted evaluation matrix. ' +
      'Returns an ADR (Architecture Decision Record) with recommendation. ' +
      'Default criteria: Maintainability (30%), Performance (25%), Learning Curve (20%), Infrastructure Cost (25%). ' +
      'Use when comparing technologies, frameworks, patterns, or infrastructure choices.',
    input_schema: {
      type: 'object' as const,
      properties: {
        title: {
          type: 'string',
          description: 'Title of the decision, e.g., "Redis vs SQLite for session storage".',
        },
        background: {
          type: 'string',
          description: 'Context and background of the decision — why is this decision needed?',
        },
        constraints: {
          type: 'array',
          items: { type: 'string' },
          description: 'Project constraints, e.g., "Must run on Kubernetes", "Budget < $100/mo".',
        },
        stakeholders: {
          type: 'array',
          items: { type: 'string' },
          description: 'People/teams affected, e.g., "Backend Team", "DevOps".',
        },
        options: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string', description: 'Option name, e.g., "Redis".' },
              description: { type: 'string', description: 'Brief description of this option.' },
              scores: {
                type: 'object',
                description: 'Scores for each criterion (1-5). Keys: maintainability, performance, learning_curve, infrastructure_cost.',
              },
              pros: {
                type: 'array',
                items: { type: 'string' },
                description: 'Advantages of this option.',
              },
              cons: {
                type: 'array',
                items: { type: 'string' },
                description: 'Disadvantages of this option.',
              },
            },
            required: ['name', 'description', 'scores', 'pros', 'cons'],
          },
          description: 'List of options to compare (minimum 2).',
        },
        custom_criteria: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string', description: 'Criterion name.' },
              weight: { type: 'number', description: 'Weight (0.0-1.0). Must sum to 1.0 across all criteria.' },
              description: { type: 'string', description: 'What this criterion measures.' },
            },
            required: ['name', 'weight', 'description'],
          },
          description: 'Optional custom criteria. If not provided, uses default criteria.',
        },
      },
      required: ['title', 'background', 'options'],
    },
  },
  {
    name: 'correlate_incident',
    description:
      'Analyze an error or bug and search for similar past incidents, related decisions, and relevant materials. ' +
      'Returns correlation matches with suggested solutions and actions based on historical data. ' +
      'Use when debugging, troubleshooting, or investigating an error.',
    input_schema: {
      type: 'object' as const,
      properties: {
        description: {
          type: 'string',
          description: 'Description of the current error or bug.',
        },
        stacktrace: {
          type: 'string',
          description: 'Optional stacktrace or error output for better matching.',
        },
      },
      required: ['description'],
    },
  },
  {
    name: 'log_incident',
    description:
      'Log a resolved incident for future correlation. This feeds the Post-Mortem database. ' +
      'Use after resolving a bug to help accelerate future debugging.',
    input_schema: {
      type: 'object' as const,
      properties: {
        title: { type: 'string', description: 'Short title of the incident.' },
        description: { type: 'string', description: 'Detailed description of what happened.' },
        root_cause: { type: 'string', description: 'Root cause analysis.' },
        solution: { type: 'string', description: 'How the incident was resolved.' },
        stacktrace: { type: 'string', description: 'Optional stacktrace for better correlation.' },
        related_decisions: {
          type: 'array',
          items: { type: 'string' },
          description: 'IDs of related decisions from the Decision Log.',
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Tags for categorization, e.g., "memory-leak", "timeout", "auth".',
        },
      },
      required: ['title', 'description', 'root_cause', 'solution'],
    },
  },
  {
    name: 'list_tradeoff_analyses',
    description:
      'List past architecture trade-off analyses. Use to review previous decisions and their rationale.',
    input_schema: {
      type: 'object' as const,
      properties: {
        limit: { type: 'number', description: 'Maximum number of results (default 10).' },
        query: { type: 'string', description: 'Optional search query to filter results.' },
      },
      required: [],
    },
  },
  {
    name: 'list_incidents',
    description:
      'List logged incidents from the Post-Mortem database. Use to review past issues and solutions.',
    input_schema: {
      type: 'object' as const,
      properties: {
        limit: { type: 'number', description: 'Maximum number of results (default 10).' },
        query: { type: 'string', description: 'Optional search query to filter results.' },
      },
      required: [],
    },
  },
  {
    name: 'get_tradeoff_adr',
    description:
      'Get the full ADR (Architecture Decision Record) for a past trade-off analysis by ID. ' +
      'Returns the complete Markdown document.',
    input_schema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'ID of the trade-off analysis.' },
      },
      required: ['id'],
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

// ─── News Feed Management Tools (cross-platform) ────────

export const NEWSFEED_TOOLS: Anthropic.Tool[] = [
  {
    name: 'manage_news_feeds',
    description:
      'Manage RSS/Atom news feed sources. Actions: add (add custom feed), remove (remove custom feed), ' +
      'disable (disable a built-in feed), enable (re-enable a disabled built-in), list (show all feeds). ' +
      'Use when the user says "adiciona essa fonte", "remove o feed", "desativa o TechCrunch", "mostra as fontes".',
    input_schema: {
      type: 'object' as const,
      properties: {
        action: { type: 'string', enum: ['add', 'remove', 'disable', 'enable', 'list'], description: 'Action to perform.' },
        name: { type: 'string', description: 'Feed name (for add) or name/URL reference (for remove/disable/enable).' },
        url: { type: 'string', description: 'RSS/Atom feed URL (required for add).' },
        category: { type: 'string', description: 'Category for the feed (required for add). E.g. tech, finance, ai, devops.' },
      },
      required: ['action'],
    },
  },
]

// ─── Memory/RAG Tools (cross-platform) ──────────────────

export const MEMORY_TOOLS: Anthropic.Tool[] = [
  {
    name: 'recall_memory',
    description:
      'Search the local RAG memory index for relevant information from memos, materials, decisions, and past sessions. ' +
      'Use when the user asks "o que eu sei sobre...", "lembra de...", "busca na memoria...", or needs context from past interactions. ' +
      'Returns the top 3 most relevant text fragments.',
    input_schema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'Natural language query to search the memory index' },
        top_k: { type: 'number', description: 'Number of results to return. Default 3, max 10.' },
      },
      required: ['query'],
    },
  },
  {
    name: 'index_memory',
    description:
      'Build or update the local RAG memory index. Indexes memos, materials, decisions, and sessions. ' +
      'Incremental — only re-indexes changed data. Use when the user says "atualiza a memoria", "reindexa", or after adding many new items.',
    input_schema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  },
  {
    name: 'memory_status',
    description: 'Show stats about the local RAG memory index: number of indexed chunks, sources, and last build time.',
    input_schema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  },
]

// ─── Archive Tools (cross-platform) ───────────────────────

export const ARCHIVE_TOOLS: Anthropic.Tool[] = [
  {
    name: 'archive_session',
    description:
      'Archive a conversation session. Archived sessions are preserved but removed from the active list. ' +
      'Use "all" as name to archive all sessions except the current one.',
    input_schema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'Session name to archive, or "all" to archive all except current.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'unarchive_session',
    description: 'Restore an archived session back to the active sessions list.',
    input_schema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'Archived session name to restore.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'list_archived_sessions',
    description: 'List all archived conversation sessions with message count and last update.',
    input_schema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  },
]

// ─── Meta-Learning Tools (cross-platform) ────────────────

export const META_LEARNING_TOOLS: Anthropic.Tool[] = [
  {
    name: 'update_living_manual',
    description:
      'Silently update the living manual with a structured insight or best practice. ' +
      'The manual is stored at ~/.config/smolerclaw/materials/manual/ and persists across sessions. ' +
      'Use when you observe a pattern that could help the user work more efficiently, ' +
      'or when they ask to document a workflow. Categories: workflow, tool, shortcut, best_practice.',
    input_schema: {
      type: 'object' as const,
      properties: {
        title: { type: 'string', description: 'Title of the manual entry (e.g. "Atalho para commits rapidos")' },
        content: {
          type: 'string',
          description: 'Full content in markdown format. Include steps, examples, and tips.',
        },
        category: {
          type: 'string',
          enum: ['workflow', 'tool', 'shortcut', 'best_practice'],
          description: 'Category. Default: best_practice.',
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Tags for categorization (e.g. "git", "automacao", "produtividade"). Optional.',
        },
      },
      required: ['title', 'content'],
    },
  },
  {
    name: 'explain_optimal_usage',
    description:
      'Generate an interactive tutorial explaining how to use smolerclaw more efficiently. ' +
      'Consults the living manual (via RAG or direct read) and recent insights to build a contextual guide. ' +
      'Use when the user asks "como usar melhor?", "dicas de uso", "tutorial", or seems to be using tools inefficiently.',
    input_schema: {
      type: 'object' as const,
      properties: {
        topic: {
          type: 'string',
          description: 'Optional topic to focus on (e.g. "workflows", "git", "tarefas"). If omitted, shows general tips.',
        },
      },
      required: [],
    },
  },
  {
    name: 'trigger_self_reflection',
    description:
      'Manually trigger the self-reflection analysis. Analyzes recent actions to detect patterns, ' +
      'generate insights about repetitive tasks, underutilized tools, and inefficient patterns. ' +
      'Updates the living manual with findings. Use at end of session or when user asks for usage analysis.',
    input_schema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  },
  {
    name: 'get_usage_insights',
    description:
      'Get recent insights generated by the meta-learning engine. Shows detected patterns, ' +
      'tips, and recommendations based on observed usage. Use when the user asks "o que aprendi?", ' +
      '"insights de uso", or wants to see optimization suggestions.',
    input_schema: {
      type: 'object' as const,
      properties: {
        count: { type: 'number', description: 'Number of recent insights to show. Default 5.' },
      },
      required: [],
    },
  },
]

// ─── High Agency Tools ───────────────────────────────────────

export const AGENCY_TOOLS: Anthropic.Tool[] = [
  {
    name: 'propose_plan',
    description:
      'Submit a structured implementation plan for user approval. ' +
      'Use this BEFORE executing any non-trivial task that involves: ' +
      '- Multiple file modifications ' +
      '- Architectural decisions ' +
      '- Business logic changes ' +
      '- API integrations ' +
      'The plan must include objective, steps with targets, and risks/assumptions. ' +
      'Execution is BLOCKED until the user approves the plan.',
    input_schema: {
      type: 'object' as const,
      properties: {
        objective: {
          type: 'string',
          description: 'Concise description of the end goal (e.g., "Implement JWT authentication for /api/users")',
        },
        steps: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              action: { type: 'string', description: 'What to do (e.g., "Create middleware")' },
              target: { type: 'string', description: 'Target file or module (e.g., "src/middleware/auth.ts")' },
              description: { type: 'string', description: 'Brief explanation of this step' },
              estimatedImpact: {
                type: 'string',
                enum: ['none', 'low', 'medium', 'high', 'critical'],
                description: 'Risk level of this step. Default: low.',
              },
              dependencies: {
                type: 'array',
                items: { type: 'string' },
                description: 'IDs of steps that must complete first. Optional.',
              },
            },
            required: ['action', 'target', 'description'],
          },
          description: 'Ordered list of implementation steps',
        },
        assumptions: {
          type: 'array',
          items: { type: 'string' },
          description: 'Key assumptions being made (e.g., "JWT secret exists in .env")',
        },
        risks: {
          type: 'array',
          items: { type: 'string' },
          description: 'Potential risks or breaking changes',
        },
      },
      required: ['objective', 'steps'],
    },
  },
  {
    name: 'check_plan_status',
    description:
      'Check if execution is allowed based on the current plan status. ' +
      'Returns whether you can proceed with modifications or need to wait for approval. ' +
      'Use this before any write operation if unsure about plan state.',
    input_schema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  },
  {
    name: 'report_plan_deviation',
    description:
      'Report that the current execution plan has encountered an obstacle. ' +
      'Use this when you discover something that invalidates the original plan. ' +
      'This STOPS execution and requires proposing an alternative approach. ' +
      'MANDATORY: Always explain what was found and propose a concrete alternative.',
    input_schema: {
      type: 'object' as const,
      properties: {
        step_id: {
          type: 'string',
          description: 'ID of the step that encountered the obstacle. Optional if not in specific step.',
        },
        obstacle: {
          type: 'string',
          description: 'What obstacle was encountered (e.g., "API does not support pagination")',
        },
        impact: {
          type: 'string',
          description: 'How this affects the plan (e.g., "Cannot proceed with step 3")',
        },
        alternative: {
          type: 'string',
          description: 'Proposed alternative approach',
        },
      },
      required: ['obstacle', 'impact', 'alternative'],
    },
  },
  {
    name: 'complete_plan_step',
    description:
      'Mark a plan step as completed and optionally provide the result. ' +
      'Use this after successfully completing each step in the approved plan. ' +
      'This helps track progress and enables checkpoint validation.',
    input_schema: {
      type: 'object' as const,
      properties: {
        step_id: {
          type: 'string',
          description: 'ID of the completed step',
        },
        result: {
          type: 'string',
          description: 'Brief description of what was accomplished. Optional.',
        },
      },
      required: ['step_id'],
    },
  },
  {
    name: 'get_current_plan',
    description:
      'Get the current active plan with its status and progress. ' +
      'Use to review the plan before continuing execution or to show status to user.',
    input_schema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  },
  {
    name: 'analyze_task_complexity',
    description:
      'Analyze a task description to determine its complexity and whether it requires planning. ' +
      'Returns complexity classification (trivial/simple/moderate/complex/architectural) ' +
      'and whether explicit approval is needed. Use this when unsure if planning is required.',
    input_schema: {
      type: 'object' as const,
      properties: {
        task: {
          type: 'string',
          description: 'Description of the task to analyze',
        },
        files: {
          type: 'array',
          items: { type: 'string' },
          description: 'List of files that would be affected. Optional.',
        },
        modules: {
          type: 'array',
          items: { type: 'string' },
          description: 'List of modules/systems that would be affected. Optional.',
        },
      },
      required: ['task'],
    },
  },
]

/** get_news tool definition (cross-platform, extracted for reference by name) */
const NEWS_TOOL = WINDOWS_TOOLS.find((t) => t.name === 'get_news')!

let _windowsToolsRegistered = false

// SessionManager reference for archive tools
let _sessionManager: { archive: (n: string) => boolean; archiveAll: () => string[]; unarchive: (n: string) => boolean; listArchived: () => string[]; getArchivedInfo: (n: string) => { messageCount: number; updated: number } | null } | null = null

export function registerSessionManager(sm: typeof _sessionManager): void {
  _sessionManager = sm
}

/** Register Windows tools and task tools. Idempotent. */
export function registerWindowsTools(): void {
  if (_windowsToolsRegistered) return
  _windowsToolsRegistered = true

  if (IS_WINDOWS) {
    TOOLS.push(...WINDOWS_TOOLS)
    TOOLS.push(...AGENT_TOOLS)
  } else {
    // Add get_news on all platforms (it's network-only)
    TOOLS.push(NEWS_TOOL)
  }

  // Task, people, memo, and email tools are cross-platform
  TOOLS.push(...TASK_TOOLS)
  TOOLS.push(...PEOPLE_TOOLS)
  TOOLS.push(...MEMO_TOOLS)
  TOOLS.push(EMAIL_TOOL)
  TOOLS.push(...TIER2_TOOLS)
  TOOLS.push(...INVESTIGATE_TOOLS)
  TOOLS.push(...MATERIAL_TOOLS)
  TOOLS.push(...MEMORY_TOOLS)
  TOOLS.push(...NEWSFEED_TOOLS)
  TOOLS.push(...VAULT_TOOLS)
  TOOLS.push(...PROJECT_TOOLS)
  TOOLS.push(...PITWALL_TOOLS)
  TOOLS.push(...BLAST_RADIUS_TOOLS)
  TOOLS.push(...ARCHIVE_TOOLS)
  TOOLS.push(...DECISION_ENGINE_TOOLS)
  TOOLS.push(...META_LEARNING_TOOLS)
  TOOLS.push(...AGENCY_TOOLS)
}

// ─── Tool Execution ──────────────────────────────────────────

const MAX_OUTPUT = 50_000

/**
 * Execute a tool and observe the execution for meta-learning.
 */
export async function executeTool(
  name: string,
  input: Record<string, unknown>,
): Promise<string> {
  const startTime = performance.now()

  try {
    const result = await executeToolInternal(name, input)

    // Observe tool execution for meta-learning (non-blocking)
    setImmediate(() => {
      observeEvent({
        type: 'tool:executed',
        name,
        input,
        durationMs: Math.round(performance.now() - startTime),
        success: !result.startsWith('Error:'),
      })
    })

    return result
  } catch (err) {
    // Observe failed execution
    setImmediate(() => {
      observeEvent({
        type: 'tool:executed',
        name,
        input,
        durationMs: Math.round(performance.now() - startTime),
        success: false,
      })
    })
    return `Error: ${err instanceof Error ? err.message : String(err)}`
  }
}

async function executeToolInternal(
  name: string,
  input: Record<string, unknown>,
): Promise<string> {
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
      // Finance tools
      case 'record_transaction': {
        const type = input.type as 'entrada' | 'saida'
        const amount = input.amount as number
        const category = input.category as string
        const description = input.description as string
        if (!type || !amount || !category || !description) return 'Error: all fields required.'
        const tx = addTransaction(type, amount, category, description)
        const sign = tx.type === 'entrada' ? '+' : '-'
        return `${sign} R$ ${tx.amount.toFixed(2)} (${tx.category}) — ${tx.description} [${tx.id}]`
      }
      case 'financial_summary':
        return getMonthSummary()
      // Decision tools
      case 'log_decision': {
        const title = input.title as string
        const context = input.context as string
        const chosen = input.chosen as string
        if (!title || !context || !chosen) return 'Error: title, context, and chosen are required.'
        const d = logDecision(title, context, chosen, input.alternatives as string, (input.tags as string[]) || [])
        return `Decisao registrada: "${d.title}" {${d.id}}`
      }
      case 'search_decisions': {
        const query = input.query as string
        if (!query?.trim()) return formatDecisionList(listDecisions())
        return formatDecisionList(searchDecisions(query))
      }
      // Investigation tools
      case 'open_investigation': {
        const title = input.title as string
        if (!title?.trim()) return 'Error: title is required.'
        const type = input.type as InvestigationType
        const validTypes: InvestigationType[] = ['bug', 'feature', 'test', 'audit', 'incident']
        if (!validTypes.includes(type)) return 'Error: type must be bug, feature, test, audit, or incident.'
        const inv = openInvestigation(title, type, input.hypothesis as string, (input.tags as string[]) || [])
        return `Investigacao aberta: "${inv.title}" (${inv.type}) {${inv.id}}`
      }
      case 'collect_evidence': {
        const ref = input.investigation as string
        if (!ref?.trim()) return 'Error: investigation is required.'
        const source = input.source as EvidenceSource
        const label = input.label as string
        const content = input.content as string
        if (!label?.trim() || !content?.trim()) return 'Error: label and content are required.'
        const ev = collectEvidence(ref, source, label, content, input.path as string)
        if (!ev) return `Investigacao nao encontrada: "${ref}"`
        return `Evidencia coletada: [${ev.id}] ${ev.source}: ${ev.label}`
      }
      case 'add_finding': {
        const ref = input.investigation as string
        if (!ref?.trim()) return 'Error: investigation is required.'
        const severity = input.severity as 'critical' | 'high' | 'medium' | 'low' | 'info'
        const title = input.title as string
        const description = input.description as string
        if (!title?.trim() || !description?.trim()) return 'Error: title and description are required.'
        const evidenceIds = (input.evidence_ids as string[]) || []
        const finding = addFinding(ref, severity, title, description, evidenceIds)
        if (!finding) return `Investigacao nao encontrada: "${ref}"`
        return `Conclusao registrada: [${finding.severity.toUpperCase()}] ${finding.title} {${finding.id}}`
      }
      case 'close_investigation': {
        const ref = input.investigation as string
        if (!ref?.trim()) return 'Error: investigation is required.'
        const summary = input.summary as string
        if (!summary?.trim()) return 'Error: summary is required.'
        const inv = closeInvestigation(ref, summary, input.recommendations as string)
        if (!inv) return `Investigacao nao encontrada: "${ref}"`
        return `Investigacao concluida: "${inv.title}" — ${inv.evidence.length} evidencias, ${inv.findings.length} conclusoes`
      }
      case 'investigation_status': {
        const ref = input.investigation as string
        if (!ref?.trim()) return 'Error: investigation is required.'
        const inv = getInvestigation(ref)
        if (!inv) return `Investigacao nao encontrada: "${ref}"`
        return formatInvestigationDetail(inv)
      }
      case 'investigation_report': {
        const ref = input.investigation as string
        if (!ref?.trim()) return 'Error: investigation is required.'
        const report = generateReport(ref)
        if (!report) return `Investigacao nao encontrada: "${ref}"`
        return report
      }
      case 'list_investigations': {
        const query = input.query as string | undefined
        if (query?.trim()) return formatInvestigationList(searchInvestigations(query))
        const status = input.status as InvestigationStatus | undefined
        const type = input.type as InvestigationType | undefined
        return formatInvestigationList(listInvestigations(status, type))
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
      // Material tools
      case 'save_material': {
        const title = input.title as string
        if (!title?.trim()) return 'Error: title is required.'
        const content = input.content as string
        if (!content?.trim()) return 'Error: content is required.'
        const category = (input.category as string) || 'geral'
        const tags = (input.tags as string[]) || []
        const mat = saveMaterial(title, content, category, tags)
        const tagStr = mat.tags.length > 0 ? ` [${mat.tags.map((t) => '#' + t).join(' ')}]` : ''
        return `Material salvo: "${mat.title}" (${mat.category})${tagStr}  {${mat.id}}`
      }
      case 'search_materials': {
        const query = input.query as string
        if (!query?.trim()) return formatMaterialList(listMaterials())
        const results = searchMaterials(query)
        return formatMaterialList(results)
      }
      case 'list_materials': {
        const category = input.category as string | undefined
        const limit = (input.limit as number) || 30
        const mats = listMaterials(limit, category)
        return formatMaterialList(mats)
      }
      case 'update_material': {
        const id = input.id as string
        if (!id?.trim()) return 'Error: id is required.'
        const updates: { title?: string; content?: string; category?: string; tags?: string[] } = {}
        if (input.title) updates.title = input.title as string
        if (input.content) updates.content = input.content as string
        if (input.category) updates.category = input.category as string
        if (input.tags) updates.tags = input.tags as string[]
        const mat = updateMaterial(id, updates)
        if (!mat) return `Material nao encontrado: "${id}"`
        return `Material atualizado: "${mat.title}" (${mat.category}) {${mat.id}}`
      }
      case 'delete_material': {
        const id = input.id as string
        if (!id?.trim()) return 'Error: id is required.'
        return deleteMaterial(id) ? 'Material removido.' : `Material nao encontrado: "${id}"`
      }
      // Windows Agent tools
      case 'execute_powershell_script': {
        const script = input.script as string
        if (!script?.trim()) return 'Error: script is required.'
        const safety = analyzeScriptSafety(script)
        if (safety.blocked) return `BLOCKED: ${safety.reason}\nEsse tipo de operacao nao e permitido.`
        if (!safety.safe && safety.reason) {
          // Risky but not blocked — the approval system will handle confirmation
          // via the 'dangerous' risk level in tool-safety.ts
        }
        const result: ScriptResult = await executePowerShellScript(script)
        const parts: string[] = []
        if (result.stdout.trim()) parts.push(`stdout:\n${result.stdout.trim()}`)
        if (result.stderr.trim()) parts.push(`stderr:\n${result.stderr.trim()}`)
        parts.push(`exit: ${result.exitCode} (${result.duration}ms)`)
        return parts.join('\n\n')
      }
      case 'analyze_screen_context':
        return await analyzeScreenContext()
      case 'read_clipboard_content': {
        const clip = await readClipboardContent()
        switch (clip.type) {
          case 'text':
            return `Clipboard (texto):\n${clip.text}`
          case 'image':
            return clip.text // Already formatted with [OCR do clipboard] prefix
          case 'empty':
            return 'Clipboard vazio.'
          case 'error':
            return `Erro ao ler clipboard: ${clip.text}`
        }
      }
      // News feed management
      case 'manage_news_feeds': {
        const action = input.action as string
        switch (action) {
          case 'list':
            return listNewsFeeds()
          case 'add': {
            const name = input.name as string
            const url = input.url as string
            const category = input.category as string
            if (!name?.trim()) return 'Error: name is required for add.'
            if (!url?.trim()) return 'Error: url is required for add.'
            if (!category?.trim()) return 'Error: category is required for add.'
            const result = addNewsFeed(name, url, category)
            if (typeof result === 'string') return result
            return `Fonte adicionada: ${result.name} (${result.category}) — ${result.url}`
          }
          case 'remove': {
            const ref = input.name as string
            if (!ref?.trim()) return 'Error: name or URL is required.'
            return removeNewsFeed(ref) ? `Fonte removida: ${ref}` : `Fonte custom nao encontrada: "${ref}"`
          }
          case 'disable': {
            const ref = input.name as string
            if (!ref?.trim()) return 'Error: name or URL is required.'
            return disableNewsFeed(ref) ? `Fonte desativada: ${ref}` : `Fonte built-in nao encontrada ou ja desativada: "${ref}"`
          }
          case 'enable': {
            const ref = input.name as string
            if (!ref?.trim()) return 'Error: name or URL is required.'
            return enableNewsFeed(ref) ? `Fonte reativada: ${ref}` : `Fonte nao encontrada ou nao esta desativada: "${ref}"`
          }
          default:
            return 'Error: action must be add, remove, disable, enable, or list.'
        }
      }
      // Memory/RAG tools
      case 'recall_memory': {
        if (!isMemoryInitialized()) return 'Error: memory not initialized. Run /indexar first.'
        const query = input.query as string
        if (!query?.trim()) return 'Error: query is required.'
        const topK = Math.min(Math.max((input.top_k as number) || 3, 1), 10)
        const results = queryMemory(query, topK)
        return formatQueryResults(results)
      }
      case 'index_memory': {
        if (!isMemoryInitialized()) return 'Error: memory not initialized.'
        const stats = buildIndex()
        return `Indexacao concluida: ${stats.indexed} fonte(s) indexada(s), ${stats.skipped} sem alteracao. Total: ${stats.total} chunks.`
      }
      case 'memory_status': {
        if (!isMemoryInitialized()) return 'Memory: nao inicializada.'
        const stats = getIndexStats()
        const builtStr = stats.builtAt
          ? new Date(stats.builtAt).toLocaleString('pt-BR')
          : 'nunca'
        return `Memory RAG Index:\n  Chunks: ${stats.chunks}\n  Fontes: ${stats.sources}\n  Ultima indexacao: ${builtStr}`
      }
      // Vault tools
      case 'vault_status': {
        if (!isVaultInitialized()) return 'Vault nao inicializado.'
        return formatVaultStatus(getVaultStatus())
      }
      case 'vault_backup': {
        if (!isVaultInitialized()) return 'Vault nao inicializado.'
        const msg = (input.message as string) || undefined
        return await performBackup(msg)
      }
      case 'sync_cloud_context': {
        if (!isVaultInitialized()) return 'Vault nao inicializado.'
        return await syncBackupToRemote()
      }
      case 'vault_init_backup': {
        if (!isVaultInitialized()) return 'Vault nao inicializado.'
        return await initShadowBackup()
      }
      // Project management tools
      case 'set_active_project': {
        const ref = input.name_or_id as string
        if (!ref?.trim()) return 'Error: name_or_id is required.'
        if (ref === 'auto') {
          const detected = autoDetectProject(process.cwd())
          if (!detected) return 'Nenhum projeto detectado no diretorio atual (nao e um repositorio git).'
          setActiveProject(detected.id)
          return `Projeto ativo: "${detected.name}" (${detected.path}) — auto-detectado [${detected.id}]`
        }
        const project = setActiveProject(ref)
        if (!project) return `Projeto nao encontrado: "${ref}". Use /projetos para listar ou add_project para criar.`
        return `Projeto ativo: "${project.name}" (${project.path}) [${project.id}]`
      }
      case 'report_work_progress': {
        const projectRef = (input.project as string) || ''
        const period = (input.period as 'today' | 'week' | 'month') || 'today'
        const lang = (input.lang as 'pt' | 'en') || 'pt'
        const savePath = input.save_to_file as string | undefined

        let targetId = projectRef
        if (!targetId) {
          const active = getActiveProject()
          if (!active) return 'Nenhum projeto ativo. Use set_active_project primeiro.'
          targetId = active.id
        }

        const report = await generateWorkReport(targetId, period, lang)
        if (!report) return `Projeto nao encontrado: "${targetId}"`

        if (savePath) {
          writeFileSync(savePath, report.markdown, 'utf-8')
          return `Relatorio salvo em: ${savePath}\n\n${report.markdown}`
        }
        return report.markdown
      }
      case 'manage_work_session': {
        const action = input.action as string
        const notes = (input.notes as string) || ''

        const active = getActiveProject()
        if (!active) return 'Nenhum projeto ativo. Use set_active_project primeiro.'

        switch (action) {
          case 'start': {
            const session = startSession(active.id, notes)
            if (!session) return 'Erro ao iniciar sessao.'
            return `Sessao iniciada para "${active.name}" as ${new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}. [${session.id}]`
          }
          case 'stop': {
            const open = getOpenSession(active.id)
            if (!open) return 'Nenhuma sessao aberta para este projeto.'
            const ended = endSession(open.id, notes)
            if (!ended) return 'Erro ao encerrar sessao.'
            return `Sessao encerrada: ${ended.durationMinutes} minutos trabalhados em "${active.name}".`
          }
          case 'status': {
            const open = getOpenSession(active.id)
            if (!open) return `Nenhuma sessao aberta para "${active.name}".`
            const started = new Date(open.startedAt)
            const elapsed = Math.round((Date.now() - started.getTime()) / 60_000)
            return `Sessao aberta: "${active.name}" — ${elapsed} minutos (desde ${started.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })})`
          }
          default:
            return 'Error: action must be start, stop, or status.'
        }
      }
      case 'add_project': {
        const name = input.name as string
        if (!name?.trim()) return 'Error: name is required.'
        const path = input.path as string
        if (!path?.trim()) return 'Error: path is required.'
        const desc = (input.description as string) || ''
        const tech = (input.tech_stack as string[]) || []
        const tags = (input.tags as string[]) || []
        const project = addProject(name, path, desc, tags, tech)
        return `Projeto registrado: "${project.name}" (${project.path}) [${project.id}]`
      }
      case 'list_projects': {
        const activeOnly = (input.active_only as boolean) || false
        return formatProjectList(listProjects(activeOnly))
      }
      case 'fetch_opportunities': {
        const status = input.status as string | undefined
        const tech = input.tech as string[] | undefined
        const opps = listOpportunities(status as any, tech)
        return formatOpportunityList(opps)
      }
      case 'add_opportunity': {
        const title = input.title as string
        if (!title?.trim()) return 'Error: title is required.'
        const desc = input.description as string
        if (!desc?.trim()) return 'Error: description is required.'
        const source = input.source as string
        if (!source?.trim()) return 'Error: source is required.'
        const tech = (input.tech_required as string[]) || []
        const priority = (input.priority as 'alta' | 'media' | 'baixa') || 'media'
        const deadline = (input.deadline as string) || null
        const opp = addOpportunity(title, desc, source, tech, priority, deadline)
        return `Oportunidade registrada: "${opp.title}" (${opp.priority}) [${opp.id}]`
      }
      case 'update_opportunity_status': {
        const id = input.id as string
        if (!id?.trim()) return 'Error: id is required.'
        const status = input.status as 'nova' | 'em_analise' | 'aceita' | 'recusada' | 'concluida'
        const opp = updateOpportunityStatus(id, status)
        if (!opp) return `Oportunidade nao encontrada: "${id}"`
        return `Oportunidade atualizada: "${opp.title}" -> ${status}`
      }
      // Pit Wall tools
      case 'pitwall_benchmark': {
        const command = input.command as string
        if (!command?.trim()) return 'Error: command is required.'
        const key = input.key as string | undefined
        const iterations = Math.min(Math.max((input.iterations as number) || 1, 1), 10)
        const warmup = (input.warmup as boolean) || false
        const cwd = input.cwd as string | undefined

        const run = await benchmark(command, { scriptKey: key, cwd, iterations, warmup })

        if (run.exitCode !== 0) {
          const report = compareToBaseline(run)
          return `AVISO: Comando terminou com exit code ${run.exitCode}. Metricas podem nao ser confiaveis.\n\n${report.markdown}`
        }

        return compareToBaseline(run).markdown
      }
      case 'pitwall_save_baseline': {
        const command = input.command as string
        if (!command?.trim()) return 'Error: command is required.'
        const key = input.key as string | undefined
        const iterations = Math.min(Math.max((input.iterations as number) || 3, 1), 10)
        const tags = (input.tags as string[]) || []
        const shouldReset = (input.reset as boolean) || false
        const cwd = input.cwd as string | undefined

        const run = await benchmark(command, { scriptKey: key, cwd, iterations, warmup: true })

        if (run.exitCode !== 0) {
          return `Error: Comando falhou (exit code ${run.exitCode}). Corrija o comando antes de salvar baseline.\n` +
            (run.stderr ? `Stderr: ${run.stderr.slice(0, 300)}` : '')
        }

        const baseline = shouldReset
          ? resetBaseline(run, tags)
          : saveBaseline(run, tags)

        const durationMs = baseline.metrics.durationNs / 1e6
        return `Baseline salvo: "${baseline.scriptKey}" (${baseline.runs} run${baseline.runs > 1 ? 's' : ''})\n` +
          `  Duracao: ${durationMs.toFixed(2)}ms\n` +
          `  Memoria: ${(baseline.metrics.peakMemoryBytes / 1024 / 1024).toFixed(1)}MB\n` +
          `  CPU (user): ${(baseline.metrics.cpuUserUs / 1000).toFixed(2)}ms`
      }
      case 'pitwall_status': {
        return formatBaselineList(listBaselines())
      }
      case 'pitwall_remove_baseline': {
        const key = input.key as string
        if (!key?.trim()) return 'Error: key is required.'
        return removeBaseline(key)
          ? `Baseline removido: "${key}"`
          : `Baseline nao encontrado: "${key}"`
      }
      // Blast Radius tools
      case 'analyze_blast_radius': {
        const file = input.file as string
        if (!file?.trim()) return 'Error: file is required.'
        const projectDir = resolve((input.project_dir as string) || process.cwd())
        const absFile = resolve(projectDir, file)
        if (!absFile.startsWith(projectDir + sep)) {
          return 'Error: file must be inside project_dir.'
        }
        try {
          const graph = buildDependencyGraph(projectDir)
          const blast = calculateBlastRadius(graph, absFile)
          return formatBlastRadius(blast)
        } catch (err) {
          return `Error: ${err instanceof Error ? err.message : String(err)}`
        }
      }
      case 'plan_refactor': {
        const file = input.file as string
        if (!file?.trim()) return 'Error: file is required.'
        const projectDir = resolve((input.project_dir as string) || process.cwd())
        const absFile = resolve(projectDir, file)
        if (!absFile.startsWith(projectDir + sep)) {
          return 'Error: file must be inside project_dir.'
        }
        try {
          const graph = buildDependencyGraph(projectDir)
          const plan = planRefactor(graph, absFile)
          return formatRefactorPlan(plan)
        } catch (err) {
          return `Error: ${err instanceof Error ? err.message : String(err)}`
        }
      }
      // Archive tools
      case 'archive_session': {
        if (!_sessionManager) return 'Error: session manager not initialized.'
        const name = input.name as string
        if (!name?.trim()) return 'Error: name is required.'
        if (name === 'all') {
          const archived = _sessionManager.archiveAll()
          return archived.length > 0
            ? `Arquivadas ${archived.length} sessoes: ${archived.join(', ')}`
            : 'Nenhuma sessao para arquivar (apenas a sessao atual esta ativa).'
        }
        return _sessionManager.archive(name)
          ? `Sessao arquivada: "${name}"`
          : `Falha ao arquivar "${name}" (nao encontrada ou e a sessao atual).`
      }
      case 'unarchive_session': {
        if (!_sessionManager) return 'Error: session manager not initialized.'
        const name = input.name as string
        if (!name?.trim()) return 'Error: name is required.'
        return _sessionManager.unarchive(name)
          ? `Sessao restaurada: "${name}"`
          : `Sessao arquivada nao encontrada: "${name}"`
      }
      case 'list_archived_sessions': {
        if (!_sessionManager) return 'Error: session manager not initialized.'
        const list = _sessionManager.listArchived()
        if (list.length === 0) return 'Nenhuma sessao arquivada.'
        const details = list.map((name) => {
          const info = _sessionManager!.getArchivedInfo(name)
          const age = info ? new Date(info.updated).toLocaleDateString('pt-BR') : ''
          const msgs = info ? `${info.messageCount} msgs` : ''
          return `  ${name.padEnd(20)} ${msgs.padEnd(10)} ${age}`
        })
        return `Sessoes arquivadas (${list.length}):\n${details.join('\n')}`
      }
      // Decision Engine tools
      case 'evaluate_architecture_tradeoffs': {
        const title = input.title as string
        if (!title?.trim()) return 'Error: title is required.'
        const background = input.background as string
        if (!background?.trim()) return 'Error: background is required.'
        const optionsInput = input.options as Array<{
          name: string
          description: string
          scores: Record<string, number>
          pros: string[]
          cons: string[]
        }>
        if (!optionsInput || optionsInput.length < 2) {
          return 'Error: at least 2 options are required.'
        }

        const context: TradeoffContext = {
          title: title.trim(),
          background: background.trim(),
          constraints: (input.constraints as string[]) || [],
          stakeholders: (input.stakeholders as string[]) || [],
        }

        const options: TradeoffOption[] = optionsInput.map((o) => ({
          name: o.name.trim(),
          description: o.description.trim(),
          scores: o.scores,
          pros: o.pros || [],
          cons: o.cons || [],
        }))

        const customCriteria = input.custom_criteria as TradeoffCriterion[] | undefined
        const criteria = customCriteria && customCriteria.length > 0
          ? customCriteria
          : DEFAULT_CRITERIA

        const result = analyzeTradeoffs(context, options, criteria)
        return result.adr
      }
      case 'correlate_incident': {
        const description = input.description as string
        if (!description?.trim()) return 'Error: description is required.'
        const stacktrace = input.stacktrace as string | undefined

        const result = correlateIncident(description, stacktrace)
        return result.summary
      }
      case 'log_incident': {
        const title = input.title as string
        if (!title?.trim()) return 'Error: title is required.'
        const description = input.description as string
        if (!description?.trim()) return 'Error: description is required.'
        const rootCause = input.root_cause as string
        if (!rootCause?.trim()) return 'Error: root_cause is required.'
        const solution = input.solution as string
        if (!solution?.trim()) return 'Error: solution is required.'

        const incident = logIncident(
          title,
          description,
          rootCause,
          solution,
          input.stacktrace as string | undefined,
          (input.related_decisions as string[]) || [],
          (input.tags as string[]) || [],
        )
        return `Incidente registrado: "${incident.title}"  {${incident.id}}\n` +
          `  Causa: ${incident.rootCause.slice(0, 80)}${incident.rootCause.length > 80 ? '...' : ''}\n` +
          `  Solucao: ${incident.solution.slice(0, 80)}${incident.solution.length > 80 ? '...' : ''}`
      }
      case 'list_tradeoff_analyses': {
        const limit = (input.limit as number) || 10
        const query = input.query as string | undefined

        const results = query
          ? searchTradeoffs(query).slice(0, limit)
          : listTradeoffs(limit)

        return formatTradeoffList(results)
      }
      case 'list_incidents': {
        const limit = (input.limit as number) || 10
        const query = input.query as string | undefined

        const results = query
          ? searchIncidents(query).slice(0, limit)
          : listIncidents(limit)

        return formatIncidentList(results)
      }
      case 'get_tradeoff_adr': {
        const id = input.id as string
        if (!id?.trim()) return 'Error: id is required.'

        const tradeoff = getTradeoff(id)
        if (!tradeoff) return `Trade-off nao encontrado: "${id}"`

        return tradeoff.adr
      }
      // Meta-Learning tools
      case 'update_living_manual': {
        const title = input.title as string
        if (!title?.trim()) return 'Error: title is required.'
        const content = input.content as string
        if (!content?.trim()) return 'Error: content is required.'
        const category = (input.category as LivingManualEntry['category']) || 'best_practice'
        const tags = (input.tags as string[]) || []

        const result = await updateLivingManual(title, content, category, tags)
        if (!result.success) {
          return 'Falha ao atualizar o manual. Verifique se o docs-engine foi inicializado.'
        }
        return `Manual atualizado: "${title}" (${category})\nArquivo: ${result.path}`
      }
      case 'explain_optimal_usage': {
        const topic = input.topic as string | undefined
        const tutorial = generateOptimalUsageTutorial(topic)
        return tutorial
      }
      case 'trigger_self_reflection': {
        const result = await runSelfReflection()
        return formatReflectionResult(result)
      }
      case 'get_usage_insights': {
        const count = Math.min(Math.max((input.count as number) || 5, 1), 20)
        const insights = getRecentInsights(count)
        return formatInsightList(insights)
      }

      // ─── High Agency Tools ─────────────────────────────────
      case 'propose_plan': {
        if (!isAgencyEngineInitialized()) {
          return 'Error: Agency engine not initialized. Planning features unavailable.'
        }
        const objective = input.objective as string
        if (!objective?.trim()) return 'Error: objective is required.'

        const rawSteps = input.steps as Array<{
          action: string
          target: string
          description: string
          estimatedImpact?: string
          dependencies?: string[]
        }>
        if (!rawSteps?.length) return 'Error: at least one step is required.'

        const steps = rawSteps.map(s => ({
          action: s.action,
          target: s.target,
          description: s.description,
          estimatedImpact: (s.estimatedImpact || 'low') as 'none' | 'low' | 'medium' | 'high' | 'critical',
          dependencies: s.dependencies || [],
        }))

        const plan = createPlan(objective, steps, {
          assumptions: input.assumptions as string[] | undefined,
          risks: input.risks as string[] | undefined,
        })

        // Auto-submit for approval
        const result = await submitPlanForApproval()
        if (!result.success) {
          return `Error creating plan: ${result.message}`
        }

        const draft = formatPlanAsDraft(plan)
        return `Plano criado e aguardando aprovação.\n\n${draft}`
      }

      case 'check_plan_status': {
        if (!isAgencyEngineInitialized()) {
          return 'Agency engine not initialized. All operations allowed (no planning enforcement).'
        }
        const check = canExecute()
        const plan = getCurrentPlan()

        if (!plan) {
          return 'Nenhum plano ativo. Operações triviais permitidas sem planejamento.'
        }

        const status = formatPlanStatus(plan)
        return `${status}\n\nExecução: ${check.allowed ? 'PERMITIDA' : 'BLOQUEADA'}\nMotivo: ${check.reason}`
      }

      case 'report_plan_deviation': {
        if (!isAgencyEngineInitialized()) {
          return 'Error: Agency engine not initialized.'
        }
        const obstacle = input.obstacle as string
        const impact = input.impact as string
        const alternative = input.alternative as string

        if (!obstacle?.trim()) return 'Error: obstacle is required.'
        if (!impact?.trim()) return 'Error: impact is required.'
        if (!alternative?.trim()) return 'Error: alternative is required.'

        const plan = getCurrentPlan()
        if (!plan) {
          return 'Nenhum plano ativo. Não há desvio a reportar.'
        }

        const stepId = input.step_id as string | undefined
        const currentStep = stepId
          ? plan.strategy.find(s => s.id === stepId)
          : plan.strategy.find(s => s.status === 'in_progress' || s.status === 'pending')

        if (currentStep) {
          reportBlockedStep(currentStep.id, obstacle, alternative)
        }

        return [
          '**Desvio Detectado**',
          '',
          `**Obstáculo:** ${obstacle}`,
          `**Impacto no Plano:** ${impact}`,
          '',
          '**Alternativa Proposta:**',
          alternative,
          '',
          '**Status:** Execução BLOQUEADA. Aguardando aprovação da alternativa.',
          '',
          '**Bloqueio:** Posso prosseguir com esta alternativa?',
        ].join('\n')
      }

      case 'complete_plan_step': {
        if (!isAgencyEngineInitialized()) {
          return 'Error: Agency engine not initialized.'
        }
        const stepId = input.step_id as string
        if (!stepId?.trim()) return 'Error: step_id is required.'

        const result = completeStep(stepId, input.result as string | undefined)
        if (!result.success) return `Error: ${result.message}`

        const plan = getCurrentPlan()
        const progressMsg = plan
          ? `Progresso: ${plan.strategy.filter(s => s.status === 'completed').length}/${plan.strategy.length}`
          : ''

        const nextMsg = result.nextStep
          ? `\nPróximo passo: ${result.nextStep.action} → ${result.nextStep.target}`
          : '\nTodos os passos concluídos!'

        return `Passo concluído: ${result.message}\n${progressMsg}${nextMsg}`
      }

      case 'get_current_plan': {
        if (!isAgencyEngineInitialized()) {
          return 'Agency engine not initialized. No planning features available.'
        }
        const plan = getCurrentPlan()
        if (!plan) {
          return 'Nenhum plano ativo no momento.'
        }
        return formatPlanAsDraft(plan)
      }

      case 'analyze_task_complexity': {
        if (!isAgencyEngineInitialized()) {
          return 'Agency engine not initialized. Cannot analyze complexity.'
        }
        const task = input.task as string
        if (!task?.trim()) return 'Error: task is required.'

        const analysis = analyzeTaskImpact(task, {
          files: input.files as string[] | undefined,
          modules: input.modules as string[] | undefined,
        })

        const lines = [
          `**Análise de Complexidade**`,
          '',
          `**Tarefa:** ${task}`,
          `**Classificação:** ${analysis.complexity}`,
          `**Requer Aprovação:** ${analysis.requiresApproval ? 'SIM' : 'NÃO'}`,
          '',
          `**Motivo:** ${analysis.reason}`,
        ]

        if (analysis.risks.length > 0) {
          lines.push('', '**Riscos Identificados:**')
          for (const risk of analysis.risks) {
            lines.push(`  - ${risk}`)
          }
        }

        if (analysis.assumptions.length > 0) {
          lines.push('', '**Premissas:**')
          for (const assumption of analysis.assumptions) {
            lines.push(`  - ${assumption}`)
          }
        }

        if (analysis.requiresApproval) {
          lines.push('', '**Recomendação:** Use `propose_plan` antes de executar esta tarefa.')
        }

        return lines.join('\n')
      }

      default: {
        // Check plugins
        const plugin = _plugins.find((p) => p.name === name)
        if (plugin) return await executePlugin(plugin, input)
        return `Error: unknown tool "${name}"`
      }
  }
}

// ─── Security ───────────────────────────────────────────────

const MAX_FILE_SIZE = 10 * 1024 * 1024 // 10 MB

/**
 * Atomic write: write to temp file then rename.
 * Prevents corruption from crash/power loss mid-write.
 */


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
  atomicWriteFile(path, content)
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
  atomicWriteFile(path, updated)

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
        'User-Agent': 'smolerclaw/1.0',
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
