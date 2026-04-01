/**
 * Business tool schemas and execution: tasks, memos, people, projects, finance,
 * decisions, email, investigations, workflows, materials, pitwall, blast radius,
 * decision engine, meta-learning, archive, scheduler, news feeds, notifications.
 */
import type Anthropic from '@anthropic-ai/sdk'
import { resolve, sep } from 'node:path'
import { writeFileSync } from 'node:fs'
import { fetchNews, type NewsCategory } from '../news'
import { addTask, completeTask, listTasks, formatTaskList, parseTime } from '../tasks'
import { saveMemo, searchMemos, listMemos, formatMemoList } from '../memos'
import { openEmailDraft, formatDraftPreview, type EmailDraft } from '../email'
import { startPomodoro, stopPomodoro, pomodoroStatus } from '../pomodoro'
import {
  scheduleJob, removeJob, enableJob, disableJob, listJobs, runJobNow,
  formatJobList, parseScheduleTime, parseScheduleDate, parseWeekDay,
  type ScheduleType,
} from '../scheduler'
import { addTransaction, getMonthSummary, getRecentTransactions } from '../finance'
import { logDecision, searchDecisions, listDecisions, formatDecisionList, formatDecisionDetail } from '../decisions'
import {
  runWorkflow, listWorkflows, getWorkflow, createWorkflow, deleteWorkflow,
  updateWorkflow, duplicateWorkflow, addStepToWorkflow, removeStepFromWorkflow,
  formatWorkflowList, formatWorkflowDetail,
  type WorkflowStep,
} from '../workflows'
import {
  openInvestigation, collectEvidence, addFinding, closeInvestigation,
  getInvestigation, listInvestigations, searchInvestigations, generateReport,
  formatInvestigationList, formatInvestigationDetail, formatEvidenceDetail,
  type InvestigationType, type InvestigationStatus, type EvidenceSource,
} from '../investigate'
import {
  addPerson, findPerson, listPeople, updatePerson, removePerson,
  logInteraction, getInteractions, delegateTask, updateDelegation,
  getDelegations, getPendingFollowUps, markFollowUpDone,
  formatPeopleList, formatPersonDetail, formatDelegationList, formatFollowUps,
  generatePeopleDashboard,
  type PersonGroup, type InteractionType,
} from '../people'
import {
  saveMaterial, searchMaterials, listMaterials, deleteMaterial, updateMaterial,
  getMaterial, formatMaterialList, formatMaterialDetail, formatMaterialCategories,
} from '../materials'
import {
  addNewsFeed, removeNewsFeed, disableNewsFeed, enableNewsFeed, listNewsFeeds,
} from '../news'
import {
  setActiveProject, getActiveProject, clearActiveProject,
  addProject, getProject, listProjects, removeProject,
  startSession, endSession, getOpenSession,
  addOpportunity, updateOpportunityStatus, listOpportunities, removeOpportunity,
  generateWorkReport, autoDetectProject,
  formatProjectList, formatProjectDetail, formatOpportunityList,
} from '../projects'
import {
  benchmark, saveBaseline, resetBaseline,
  compareToBaseline, listBaselines, removeBaseline,
  formatBaselineList,
} from '../pitwall'
import {
  buildDependencyGraph, calculateBlastRadius, planRefactor,
  formatBlastRadius, formatRefactorPlan,
} from '../services/dependency-graph'
import {
  analyzeTradeoffs, correlateIncident, logIncident,
  listTradeoffs, listIncidents, searchIncidents, searchTradeoffs, getTradeoff,
  formatTradeoffList, formatIncidentList, formatIncidentDetail,
  DEFAULT_CRITERIA,
  type TradeoffContext, type TradeoffOption, type TradeoffCriterion,
} from '../services/decision-engine'
import {
  observeEvent, runSelfReflection, updateLivingManual,
  searchLivingManual, generateOptimalUsageTutorial,
  getRecentInsights, getBufferStats,
  formatReflectionResult, formatInsightList,
  type ObservedEvent, type LivingManualEntry,
} from '../services/docs-engine'
import {
  openApp, openFile, openUrl, getRunningApps, getSystemInfo, getOutlookEvents,
} from '../windows'
import {
  executePowerShellScript, analyzeScriptSafety, analyzeScreenContext,
  readClipboardContent, sendNotification, type ScriptResult,
} from '../windows-agent'
import { parseFuzzyDate } from './helpers'

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

// ─── Scheduler Tools (Windows Task Scheduler) ──────────────

export const SCHEDULER_TOOLS: Anthropic.Tool[] = [
  {
    name: 'schedule_job',
    description:
      'Create a persistent scheduled job using Windows Task Scheduler. ' +
      'Jobs fire even when smolerclaw is not running. ' +
      'Supports one-time, daily, and weekly schedules.',
    input_schema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'Human-readable name for the job' },
        time: { type: 'string', description: 'Time in HH:MM format (e.g., "14:00", "09:30")' },
        message: { type: 'string', description: 'Message to display in the notification' },
        schedule_type: {
          type: 'string',
          enum: ['once', 'daily', 'weekly'],
          description: 'Schedule type: once (single execution), daily, or weekly. Default: once',
        },
        date_or_day: {
          type: 'string',
          description: 'For "once": date in DD/MM/YYYY format or "hoje"/"amanha". For "weekly": day name (e.g., "segunda", "friday"). Optional.',
        },
      },
      required: ['name', 'time', 'message'],
    },
  },
  {
    name: 'remove_scheduled_job',
    description: 'Remove a scheduled job by its ID or name.',
    input_schema: {
      type: 'object' as const,
      properties: {
        reference: { type: 'string', description: 'Job ID or partial name to match' },
      },
      required: ['reference'],
    },
  },
  {
    name: 'list_scheduled_jobs',
    description: 'List all scheduled jobs. Shows name, schedule, and status.',
    input_schema: {
      type: 'object' as const,
      properties: {
        include_disabled: { type: 'boolean', description: 'Include disabled jobs. Default false.' },
      },
      required: [],
    },
  },
  {
    name: 'enable_scheduled_job',
    description: 'Enable a previously disabled scheduled job.',
    input_schema: {
      type: 'object' as const,
      properties: {
        reference: { type: 'string', description: 'Job ID or partial name to match' },
      },
      required: ['reference'],
    },
  },
  {
    name: 'disable_scheduled_job',
    description: 'Disable a scheduled job without removing it.',
    input_schema: {
      type: 'object' as const,
      properties: {
        reference: { type: 'string', description: 'Job ID or partial name to match' },
      },
      required: ['reference'],
    },
  },
  {
    name: 'run_scheduled_job_now',
    description: 'Execute a scheduled job immediately (for testing).',
    input_schema: {
      type: 'object' as const,
      properties: {
        reference: { type: 'string', description: 'Job ID or partial name to match' },
      },
      required: ['reference'],
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

// ─── Business Tool Execution ─────────────────────────────────

export async function executeBusinessTool(
  name: string,
  input: Record<string, unknown>,
  sessionManager: { archive: (n: string) => boolean; archiveAll: () => string[]; unarchive: (n: string) => boolean; listArchived: () => string[]; getArchivedInfo: (n: string) => { messageCount: number; updated: number } | null } | null,
): Promise<string | null> {
  switch (name) {
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
    // Scheduler tools
    case 'schedule_job': {
      const name = input.name as string
      const timeStr = input.time as string
      const message = input.message as string
      if (!name?.trim() || !timeStr?.trim() || !message?.trim()) {
        return 'Error: name, time, and message are required.'
      }
      const parsedTime = parseScheduleTime(timeStr)
      if (!parsedTime) return `Error: invalid time format "${timeStr}". Use HH:MM.`

      const schedType = (input.schedule_type as ScheduleType) || 'once'
      let dateOrDay: string | undefined

      if (input.date_or_day) {
        const raw = input.date_or_day as string
        if (schedType === 'weekly') {
          dateOrDay = parseWeekDay(raw) ?? undefined
        } else {
          dateOrDay = parseScheduleDate(raw) ?? undefined
        }
      }

      // Default date for 'once' if not specified
      if (schedType === 'once' && !dateOrDay) {
        const now = new Date()
        const [h, m] = parsedTime.split(':').map(Number)
        const scheduleTime = new Date(now)
        scheduleTime.setHours(h, m, 0, 0)
        if (scheduleTime <= now) {
          scheduleTime.setDate(scheduleTime.getDate() + 1)
        }
        dateOrDay = [
          String(scheduleTime.getMonth() + 1).padStart(2, '0'),
          String(scheduleTime.getDate()).padStart(2, '0'),
          String(scheduleTime.getFullYear()),
        ].join('/')
      }

      const job = await scheduleJob(name, schedType, parsedTime, 'toast', message, dateOrDay)
      return `Agendamento criado: "${job.name}" [${job.id}] — ${job.scheduleType} às ${job.time}`
    }
    case 'remove_scheduled_job': {
      const ref = input.reference as string
      if (!ref?.trim()) return 'Error: reference is required.'
      const removed = await removeJob(ref)
      return removed ? 'Agendamento removido.' : `Agendamento nao encontrado: "${ref}"`
    }
    case 'list_scheduled_jobs': {
      const includeDisabled = (input.include_disabled as boolean) || false
      const jobs = listJobs(includeDisabled)
      return formatJobList(jobs)
    }
    case 'enable_scheduled_job': {
      const ref = input.reference as string
      if (!ref?.trim()) return 'Error: reference is required.'
      const job = await enableJob(ref)
      return job ? `Agendamento "${job.name}" ativado.` : `Agendamento nao encontrado: "${ref}"`
    }
    case 'disable_scheduled_job': {
      const ref = input.reference as string
      if (!ref?.trim()) return 'Error: reference is required.'
      const job = await disableJob(ref)
      return job ? `Agendamento "${job.name}" desativado.` : `Agendamento nao encontrado: "${ref}"`
    }
    case 'run_scheduled_job_now': {
      const ref = input.reference as string
      if (!ref?.trim()) return 'Error: reference is required.'
      return await runJobNow(ref)
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
    // Notifications
    case 'send_notification': {
      const title = input.title as string
      const message = input.message as string
      const result = await sendNotification(title, message)
      if (result.success) {
        return `Notificação enviada: "${title}"`
      }
      return `Erro ao enviar notificação: ${result.error}`
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
      if (!sessionManager) return 'Error: session manager not initialized.'
      const name = input.name as string
      if (!name?.trim()) return 'Error: name is required.'
      if (name === 'all') {
        const archived = sessionManager.archiveAll()
        return archived.length > 0
          ? `Arquivadas ${archived.length} sessoes: ${archived.join(', ')}`
          : 'Nenhuma sessao para arquivar (apenas a sessao atual esta ativa).'
      }
      return sessionManager.archive(name)
        ? `Sessao arquivada: "${name}"`
        : `Falha ao arquivar "${name}" (nao encontrada ou e a sessao atual).`
    }
    case 'unarchive_session': {
      if (!sessionManager) return 'Error: session manager not initialized.'
      const name = input.name as string
      if (!name?.trim()) return 'Error: name is required.'
      return sessionManager.unarchive(name)
        ? `Sessao restaurada: "${name}"`
        : `Sessao arquivada nao encontrada: "${name}"`
    }
    case 'list_archived_sessions': {
      if (!sessionManager) return 'Error: session manager not initialized.'
      const list = sessionManager.listArchived()
      if (list.length === 0) return 'Nenhuma sessao arquivada.'
      const details = list.map((name) => {
        const info = sessionManager!.getArchivedInfo(name)
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
    default:
      return null
  }
}
