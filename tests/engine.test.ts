import { describe, test, expect } from 'bun:test'
import { canonicalJson, canonicalHash } from '../src/engine/canonical'
import { InputValidator } from '../src/engine/validate'
import { decide, decideWorkflowStep, isListed, policyFromEnv, capturePolicyEnv, DEFAULT_POLICY, type EnginePolicy } from '../src/engine/policy'
import { createEngine, type CatalogTool } from '../src/engine/engine'
import type { AuditRecord } from '../src/engine/audit'
import { exitCodeFor, isEngineCommand, parseEngineArgs, splitEngineArgs } from '../src/modes/engine-mode'
import { selfCommand } from '../src/engine/self-command'
import { assessToolRisk } from '../src/tool-safety'
import { ok, fail, type ToolResult } from '../src/core/result'

const CATALOG: CatalogTool[] = [
  {
    name: 'list_tasks',
    description: 'List tasks',
    input_schema: { type: 'object', properties: { all: { type: 'boolean' } }, required: [] },
  },
  {
    name: 'create_task',
    description: 'Create a task',
    input_schema: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] },
  },
  {
    name: 'run_command',
    description: 'Run a shell command',
    input_schema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
  },
]

function fixedClock(): () => Date {
  const t = new Date('2026-11-18T12:00:00.000Z')
  return () => t
}

function buildEngine(
  policy: EnginePolicy = DEFAULT_POLICY,
  execute: (name: string) => Promise<ToolResult> = async (n) => ok(`ran ${n}`),
) {
  const records: AuditRecord[] = []
  const calls: string[] = []
  const engine = createEngine({
    catalog: () => CATALOG,
    execute: async (name) => {
      calls.push(name)
      return execute(name)
    },
    policy,
    audit: { write: (r) => records.push(r) },
    clock: fixedClock(),
  })
  return { engine, records, calls }
}

describe('canonical JSON', () => {
  test('is independent of key order', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe(canonicalJson({ a: { c: 3, d: 2 }, b: 1 }))
  })

  test('drops undefined values and keeps array order', () => {
    expect(canonicalJson({ a: undefined, b: [3, 1] })).toBe('{"b":[3,1]}')
  })

  test('hash is stable', () => {
    expect(canonicalHash({ x: 1, y: 2 })).toBe(canonicalHash({ y: 2, x: 1 }))
    expect(canonicalHash({ x: 1 })).not.toBe(canonicalHash({ x: 2 }))
  })
})

describe('InputValidator', () => {
  const validator = new InputValidator()

  test('accepts valid input', () => {
    expect(validator.validate(CATALOG[1], { title: 'a' }).valid).toBe(true)
  })

  test('reports missing required and wrong types', () => {
    const result = validator.validate(CATALOG[1], { title: 42 })
    expect(result.valid).toBe(false)
    expect(result.errors.join(' ')).toContain('/title')
    expect(validator.validate(CATALOG[1], {}).errors.join(' ')).toContain('title')
  })

  test('fails closed on malformed schemas', () => {
    const broken = { name: 'broken', input_schema: { type: 'not-a-type' } }
    expect(validator.canValidate(broken)).toBe(false)
    expect(validator.validate(broken, { anything: true }).valid).toBe(false)
  })

  test('recompiles when a tool schema reference changes', () => {
    const v1 = { name: 'dynamic', input_schema: { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] } }
    const v2 = { name: 'dynamic', input_schema: { type: 'object', properties: { b: { type: 'number' } }, required: ['b'] } }
    expect(validator.validate(v1, { a: 'ok' }).valid).toBe(true)
    expect(validator.validate(v2, { a: 'ok' }).valid).toBe(false)
    expect(validator.validate(v2, { b: 42 }).valid).toBe(true)
  })
})

describe('policy', () => {
  test('dangerous is always denied', () => {
    const d = decide(DEFAULT_POLICY, 'run_command', { command: 'rm -rf /' })
    expect(d.allowed).toBe(false)
    expect(d.risk).toBe('dangerous')
  })

  test('read-only mode allows safe tools and denies moderate ones', () => {
    const readonly = { ...DEFAULT_POLICY, allowModerate: false }
    expect(decide(readonly, 'list_tasks', {}).allowed).toBe(true)
    expect(decide(readonly, 'create_task', { title: 'x' }).allowed).toBe(false)
  })

  test('allow and deny lists', () => {
    expect(isListed({ ...DEFAULT_POLICY, deny: ['list_tasks'] }, 'list_tasks')).toBe(false)
    expect(isListed({ ...DEFAULT_POLICY, allow: ['create_task'] }, 'list_tasks')).toBe(false)
    expect(isListed({ ...DEFAULT_POLICY, allow: ['create_task'] }, 'create_task')).toBe(true)
  })

  test('policyFromEnv parses variables', () => {
    const p = policyFromEnv({ SMOLERCLAW_READONLY: '1', SMOLERCLAW_DENY: 'a, b', SMOLERCLAW_ALLOW: '' })
    expect(p).toEqual({ allowModerate: false, deny: ['a', 'b'], allow: [], allowSend: false, plugins: [] })
    expect(policyFromEnv({})).toEqual(DEFAULT_POLICY)
    expect(policyFromEnv({ SMOLERCLAW_ALLOW_SEND: '1', SMOLERCLAW_PLUGINS: 'x,y' })).toMatchObject({ allowSend: true, plugins: ['x', 'y'] })
  })

  test('sending email to third parties is denied unless explicitly allowed', () => {
    for (const name of ['m365_send_email', 'gws_send_email']) {
      const denied = decide(DEFAULT_POLICY, name, { to: 'a@b.c', subject: 's', body: 'b' })
      expect(denied.allowed).toBe(false)
      expect(denied.reason).toContain('SMOLERCLAW_ALLOW_SEND=1')
      expect(decide({ ...DEFAULT_POLICY, allowSend: true }, name, { to: 'a@b.c' }).allowed).toBe(true)
    }
    // Drafts never leave the machine and stay allowed.
    expect(decide(DEFAULT_POLICY, 'draft_email', { to: 'a@b.c', subject: 's', body: 'b' }).allowed).toBe(true)
  })

  test('captured policy env keeps only policy keys', () => {
    expect(capturePolicyEnv({ SMOLERCLAW_READONLY: '1', PATH: 'x', SMOLERCLAW_DENY: '' })).toEqual({ SMOLERCLAW_READONLY: '1' })
  })

  test('workflow step policy enforces read-only, dangerous commands and deny lists', () => {
    const readonly = { ...DEFAULT_POLICY, allowModerate: false }
    expect(decideWorkflowStep(readonly, 'log', 'hello').allowed).toBe(true)
    expect(decideWorkflowStep(readonly, 'wait', '1').allowed).toBe(true)
    expect(decideWorkflowStep(readonly, 'open_app', 'vscode').allowed).toBe(false)
    expect(decideWorkflowStep(readonly, 'notify', 'hi').allowed).toBe(false)
    expect(decideWorkflowStep(readonly, 'run_command', 'echo ok').allowed).toBe(false)
    expect(decideWorkflowStep(DEFAULT_POLICY, 'run_command', 'rm -rf /').allowed).toBe(false)
    expect(decideWorkflowStep(DEFAULT_POLICY, 'run_command', 'echo ok').allowed).toBe(true)
    expect(decideWorkflowStep({ ...DEFAULT_POLICY, deny: ['run_command'] }, 'run_command', 'echo ok').allowed).toBe(false)
    expect(decideWorkflowStep(DEFAULT_POLICY, 'unknown_step', 'x').allowed).toBe(false)
  })
})

describe('tool-safety read-only classification', () => {
  test('known reads are safe, state-changing tools are not', () => {
    expect(assessToolRisk('list_tasks', {}).level).toBe('safe')
    expect(assessToolRisk('search_notes', {}).level).toBe('safe')
    expect(assessToolRisk('check_energy', {}).level).toBe('moderate')
    expect(assessToolRisk('create_task', {}).level).toBe('moderate')
    expect(assessToolRisk('create_task', {}).reason).toBe('changes state: create_task')
    expect(assessToolRisk('gws_list_emails', {}).level).toBe('safe')
  })
})

describe('engine pipeline', () => {
  test('executes a valid, allowed call and audits it', async () => {
    const { engine, records, calls } = buildEngine()
    const result = await engine.invoke('create_task', { title: 'a' })
    expect(result).toMatchObject({ ok: true, decision: 'executed', risk: 'moderate', output: 'ran create_task' })
    expect(calls).toEqual(['create_task'])
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({
      tool: 'create_task',
      decision: 'executed',
      ok: true,
      ts: '2026-11-18T12:00:00.000Z',
    })
    expect(records[0]).not.toHaveProperty('input')
  })

  test('unknown tool never executes', async () => {
    const { engine, calls } = buildEngine()
    const result = await engine.invoke('nope', {})
    expect(result.decision).toBe('unknown')
    expect(calls).toEqual([])
  })

  test('non-object and schema-invalid input never executes', async () => {
    const { engine, calls } = buildEngine()
    expect((await engine.invoke('create_task', [1, 2])).decision).toBe('invalid')
    expect((await engine.invoke('create_task', { title: 7 })).decision).toBe('invalid')
    expect(calls).toEqual([])
  })

  test('policy denial never executes and never logs the raw argument', async () => {
    const { engine, calls, records } = buildEngine()
    const result = await engine.invoke('run_command', { command: 'rm -rf /' })
    expect(result.decision).toBe('denied')
    expect(calls).toEqual([])
    expect(JSON.stringify(records)).not.toContain('rm -rf')
  })

  test('distinct non-object inputs hash differently', async () => {
    const { engine } = buildEngine()
    const a = await engine.invoke('create_task', [1])
    const b = await engine.invoke('create_task', 'text')
    expect(a.inputHash).not.toBe(b.inputHash)
  })

  test('tool errors and throws become ok=false', async () => {
    const failing = buildEngine(DEFAULT_POLICY, async () => fail('Pessoa não encontrada'))
    const failed = await failing.engine.invoke('list_tasks', {})
    expect(failed.ok).toBe(false)
    expect(failed.output).toBe('Error: Pessoa não encontrada')
    const throwing = buildEngine(DEFAULT_POLICY, async () => {
      throw new Error('kaput')
    })
    const result = await throwing.engine.invoke('list_tasks', {})
    expect(result.ok).toBe(false)
    expect(result.output).toBe('Error: kaput')
  })

  test('passes structured data through on success only', async () => {
    const { engine } = buildEngine(DEFAULT_POLICY, async () => ok('2 tarefas', [{ id: 'a' }, { id: 'b' }]))
    expect((await engine.invoke('list_tasks', {})).data).toEqual([{ id: 'a' }, { id: 'b' }])
  })

  test('same input yields the same result and hash', async () => {
    const { engine } = buildEngine()
    const a = await engine.invoke('create_task', { title: 'x' })
    const b = await engine.invoke('create_task', { title: 'x' })
    expect(a).toEqual(b)
  })

  test('listTools is sorted, deduplicated and respects lists', () => {
    const engine = createEngine({
      catalog: () => [CATALOG[2], CATALOG[0], CATALOG[0], CATALOG[1]],
      execute: async () => ok(''),
      policy: { ...DEFAULT_POLICY, deny: ['run_command'] },
      audit: { write: () => {} },
    })
    expect(engine.listTools().map((t) => t.name)).toEqual(['create_task', 'list_tasks'])
  })

  test('dry-run validates and checks policy without executing', async () => {
    const { engine, records, calls } = buildEngine()
    const result = await engine.invoke('create_task', { title: 'a' }, { dryRun: true })
    expect(result).toMatchObject({ ok: true, decision: 'dry-run', risk: 'moderate' })
    expect(calls).toEqual([])
    expect(records[0]).toMatchObject({ tool: 'create_task', decision: 'dry-run', ok: true, dryRun: true })
  })

  test('timeout aborts hanging tool execution cleanly', async () => {
    const engine = createEngine({
      catalog: () => CATALOG,
      execute: () => new Promise(() => {}),
      policy: DEFAULT_POLICY,
      audit: { write: () => {} },
      timeoutMs: 25,
    })
    const result = await engine.invoke('list_tasks', {})
    expect(result.ok).toBe(false)
    expect(result.decision).toBe('executed')
    expect(result.output).toContain('timed out')
  })

  test('rate limit denies excess invocations and records runId/caller in audit', async () => {
    const records: AuditRecord[] = []
    let count = 0
    const engine = createEngine({
      catalog: () => CATALOG,
      execute: async () => ok('ok'),
      policy: DEFAULT_POLICY,
      audit: { write: (r) => records.push(r) },
      runId: 'run-123',
      caller: 'mcp',
      checkRateLimit: () => ++count <= 1,
    })
    expect((await engine.invoke('list_tasks', {})).ok).toBe(true)
    const denied = await engine.invoke('list_tasks', {})
    expect(denied.decision).toBe('denied')
    expect(denied.output).toContain('rate limit')
    expect(records[0]).toMatchObject({ runId: 'run-123', caller: 'mcp', decision: 'executed' })
    expect(records[1]).toMatchObject({ runId: 'run-123', caller: 'mcp', decision: 'denied' })
  })
})

describe('engine CLI helpers', () => {
  const base = { tool: 't', output: '', inputHash: '', durationMs: 0, risk: 'safe' as const }

  test('exit codes map decisions', () => {
    expect(exitCodeFor({ ...base, ok: true, decision: 'executed' })).toBe(0)
    expect(exitCodeFor({ ...base, ok: false, decision: 'executed' })).toBe(1)
    expect(exitCodeFor({ ...base, ok: false, decision: 'invalid' })).toBe(2)
    expect(exitCodeFor({ ...base, ok: false, decision: 'unknown' })).toBe(2)
    expect(exitCodeFor({ ...base, ok: false, decision: 'denied' })).toBe(3)
  })

  test('flags never leak into positionals', () => {
    expect(splitEngineArgs(['list_tasks', '--json'])).toEqual({ asJson: true, positional: ['list_tasks'] })
    expect(splitEngineArgs(['--json', 'create_task', '{}'])).toEqual({ asJson: true, positional: ['create_task', '{}'] })
    expect(splitEngineArgs(['search_memos', '-'])).toEqual({ asJson: false, positional: ['search_memos', '-'] })
  })

  test('parseEngineArgs handles --data-dir, --dry-run and --timeout', () => {
    expect(parseEngineArgs(['create_task', '{}', '--json', '--dry-run', '--data-dir', '/tmp/s', '--timeout=5000']))
      .toEqual({
        asJson: true,
        dryRun: true,
        dataDir: '/tmp/s',
        timeoutMs: 5000,
        positional: ['create_task', '{}'],
      })
    expect(() => parseEngineArgs(['--data-dir'])).toThrow('--data-dir requires a path')
    expect(() => parseEngineArgs(['--timeout', '-1'])).toThrow('--timeout')
    expect(() => parseEngineArgs(['--bogus'])).toThrow('unknown option')
  })

  test('recognizes engine commands only', () => {
    expect(isEngineCommand('run')).toBe(true)
    expect(isEngineCommand('mcp')).toBe(true)
    expect(isEngineCommand('ui')).toBe(false)
    expect(isEngineCommand(undefined)).toBe(false)
  })

  test('selfCommand distinguishes script runs from compiled binaries', () => {
    expect(selfCommand({ execPath: '/bin/bun', argv: ['/bin/bun', '/app/src/index.ts'] }))
      .toEqual(['/bin/bun', '/app/src/index.ts'])
    expect(selfCommand({ execPath: '/opt/smolerclaw', argv: ['/opt/smolerclaw', 'workflow'] }))
      .toEqual(['/opt/smolerclaw'])
    expect(selfCommand({ execPath: '/opt/smolerclaw', argv: ['/opt/smolerclaw'] })).toEqual(['/opt/smolerclaw'])
  })
})

describe('PowerShell quoting', () => {
  test('doubles ASCII and typographic single quotes', async () => {
    const { psSingleQuoteEscape } = await import('../src/utils/windows-executor')
    expect(psSingleQuoteEscape("a'b")).toBe("a''b")
    expect(psSingleQuoteEscape('x’; evil; ‘')).toBe('x’’; evil; ‘‘')
  })
})
