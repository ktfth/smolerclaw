import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { MANUAL_MODEL, parseModelString } from '../src/providers'
import { resolveModel } from '../src/models'
import { resolveAuthForModel } from '../src/auth'
import { initProvider } from '../src/init/providers'
import { initNotes, closeNotes } from '../src/notes'
import { initTasks, listTasks } from '../src/tasks'
import { initObsidian } from '../src/obsidian'
import {
  formatRunResult, formatToolList, invokeEngineTool, listEngineTools, parseRunArgs, readDayJournal,
} from '../src/commands/engine-commands'
import type { ChatEvent } from '../src/types'

let dataDir = ''

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'smolerclaw-manual-'))
  closeNotes()
  initNotes(dataDir)
  initTasks(dataDir, () => {})
})

afterEach(() => {
  initObsidian(undefined)
  closeNotes()
})

describe('manual provider', () => {
  test('needs no credentials and is reachable by name', () => {
    expect(parseModelString('manual').provider).toBe('manual')
    expect(resolveModel('Manual')).toBe(MANUAL_MODEL)
    expect(resolveAuthForModel(MANUAL_MODEL)?.provider).toBe('manual')
  })

  test('free text is answered locally with how to work by commands', async () => {
    const provider = initProvider({ auth: null }, MANUAL_MODEL, 1024, 'auto')
    expect(provider.getAssistantLabel()).toBe('Manual')
    const events: ChatEvent[] = []
    for await (const e of provider.chat([{ role: 'user', content: 'oi' }], '')) events.push(e)
    const text = events.flatMap((e) => (e.type === 'text' ? [e.text] : [])).join('')
    expect(text).toContain('/run')
    expect(events.at(-1)).toEqual({ type: 'done' })
  })
})

describe('run arguments', () => {
  test('tool with optional JSON object input', () => {
    expect(parseRunArgs('list_tasks')).toEqual({ ok: true, tool: 'list_tasks', input: {} })
    expect(parseRunArgs('create_task {"title":"pão"}')).toEqual({ ok: true, tool: 'create_task', input: { title: 'pão' } })
    expect(parseRunArgs('create_task [1]').ok).toBe(false)
    expect(parseRunArgs('create_task {title}').ok).toBe(false)
    expect(parseRunArgs('').ok).toBe(false)
  })
})

describe('engine from the TUI', () => {
  test('lists tools with what kind of change they make', () => {
    const text = formatToolList(listEngineTools(dataDir), 'task')
    expect(text).toContain('create_task')
    expect(text).toContain('list_tasks')
    expect(text).toMatch(/list_tasks\s+leitura/)
    expect(text).not.toContain('save_note')
  })

  test('a run goes through the engine: executed, audited and written to the vault journal', async () => {
    const vault = mkdtempSync(join(tmpdir(), 'smolerclaw-manual-vault-'))
    mkdirSync(join(vault, '.obsidian'))
    initObsidian(vault)

    const result = await invokeEngineTool(dataDir, 'create_task', { title: 'conferir o diário' })
    expect(result.ok).toBe(true)
    expect(formatRunResult(result)).toStartWith('✓ create_task — executado')
    expect(listTasks().map((t) => t.title)).toContain('conferir o diário')

    const audit = readdirSync(join(dataDir, 'audit'))
    expect(readFileSync(join(dataDir, 'audit', audit[0]), 'utf-8')).toContain('"caller":"tui"')
    expect(readDayJournal(dataDir)).toContain('Criou a tarefa “conferir o diário”')
  })

  test('a dry run validates without executing', async () => {
    const result = await invokeEngineTool(dataDir, 'create_task', { title: 'só validar' }, true)
    expect(formatRunResult(result)).toContain('validado, não executado')
    expect(listTasks()).toEqual([])
    const invalid = await invokeEngineTool(dataDir, 'create_task', {}, true)
    expect(formatRunResult(invalid)).toStartWith('✗ create_task — entrada inválida')
  })

  test('without a vault the day view falls back to the audit log', async () => {
    await invokeEngineTool(dataDir, 'create_task', { title: 'sem vault' })
    const day = readdirSync(join(dataDir, 'audit'))[0].slice('engine-'.length, -'.jsonl'.length)
    const text = readDayJournal(dataDir, day)
    expect(text).toContain('Log de auditoria')
    expect(text).toContain('Criou uma tarefa')
    expect(readDayJournal(dataDir, 'ontem')).toContain('Uso:')
  })
})
