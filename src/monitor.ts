/**
 * Process monitor — watch Windows processes and notify if they stop.
 * Non-destructive: only checks process existence, never kills anything.
 *
 * REFACTORED: All PowerShell execution now goes through windows-executor.ts
 */

import { IS_WINDOWS } from './platform'
import { showToast, isProcessRunning } from './utils/windows-executor'

// ─── Types ──────────────────────────────────────────────────

interface MonitoredProcess {
  name: string
  interval: ReturnType<typeof setInterval>
  lastSeen: boolean
}

type MonitorCallback = (message: string) => void

// ─── State ──────────────────────────────────────────────────

const _monitors = new Map<string, MonitoredProcess>()
let _onNotify: MonitorCallback | null = null

// ─── Init ───────────────────────────────────────────────────

export function initMonitor(onNotify: MonitorCallback): void {
  _onNotify = onNotify
}

// ─── Public API ─────────────────────────────────────────────

/**
 * Start monitoring a process by name. Checks every intervalSec seconds.
 */
export function startMonitor(processName: string, intervalSec = 60): string {
  if (!IS_WINDOWS) return 'Error: monitor is only available on Windows.'

  const key = processName.toLowerCase()
  if (_monitors.has(key)) {
    return `"${processName}" ja esta sendo monitorado.`
  }

  const interval = setInterval(() => checkProcess(key), intervalSec * 1000)

  _monitors.set(key, {
    name: processName,
    interval,
    lastSeen: true, // assume running at start
  })

  // Do an initial check
  checkProcess(key)

  return `Monitorando "${processName}" a cada ${intervalSec}s.`
}

/**
 * Stop monitoring a process.
 */
export function stopMonitor(processName: string): string {
  const key = processName.toLowerCase()
  const monitor = _monitors.get(key)
  if (!monitor) {
    return `"${processName}" nao esta sendo monitorado.`
  }

  clearInterval(monitor.interval)
  _monitors.delete(key)
  return `Monitor parado: "${processName}"`
}

/**
 * List all monitored processes.
 */
export function listMonitors(): string {
  if (_monitors.size === 0) return 'Nenhum processo monitorado.'

  const lines = [..._monitors.values()].map((m) => {
    const status = m.lastSeen ? 'rodando' : 'PARADO'
    return `  ${m.name.padEnd(20)} [${status}]`
  })

  return `Processos monitorados (${_monitors.size}):\n${lines.join('\n')}`
}

/**
 * Stop all monitors (call on exit).
 */
export function stopAllMonitors(): void {
  for (const monitor of _monitors.values()) {
    clearInterval(monitor.interval)
  }
  _monitors.clear()
}

// ─── Internal ───────────────────────────────────────────────

async function checkProcess(key: string): Promise<void> {
  const monitor = _monitors.get(key)
  if (!monitor) return

  const running = await isProcessRunning(monitor.name, { timeout: 10_000 })

  if (monitor.lastSeen && !running) {
    // Process just stopped
    const msg = `ALERTA: "${monitor.name}" parou de rodar!`
    showToast('Processo parou!', `"${monitor.name}" nao esta mais rodando.`, { timeout: 10_000 }).catch(() => {})
    _onNotify?.(msg)
  } else if (!monitor.lastSeen && running) {
    // Process came back
    const msg = `"${monitor.name}" voltou a rodar.`
    _onNotify?.(msg)
  }

  // Update state immutably
  _monitors.set(key, { ...monitor, lastSeen: running })
}
