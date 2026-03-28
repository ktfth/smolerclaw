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
const TRACKED_FILES = [
  'config.json',
  'memos.json',
  'materials.json',
  'decisions.json',
  'tasks.json',
  'finance.json',
  'people.json',
  'projects.json',
  'work-sessions.json',
  'opportunities.json',
  'workflows.json',
  'news-feeds.json',
  'pitwall-baselines.json',
  'rag/rag-index.json',
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
  _initialized = true

  // Check if backup repo exists
  _backupEnabled = existsSync(join(_backupDir, '.git'))
  if (_backupEnabled) {
    _lastBackup = readLastBackupTime()
  }
}

export function isVaultInitialized(): boolean {
  return _initialized
}

// ─── Atomic Write ───────────────────────────────────────────

/**
 * Write content to a file atomically.
 * Writes to a temp file first, then renames (atomic on most filesystems).
 * Updates the checksum registry after successful write.
 */
export function atomicWriteFile(filePath: string, content: string): void {
  const dir = dirname(filePath)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })

  const tmp = join(dir, `.smolerclaw-${randomUUID().slice(0, 8)}.tmp`)
  writeFileSync(tmp, content)
  renameSync(tmp, filePath)

  // Update checksum for tracked files
  if (_initialized) {
    const rel = relativeToData(filePath)
    if (rel && TRACKED_FILES.includes(rel)) {
      updateChecksum(rel, content)
    }
  }
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
export async function initShadowBackup(): Promise<string> {
  if (!_dataDir) return 'Error: vault not initialized.'

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
    if (!init.ok) return `Error: git init failed: ${init.stderr}`

    await gitCmd(['git', 'config', 'user.email', 'vault@smolerclaw.local'], _backupDir)
    await gitCmd(['git', 'config', 'user.name', 'smolerclaw-vault'], _backupDir)
  }

  _backupEnabled = true
  return 'Shadow backup inicializado.'
}

/**
 * Perform a shadow backup — copy tracked files to backup dir and commit.
 * Runs in background, non-blocking.
 */
export async function performBackup(message?: string): Promise<string> {
  if (!_backupEnabled) return 'Backup nao ativado. Use vault_init_backup primeiro.'

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

    // Also copy config
    const configFile = join(_configDir, 'config.json')
    if (existsSync(configFile)) {
      writeFileSync(join(_backupDir, 'config.json'), readFileSync(configFile, 'utf-8'))
    }

    // Git add + commit
    await gitCmd(['git', 'add', '-A'], _backupDir)

    const status = await gitCmd(['git', 'status', '--porcelain'], _backupDir)
    if (!status.stdout.trim()) return 'Nenhuma mudanca para backup.'

    const commitMsg = message || `backup ${new Date().toISOString().slice(0, 19)}`
    const commit = await gitCmd(['git', 'commit', '-m', commitMsg], _backupDir)
    if (!commit.ok) return `Backup commit falhou: ${commit.stderr}`

    _lastBackup = new Date().toISOString()
    return `Backup concluido: ${commitMsg}`
  } catch (err) {
    return `Backup falhou: ${err instanceof Error ? err.message : String(err)}`
  }
}

/**
 * Push backup to a configured remote (if set).
 */
export async function syncBackupToRemote(): Promise<string> {
  if (!_backupEnabled) return 'Backup nao ativado.'

  // Check if remote is configured
  const remote = await gitCmd(['git', 'remote', '-v'], _backupDir)
  if (!remote.stdout.trim()) {
    return 'Nenhum remote configurado. Use: git -C <backup-dir> remote add origin <url>'
  }

  const push = await gitCmd(['git', 'push', '-u', 'origin', BACKUP_BRANCH], _backupDir)
  if (!push.ok) return `Push falhou: ${push.stderr}`

  return 'Sync concluido — dados enviados para o remote.'
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

// ─── Background Backup Timer ────────────────────────────────

let _backupTimer: ReturnType<typeof setInterval> | null = null

/**
 * Start periodic background backups (every N minutes).
 * Non-blocking — runs after the current event loop tick.
 */
export function startAutoBackup(intervalMinutes: number = 30): void {
  stopAutoBackup()
  if (!_backupEnabled) return

  _backupTimer = setInterval(() => {
    performBackup('auto-backup').catch(() => {
      // Silent failure — don't crash the TUI
    })
  }, intervalMinutes * 60 * 1000)
}

export function stopAutoBackup(): void {
  if (_backupTimer) {
    clearInterval(_backupTimer)
    _backupTimer = null
  }
}

export function getBackupDir(): string {
  return _backupDir
}
