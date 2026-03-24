import { describe, test, expect, beforeEach } from 'bun:test'
import { initTasks, stopTasks, addTask, completeTask, removeTask, listTasks, formatTaskList, parseTime } from '../src/tasks'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

describe('tasks', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'smolerclaw-test-'))
    initTasks(tmpDir, () => {}) // no-op notification
  })

  test('addTask creates a task', () => {
    const task = addTask('buy bread')
    expect(task.id).toBeTruthy()
    expect(task.title).toBe('buy bread')
    expect(task.done).toBe(false)
    expect(task.dueAt).toBeNull()
  })

  test('addTask with due time', () => {
    const due = new Date(Date.now() + 60_000)
    const task = addTask('meeting', due)
    expect(task.dueAt).toBeTruthy()
    expect(new Date(task.dueAt!).getTime()).toBeCloseTo(due.getTime(), -3)
  })

  test('listTasks returns pending tasks', () => {
    addTask('task 1')
    addTask('task 2')
    const tasks = listTasks()
    expect(tasks.length).toBe(2)
  })

  test('completeTask marks task as done', () => {
    const task = addTask('do thing')
    const completed = completeTask(task.id)
    expect(completed?.done).toBe(true)

    const pending = listTasks()
    expect(pending.length).toBe(0)
  })

  test('completeTask by partial title', () => {
    addTask('buy groceries')
    const completed = completeTask('groceries')
    expect(completed).toBeTruthy()
    expect(completed?.done).toBe(true)
  })

  test('removeTask by id', () => {
    const task = addTask('temp task')
    expect(removeTask(task.id)).toBe(true)
    expect(listTasks().length).toBe(0)
  })

  test('removeTask returns false for unknown', () => {
    expect(removeTask('nonexistent')).toBe(false)
  })

  test('listTasks with showDone', () => {
    const task = addTask('done task')
    completeTask(task.id)
    addTask('pending task')

    expect(listTasks(false).length).toBe(1)
    expect(listTasks(true).length).toBe(2)
  })

  test('formatTaskList shows tasks', () => {
    addTask('item A')
    addTask('item B')
    const text = formatTaskList(listTasks())
    expect(text).toContain('item A')
    expect(text).toContain('item B')
    expect(text).toContain('[ ]')
  })

  test('formatTaskList empty', () => {
    const text = formatTaskList([])
    expect(text).toContain('Nenhuma tarefa')
  })

  // Cleanup
  test('stopTasks does not throw', () => {
    expect(() => stopTasks()).not.toThrow()
  })
})

describe('parseTime', () => {
  test('parses "18h"', () => {
    const result = parseTime('18h')
    expect(result).toBeTruthy()
    expect(result!.getHours()).toBe(18)
    expect(result!.getMinutes()).toBe(0)
  })

  test('parses "18h30"', () => {
    const result = parseTime('18h30')
    expect(result).toBeTruthy()
    expect(result!.getHours()).toBe(18)
    expect(result!.getMinutes()).toBe(30)
  })

  test('parses "18:30"', () => {
    const result = parseTime('18:30')
    expect(result).toBeTruthy()
    expect(result!.getHours()).toBe(18)
    expect(result!.getMinutes()).toBe(30)
  })

  test('parses "9h"', () => {
    const result = parseTime('9h')
    expect(result).toBeTruthy()
    expect(result!.getHours()).toBe(9)
  })

  test('parses "em 30 minutos"', () => {
    const now = new Date()
    const result = parseTime('em 30 minutos')
    expect(result).toBeTruthy()
    const diff = result!.getTime() - now.getTime()
    // Should be approximately 30 minutes from now (allow 5s tolerance)
    expect(diff).toBeGreaterThan(29 * 60_000)
    expect(diff).toBeLessThan(31 * 60_000)
  })

  test('parses "em 2 horas"', () => {
    const now = new Date()
    const result = parseTime('em 2 horas')
    expect(result).toBeTruthy()
    const diff = result!.getTime() - now.getTime()
    expect(diff).toBeGreaterThan(119 * 60_000)
    expect(diff).toBeLessThan(121 * 60_000)
  })

  test('parses "amanha 9h"', () => {
    const result = parseTime('amanha 9h')
    expect(result).toBeTruthy()
    const tomorrow = new Date()
    tomorrow.setDate(tomorrow.getDate() + 1)
    expect(result!.getDate()).toBe(tomorrow.getDate())
    expect(result!.getHours()).toBe(9)
  })

  test('returns null for invalid input', () => {
    expect(parseTime('hello world')).toBeNull()
    expect(parseTime('')).toBeNull()
  })
})
