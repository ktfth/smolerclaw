/**
 * Process monitor — watch Windows processes and notify if they stop.
 * Non-destructive: only checks process existence, never kills anything.
 */

import { IS_WINDOWS } from './platform'

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

  const isRunning = await isProcessRunning(monitor.name)

  if (monitor.lastSeen && !isRunning) {
    // Process just stopped
    const msg = `ALERTA: "${monitor.name}" parou de rodar!`
    fireToast('Processo parou!', `"${monitor.name}" nao esta mais rodando.`)
    _onNotify?.(msg)
  } else if (!monitor.lastSeen && isRunning) {
    // Process came back
    const msg = `"${monitor.name}" voltou a rodar.`
    _onNotify?.(msg)
  }

  // Update state immutably
  _monitors.set(key, { ...monitor, lastSeen: isRunning })
}

async function isProcessRunning(name: string): Promise<boolean> {
  if (!IS_WINDOWS) return false

  try {
    const cmd = `(Get-Process -Name '${name}' -ErrorAction SilentlyContinue) -ne $null`
    const proc = Bun.spawn(
      ['powershell', '-NoProfile', '-NonInteractive', '-Command', cmd],
      { stdout: 'pipe', stderr: 'pipe' },
    )
    const timer = setTimeout(() => proc.kill(), 10_000)
    const [stdout] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])
    await proc.exited
    clearTimeout(timer)
    return stdout.trim().toLowerCase() === 'true'
  } catch {
    return false
  }
}

async function fireToast(title: string, body: string): Promise<void> {
  if (!IS_WINDOWS) return

  const safeTitle = title.replace(/'/g, "''")
  const safeBody = body.replace(/'/g, "''")

  const cmd = [
    '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null',
    '[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null',
    `$template = '<toast><visual><binding template="ToastText02"><text id="1">${safeTitle}</text><text id="2">${safeBody}</text></binding></visual><audio src="ms-winsoundevent:Notification.Default"/></toast>'`,
    '$xml = New-Object Windows.Data.Xml.Dom.XmlDocument',
    '$xml.LoadXml($template)',
    '$toast = [Windows.UI.Notifications.ToastNotification]::new($xml)',
    '[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier("smolerclaw").Show($toast)',
  ].join('; ')

  try {
    const proc = Bun.spawn(
      ['powershell', '-NoProfile', '-NonInteractive', '-Command', cmd],
      { stdout: 'pipe', stderr: 'pipe' },
    )
    const timer = setTimeout(() => proc.kill(), 10_000)
    await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])
    await proc.exited
    clearTimeout(timer)
  } catch { /* best effort */ }
}
