/**
 * FSWatcher — native file system monitoring for Windows.
 *
 * Uses Node's fs.watch (Bun-compatible) for event-driven change detection.
 * Replaces polling with real-time notifications via event-bus.
 *
 * Features:
 *   - Watch directories recursively for file changes
 *   - Debounce rapid changes (e.g., editors saving multiple times)
 *   - Filter by glob patterns
 *   - Emit structured events via event-bus
 *   - Track change history for audit trail
 */

import { watch, type FSWatcher as NodeFSWatcher, existsSync, statSync } from 'node:fs'
import { join, relative, extname, basename } from 'node:path'
import { randomUUID } from 'node:crypto'
import { eventBus } from './core/event-bus'
import { IS_WINDOWS } from './platform'

// ─── Types ──────────────────────────────────────────────────

export interface WatchTarget {
  id: string
  path: string
  recursive: boolean
  patterns: string[]        // glob-like extensions: ['.ts', '.json', '.md']
  debounceMs: number
  createdAt: string
}

export interface FileChangeEvent {
  watchId: string
  eventType: 'rename' | 'change'
  filePath: string
  relativePath: string
  extension: string
  timestamp: number
}

export interface WatcherStatus {
  active: boolean
  targets: WatchTarget[]
  totalChangesDetected: number
  recentChanges: FileChangeEvent[]
}

type WatcherCallback = (event: FileChangeEvent) => void

// ─── Constants ──────────────────────────────────────────────

const DEFAULT_DEBOUNCE_MS = 300
const MAX_RECENT_CHANGES = 100
const DEFAULT_PATTERNS = ['.ts', '.js', '.json', '.md', '.yaml', '.yml', '.toml']

// Directories to always ignore
const IGNORE_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.next',
  '__pycache__', '.venv', 'target', '.cache', '.backup',
])

// ─── State ──────────────────────────────────────────────────

const _watchers = new Map<string, { target: WatchTarget; watcher: NodeFSWatcher }>()
const _recentChanges: FileChangeEvent[] = []
let _totalChanges = 0
let _onNotify: WatcherCallback | null = null

// Debounce tracking: path -> timeout
const _debounceTimers = new Map<string, ReturnType<typeof setTimeout>>()

// ─── Initialization ─────────────────────────────────────────

export function initFSWatcher(onNotify?: WatcherCallback): void {
  _onNotify = onNotify ?? null
}

// ─── Public API ─────────────────────────────────────────────

/**
 * Start watching a directory for file changes.
 * Returns the watch ID for later management.
 */
export function watchDirectory(
  dirPath: string,
  options: {
    recursive?: boolean
    patterns?: string[]
    debounceMs?: number
  } = {},
): string {
  if (!existsSync(dirPath)) {
    throw new Error(`Directory does not exist: ${dirPath}`)
  }

  const stat = statSync(dirPath)
  if (!stat.isDirectory()) {
    throw new Error(`Path is not a directory: ${dirPath}`)
  }

  // Check if already watching this path
  for (const [id, entry] of _watchers) {
    if (entry.target.path === dirPath) {
      return id // already watching
    }
  }

  const id = randomUUID().slice(0, 8)
  const recursive = options.recursive ?? true
  const patterns = options.patterns ?? DEFAULT_PATTERNS
  const debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS

  const target: WatchTarget = {
    id,
    path: dirPath,
    recursive,
    patterns,
    debounceMs,
    createdAt: new Date().toISOString(),
  }

  const fsWatcher = watch(
    dirPath,
    { recursive },
    (eventType, filename) => {
      if (!filename) return
      handleChange(target, eventType as 'rename' | 'change', filename)
    },
  )

  fsWatcher.on('error', (err) => {
    eventBus.emit('status:update', {
      source: 'fs-watcher',
      message: `Watcher error on ${dirPath}: ${err.message}`,
      level: 'error',
      timestamp: Date.now(),
    })
  })

  _watchers.set(id, { target, watcher: fsWatcher })

  return id
}

/**
 * Stop watching a specific directory.
 */
export function unwatchDirectory(watchId: string): boolean {
  const entry = _watchers.get(watchId)
  if (!entry) return false

  entry.watcher.close()
  _watchers.delete(watchId)
  return true
}

/**
 * Stop all watchers.
 */
export function unwatchAll(): void {
  for (const entry of _watchers.values()) {
    entry.watcher.close()
  }
  _watchers.clear()

  // Clear debounce timers
  for (const timer of _debounceTimers.values()) {
    clearTimeout(timer)
  }
  _debounceTimers.clear()
}

/**
 * List all active watchers.
 */
export function listWatchers(): string {
  if (_watchers.size === 0) return 'Nenhum diretorio monitorado.'

  const lines = [..._watchers.values()].map(({ target }) => {
    const patStr = target.patterns.join(', ')
    const mode = target.recursive ? 'recursivo' : 'raiz'
    return `  [${target.id}] ${target.path} (${mode}, ${patStr})`
  })

  return `Diretorios monitorados (${_watchers.size}):\n${lines.join('\n')}`
}

/**
 * Get watcher status with recent changes.
 */
export function getWatcherStatus(): WatcherStatus {
  return {
    active: _watchers.size > 0,
    targets: [..._watchers.values()].map((e) => e.target),
    totalChangesDetected: _totalChanges,
    recentChanges: [..._recentChanges],
  }
}

/**
 * Get recent file changes, optionally filtered by extension.
 */
export function getRecentChanges(filterExt?: string): readonly FileChangeEvent[] {
  if (!filterExt) return _recentChanges
  return _recentChanges.filter((c) => c.extension === filterExt)
}

// ─── Internal ───────────────────────────────────────────────

function handleChange(
  target: WatchTarget,
  eventType: 'rename' | 'change',
  filename: string,
): void {
  // Normalize path separators
  const normalized = filename.replace(/\\/g, '/')

  // Skip ignored directories
  const parts = normalized.split('/')
  if (parts.some((p) => IGNORE_DIRS.has(p))) return

  // Check extension filter
  const ext = extname(filename).toLowerCase()
  if (target.patterns.length > 0 && !target.patterns.includes(ext)) return

  // Debounce: skip if same file changed within debounce window
  const debounceKey = `${target.id}:${normalized}`
  const existingTimer = _debounceTimers.get(debounceKey)
  if (existingTimer) {
    clearTimeout(existingTimer)
  }

  const timer = setTimeout(() => {
    _debounceTimers.delete(debounceKey)
    emitChange(target, eventType, filename, normalized)
  }, target.debounceMs)

  _debounceTimers.set(debounceKey, timer)
}

function emitChange(
  target: WatchTarget,
  eventType: 'rename' | 'change',
  filename: string,
  normalized: string,
): void {
  const fullPath = join(target.path, filename)

  const event: FileChangeEvent = {
    watchId: target.id,
    eventType,
    filePath: fullPath,
    relativePath: normalized,
    extension: extname(filename).toLowerCase(),
    timestamp: Date.now(),
  }

  // Track in recent changes (immutable append, trim oldest)
  _recentChanges.unshift(event)
  if (_recentChanges.length > MAX_RECENT_CHANGES) {
    _recentChanges.length = MAX_RECENT_CHANGES
  }
  _totalChanges++

  // Emit via event bus
  eventBus.emit('fs:changed', event)

  // Notify callback if registered
  _onNotify?.(event)
}

/**
 * Format a change event for display.
 */
export function formatChangeEvent(event: FileChangeEvent): string {
  const type = event.eventType === 'rename' ? 'NOVO/REMOVIDO' : 'MODIFICADO'
  const time = new Date(event.timestamp).toLocaleTimeString('pt-BR')
  return `[${time}] ${type}: ${event.relativePath}`
}
