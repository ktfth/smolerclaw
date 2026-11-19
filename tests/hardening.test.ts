import { describe, test, expect, afterEach } from 'bun:test'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { isBatchShim, resolveCliBinary } from '../src/utils/resolve-bin'
import { checkProjectPath } from '../src/projects'
import { initScheduler, listJobs } from '../src/scheduler'
import { resolveAuthForProvider } from '../src/auth'
import { executeToolResult } from '../src/tools'
import { needsApproval, requiresExplicitConsent } from '../src/approval'

const tmp = (prefix: string) => mkdtempSync(join(tmpdir(), prefix))

describe('CLI binary resolution', () => {
  test('batch shims are recognised case-insensitively', () => {
    expect(isBatchShim('C:/x/m365.cmd')).toBe(true)
    expect(isBatchShim('C:/x/M365.BAT')).toBe(true)
    expect(isBatchShim('C:/x/m365.exe')).toBe(false)
  })

  test('a .cmd shim in the bin dir is never selected', () => {
    const dir = tmp('smolerclaw-bin-')
    const name = 'smolerclaw-fake-cli'
    writeFileSync(join(dir, `${name}.cmd`), '@echo off')
    expect(resolveCliBinary(name, dir)).toBeNull()
  })

  test('the platform executable in the bin dir is selected', () => {
    const dir = tmp('smolerclaw-bin-')
    const file = process.platform === 'win32' ? 'tool.exe' : 'tool'
    writeFileSync(join(dir, file), '')
    expect(resolveCliBinary('tool', dir)).toBe(join(dir, file))
  })
})

describe('project paths', () => {
  test('accepts only absolute, existing, local directories', () => {
    expect(checkProjectPath(process.cwd())).toEqual({ ok: true, path: process.cwd() })
    expect(checkProjectPath('relative/dir').ok).toBe(false)
    expect(checkProjectPath('//server/share').ok).toBe(false)
    expect(checkProjectPath('\\server\share').ok).toBe(false)
    expect(checkProjectPath(join(process.cwd(), 'package.json')).ok).toBe(false)
    expect(checkProjectPath(join(process.cwd(), 'does-not-exist')).ok).toBe(false)
  })
})

describe('scheduler', () => {
  test('legacy raw-command jobs are dropped on load', () => {
    const dir = tmp('smolerclaw-sched-')
    const base = { scheduleType: 'daily', time: '09:00', enabled: false, createdAt: '', updatedAt: '' }
    writeFileSync(join(dir, 'scheduler.json'), JSON.stringify([
      { ...base, id: 'a', name: 'evil', action: 'command', target: 'calc.exe', taskName: 'x_a' },
      { ...base, id: 'b', name: 'lembrete', action: 'toast', target: 'oi', taskName: 'x_b' },
    ]))
    initScheduler(dir, () => {}, { sync: false })
    expect(listJobs(true).map((j) => j.id)).toEqual(['b'])
    // The refused job is also purged from disk, not just hidden in memory.
    expect(readFileSync(join(dir, 'scheduler.json'), 'utf-8')).not.toContain('calc.exe')
  })
})

describe('anthropic auth', () => {
  const saved = process.env.ANTHROPIC_API_KEY
  afterEach(() => {
    if (saved === undefined) delete process.env.ANTHROPIC_API_KEY
    else process.env.ANTHROPIC_API_KEY = saved
  })

  test('uses ANTHROPIC_API_KEY and nothing else', () => {
    process.env.ANTHROPIC_API_KEY = ' sk-test '
    expect(resolveAuthForProvider('anthropic')).toMatchObject({ kind: 'api-key', token: 'sk-test', source: 'ANTHROPIC_API_KEY' })
    delete process.env.ANTHROPIC_API_KEY
    expect(() => resolveAuthForProvider('anthropic')).toThrow('ANTHROPIC_API_KEY')
  })
})

describe('chat approval', () => {
  test('sending email always needs explicit consent, other tools follow the mode', () => {
    expect(requiresExplicitConsent('m365_send_email')).toBe(true)
    expect(requiresExplicitConsent('gws_send_email')).toBe(true)
    expect(requiresExplicitConsent('draft_email')).toBe(false)
    // The default mode alone would not have asked: consent is what closes the gap.
    expect(needsApproval('confirm-writes', 'gws_send_email', 'moderate')).toBe(false)
  })
})

describe('chat-path validation', () => {
  test('schema violations fail before the handler runs', async () => {
    const bad = await executeToolResult('schedule_job', { name: 'x', time: '09:00', message: 'm', schedule_type: 'hourly' })
    expect(bad.ok).toBe(false)
    expect(bad.text).toContain('invalid input for "schedule_job"')
  })
})
