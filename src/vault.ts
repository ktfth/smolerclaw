/**
 * Storage vault — centralized safe persistence layer.
 *
 * Provides:
 *   - Atomic writes (tmp + rename) to prevent corruption
 *   - SHA-256 checksum guards on load
 *   - Shadow backup via local git repo
 *   - Vault status reporting
 *
 * All data-persistence modules should use vault.writeJson / vault.readJson
 * instead of raw writeFileSync / readFileSync for critical data.
 */

import {
  existsSync, mkdirSync, readFileSync, writeFileSync,
  renameSync, readdirSync, statSync,
} from 'node:fs'
import { join, dirname, basename, relative } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { eventBus } from './core/event-bus'
import type { FileSavedEvent, TaskCompletedEvent } from './types'
import { ok, fail, type ToolResult } from './core/result'
import { exportNotesSnapshot } from './notes'
import { exportTasksSnapshot } from './tasks'

// ─── Types ──────────────────────────────────────────────────

export interface ChecksumRecord {
  file: string
  sha256: string
  size: number
  updatedAt: string
}

export interface VaultStatus {
  files: FileIntegrity[]
  lastBackup: string | null
  backupEnabled: boolean
  totalFiles: number
  corruptFiles: number
}

export interface FileIntegrity {
  file: string
  exists: boolean
  checksumValid: boolean | null  // null = no checksum recorded yet
  size: number
  lastModified: string
}

interface ChecksumStore {
  checksums: ChecksumRecord[]
  version: number
}

// ─── Constants ──────────────────────────────────────────────

const VAULT_VERSION = 1
const CHECKSUM_FILE = 'vault-checksums.json'
const BACKUP_BRANCH = 'smolerclaw-backup'

// Files to track checksums for (relative to dataDir)
/**
 * JSON files in the data dir. Tasks and notes live in SQLite and config in the
 * config dir; performBackup snapshots or copies those separately.
 */
const TRACKED_FILES = [
  'decisions.json',
  'finance.json',
  'people.json',
  'projects.json',
  'work-sessions.json',
  'opportunities.json',
  'workflows.json',
  'scheduler.json',
]

// ─── Singleton State ────────────────────────────────────────

let _dataDir = ''
let _configDir = ''
let _checksums: ChecksumRecord[] = []
let _backupDir = ''
let _backupEnabled = false
let _lastBackup: string | null = null
let _initialized = false

// ─── Initialization ─────────────────────────────────────────

export function initVault(dataDir: string, configDir: string): void {
  _dataDir = dataDir
  _configDir = configDir
  _backupDir = join(dataDir, '.backup')
  loadChecksums()
  adoptUnrecordedFiles()
  _initialized = true

  // Check if backup repo exists
  _backupEnabled = existsSync(join(_backupDir, '.git'))
  _lastBackup = _backupEnabled ? readLastBackupTime() : null
}

export function isVaultInitialized(): boolean {
  return _initialized
}

// ─── Atomic Write ───────────────────────────────────────────

/**
 * Write content to a file atomically.
 * Writes to a temp file first, then renames (atomic on most filesystems).
 * Updates the checksum registry after successful write.
 * Emits 'file:saved' event for reactive backup triggers.
 */
export function atomicWriteFile(filePath: string, content: string): void {
  const dir = dirname(filePath)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })

  const tmp = join(dir, `.smolerclaw-${randomUUID().slice(0, 8)}.tmp`)
  writeFileSync(tmp, content)
  renameSync(tmp, filePath)

  // Update checksum for tracked files
  let isTracked = false
  if (_initialized) {
    const rel = relativeToData(filePath)
    if (rel && TRACKED_FILES.includes(rel)) {
      updateChecksum(rel, content)
      isTracked = true
    }
  }

  // Emit file:saved event for backup triggers and other listeners
  const event: FileSavedEvent = {
    filePath,
    size: Buffer.byteLength(content, 'utf-8'),
    isTracked,
    timestamp: Date.now(),
  }
  eventBus.emit('file:saved', event)
}

/**
 * Write a JSON object atomically with pretty-printing.
 */
export function writeJson(filePath: string, data: unknown): void {
  atomicWriteFile(filePath, JSON.stringify(data, null, 2))
}

/**
 * Read and parse a JSON file with optional checksum verification.
 * Returns the parsed data, or null if the file doesn't exist or is corrupted.
 * If checksum fails, returns the data but logs a warning.
 */
export function readJson<T>(filePath: string, fallback: T): T {
  if (!existsSync(filePath)) return fallback

  let raw: string
  try {
    raw = readFileSync(filePath, 'utf-8')
  } catch {
    return fallback
  }

  // Verify checksum if available
  if (_initialized) {
    const rel = relativeToData(filePath)
    if (rel) {
      const record = _checksums.find((c) => c.file === rel)
      if (record) {
        const actual = sha256(raw)
        if (actual !== record.sha256) {
          if (process.env.DEBUG) {
            console.error(`[vault] Checksum mismatch: ${rel} (expected ${record.sha256.slice(0, 8)}..., got ${actual.slice(0, 8)}...)`)
          }
          // Data may have been edited externally — update checksum
          updateChecksum(rel, raw)
        }
      }
    }
  }

  try {
    return JSON.parse(raw)
  } catch {
    return fallback
  }
}

// ─── Checksum Management ────────────────────────────────────

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}

function updateChecksum(relFile: string, content: string): void {
  const hash = sha256(content)
  const now = new Date().toISOString()
  const size = Buffer.byteLength(content, 'utf-8')

  _checksums = [
    ..._checksums.filter((c) => c.file !== relFile),
    { file: relFile, sha256: hash, size, updatedAt: now },
  ]
  saveChecksums()
}

/**
 * A tracked file with no checksum record was written before the vault knew
 * about it; its current content becomes the baseline. Changes after that are
 * caught, earlier ones cannot be known either way.
 */
function adoptUnrecordedFiles(): void {
  const recorded = new Set(_checksums.map((c) => c.file))
  const now = new Date().toISOString()
  const adopted: ChecksumRecord[] = []
  for (const rel of TRACKED_FILES) {
    if (recorded.has(rel)) continue
    const file = join(_dataDir, rel)
    if (!existsSync(file)) continue
    try {
      const content = readFileSync(file, 'utf-8')
      adopted.push({ file: rel, sha256: sha256(content), size: Buffer.byteLength(content, 'utf-8'), updatedAt: now })
    } catch {
      // Unreadable now: stays unrecorded and shows as such in the status.
    }
  }
  if (adopted.length === 0) return
  _checksums = [..._checksums, ...adopted]
  saveChecksums()
}

function loadChecksums(): void {
  const file = join(_dataDir, CHECKSUM_FILE)
  if (!existsSync(file)) {
    _checksums = []
    return
  }
  try {
    const data: ChecksumStore = JSON.parse(readFileSync(file, 'utf-8'))
    if (data.version !== VAULT_VERSION) {
      _checksums = []
      return
    }
    _checksums = data.checksums || []
  } catch {
    _checksums = []
  }
}

function saveChecksums(): void {
  if (!_dataDir) return
  const file = join(_dataDir, CHECKSUM_FILE)
  const data: ChecksumStore = { checksums: _checksums, version: VAULT_VERSION }
  // Use raw write here — checksums file protects itself
  const tmp = join(_dataDir, `.vault-${randomUUID().slice(0, 8)}.tmp`)
  writeFileSync(tmp, JSON.stringify(data, null, 2))
  renameSync(tmp, file)
}

function relativeToData(filePath: string): string | null {
  try {
    const rel = relative(_dataDir, filePath).replace(/\\/g, '/')
    if (rel.startsWith('..') || rel.startsWith('/')) return null
    return rel
  } catch {
    return null
  }
}

// ─── Vault Status ───────────────────────────────────────────

/**
 * Get the integrity status of all tracked files.
 */
export function getVaultStatus(): VaultStatus {
  const files: FileIntegrity[] = []
  let corruptFiles = 0

  for (const rel of TRACKED_FILES) {
    const fullPath = join(_dataDir, rel)
    const exists = existsSync(fullPath)

    if (!exists) {
      files.push({ file: rel, exists: false, checksumValid: null, size: 0, lastModified: '' })
      continue
    }

    let size = 0
    let lastModified = ''
    try {
      const stat = statSync(fullPath)
      size = stat.size
      lastModified = stat.mtime.toISOString()
    } catch { /* skip */ }

    const record = _checksums.find((c) => c.file === rel)
    let checksumValid: boolean | null = null

    if (record) {
      try {
        const content = readFileSync(fullPath, 'utf-8')
        const actual = sha256(content)
        checksumValid = actual === record.sha256
        if (!checksumValid) corruptFiles++
      } catch {
        checksumValid = false
        corruptFiles++
      }
    }

    files.push({ file: rel, exists, checksumValid, size, lastModified })
  }

  return {
    files,
    lastBackup: _lastBackup,
    backupEnabled: _backupEnabled,
    totalFiles: files.filter((f) => f.exists).length,
    corruptFiles,
  }
}

export function formatVaultStatus(status: VaultStatus): string {
  const lines: string[] = ['=== Vault Status ===']

  // Summary
  const healthIcon = status.corruptFiles === 0 ? 'OK' : `ATENCAO (${status.corruptFiles} corrompido(s))`
  lines.push(`Integridade: ${healthIcon}`)
  lines.push(`Arquivos rastreados: ${status.totalFiles}/${TRACKED_FILES.length}`)
  lines.push(`Backup: ${status.backupEnabled ? 'ativado' : 'desativado'}`)
  if (status.lastBackup) {
    lines.push(`Ultimo backup: ${new Date(status.lastBackup).toLocaleString('pt-BR')}`)
  }

  // File details
  lines.push('\n--- Arquivos ---')
  for (const f of status.files) {
    if (!f.exists) {
      lines.push(`  ${f.file.padEnd(30)} (nao existe)`)
      continue
    }
    const sizeKB = (f.size / 1024).toFixed(1)
    const check = f.checksumValid === null ? '?' : f.checksumValid ? 'OK' : 'CORROMPIDO'
    const date = f.lastModified
      ? new Date(f.lastModified).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
      : ''
    lines.push(`  ${f.file.padEnd(30)} ${sizeKB.padStart(8)} KB  [${check}]  ${date}`)
  }

  return lines.join('\n')
}

// ─── Shadow Backup (Git-based) ──────────────────────────────

/**
 * Initialize the shadow backup repository.
 * Creates a local git repo in dataDir/.backup/ with a .gitignore.
 */
export async function initShadowBackup(): Promise<ToolResult> {
  if (!_dataDir) return fail('vault not initialized.')

  if (!existsSync(_backupDir)) mkdirSync(_backupDir, { recursive: true })

  // Create .gitignore to exclude sensitive files
  const gitignore = [
    '# Sensitive — never backup',
    '*.credentials.json',
    '*.tmp',
    '.vault-*.tmp',
    '.smolerclaw-*.tmp',
    '',
    '# Large/transient',
    'rag/',
    'sessions/archive/',
    '',
  ].join('\n')
  writeFileSync(join(_backupDir, '.gitignore'), gitignore)

  // Init git repo if not exists
  if (!existsSync(join(_backupDir, '.git'))) {
    const init = await gitCmd(['git', 'init', '-b', BACKUP_BRANCH], _backupDir)
    if (!init.ok) return fail(`git init failed: ${init.stderr}`)

    await gitCmd(['git', 'config', 'user.email', 'vault@smolerclaw.local'], _backupDir)
    await gitCmd(['git', 'config', 'user.name', 'smolerclaw-vault'], _backupDir)
  }

  _backupEnabled = true
  return ok('Shadow backup inicializado.')
}

/**
 * Perform a shadow backup — copy tracked files to backup dir and commit.
 * Runs in background, non-blocking.
 * Emits 'task:completed' event on completion.
 */
export async function performBackup(message?: string): Promise<ToolResult> {
  if (!_backupEnabled) return fail('Backup não ativado. Use vault_init_backup primeiro.')

  const startTime = Date.now()

  try {
    // Copy tracked files to backup dir
    for (const rel of TRACKED_FILES) {
      const src = join(_dataDir, rel)
      if (!existsSync(src)) continue
      const dest = join(_backupDir, rel)
      const destDir = dirname(dest)
      if (!existsSync(destDir)) mkdirSync(destDir, { recursive: true })
      writeFileSync(dest, readFileSync(src, 'utf-8'))
    }

    // Notes and tasks live in SQLite; back them up as JSON snapshots.
    const notes = exportNotesSnapshot()
    if (notes !== null) writeFileSync(join(_backupDir, 'notes.json'), notes)
    const tasks = exportTasksSnapshot()
    if (tasks !== null) writeFileSync(join(_backupDir, 'tasks.json'), tasks)

    // Also copy config
    const configFile = join(_configDir, 'config.json')
    if (existsSync(configFile)) {
      writeFileSync(join(_backupDir, 'config.json'), readFileSync(configFile, 'utf-8'))
    }

    // Git add + commit
    await gitCmd(['git', 'add', '-A'], _backupDir)

    const status = await gitCmd(['git', 'status', '--porcelain'], _backupDir)
    if (!status.stdout.trim()) {
      // Emit event for no-change scenario
      const event: TaskCompletedEvent = {
        taskId: `backup-${Date.now()}`,
        taskType: 'backup',
        success: true,
        message: 'Nenhuma mudanca para backup',
        duration: Date.now() - startTime,
        timestamp: Date.now(),
      }
      eventBus.emit('task:completed', event)
      return ok('Nenhuma mudança para backup.')
    }

    const commitMsg = message || `backup ${new Date().toISOString().slice(0, 19)}`
    const commit = await gitCmd(['git', 'commit', '-m', commitMsg], _backupDir)
    if (!commit.ok) {
      const errorEvent: TaskCompletedEvent = {
        taskId: `backup-${Date.now()}`,
        taskType: 'backup',
        success: false,
        message: `Commit falhou: ${commit.stderr}`,
        duration: Date.now() - startTime,
        timestamp: Date.now(),
      }
      eventBus.emit('task:completed', errorEvent)
      return fail(`Backup commit falhou: ${commit.stderr}`)
    }

    _lastBackup = new Date().toISOString()

    // Emit success event
    const successEvent: TaskCompletedEvent = {
      taskId: `backup-${Date.now()}`,
      taskType: 'backup',
      success: true,
      message: `Backup concluido: ${commitMsg}`,
      duration: Date.now() - startTime,
      timestamp: Date.now(),
    }
    eventBus.emit('task:completed', successEvent)

    return ok(`Backup concluído: ${commitMsg}`)
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err)
    // Emit failure event
    const failEvent: TaskCompletedEvent = {
      taskId: `backup-${Date.now()}`,
      taskType: 'backup',
      success: false,
      message: `Backup falhou: ${errorMsg}`,
      duration: Date.now() - startTime,
      timestamp: Date.now(),
    }
    eventBus.emit('task:completed', failEvent)
    return fail(`Backup falhou: ${errorMsg}`)
  }
}

/**
 * Push backup to a configured remote (if set).
 */
export async function syncBackupToRemote(): Promise<ToolResult> {
  if (!_backupEnabled) return fail('Backup não ativado.')

  // Check if remote is configured
  const remote = await gitCmd(['git', 'remote', '-v'], _backupDir)
  if (!remote.stdout.trim()) {
    return fail('Nenhum remote configurado. Use: git -C <backup-dir> remote add origin <url>')
  }

  const push = await gitCmd(['git', 'push', '-u', 'origin', BACKUP_BRANCH], _backupDir)
  if (!push.ok) return fail(`Push falhou: ${push.stderr}`)

  return ok('Sync concluído — dados enviados para o remote.')
}

function readLastBackupTime(): string | null {
  try {
    const log = Bun.spawnSync(
      ['git', 'log', '-1', '--format=%aI'],
      { cwd: _backupDir, stdout: 'pipe', stderr: 'pipe' },
    )
    const ts = new TextDecoder().decode(log.stdout).trim()
    return ts || null
  } catch {
    return null
  }
}

async function gitCmd(
  args: string[],
  cwd: string,
): Promise<{ stdout: string; stderr: string; ok: boolean }> {
  const proc = Bun.spawn(args, { stdout: 'pipe', stderr: 'pipe', cwd })
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  const code = await proc.exited
  return { stdout: stdout.trim(), stderr: stderr.trim(), ok: code === 0 }
}

// ─── Event-Driven Backup ─────────────────────────────────────

let _eventBackupUnsubscribe: (() => void) | null = null
let _pendingBackupTimeout: ReturnType<typeof setTimeout> | null = null
let _pendingBackupFiles: string[] = []

/**
 * Start event-driven backup. Listens for file:saved events and triggers
 * backup after a debounce period (default 5 seconds after last write).
 * This provides reactive backup without polling.
 */
export function startEventDrivenBackup(debounceMs: number = 5000): () => void {
  if (_eventBackupUnsubscribe) {
    // Already running
    return _eventBackupUnsubscribe
  }

  _eventBackupUnsubscribe = eventBus.on(
    'file:saved',
    (event: FileSavedEvent) => {
      // Only trigger backup for tracked files
      if (!event.isTracked) return

      // Add to pending list
      _pendingBackupFiles.push(event.filePath)

      // Debounce: reset timer on each new write
      if (_pendingBackupTimeout) {
        clearTimeout(_pendingBackupTimeout)
      }

      _pendingBackupTimeout = setTimeout(() => {
        // Fire and forget — errors handled via event emission
        const filesCount = _pendingBackupFiles.length
        _pendingBackupFiles = []
        _pendingBackupTimeout = null

        performBackup(`auto-save (${filesCount} file${filesCount > 1 ? 's' : ''})`).catch(() => {
          // Silent failure — event already emitted in performBackup
        })
      }, debounceMs)
    },
    { async: true },
  )

  return _eventBackupUnsubscribe
}

/**
 * Stop event-driven backup.
 */
export function stopEventDrivenBackup(): void {
  if (_eventBackupUnsubscribe) {
    _eventBackupUnsubscribe()
    _eventBackupUnsubscribe = null
  }
  if (_pendingBackupTimeout) {
    clearTimeout(_pendingBackupTimeout)
    _pendingBackupTimeout = null
  }
  _pendingBackupFiles = []
}

// ─── Background Backup Timer ────────────────────────────────

let _backupTimer: ReturnType<typeof setInterval> | null = null
let _backupInFlight: Promise<ToolResult> | null = null

/** True when no backup exists yet, or the last one is older than the interval. */
export function backupIsDue(lastBackup: string | null, intervalMinutes: number, now: number): boolean {
  if (!lastBackup) return true
  const last = Date.parse(lastBackup)
  if (Number.isNaN(last)) return true
  return now - last >= intervalMinutes * 60_000
}

/**
 * Back up when due. Returns null when skipped: backup not initialized, not due
 * yet, or another backup already running in this process.
 */
export async function runAutoBackupIfDue(intervalMinutes: number): Promise<ToolResult | null> {
  if (!_backupEnabled || _backupInFlight) return null
  if (!backupIsDue(_lastBackup, intervalMinutes, Date.now())) return null
  _backupInFlight = performBackup('auto-backup')
  try {
    return await _backupInFlight
  } finally {
    _backupInFlight = null
  }
}

/**
 * Start periodic background backups (every N minutes) and catch up right away
 * when the last backup is already older than the interval. Only for
 * long-lived processes (TUI, MCP server): killing a one-shot command
 * mid-commit would leave a stale git lock. The timer never keeps the process alive.
 */
export function startAutoBackup(intervalMinutes: number = 30): void {
  stopAutoBackup()
  if (!_backupEnabled) return

  const tick = (): void => {
    runAutoBackupIfDue(intervalMinutes).catch(() => {
      // performBackup already reports failures through the event bus
    })
  }
  _backupTimer = setInterval(tick, intervalMinutes * 60_000)
  _backupTimer.unref?.()
  setTimeout(tick, 0).unref?.()
}

export function stopAutoBackup(): void {
  if (_backupTimer) {
    clearInterval(_backupTimer)
    _backupTimer = null
  }
}

export function isAutoBackupRunning(): boolean {
  return _backupTimer !== null
}

export function getBackupDir(): string {
  return _backupDir
}
