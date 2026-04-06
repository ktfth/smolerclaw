/**
 * M365 To Do — task lists and tasks.
 *
 * Wraps m365 CLI To Do commands with caching.
 */

import { executeM365 } from './executor'
import { cacheGet, cacheSet, cacheInvalidatePrefix } from './cache'
import type { M365TodoList, M365TodoTask, M365CreateTodoParams, M365Result } from './types'

/**
 * List all To Do task lists.
 */
export async function listTodoLists(
  options: { fresh?: boolean } = {},
): Promise<M365Result<M365TodoList[]>> {
  const cacheKey = 'todo:lists'

  if (!options.fresh) {
    const cached = cacheGet<M365TodoList[]>(cacheKey)
    if (cached) {
      return { success: true, data: cached, error: null, raw: '', duration: 0 }
    }
  }

  const result = await executeM365<M365TodoList[]>(['todo', 'list', 'list'])

  if (result.success && result.data) {
    cacheSet(cacheKey, result.data, 'todo')
  }

  return result
}

/**
 * List tasks in a To Do list. If no listId, uses the default list.
 */
export async function listTodoTasks(
  listId?: string,
  options: { fresh?: boolean } = {},
): Promise<M365Result<M365TodoTask[]>> {
  const cacheKey = `todo:tasks:${listId ?? 'default'}`

  if (!options.fresh) {
    const cached = cacheGet<M365TodoTask[]>(cacheKey)
    if (cached) {
      return { success: true, data: cached, error: null, raw: '', duration: 0 }
    }
  }

  const args = ['todo', 'task', 'list']
  if (listId) {
    args.push('--listId', listId)
  } else {
    args.push('--listName', 'Tasks')
  }

  const result = await executeM365<M365TodoTask[]>(args)

  if (result.success && result.data) {
    cacheSet(cacheKey, result.data, 'todo')
  }

  return result
}

/**
 * Create a new To Do task.
 */
export async function createTodo(params: M365CreateTodoParams): Promise<M365Result<string>> {
  const args = ['todo', 'task', 'add', '--title', params.title]

  if (params.listId) args.push('--listId', params.listId)
  if (params.dueDateTime) args.push('--dueDateTime', params.dueDateTime)
  if (params.importance) args.push('--importance', params.importance)

  const result = await executeM365<string>(args, { jsonOutput: false })

  if (result.success) {
    cacheInvalidatePrefix('todo:')
  }

  return result
}

/**
 * Mark a To Do task as completed.
 */
export async function completeTodo(
  taskId: string,
  listId?: string,
): Promise<M365Result<string>> {
  const args = ['todo', 'task', 'set', '--id', taskId, '--status', 'completed']
  if (listId) args.push('--listId', listId)

  const result = await executeM365<string>(args, { jsonOutput: false })

  if (result.success) {
    cacheInvalidatePrefix('todo:')
  }

  return result
}

/**
 * Format task list for TUI display.
 */
export function formatTodoList(tasks: M365TodoTask[]): string {
  if (tasks.length === 0) return 'No tasks found.'

  const pending = tasks.filter((t) => t.status !== 'completed')
  const completed = tasks.filter((t) => t.status === 'completed')

  const lines = ['--- To Do ---']

  if (pending.length > 0) {
    for (const task of pending) {
      const due = task.dueDateTime
        ? ` (due: ${new Date(task.dueDateTime).toLocaleDateString('pt-BR')})`
        : ''
      const imp = task.importance === 'high' ? ' !' : ''
      lines.push(`  [ ] ${task.title}${due}${imp}`)
    }
  }

  if (completed.length > 0) {
    lines.push(`  --- ${completed.length} completed ---`)
  }

  lines.push('-------------')
  return lines.join('\n')
}

/**
 * Format list of To Do lists for TUI display.
 */
export function formatTodoLists(lists: M365TodoList[]): string {
  if (lists.length === 0) return 'No task lists found.'

  const lines = ['--- To Do Lists ---']
  for (const list of lists) {
    const shared = list.isShared ? ' (shared)' : ''
    lines.push(`  ${list.displayName}${shared} [${list.id.slice(-6)}]`)
  }
  lines.push('-------------------')
  return lines.join('\n')
}
