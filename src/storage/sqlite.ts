/**
 * SQLite persistence layer — structured storage via bun:sqlite.
 *
 * Provides:
 *   - Typed repository interface for common data patterns
 *   - Event/change log for FSWatcher and audit trail
 *   - Query capabilities beyond what JSON files offer
 *   - WAL mode for concurrent reads during writes
 *   - Migration system for schema evolution
 *
 * Coexists with existing JSON/vault storage — modules can adopt
 * SQLite incrementally without breaking existing persistence.
 */

import { Database } from 'bun:sqlite'
import { existsSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { eventBus } from '../core/event-bus'

// ─── Types ──────────────────────────────────────────────────

export interface WatchEvent {
  id: number
  watchId: string
  eventType: string
  filePath: string
  relativePath: string
  extension: string
  timestamp: number
}

export interface AuditEntry {
  id: number
  action: string
  category: string
  details: string
  severity: 'info' | 'warning' | 'error' | 'critical'
  source: string
  timestamp: number
}

export interface DockerEvent {
  id: number
  containerId: string
  containerName: string
  action: string
  status: string
  image: string
  timestamp: number
}

export interface SecurityScan {
  id: number
  scanType: string
  target: string
  findings: string  // JSON stringified array
  severity: string
  passed: boolean
  timestamp: number
}

export interface QueryOptions {
  limit?: number
  offset?: number
  orderBy?: string
  orderDir?: 'ASC' | 'DESC'
}

// ─── Constants ──────────────────────────────────────────────

const DB_FILENAME = 'smolerclaw.db'
const SCHEMA_VERSION = 1

// ─── Singleton State ────────────────────────────────────────

let _db: Database | null = null
let _dbPath = ''
let _initialized = false

// ─── Initialization ─────────────────────────────────────────

/**
 * Initialize SQLite database.
 * Creates the database file and runs migrations.
 */
export function initSQLite(dataDir: string): void {
  if (_initialized) return

  const dir = join(dataDir, 'db')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })

  _dbPath = join(dir, DB_FILENAME)
  _db = new Database(_dbPath)

  // Enable WAL mode for better concurrent performance
  _db.exec('PRAGMA journal_mode = WAL')
  _db.exec('PRAGMA synchronous = NORMAL')
  _db.exec('PRAGMA foreign_keys = ON')

  runMigrations(_db)
  _initialized = true

  eventBus.emit('status:update', {
    source: 'sqlite',
    message: `SQLite inicializado: ${_dbPath}`,
    level: 'info',
    timestamp: Date.now(),
  })
}

/**
 * Get the database instance. Throws if not initialized.
 */
export function getDatabase(): Database {
  if (!_db) throw new Error('SQLite not initialized. Call initSQLite() first.')
  return _db
}

/**
 * Check if SQLite is initialized.
 */
export function isSQLiteInitialized(): boolean {
  return _initialized
}

/**
 * Close the database connection gracefully.
 */
export function closeSQLite(): void {
  if (_db) {
    _db.close()
    _db = null
    _initialized = false
  }
}

// ─── Migrations ─────────────────────────────────────────────

function runMigrations(db: Database): void {
  // Create version tracking table
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `)

  const currentVersion = db.query<{ version: number }, []>(
    'SELECT MAX(version) as version FROM schema_version',
  ).get()?.version ?? 0

  if (currentVersion < 1) applyMigration1(db)
}

function applyMigration1(db: Database): void {
  db.exec(`
    -- FSWatcher events log
    CREATE TABLE IF NOT EXISTS watch_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      watch_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      file_path TEXT NOT NULL,
      relative_path TEXT NOT NULL,
      extension TEXT NOT NULL DEFAULT '',
      timestamp INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_watch_events_ts ON watch_events(timestamp DESC);
    CREATE INDEX IF NOT EXISTS idx_watch_events_ext ON watch_events(extension);

    -- Security audit trail
    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      action TEXT NOT NULL,
      category TEXT NOT NULL,
      details TEXT NOT NULL DEFAULT '',
      severity TEXT NOT NULL DEFAULT 'info',
      source TEXT NOT NULL DEFAULT 'system',
      timestamp INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_log(timestamp DESC);
    CREATE INDEX IF NOT EXISTS idx_audit_category ON audit_log(category);
    CREATE INDEX IF NOT EXISTS idx_audit_severity ON audit_log(severity);

    -- Docker events
    CREATE TABLE IF NOT EXISTS docker_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      container_id TEXT NOT NULL DEFAULT '',
      container_name TEXT NOT NULL DEFAULT '',
      action TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT '',
      image TEXT NOT NULL DEFAULT '',
      timestamp INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_docker_ts ON docker_events(timestamp DESC);

    -- Security scan results
    CREATE TABLE IF NOT EXISTS security_scans (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      scan_type TEXT NOT NULL,
      target TEXT NOT NULL,
      findings TEXT NOT NULL DEFAULT '[]',
      severity TEXT NOT NULL DEFAULT 'info',
      passed INTEGER NOT NULL DEFAULT 1,
      timestamp INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_scans_ts ON security_scans(timestamp DESC);
    CREATE INDEX IF NOT EXISTS idx_scans_type ON security_scans(scan_type);

    -- Schema version
    INSERT INTO schema_version (version) VALUES (1);
  `)
}

// ─── Watch Events Repository ────────────────────────────────

/**
 * Log a file system change event.
 */
export function logWatchEvent(event: {
  watchId: string
  eventType: string
  filePath: string
  relativePath: string
  extension: string
  timestamp: number
}): void {
  const db = getDatabase()
  db.run(
    `INSERT INTO watch_events (watch_id, event_type, file_path, relative_path, extension, timestamp)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [event.watchId, event.eventType, event.filePath, event.relativePath, event.extension, event.timestamp],
  )
}

/**
 * Query watch events with filtering.
 */
export function queryWatchEvents(options: QueryOptions & {
  extension?: string
  since?: number
  watchId?: string
} = {}): WatchEvent[] {
  const db = getDatabase()
  const conditions: string[] = []
  const params: (string | number | null)[] = []

  if (options.extension) {
    conditions.push('extension = ?')
    params.push(options.extension)
  }
  if (options.since) {
    conditions.push('timestamp >= ?')
    params.push(options.since)
  }
  if (options.watchId) {
    conditions.push('watch_id = ?')
    params.push(options.watchId)
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
  const orderBy = options.orderBy ?? 'timestamp'
  const orderDir = options.orderDir ?? 'DESC'
  const limit = options.limit ?? 50
  const offset = options.offset ?? 0

  const rows = db.query<{
    id: number; watch_id: string; event_type: string; file_path: string
    relative_path: string; extension: string; timestamp: number
  }, (string | number | null)[]>(
    `SELECT id, watch_id, event_type, file_path, relative_path, extension, timestamp
     FROM watch_events ${where}
     ORDER BY ${orderBy} ${orderDir}
     LIMIT ? OFFSET ?`,
  ).all(...params, limit, offset)

  return rows.map((r) => ({
    id: r.id,
    watchId: r.watch_id,
    eventType: r.event_type,
    filePath: r.file_path,
    relativePath: r.relative_path,
    extension: r.extension,
    timestamp: r.timestamp,
  }))
}

/**
 * Count watch events, optionally filtered.
 */
export function countWatchEvents(since?: number): number {
  const db = getDatabase()
  if (since) {
    return db.query<{ count: number }, [number]>(
      'SELECT COUNT(*) as count FROM watch_events WHERE timestamp >= ?',
    ).get(since)?.count ?? 0
  }
  return db.query<{ count: number }, []>(
    'SELECT COUNT(*) as count FROM watch_events',
  ).get()?.count ?? 0
}

// ─── Audit Log Repository ───────────────────────────────────

/**
 * Write an audit log entry.
 */
export function logAudit(entry: {
  action: string
  category: string
  details?: string
  severity?: 'info' | 'warning' | 'error' | 'critical'
  source?: string
}): void {
  const db = getDatabase()
  db.run(
    `INSERT INTO audit_log (action, category, details, severity, source, timestamp)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      entry.action,
      entry.category,
      entry.details ?? '',
      entry.severity ?? 'info',
      entry.source ?? 'system',
      Date.now(),
    ],
  )
}

/**
 * Query audit log with filtering.
 */
export function queryAuditLog(options: QueryOptions & {
  category?: string
  severity?: string
  since?: number
  source?: string
} = {}): AuditEntry[] {
  const db = getDatabase()
  const conditions: string[] = []
  const params: (string | number | null)[] = []

  if (options.category) {
    conditions.push('category = ?')
    params.push(options.category)
  }
  if (options.severity) {
    conditions.push('severity = ?')
    params.push(options.severity)
  }
  if (options.since) {
    conditions.push('timestamp >= ?')
    params.push(options.since)
  }
  if (options.source) {
    conditions.push('source = ?')
    params.push(options.source)
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
  const limit = options.limit ?? 50
  const offset = options.offset ?? 0

  const rows = db.query<{
    id: number; action: string; category: string; details: string
    severity: string; source: string; timestamp: number
  }, (string | number | null)[]>(
    `SELECT id, action, category, details, severity, source, timestamp
     FROM audit_log ${where}
     ORDER BY timestamp DESC
     LIMIT ? OFFSET ?`,
  ).all(...params, limit, offset)

  return rows.map((r) => ({
    id: r.id,
    action: r.action,
    category: r.category,
    details: r.details,
    severity: r.severity as AuditEntry['severity'],
    source: r.source,
    timestamp: r.timestamp,
  }))
}

// ─── Docker Events Repository ───────────────────────────────

/**
 * Log a Docker event.
 */
export function logDockerEvent(event: {
  containerId?: string
  containerName?: string
  action: string
  status?: string
  image?: string
}): void {
  const db = getDatabase()
  db.run(
    `INSERT INTO docker_events (container_id, container_name, action, status, image, timestamp)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      event.containerId ?? '',
      event.containerName ?? '',
      event.action,
      event.status ?? '',
      event.image ?? '',
      Date.now(),
    ],
  )
}

/**
 * Query Docker events.
 */
export function queryDockerEvents(options: QueryOptions & {
  action?: string
  since?: number
} = {}): DockerEvent[] {
  const db = getDatabase()
  const conditions: string[] = []
  const params: (string | number | null)[] = []

  if (options.action) {
    conditions.push('action = ?')
    params.push(options.action)
  }
  if (options.since) {
    conditions.push('timestamp >= ?')
    params.push(options.since)
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
  const limit = options.limit ?? 50
  const offset = options.offset ?? 0

  const rows = db.query<{
    id: number; container_id: string; container_name: string
    action: string; status: string; image: string; timestamp: number
  }, (string | number | null)[]>(
    `SELECT id, container_id, container_name, action, status, image, timestamp
     FROM docker_events ${where}
     ORDER BY timestamp DESC
     LIMIT ? OFFSET ?`,
  ).all(...params, limit, offset)

  return rows.map((r) => ({
    id: r.id,
    containerId: r.container_id,
    containerName: r.container_name,
    action: r.action,
    status: r.status,
    image: r.image,
    timestamp: r.timestamp,
  }))
}

// ─── Security Scans Repository ──────────────────────────────

/**
 * Log a security scan result.
 */
export function logSecurityScan(scan: {
  scanType: string
  target: string
  findings: string[]
  severity: string
  passed: boolean
}): void {
  const db = getDatabase()
  db.run(
    `INSERT INTO security_scans (scan_type, target, findings, severity, passed, timestamp)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      scan.scanType,
      scan.target,
      JSON.stringify(scan.findings),
      scan.severity,
      scan.passed ? 1 : 0,
      Date.now(),
    ],
  )
}

/**
 * Query security scans.
 */
export function querySecurityScans(options: QueryOptions & {
  scanType?: string
  passed?: boolean
  since?: number
} = {}): SecurityScan[] {
  const db = getDatabase()
  const conditions: string[] = []
  const params: (string | number | null)[] = []

  if (options.scanType) {
    conditions.push('scan_type = ?')
    params.push(options.scanType)
  }
  if (options.passed !== undefined) {
    conditions.push('passed = ?')
    params.push(options.passed ? 1 : 0)
  }
  if (options.since) {
    conditions.push('timestamp >= ?')
    params.push(options.since)
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
  const limit = options.limit ?? 50
  const offset = options.offset ?? 0

  const rows = db.query<{
    id: number; scan_type: string; target: string; findings: string
    severity: string; passed: number; timestamp: number
  }, (string | number | null)[]>(
    `SELECT id, scan_type, target, findings, severity, passed, timestamp
     FROM security_scans ${where}
     ORDER BY timestamp DESC
     LIMIT ? OFFSET ?`,
  ).all(...params, limit, offset)

  return rows.map((r) => ({
    id: r.id,
    scanType: r.scan_type,
    target: r.target,
    findings: r.findings,
    severity: r.severity,
    passed: !!r.passed,
    timestamp: r.timestamp,
  }))
}

// ─── Statistics ─────────────────────────────────────────────

/**
 * Get database statistics for status display.
 */
export function getDBStats(): {
  watchEvents: number
  auditEntries: number
  dockerEvents: number
  securityScans: number
  dbSizeKB: number
} {
  const db = getDatabase()

  const watchEvents = db.query<{ c: number }, []>('SELECT COUNT(*) as c FROM watch_events').get()?.c ?? 0
  const auditEntries = db.query<{ c: number }, []>('SELECT COUNT(*) as c FROM audit_log').get()?.c ?? 0
  const dockerEvents = db.query<{ c: number }, []>('SELECT COUNT(*) as c FROM docker_events').get()?.c ?? 0
  const securityScans = db.query<{ c: number }, []>('SELECT COUNT(*) as c FROM security_scans').get()?.c ?? 0

  // Get database file size
  let dbSizeKB = 0
  try {
    const stat = Bun.file(_dbPath)
    dbSizeKB = Math.round(stat.size / 1024)
  } catch { /* ignore */ }

  return { watchEvents, auditEntries, dockerEvents, securityScans, dbSizeKB }
}

/**
 * Format DB stats for display.
 */
export function formatDBStats(): string {
  const stats = getDBStats()
  return [
    '=== SQLite Status ===',
    `Arquivo: ${_dbPath}`,
    `Tamanho: ${stats.dbSizeKB} KB`,
    `Eventos FS: ${stats.watchEvents}`,
    `Auditoria: ${stats.auditEntries}`,
    `Docker: ${stats.dockerEvents}`,
    `Scans: ${stats.securityScans}`,
  ].join('\n')
}

// ─── Cleanup ────────────────────────────────────────────────

/**
 * Purge old events beyond a retention period (default: 30 days).
 */
export function purgeOldEvents(retentionDays: number = 30): number {
  const db = getDatabase()
  const cutoff = Date.now() - (retentionDays * 24 * 60 * 60 * 1000)

  const result1 = db.run('DELETE FROM watch_events WHERE timestamp < ?', [cutoff])
  const result2 = db.run('DELETE FROM audit_log WHERE timestamp < ?', [cutoff])
  const result3 = db.run('DELETE FROM docker_events WHERE timestamp < ?', [cutoff])

  const total = (result1.changes ?? 0) + (result2.changes ?? 0) + (result3.changes ?? 0)

  if (total > 0) {
    db.exec('VACUUM')  // reclaim space
  }

  return total
}
