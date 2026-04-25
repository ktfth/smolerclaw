/**
 * Auto-refresh — proactively monitors OAuth token expiration
 * and refreshes credentials before they expire.
 *
 * Uses a timer-based approach: checks periodically and triggers
 * refresh when approaching expiration (configurable buffer).
 */

import { refreshAuth, type AuthResult } from './auth'
import { emit } from './core/event-bus'
import { logger } from './core/logger'

// ─── Types ──────────────────────────────────────────────────

export interface AutoRefreshOptions {
  /** How often to check expiration (ms). Default: 60_000 (1 min) */
  checkIntervalMs?: number
  /** How far before expiration to trigger refresh (ms). Default: 300_000 (5 min) */
  refreshBufferMs?: number
  /** Called when token is successfully refreshed */
  onRefreshed?: (auth: AuthResult) => void
  /** Called when refresh fails */
  onRefreshFailed?: (error: string) => void
}

interface AutoRefreshState {
  readonly timer: ReturnType<typeof setInterval> | null
  readonly lastRefresh: number
  readonly refreshCount: number
  readonly running: boolean
}

type ExpiringAuth = AuthResult & { expiresAt: number }

// ─── State ──────────────────────────────────────────────────

const DEFAULT_CHECK_INTERVAL = 60_000    // 1 minute
const DEFAULT_REFRESH_BUFFER = 300_000   // 5 minutes before expiry

let _state: AutoRefreshState = {
  timer: null,
  lastRefresh: 0,
  refreshCount: 0,
  running: false,
}

let _currentAuth: ExpiringAuth | null = null

// ─── Core ───────────────────────────────────────────────────

/**
 * Start the auto-refresh timer.
 * Periodically checks if the current token is near expiration
 * and refreshes it proactively.
 */
export function startAutoRefresh(
  auth: ExpiringAuth,
  opts: AutoRefreshOptions = {},
): void {
  // Stop any existing timer
  stopAutoRefresh()

  _currentAuth = auth

  const checkInterval = opts.checkIntervalMs ?? DEFAULT_CHECK_INTERVAL
  const refreshBuffer = opts.refreshBufferMs ?? DEFAULT_REFRESH_BUFFER

  const timer = setInterval(() => {
    checkAndRefresh(refreshBuffer, opts)
  }, checkInterval)

  // Unref so it doesn't keep the process alive
  if (timer.unref) timer.unref()

  _state = {
    timer,
    lastRefresh: Date.now(),
    refreshCount: 0,
    running: true,
  }

  logger.debug('Auto-refresh started', { checkInterval, refreshBuffer })

  emit('status:update', {
    source: 'auto-refresh',
    message: 'Auto-refresh ativo',
    level: 'info',
    timestamp: Date.now(),
  })
}

/**
 * Stop the auto-refresh timer.
 */
export function stopAutoRefresh(): void {
  if (_state.timer) {
    clearInterval(_state.timer)
  }
  _state = { ..._state, timer: null, running: false }
  _currentAuth = null
}

/**
 * Update the current auth reference (e.g. after a manual /refresh).
 */
export function updateAutoRefreshAuth(auth: ExpiringAuth): void {
  _currentAuth = auth
}

/**
 * Get auto-refresh status for display.
 */
export function getAutoRefreshStatus(): {
  running: boolean
  lastRefresh: number
  refreshCount: number
  tokenExpiresAt: number | null
  tokenExpiresIn: string | null
} {
  const expiresAt = _currentAuth?.expiresAt ?? null
  let expiresIn: string | null = null

  if (expiresAt) {
    const ms = expiresAt - Date.now()
    if (ms <= 0) {
      expiresIn = 'expirado'
    } else {
      const minutes = Math.floor(ms / 60_000)
      const hours = Math.floor(minutes / 60)
      expiresIn = hours > 0
        ? `${hours}h ${minutes % 60}m`
        : `${minutes}m`
    }
  }

  return {
    running: _state.running,
    lastRefresh: _state.lastRefresh,
    refreshCount: _state.refreshCount,
    tokenExpiresAt: expiresAt,
    tokenExpiresIn: expiresIn,
  }
}

/**
 * Format status for TUI display.
 */
export function formatAutoRefreshStatus(): string {
  const status = getAutoRefreshStatus()
  const lines = [
    `Auto-refresh: ${status.running ? 'ativo' : 'inativo'}`,
    `Renovacoes: ${status.refreshCount}`,
  ]

  if (status.tokenExpiresIn) {
    lines.push(`Token expira em: ${status.tokenExpiresIn}`)
  }

  if (status.lastRefresh > 0) {
    const ago = Math.round((Date.now() - status.lastRefresh) / 60_000)
    lines.push(`Ultima renovacao: ${ago === 0 ? 'agora' : `${ago}m atras`}`)
  }

  return lines.join('\n')
}

// ─── Internal ───────────────────────────────────────────────

function checkAndRefresh(
  bufferMs: number,
  opts: AutoRefreshOptions,
): void {
  if (!_currentAuth) return

  const now = Date.now()
  const timeUntilExpiry = _currentAuth.expiresAt - now

  // Not near expiration yet
  if (timeUntilExpiry > bufferMs) return

  logger.debug('Token near expiration, attempting refresh', {
    expiresIn: Math.round(timeUntilExpiry / 1000),
  })

  emit('status:update', {
    source: 'auto-refresh',
    message: 'Renovando token automaticamente...',
    level: 'warning',
    timestamp: now,
  })

  try {
    // First try a simple re-read — Claude Code may have already rotated the token
    const reread = refreshAuth()
    if (reread && reread.expiresAt !== null && reread.expiresAt > _currentAuth.expiresAt) {
      // Token was already rotated externally — just adopt it
      applyRefresh(reread as ExpiringAuth, now, opts)
      return
    }

    // Token on disk is the same or worse — spawn `claude` to force rotation
    spawnTokenRotation(now, opts)
  } catch (err) {
    const msg = `Erro ao renovar: ${err instanceof Error ? err.message : String(err)}`
    opts.onRefreshFailed?.(msg)

    emit('status:update', {
      source: 'auto-refresh',
      message: msg,
      level: 'error',
      timestamp: now,
    })
  }
}

function applyRefresh(
  fresh: ExpiringAuth,
  now: number,
  opts: AutoRefreshOptions,
): void {
  _currentAuth = fresh
  _state = {
    ..._state,
    lastRefresh: now,
    refreshCount: _state.refreshCount + 1,
  }

  opts.onRefreshed?.(fresh)

  emit('status:update', {
    source: 'auto-refresh',
    message: `Token renovado (expira ${formatExpiry(fresh.expiresAt)})`,
    level: 'success',
    timestamp: now,
  })

  logger.debug('Auto-refresh successful', {
    expiresAt: new Date(fresh.expiresAt).toISOString(),
    refreshCount: _state.refreshCount,
  })
}

function spawnTokenRotation(
  now: number,
  opts: AutoRefreshOptions,
): void {
  // Spawn claude to force OAuth token rotation (non-blocking)
  try {
    const proc = Bun.spawn(['claude', '-p', 'Fresh!'], {
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const timer = setTimeout(() => proc.kill(), 15_000)

    proc.exited.then(() => {
      clearTimeout(timer)
      // Re-read after claude has rotated the token
      const fresh = refreshAuth()
      if (fresh && fresh.expiresAt !== null && fresh.expiresAt > now) {
        applyRefresh(fresh as ExpiringAuth, Date.now(), opts)
      } else {
        const msg = 'Falha ao renovar token — claude nao rotacionou credenciais'
        opts.onRefreshFailed?.(msg)
        emit('status:update', {
          source: 'auto-refresh',
          message: msg,
          level: 'error',
          timestamp: Date.now(),
        })
      }
    }).catch(() => {
      clearTimeout(timer)
      const msg = 'Falha ao executar claude para renovar token'
      opts.onRefreshFailed?.(msg)
      emit('status:update', {
        source: 'auto-refresh',
        message: msg,
        level: 'error',
        timestamp: Date.now(),
      })
    })
  } catch {
    // claude not found or spawn failed
    const msg = 'claude CLI nao encontrado — renovacao automatica indisponivel'
    opts.onRefreshFailed?.(msg)
    emit('status:update', {
      source: 'auto-refresh',
      message: msg,
      level: 'error',
      timestamp: Date.now(),
    })
  }
}

function formatExpiry(expiresAt: number): string {
  return new Date(expiresAt).toLocaleTimeString('pt-BR', {
    hour: '2-digit',
    minute: '2-digit',
  })
}
