import { describe, test, expect, beforeEach } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { bindTools, ok, fail, toChatText, fromLegacyText } from '../src/core/result'
import { TOOLS, engineCatalog, executeToolResult, executeTool } from '../src/tools'
import { READ_ONLY_TOOL_NAMES, CATALOG_TOOL_NAMES } from '../src/tools/read-only'
import { initPeople } from '../src/people'
import { initTasks } from '../src/tasks'
import { initProjects, addProject, setActiveProject } from '../src/projects'
import { initNotes, closeNotes } from '../src/notes'

const WORKSTATION = ['read_file', 'write_file', 'edit_file', 'search_files', 'find_files', 'list_directory', 'run_command', 'fetch_url']
const schema = (name: string) => ({ name, description: name, input_schema: { type: 'object' as const, properties: {} } })

describe('ToolResult helpers', () => {
  test('chat text prefixes failures exactly once', () => {
    expect(toChatText(ok('feito'))).toBe('feito')
    expect(toChatText(fail('não encontrado'))).toBe('Error: não encontrado')
    expect(toChatText(fail('Error: boom'))).toBe('Error: boom')
  })

  test('legacy text adapter follows the Error: convention', () => {
    expect(fromLegacyText('Error: x').ok).toBe(false)
    expect(fromLegacyText('tudo certo').ok).toBe(true)
  })

  test('ok keeps data only when given', () => {
    expect(ok('a')).toEqual({ ok: true, text: 'a' })
    expect(ok('a', [1])).toEqual({ ok: true, text: 'a', data: [1] })
  })
})

describe('bindTools', () => {
  const run = () => ok('')

  test('pairs schemas with handlers and read-only flags', () => {
    const entries = bindTools([schema('a'), schema('b')], { a: run, b: run }, ['b'])
    expect(entries.map((e) => [e.schema.name, e.readOnly])).toEqual([['a', false], ['b', true]])
  })

  test('rejects any mismatch at load time', () => {
    expect(() => bindTools([schema('a')], {})).toThrow('schema without handler: a')
    expect(() => bindTools([], { a: run })).toThrow('handler without schema: a')
    expect(() => bindTools([schema('a')], { a: run }, ['z'])).toThrow('read-only name without schema: z')
  })
})

describe('catalog', () => {
  test('engine catalog excludes workstation primitives; chat catalog has them', () => {
    const engineNames = engineCatalog().map((t) => t.name)
    for (const name of WORKSTATION) {
      expect(engineNames).not.toContain(name)
      expect(TOOLS.map((t) => t.name)).toContain(name)
    }
  })

  test('engine catalog is the personal-management core with unique names', () => {
    const names = engineCatalog().map((t) => t.name)
    expect(new Set(names).size).toBe(names.length)
    expect(names.length).toBe(CATALOG_TOOL_NAMES.size)
    for (const core of ['create_task', 'list_people', 'save_note', 'record_transaction', 'schedule_job', 'gws_list_emails']) {
      expect(names).toContain(core)
    }
    for (const cut of ['open_map', 'pitwall_benchmark', 'docker_status', 'get_news', 'check_energy', 'propose_plan']) {
      expect(names).not.toContain(cut)
    }
  })

  test('read-only names are a subset of the catalog and exclude writes', () => {
    for (const name of READ_ONLY_TOOL_NAMES) expect(CATALOG_TOOL_NAMES.has(name)).toBe(true)
    for (const write of ['create_task', 'record_transaction', 'draft_email', 'm365_send_email', 'vault_backup']) {
      expect(READ_ONLY_TOOL_NAMES.has(write)).toBe(false)
    }
  })

  test('plugins reach the engine only when allow-listed', () => {
    TOOLS.push({ name: 'demo_plugin', description: 'x', input_schema: { type: 'object', properties: {} } })
    try {
      expect(engineCatalog().map((t) => t.name)).not.toContain('demo_plugin')
      expect(engineCatalog(new Set(['demo_plugin', 'run_command'])).map((t) => t.name)).toEqual(
        expect.arrayContaining(['demo_plugin']),
      )
      // Allow-listing never re-exposes a workstation primitive.
      expect(engineCatalog(new Set(['run_command'])).map((t) => t.name)).not.toContain('run_command')
    } finally {
      TOOLS.pop()
    }
  })

  test('report_work_progress can no longer write arbitrary files', () => {
    const report = engineCatalog().find((t) => t.name === 'report_work_progress')
    expect(JSON.stringify(report?.input_schema)).not.toContain('save_to_file')
  })
})

describe('domain handlers report failure structurally', () => {
  beforeEach(() => {
    const dir = mkdtempSync(join(tmpdir(), 'smolerclaw-catalog-'))
    initPeople(dir)
    initTasks(dir, () => {})
    closeNotes()
    initNotes(dir)
  })

  test('not-found results are failures, not successes', async () => {
    expect((await executeToolResult('find_person_info', { name_or_id: 'ninguem' })).ok).toBe(false)
    expect((await executeToolResult('complete_task', { reference: 'nada' })).ok).toBe(false)
  })

  test('successful writes return the created record as data', async () => {
    const created = await executeToolResult('create_task', { title: 'pagar aluguel' })
    expect(created.ok).toBe(true)
    expect(created.ok && (created.data as { title: string }).title).toBe('pagar aluguel')

    const listed = await executeToolResult('list_tasks', {})
    expect(listed.ok && (listed.data as unknown[]).length).toBe(1)
  })

  test('unparseable times fail instead of silently dropping the reminder', async () => {
    const result = await executeToolResult('create_task', { title: 'x', time: 'quando der' })
    expect(result.ok).toBe(false)
  })

  test('chat entry point renders failures with the Error: prefix', async () => {
    expect(await executeTool('find_person_info', { name_or_id: 'ninguem' })).toBe('Error: Pessoa não encontrada: "ninguem"')
    expect(await executeTool('nope', {})).toBe('Error: unknown tool "nope"')
  })
})

describe('task tools — project link', () => {
  let projectId: string

  beforeEach(() => {
    const dir = mkdtempSync(join(tmpdir(), 'smolerclaw-catalog-'))
    initTasks(dir, () => {})
    initProjects(dir)
    projectId = addProject('harness', dir).id
  })

  test('create_task links a project by name', async () => {
    const created = await executeToolResult('create_task', { title: 'corrigir bug', project: 'harness' })
    expect(created.ok && (created.data as { projectId: string }).projectId).toBe(projectId)
  })

  test('create_task accepts "ativo" for the active project', async () => {
    setActiveProject(projectId)
    const created = await executeToolResult('create_task', { title: 'x', project: 'ativo' })
    expect(created.ok && (created.data as { projectId: string }).projectId).toBe(projectId)
  })

  test('create_task fails for an unknown project', async () => {
    expect((await executeToolResult('create_task', { title: 'x', project: 'nenhum' })).ok).toBe(false)
  })

  test('list_tasks filters by project', async () => {
    await executeToolResult('create_task', { title: 'do projeto', project: 'harness' })
    await executeToolResult('create_task', { title: 'pessoal' })
    const listed = await executeToolResult('list_tasks', { project: 'harness' })
    expect(listed.ok && (listed.data as { title: string }[]).map((t) => t.title)).toEqual(['do projeto'])
  })
})
