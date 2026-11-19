import type Anthropic from '@anthropic-ai/sdk'
import { addTask, completeTask, listTasks, formatTaskList, parseTime } from '../../tasks'
import { bindTools, ok, fail, requireText, type ToolHandler } from '../../core/result'

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

const HANDLERS: Record<string, ToolHandler> = {
  create_task: (input) => {
    const title = requireText(input, 'title')
    if (!title) return fail('title is required.')
    const timeStr = input.time as string | undefined
    const dueTime = timeStr ? parseTime(timeStr) : null
    if (timeStr && !dueTime) return fail(`could not parse time "${timeStr}".`)
    const task = addTask(title, dueTime ?? undefined)
    const dueInfo = dueTime
      ? ` — lembrete: ${dueTime.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`
      : ''
    return ok(`Tarefa criada: "${task.title}"${dueInfo}  [${task.id}]`, task)
  },
  complete_task: (input) => {
    const ref = requireText(input, 'reference')
    if (!ref) return fail('reference is required.')
    const task = completeTask(ref)
    return task ? ok(`Concluída: "${task.title}"`, task) : fail(`Tarefa não encontrada: "${ref}"`)
  },
  list_tasks: (input) => {
    const tasks = listTasks(input.show_done === true)
    return ok(formatTaskList(tasks), tasks)
  },
}

export const TASK_TOOLS = bindTools(SCHEMAS, HANDLERS, ['list_tasks'])
