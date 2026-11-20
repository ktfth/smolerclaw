import type Anthropic from '@anthropic-ai/sdk'
import {
  setActiveProject, getActiveProject, addProject, listProjects,
  startSession, endSession, getOpenSession, openSessionStatus, MAX_SESSION_MINUTES,
  addOpportunity, updateOpportunityStatus, listOpportunities,
  generateWorkReport, autoDetectProject, checkProjectPath,
  formatProjectList, formatOpportunityList,
  type Opportunity,
} from '../../projects'
import { bindTools, ok, fail, requireText, optionalText, optionalStrings, type ToolHandler, type ToolResult } from '../../core/result'

const SCHEMAS: Anthropic.Tool[] = [
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

const NO_ACTIVE_PROJECT = 'Nenhum projeto ativo. Use set_active_project primeiro.'

function clock(d: Date): string {
  return d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
}

function workSession(action: unknown, notes: string): ToolResult {
  const active = getActiveProject()
  if (!active) return fail(NO_ACTIVE_PROJECT)

  switch (action) {
    case 'start': {
      const session = startSession(active.id, notes)
      if (!session) return fail('Erro ao iniciar sessão.')
      return ok(`Sessão iniciada para "${active.name}" às ${clock(new Date())}. [${session.id}]`, session)
    }
    case 'stop': {
      const open = getOpenSession(active.id)
      if (!open) return fail('Nenhuma sessão aberta para este projeto.')
      const ended = endSession(open.id, notes)
      if (!ended) return fail('Erro ao encerrar sessão.')
      const capNote = ended.capped ? ` A sessão ficou aberta além de ${MAX_SESSION_MINUTES / 60}h e foi registrada no teto.` : ''
      return ok(`Sessão encerrada: ${ended.durationMinutes} minutos trabalhados em "${active.name}".${capNote}`, ended)
    }
    case 'status': {
      const open = getOpenSession(active.id)
      if (!open) return ok(`Nenhuma sessão aberta para "${active.name}".`, null)
      const status = openSessionStatus(open)
      const staleNote = status.stale ? ` Aberta há mais de ${MAX_SESSION_MINUTES / 60}h: provavelmente esquecida; ao encerrar, conta ${MAX_SESSION_MINUTES / 60}h.` : ''
      return ok(`Sessão aberta: "${active.name}" — ${status.elapsedMinutes} minutos (desde ${clock(new Date(open.startedAt))}).${staleNote}`, status)
    }
    default:
      return fail('action must be start, stop, or status.')
  }
}

const HANDLERS: Record<string, ToolHandler> = {
  set_active_project: (input) => {
    const ref = requireText(input, 'name_or_id')
    if (!ref) return fail('name_or_id is required.')
    if (ref === 'auto') {
      const detected = autoDetectProject(process.cwd())
      if (!detected) return fail('Nenhum projeto detectado no diretório atual (não é um repositório git).')
      setActiveProject(detected.id)
      return ok(`Projeto ativo: "${detected.name}" (${detected.path}) — auto-detectado [${detected.id}]`, detected)
    }
    const project = setActiveProject(ref)
    return project
      ? ok(`Projeto ativo: "${project.name}" (${project.path}) [${project.id}]`, project)
      : fail(`Projeto não encontrado: "${ref}". Use list_projects para listar ou add_project para criar.`)
  },
  report_work_progress: async (input) => {
    const period = (input.period as 'today' | 'week' | 'month') || 'today'
    const lang = (input.lang as 'pt' | 'en') || 'pt'
    const targetId = optionalText(input, 'project') ?? getActiveProject()?.id
    if (!targetId) return fail(NO_ACTIVE_PROJECT)
    const report = await generateWorkReport(targetId, period, lang)
    return report ? ok(report.markdown) : fail(`Projeto não encontrado: "${targetId}"`)
  },
  manage_work_session: (input) => workSession(input.action, optionalText(input, 'notes') ?? ''),
  add_project: (input) => {
    const name = requireText(input, 'name')
    if (!name) return fail('name is required.')
    const rawPath = requireText(input, 'path')
    if (!rawPath) return fail('path is required.')
    const checked = checkProjectPath(rawPath)
    if (!checked.ok) return fail(checked.error)
    const project = addProject(
      name, checked.path, optionalText(input, 'description') ?? '',
      optionalStrings(input, 'tags') ?? [], optionalStrings(input, 'tech_stack') ?? [],
    )
    return ok(`Projeto registrado: "${project.name}" (${project.path}) [${project.id}]`, project)
  },
  list_projects: (input) => {
    const projects = listProjects(input.active_only === true)
    return ok(formatProjectList(projects), projects)
  },
  fetch_opportunities: (input) => {
    const opps = listOpportunities(input.status as Opportunity['status'] | undefined, optionalStrings(input, 'tech'))
    return ok(formatOpportunityList(opps), opps)
  },
  add_opportunity: (input) => {
    const title = requireText(input, 'title')
    if (!title) return fail('title is required.')
    const desc = requireText(input, 'description')
    if (!desc) return fail('description is required.')
    const source = requireText(input, 'source')
    if (!source) return fail('source is required.')
    const priority = (input.priority as 'alta' | 'media' | 'baixa') || 'media'
    const opp = addOpportunity(
      title, desc, source, optionalStrings(input, 'tech_required') ?? [], priority,
      optionalText(input, 'deadline') ?? null,
    )
    return ok(`Oportunidade registrada: "${opp.title}" (${opp.priority}) [${opp.id}]`, opp)
  },
  update_opportunity_status: (input) => {
    const id = requireText(input, 'id')
    if (!id) return fail('id is required.')
    const status = input.status as Opportunity['status']
    const opp = updateOpportunityStatus(id, status)
    return opp ? ok(`Oportunidade atualizada: "${opp.title}" -> ${status}`, opp) : fail(`Oportunidade não encontrada: "${id}"`)
  },
}

export const PROJECT_TOOLS = bindTools(SCHEMAS, HANDLERS, ['report_work_progress', 'list_projects', 'fetch_opportunities'])
