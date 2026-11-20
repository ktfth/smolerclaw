import { describe, test, expect, afterEach } from 'bun:test'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const ENTRY = join(import.meta.dir, '..', 'src', 'index.ts')
const dirsToClean: string[] = []

function makeSandboxDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'smolerclaw-e2e-'))
  dirsToClean.push(dir)
  return dir
}

afterEach(() => {
  while (dirsToClean.length > 0) {
    const dir = dirsToClean.pop()!
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // Best-effort cleanup on Windows
    }
  }
})

async function runCli(
  args: string[],
  envOverrides: Record<string, string | undefined> = {},
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn([process.execPath, ENTRY, ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, ...envOverrides },
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { exitCode, stdout: stdout.trim(), stderr: stderr.trim() }
}

function readAuditRecords(dataDir: string): Array<Record<string, unknown>> {
  const auditDir = join(dataDir, 'audit')
  const files = readdirSync(auditDir).filter((f) => f.endsWith('.jsonl'))
  return files.flatMap((f) =>
    readFileSync(join(auditDir, f), 'utf-8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>),
  )
}

describe('deterministic engine E2E (subprocess)', () => {
  test('tools --json lists catalog with readOnly/destructive/openWorld hints', async () => {
    const dataDir = makeSandboxDir()
    const res = await runCli(['tools', '--json', '--data-dir', dataDir])
    expect(res.exitCode).toBe(0)
    const tools = JSON.parse(res.stdout) as Array<{
      name: string
      readOnly: boolean
      destructive: boolean
      openWorld: boolean
    }>
    const listTasks = tools.find((t) => t.name === 'list_tasks')
    const deleteNote = tools.find((t) => t.name === 'delete_note')
    const m365Send = tools.find((t) => t.name === 'm365_send_email')
    expect(listTasks).toMatchObject({ readOnly: true, destructive: false, openWorld: false })
    expect(deleteNote).toMatchObject({ readOnly: false, destructive: true })
    expect(m365Send).toMatchObject({ readOnly: false, destructive: true, openWorld: true })
  }, 15_000)

  test('run supports --dry-run, real writes in isolated dataDir, and read-only policy denial', async () => {
    const dataDir = makeSandboxDir()

    // Dry-run validates without mutating state
    const dry = await runCli(
      ['run', 'create_task', '{"title":"nao salvar"}', '--dry-run', '--json', '--data-dir', dataDir],
      { SMOLERCLAW_RUN_ID: 'e2e-run-1' },
    )
    expect(dry.exitCode).toBe(0)
    expect(JSON.parse(dry.stdout)).toMatchObject({ ok: true, decision: 'dry-run' })

    const emptyList = await runCli(['run', 'list_tasks', '{}', '--json', '--data-dir', dataDir])
    expect(emptyList.exitCode).toBe(0)
    expect(JSON.parse(emptyList.stdout).data).toEqual([])

    // Real write persists inside isolated dataDir
    const created = await runCli(
      ['run', 'create_task', '{"title":"pagar luz"}', '--json'],
      { SMOLERCLAW_DATA_DIR: dataDir, SMOLERCLAW_RUN_ID: 'e2e-run-2' },
    )
    expect(created.exitCode).toBe(0)
    expect(JSON.parse(created.stdout)).toMatchObject({ ok: true, decision: 'executed' })

    const listed = await runCli(['run', 'list_tasks', '{}', '--json'], { SMOLERCLAW_DATA_DIR: dataDir })
    expect(listed.exitCode).toBe(0)
    expect((JSON.parse(listed.stdout).data as Array<{ title: string }>).map((t) => t.title)).toEqual(['pagar luz'])

    // Read-only denies writes with exit code 3
    const denied = await runCli(
      ['run', 'create_task', '{"title":"bloqueada"}', '--json'],
      { SMOLERCLAW_DATA_DIR: dataDir, SMOLERCLAW_READONLY: '1', SMOLERCLAW_RUN_ID: 'e2e-run-3' },
    )
    expect(denied.exitCode).toBe(3)
    expect(JSON.parse(denied.stdout)).toMatchObject({ ok: false, decision: 'denied' })

    // Audit trail captured correlation IDs and never stored raw arguments
    const records = readAuditRecords(dataDir)
    expect(records.some((r) => r.runId === 'e2e-run-1' && r.decision === 'dry-run' && r.caller === 'cli')).toBe(true)
    expect(records.some((r) => r.runId === 'e2e-run-2' && r.decision === 'executed' && r.ok === true)).toBe(true)
    expect(records.some((r) => r.runId === 'e2e-run-3' && r.decision === 'denied')).toBe(true)
    expect(JSON.stringify(records)).not.toContain('bloqueada')
  }, 20_000)

  test('workflow respects SMOLERCLAW_READONLY and --dry-run and writes audit records', async () => {
    const dataDir = makeSandboxDir()

    const denied = await runCli(
      ['workflow', 'iniciar-dia', '--json'],
      { SMOLERCLAW_DATA_DIR: dataDir, SMOLERCLAW_READONLY: '1', SMOLERCLAW_RUN_ID: 'wf-ro' },
    )
    expect(denied.exitCode).toBe(3)
    expect(JSON.parse(denied.stdout)).toMatchObject({ ok: false, decision: 'denied', workflow: 'iniciar-dia' })

    const dry = await runCli(
      ['workflow', 'iniciar-dia', '--dry-run', '--json'],
      { SMOLERCLAW_DATA_DIR: dataDir, SMOLERCLAW_RUN_ID: 'wf-dry' },
    )
    expect(dry.exitCode).toBe(0)
    expect(JSON.parse(dry.stdout)).toMatchObject({ ok: true, decision: 'dry-run', workflow: 'iniciar-dia' })

    const records = readAuditRecords(dataDir)
    expect(records.some((r) => r.runId === 'wf-ro' && r.tool === 'workflow:notify' && r.decision === 'denied')).toBe(true)
    expect(records.some((r) => r.runId === 'wf-dry' && r.decision === 'dry-run')).toBe(true)
  }, 15_000)

  test('mcp server over stdio runs against isolated dataDir and exposes tool annotations', async () => {
    const dataDir = makeSandboxDir()
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [ENTRY, 'mcp', '--data-dir', dataDir],
      env: { ...process.env, SMOLERCLAW_RUN_ID: 'mcp-e2e' } as Record<string, string>,
    })
    const client = new Client({ name: 'e2e-harness', version: '1.0.0' })
    await client.connect(transport)

    try {
      const { tools } = await client.listTools()
      const deleteNote = tools.find((t) => t.name === 'delete_note')
      const listNotes = tools.find((t) => t.name === 'list_notes')
      expect(deleteNote?.annotations).toMatchObject({ destructiveHint: true })
      expect(listNotes?.annotations).toMatchObject({ readOnlyHint: true })

      const saved = await client.callTool({
        name: 'save_note',
        arguments: { kind: 'memo', body: 'nota do harness #e2e' },
      })
      expect(saved.isError).toBe(false)
      expect((saved.structuredContent as { data: { kind: string } }).data.kind).toBe('memo')

      const listed = await client.callTool({ name: 'list_notes', arguments: {} })
      expect(listed.isError).toBe(false)
      expect((listed.structuredContent as { data: unknown[] }).data).toHaveLength(1)
    } finally {
      await client.close()
      await transport.close()
    }

    const records = readAuditRecords(dataDir)
    expect(records.some((r) => r.runId === 'mcp-e2e' && r.caller === 'mcp' && r.tool === 'save_note')).toBe(true)
  }, 15_000)
})
