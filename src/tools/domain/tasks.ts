import type Anthropic from '@anthropic-ai/sdk'
import { addTask, completeTask, listTasks, formatTaskList, parseTime } from '../../tasks'
import { getProject, getActiveProject, type Project } from '../../projects'
import { bindTools, ok, fail, requireText, optionalText, type ToolHandler } from '../../core/result'

const PROJECT_PARAM = {
  type: 'string',
  description: 'Project name or ID, or "ativo" for the active project. Optional.',
}

/** Resolve the optional project field: undefined when absent, an error string when unknown. */
function resolveProject(input: Record<string, unknown>): Project | string | undefined {
  const ref = optionalText(input, 'project')
  if (!ref) return undefined
  const project = ref === 'ativo' || ref === 'active' ? getActiveProject() : getProject(ref)
  return project ?? (ref === 'ativo' || ref === 'active' ? 'Nenhum projeto ativo.' : `Projeto não encontrado: "${ref}"`)
}

const SCHEMAS: Anthropic.Tool[] = [
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
        project: { ...PROJECT_PARAM, description: 'Link the task to a project: name or ID, or "ativo" for the active project. Optional; omit for personal tasks.' },
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
        project: { ...PROJECT_PARAM, description: 'Only tasks linked to this project: name or ID, or "ativo". Optional.' },
      },
      required: [],
    },
  },
]

const HANDLERS: Record<string, ToolHandler> = {
  create_task: (input) => {
    const title = requireText(input, 'title')
    if (!title) return fail('title is required.')
    const timeStr = input.time as string | undefined
    const dueTime = timeStr ? parseTime(timeStr) : null
    if (timeStr && !dueTime) return fail(`could not parse time "${timeStr}".`)
    const project = resolveProject(input)
    if (typeof project === 'string') return fail(project)
    const task = addTask(title, dueTime ?? undefined, project?.id)
    const dueInfo = dueTime
      ? ` — lembrete: ${dueTime.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`
      : ''
    const projectInfo = project ? ` — projeto: ${project.name}` : ''
    return ok(`Tarefa criada: "${task.title}"${dueInfo}${projectInfo}  [${task.id}]`, task)
  },
  complete_task: (input) => {
    const ref = requireText(input, 'reference')
    if (!ref) return fail('reference is required.')
    const task = completeTask(ref)
    return task ? ok(`Concluída: "${task.title}"`, task) : fail(`Tarefa não encontrada: "${ref}"`)
  },
  list_tasks: (input) => {
    const project = resolveProject(input)
    if (typeof project === 'string') return fail(project)
    const tasks = listTasks(input.show_done === true, project?.id)
    return ok(formatTaskList(tasks), tasks)
  },
}

export const TASK_TOOLS = bindTools(SCHEMAS, HANDLERS, ['list_tasks'])
