import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdirSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  initSQLite, isSQLiteInitialized, closeSQLite, getDatabase,
  logWatchEvent, queryWatchEvents, countWatchEvents,
  logAudit, queryAuditLog,
  logDockerEvent, queryDockerEvents,
  logSecurityScan, querySecurityScans,
  getDBStats, formatDBStats, purgeOldEvents,
} from '../src/storage/sqlite'

const TEST_DIR = join(tmpdir(), `smolerclaw-sqlite-test-${Date.now()}`)

function cleanup(): void {
  closeSQLite()
  try { rmSync(TEST_DIR, { recursive: true, force: true }) } catch { /* ignore */ }
}

describe('SQLite — Initialization', () => {
  beforeEach(() => {
    cleanup()
    mkdirSync(TEST_DIR, { recursive: true })
  })

  afterEach(() => {
    cleanup()
  })

  test('initSQLite creates database directory and file', () => {
    initSQLite(TEST_DIR)
    expect(isSQLiteInitialized()).toBe(true)
    expect(existsSync(join(TEST_DIR, 'db', 'smolerclaw.db'))).toBe(true)
  })

  test('initSQLite is idempotent', () => {
    initSQLite(TEST_DIR)
    initSQLite(TEST_DIR) // should not throw
    expect(isSQLiteInitialized()).toBe(true)
  })

  test('getDatabase throws before initialization', () => {
    expect(() => getDatabase()).toThrow('SQLite not initialized')
  })

  test('closeSQLite resets state', () => {
    initSQLite(TEST_DIR)
    closeSQLite()
    expect(isSQLiteInitialized()).toBe(false)
  })
})

describe('SQLite — Watch Events', () => {
  beforeEach(() => {
    cleanup()
    mkdirSync(TEST_DIR, { recursive: true })
    initSQLite(TEST_DIR)
  })

  afterEach(() => {
    cleanup()
  })

  test('logWatchEvent inserts a record', () => {
    logWatchEvent({
      watchId: 'w1',
      eventType: 'change',
      filePath: '/test/file.ts',
      relativePath: 'file.ts',
      extension: '.ts',
      timestamp: Date.now(),
    })
    const events = queryWatchEvents()
    expect(events.length).toBe(1)
    expect(events[0].watchId).toBe('w1')
    expect(events[0].eventType).toBe('change')
  })

  test('queryWatchEvents filters by extension', () => {
    logWatchEvent({ watchId: 'w1', eventType: 'change', filePath: '/a.ts', relativePath: 'a.ts', extension: '.ts', timestamp: Date.now() })
    logWatchEvent({ watchId: 'w1', eventType: 'change', filePath: '/b.json', relativePath: 'b.json', extension: '.json', timestamp: Date.now() })

    const tsEvents = queryWatchEvents({ extension: '.ts' })
    expect(tsEvents.length).toBe(1)
    expect(tsEvents[0].extension).toBe('.ts')
  })

  test('queryWatchEvents filters by since timestamp', () => {
    const past = Date.now() - 100_000
    const now = Date.now()
    logWatchEvent({ watchId: 'w1', eventType: 'change', filePath: '/old.ts', relativePath: 'old.ts', extension: '.ts', timestamp: past })
    logWatchEvent({ watchId: 'w1', eventType: 'change', filePath: '/new.ts', relativePath: 'new.ts', extension: '.ts', timestamp: now })

    const recentEvents = queryWatchEvents({ since: now - 1000 })
    expect(recentEvents.length).toBe(1)
    expect(recentEvents[0].relativePath).toBe('new.ts')
  })

  test('countWatchEvents returns total count', () => {
    logWatchEvent({ watchId: 'w1', eventType: 'change', filePath: '/a.ts', relativePath: 'a.ts', extension: '.ts', timestamp: Date.now() })
    logWatchEvent({ watchId: 'w1', eventType: 'change', filePath: '/b.ts', relativePath: 'b.ts', extension: '.ts', timestamp: Date.now() })
    expect(countWatchEvents()).toBe(2)
  })

  test('countWatchEvents filters by since', () => {
    const old = Date.now() - 200_000
    logWatchEvent({ watchId: 'w1', eventType: 'change', filePath: '/old.ts', relativePath: 'old.ts', extension: '.ts', timestamp: old })
    logWatchEvent({ watchId: 'w1', eventType: 'change', filePath: '/new.ts', relativePath: 'new.ts', extension: '.ts', timestamp: Date.now() })
    expect(countWatchEvents(Date.now() - 1000)).toBe(1)
  })

  test('queryWatchEvents respects limit', () => {
    for (let i = 0; i < 10; i++) {
      logWatchEvent({ watchId: 'w1', eventType: 'change', filePath: `/f${i}.ts`, relativePath: `f${i}.ts`, extension: '.ts', timestamp: Date.now() + i })
    }
    const limited = queryWatchEvents({ limit: 3 })
    expect(limited.length).toBe(3)
  })
})

describe('SQLite — Audit Log', () => {
  beforeEach(() => {
    cleanup()
    mkdirSync(TEST_DIR, { recursive: true })
    initSQLite(TEST_DIR)
  })

  afterEach(() => {
    cleanup()
  })

  test('logAudit inserts an entry', () => {
    logAudit({ action: 'test_action', category: 'test' })
    const entries = queryAuditLog()
    expect(entries.length).toBe(1)
    expect(entries[0].action).toBe('test_action')
    expect(entries[0].category).toBe('test')
    expect(entries[0].severity).toBe('info')
  })

  test('logAudit supports all severity levels', () => {
    logAudit({ action: 'a1', category: 'test', severity: 'warning' })
    logAudit({ action: 'a2', category: 'test', severity: 'error' })
    logAudit({ action: 'a3', category: 'test', severity: 'critical' })

    const warnings = queryAuditLog({ severity: 'warning' })
    expect(warnings.length).toBe(1)
    expect(warnings[0].severity).toBe('warning')
  })

  test('queryAuditLog filters by category', () => {
    logAudit({ action: 'docker_start', category: 'docker' })
    logAudit({ action: 'fw_check', category: 'firewall' })

    const dockerEntries = queryAuditLog({ category: 'docker' })
    expect(dockerEntries.length).toBe(1)
    expect(dockerEntries[0].category).toBe('docker')
  })

  test('logAudit includes details', () => {
    logAudit({ action: 'scan', category: 'security', details: 'Found 3 issues', severity: 'error' })
    const entries = queryAuditLog()
    expect(entries[0].details).toBe('Found 3 issues')
  })
})

describe('SQLite — Docker Events', () => {
  beforeEach(() => {
    cleanup()
    mkdirSync(TEST_DIR, { recursive: true })
    initSQLite(TEST_DIR)
  })

  afterEach(() => {
    cleanup()
  })

  test('logDockerEvent inserts a record', () => {
    logDockerEvent({
      containerId: 'abc123',
      containerName: 'my-app',
      action: 'start',
      status: 'running',
      image: 'node:24',
    })
    const events = queryDockerEvents()
    expect(events.length).toBe(1)
    expect(events[0].containerId).toBe('abc123')
    expect(events[0].action).toBe('start')
  })

  test('queryDockerEvents filters by action', () => {
    logDockerEvent({ action: 'start', status: 'running' })
    logDockerEvent({ action: 'stop', status: 'exited' })

    const starts = queryDockerEvents({ action: 'start' })
    expect(starts.length).toBe(1)
  })
})

describe('SQLite — Security Scans', () => {
  beforeEach(() => {
    cleanup()
    mkdirSync(TEST_DIR, { recursive: true })
    initSQLite(TEST_DIR)
  })

  afterEach(() => {
    cleanup()
  })

  test('logSecurityScan inserts a record', () => {
    logSecurityScan({
      scanType: 'firewall',
      target: 'system',
      findings: ['Profile disabled'],
      severity: 'warning',
      passed: false,
    })
    const scans = querySecurityScans()
    expect(scans.length).toBe(1)
    expect(scans[0].scanType).toBe('firewall')
    expect(scans[0].passed).toBe(false)
  })

  test('querySecurityScans filters by passed', () => {
    logSecurityScan({ scanType: 'ports', target: 'system', findings: [], severity: 'info', passed: true })
    logSecurityScan({ scanType: 'secrets', target: 'cwd', findings: ['key found'], severity: 'critical', passed: false })

    const failed = querySecurityScans({ passed: false })
    expect(failed.length).toBe(1)
    expect(failed[0].scanType).toBe('secrets')
  })

  test('querySecurityScans filters by type', () => {
    logSecurityScan({ scanType: 'ports', target: 'system', findings: [], severity: 'info', passed: true })
    logSecurityScan({ scanType: 'firewall', target: 'system', findings: [], severity: 'info', passed: true })

    const ports = querySecurityScans({ scanType: 'ports' })
    expect(ports.length).toBe(1)
  })
})

describe('SQLite — Stats & Maintenance', () => {
  beforeEach(() => {
    cleanup()
    mkdirSync(TEST_DIR, { recursive: true })
    initSQLite(TEST_DIR)
  })

  afterEach(() => {
    cleanup()
  })

  test('getDBStats returns zero counts for empty DB', () => {
    const stats = getDBStats()
    expect(stats.watchEvents).toBe(0)
    expect(stats.auditEntries).toBe(0)
    expect(stats.dockerEvents).toBe(0)
    expect(stats.securityScans).toBe(0)
  })

  test('getDBStats reflects inserted data', () => {
    logWatchEvent({ watchId: 'w1', eventType: 'change', filePath: '/a.ts', relativePath: 'a.ts', extension: '.ts', timestamp: Date.now() })
    logAudit({ action: 'test', category: 'test' })
    logDockerEvent({ action: 'start' })

    const stats = getDBStats()
    expect(stats.watchEvents).toBe(1)
    expect(stats.auditEntries).toBe(1)
    expect(stats.dockerEvents).toBe(1)
  })

  test('formatDBStats returns formatted string', () => {
    const output = formatDBStats()
    expect(output).toContain('SQLite Status')
    expect(output).toContain('Eventos FS')
  })

  test('purgeOldEvents removes old data', () => {
    const oldTimestamp = Date.now() - (60 * 24 * 60 * 60 * 1000) // 60 days ago
    logWatchEvent({ watchId: 'w1', eventType: 'change', filePath: '/old.ts', relativePath: 'old.ts', extension: '.ts', timestamp: oldTimestamp })
    logWatchEvent({ watchId: 'w1', eventType: 'change', filePath: '/new.ts', relativePath: 'new.ts', extension: '.ts', timestamp: Date.now() })

    const purged = purgeOldEvents(30)
    expect(purged).toBeGreaterThanOrEqual(1)

    const remaining = queryWatchEvents()
    expect(remaining.length).toBe(1)
    expect(remaining[0].relativePath).toBe('new.ts')
  })

  test('purgeOldEvents returns 0 when nothing to purge', () => {
    logWatchEvent({ watchId: 'w1', eventType: 'change', filePath: '/new.ts', relativePath: 'new.ts', extension: '.ts', timestamp: Date.now() })
    const purged = purgeOldEvents(30)
    expect(purged).toBe(0)
  })
})
