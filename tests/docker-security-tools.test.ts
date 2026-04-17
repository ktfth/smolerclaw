import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  DOCKER_TOOLS, SECURITY_TOOLS, WATCHER_TOOLS, DB_TOOLS,
  DOCKER_SECURITY_TOOLS, executeDockerSecurityTool,
} from '../src/tools/docker-security-tools'
import { initSQLite, closeSQLite, logAudit, queryAuditLog } from '../src/storage/sqlite'
import { initFSWatcher, unwatchAll } from '../src/fs-watcher'

const TEST_DIR = join(tmpdir(), `smolerclaw-dst-test-${Date.now()}`)

function cleanup(): void {
  unwatchAll()
  closeSQLite()
  try { rmSync(TEST_DIR, { recursive: true, force: true }) } catch { /* ignore */ }
}

describe('Docker/Security Tools — Schemas', () => {
  test('DOCKER_TOOLS has correct tool count', () => {
    expect(DOCKER_TOOLS.length).toBe(3)
  })

  test('SECURITY_TOOLS has correct tool count', () => {
    expect(SECURITY_TOOLS.length).toBe(2)
  })

  test('WATCHER_TOOLS has correct tool count', () => {
    expect(WATCHER_TOOLS.length).toBe(4)
  })

  test('DB_TOOLS has correct tool count', () => {
    expect(DB_TOOLS.length).toBe(2)
  })

  test('DOCKER_SECURITY_TOOLS combines all tool schemas', () => {
    expect(DOCKER_SECURITY_TOOLS.length).toBe(11)
  })

  test('all tools have name and description', () => {
    for (const tool of DOCKER_SECURITY_TOOLS) {
      expect(tool.name).toBeTruthy()
      expect(tool.description).toBeTruthy()
      expect(tool.input_schema).toBeTruthy()
    }
  })

  test('tool names are unique', () => {
    const names = DOCKER_SECURITY_TOOLS.map((t) => t.name)
    const unique = new Set(names)
    expect(unique.size).toBe(names.length)
  })
})

describe('Docker/Security Tools — Execution', () => {
  beforeEach(() => {
    cleanup()
    mkdirSync(TEST_DIR, { recursive: true })
    initSQLite(TEST_DIR)
    initFSWatcher()
  })

  afterEach(() => {
    cleanup()
  })

  test('executeDockerSecurityTool returns null for unknown tool', async () => {
    const result = await executeDockerSecurityTool('unknown_tool', {})
    expect(result).toBeNull()
  })

  // ─── FSWatcher Tools ──────────────────────────────────────

  test('fs_watch starts watching a directory', async () => {
    const result = await executeDockerSecurityTool('fs_watch', { path: TEST_DIR })
    expect(result).toContain('Monitorando')
    expect(result).toContain(TEST_DIR)
  })

  test('fs_watch returns error for missing path', async () => {
    const result = await executeDockerSecurityTool('fs_watch', {})
    expect(result).toContain('Error')
  })

  test('fs_watch_status shows active watchers', async () => {
    await executeDockerSecurityTool('fs_watch', { path: TEST_DIR })
    const result = await executeDockerSecurityTool('fs_watch_status', {})
    expect(result).toContain('Ativo: Sim')
    expect(result).toContain(TEST_DIR)
  })

  test('fs_unwatch removes a watcher', async () => {
    const watchResult = await executeDockerSecurityTool('fs_watch', { path: TEST_DIR })
    const id = watchResult!.match(/Watch ID: (\w+)/)?.[1]
    expect(id).toBeTruthy()

    const result = await executeDockerSecurityTool('fs_unwatch', { watch_id: id })
    expect(result).toContain('parado')
  })

  test('fs_unwatch all clears all watchers', async () => {
    await executeDockerSecurityTool('fs_watch', { path: TEST_DIR })
    const result = await executeDockerSecurityTool('fs_unwatch', { watch_id: 'all' })
    expect(result).toContain('Todos')
  })

  test('fs_watch_history returns empty when no events', async () => {
    const result = await executeDockerSecurityTool('fs_watch_history', { hours: 1 })
    expect(result).toContain('Nenhuma')
  })

  // ─── DB Tools ─────────────────────────────────────────────

  test('db_status returns formatted stats', async () => {
    const result = await executeDockerSecurityTool('db_status', {})
    expect(result).toContain('SQLite Status')
    expect(result).toContain('Eventos FS')
  })

  test('db_purge runs successfully', async () => {
    const result = await executeDockerSecurityTool('db_purge', { retention_days: 7 })
    expect(result).toContain('Limpeza')
    expect(result).toContain('7 dias')
  })

  // ─── Security Tools ───────────────────────────────────────

  test('security_audit_log returns empty message when no entries', async () => {
    const result = await executeDockerSecurityTool('security_audit_log', {})
    expect(result).toContain('Nenhuma')
  })

  test('security_audit_log returns entries after logging', async () => {
    logAudit({ action: 'test_scan', category: 'firewall', severity: 'warning', details: 'Test finding' })
    const result = await executeDockerSecurityTool('security_audit_log', { limit: 10 })
    expect(result).toContain('test_scan')
    expect(result).toContain('firewall')
  })

  test('security_audit_log filters by category', async () => {
    logAudit({ action: 'docker_start', category: 'docker' })
    logAudit({ action: 'fw_check', category: 'firewall' })

    const result = await executeDockerSecurityTool('security_audit_log', { category: 'docker' })
    expect(result).toContain('docker_start')
    expect(result).not.toContain('fw_check')
  })

  // ─── Docker Tools ─────────────────────────────────────────

  test('docker_generate creates a bun Dockerfile', async () => {
    const result = await executeDockerSecurityTool('docker_generate', { type: 'dockerfile', runtime: 'bun' })
    expect(result).toContain('Dockerfile')
    expect(result).toContain('oven/bun')
    expect(result).toContain('bun install')
  })

  test('docker_generate creates a node Dockerfile', async () => {
    const result = await executeDockerSecurityTool('docker_generate', { type: 'dockerfile', runtime: 'node' })
    expect(result).toContain('node:24')
    expect(result).toContain('npm ci')
  })

  test('docker_generate creates a python Dockerfile', async () => {
    const result = await executeDockerSecurityTool('docker_generate', { type: 'dockerfile', runtime: 'python' })
    expect(result).toContain('python:3.13')
    expect(result).toContain('uvicorn')
  })

  test('docker_generate returns error for unknown runtime', async () => {
    const result = await executeDockerSecurityTool('docker_generate', { type: 'dockerfile', runtime: 'ruby' })
    expect(result).toContain('Error')
    expect(result).toContain('nao suportado')
  })

  test('docker_generate creates a compose file with postgres', async () => {
    const result = await executeDockerSecurityTool('docker_generate', { type: 'compose', services: 'postgres' })
    expect(result).toContain('postgres:17')
    expect(result).toContain('POSTGRES_DB')
  })

  test('docker_generate creates a compose file with redis', async () => {
    const result = await executeDockerSecurityTool('docker_generate', { type: 'compose', services: 'redis' })
    expect(result).toContain('redis:7')
    expect(result).toContain('6379')
  })

  test('docker_generate creates a compose file with multiple services', async () => {
    const result = await executeDockerSecurityTool('docker_generate', { type: 'compose', services: 'postgres,redis' })
    expect(result).toContain('postgres')
    expect(result).toContain('redis')
    expect(result).toContain('volumes')
  })

  test('docker_generate returns error for invalid type', async () => {
    const result = await executeDockerSecurityTool('docker_generate', { type: 'invalid' })
    expect(result).toContain('Error')
  })

  // ─── Security Scan ────────────────────────────────────────

  test('security_scan returns error for invalid type', async () => {
    const result = await executeDockerSecurityTool('security_scan', { scan_type: 'invalid' })
    expect(result).toContain('Error')
    expect(result).toContain('invalido')
  })
})
