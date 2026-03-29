/**
 * Windows-specific utilities for the business assistant.
 * All operations are non-destructive (read-only or open-only).
 *
 * getDateTimeInfo() is cross-platform (pure JS, no Windows APIs).
 *
 * REFACTORED: All PowerShell execution now goes through windows-executor.ts
 */

import { IS_WINDOWS } from './platform'
import {
  executePowerShell,
  startProcess,
  invokeItem,
  getVisibleProcesses,
  checkExecutable,
  psSingleQuoteEscape,
  DEFAULT_TIMEOUT_MS,
} from './utils/windows-executor'

// ─── Security: PowerShell input sanitization ────────────────

/** Characters that can break out of a PowerShell double-quoted string or inject commands */
const PS_DANGEROUS = /[";`$\n\r|&<>{}()]/

/**
 * Validate a string is safe for embedding in a PowerShell command.
 * Rejects any string containing shell metacharacters rather than
 * trying to escape them (defense-in-depth).
 */
function validatePsInput(value: string, label: string): string | null {
  if (!value || typeof value !== 'string') {
    return `Error: ${label} is required.`
  }
  if (value.length > 500) {
    return `Error: ${label} too long (max 500 chars).`
  }
  if (PS_DANGEROUS.test(value)) {
    return `Error: ${label} contains invalid characters. Avoid: " ; \` $ | & < > { } ( ) and newlines.`
  }
  return null
}

// ─── App Launcher ───────────────────────────────────────────

/** Known Windows applications with their executable paths/commands */
const KNOWN_APPS: Record<string, string> = {
  // Microsoft Office (protocol URIs for MSIX/Store apps)
  excel: 'excel',
  word: 'winword',
  powerpoint: 'powerpnt',
  outlook: 'ms-outlook:',
  onenote: 'onenote',
  teams: 'msteams:',

  // Browsers
  edge: 'msedge',
  chrome: 'chrome',
  firefox: 'firefox',

  // System tools
  calculator: 'calc',
  notepad: 'notepad',
  terminal: 'wt',
  explorer: 'explorer',
  taskmanager: 'taskmgr',
  settings: 'ms-settings:',
  paint: 'mspaint',
  snip: 'snippingtool',

  // Dev tools
  vscode: 'code',
  cursor: 'cursor',
  postman: 'Postman',
}

/**
 * Open a Windows application by name. Non-destructive.
 */
export async function openApp(name: string, args?: string): Promise<string> {
  // Validate inputs first (platform-independent, so security tests work on CI)
  const key = name.toLowerCase().replace(/\s+/g, '')
  const exe = KNOWN_APPS[key]

  if (!exe) {
    const available = Object.keys(KNOWN_APPS).join(', ')
    return `Unknown app: "${name}". Available: ${available}`
  }

  if (args) {
    const err = validatePsInput(args, 'argument')
    if (err) return err
  }

  if (!IS_WINDOWS) return 'Error: this command is only available on Windows.'

  // Check if executable exists (skip for protocol URIs like ms-outlook:)
  if (!exe.includes(':')) {
    const check = await checkExecutable(exe)
    if (!check.exists) {
      return `Error: ${exe} not found. ${check.error || ''}`
    }
  }

  try {
    const result = await startProcess(exe, args)
    if (result.exitCode !== 0 && result.stderr.trim()) {
      return `Error opening ${name}: ${result.stderr.trim()}`
    }
    if (result.timedOut) {
      return `Error opening ${name}: timeout (application may have opened but response was delayed)`
    }
    return `Opened: ${name}`
  } catch (err) {
    return `Error opening ${name}: ${err instanceof Error ? err.message : String(err)}`
  }
}

/**
 * Open a URL in the default browser.
 */
export async function openUrl(url: string): Promise<string> {
  // Validate inputs first (platform-independent)
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    return 'Error: URL must start with http:// or https://'
  }

  const err = validatePsInput(url, 'URL')
  if (err) return err

  if (!IS_WINDOWS) return 'Error: this command is only available on Windows.'

  try {
    const result = await startProcess(url)
    if (result.exitCode !== 0 && result.stderr.trim()) {
      return `Error: ${result.stderr.trim()}`
    }
    if (result.timedOut) {
      return `Error: timeout opening URL (browser may have opened but response was delayed)`
    }
    return `Opened in browser: ${url}`
  } catch (err) {
    return `Error: ${err instanceof Error ? err.message : String(err)}`
  }
}

/**
 * Open a file with its default application.
 */
export async function openFile(filePath: string): Promise<string> {
  // Validate inputs first (platform-independent)
  const err = validatePsInput(filePath, 'file path')
  if (err) return err

  if (!IS_WINDOWS) return 'Error: this command is only available on Windows.'

  try {
    const result = await invokeItem(filePath)
    if (result.exitCode !== 0 && result.stderr.trim()) {
      return `Error: ${result.stderr.trim()}`
    }
    if (result.timedOut) {
      return `Error: timeout opening file (application may have opened but response was delayed)`
    }
    return `Opened: ${filePath}`
  } catch (err) {
    return `Error: ${err instanceof Error ? err.message : String(err)}`
  }
}

// ─── System Info ────────────────────────────────────────────

/**
 * Get a summary of running processes (top by CPU/memory).
 * Non-destructive — read-only.
 */
export async function getRunningApps(): Promise<string> {
  if (!IS_WINDOWS) return 'Error: this command is only available on Windows.'

  try {
    const result = await getVisibleProcesses(15)
    if (result.stderr.trim()) {
      return `Error: ${result.stderr.trim()}`
    }
    if (result.timedOut) {
      return 'Error: timeout getting process list'
    }
    return result.stdout.trim() || 'No windowed applications running.'
  } catch (err) {
    return `Error: ${err instanceof Error ? err.message : String(err)}`
  }
}

/**
 * Get system resource summary (CPU, RAM, disk).
 */
export async function getSystemInfo(): Promise<string> {
  if (!IS_WINDOWS) return 'Error: this command is only available on Windows.'

  const commands = [
    `$cpu = (Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average; "CPU: $cpu%"`,
    `$os = Get-CimInstance Win32_OperatingSystem; $total = [math]::Round($os.TotalVisibleMemorySize/1MB,1); $free = [math]::Round($os.FreePhysicalMemory/1MB,1); $used = $total - $free; "RAM: $used GB / $total GB (Free: $free GB)"`,
    `Get-CimInstance Win32_LogicalDisk -Filter "DriveType=3" | ForEach-Object { $free = [math]::Round($_.FreeSpace/1GB,1); $total = [math]::Round($_.Size/1GB,1); "$($_.DeviceID) $free GB free / $total GB" }`,
    `$uptime = (Get-Date) - (Get-CimInstance Win32_OperatingSystem).LastBootUpTime; "Uptime: $($uptime.Days)d $($uptime.Hours)h $($uptime.Minutes)m"`,
    `$b = Get-CimInstance Win32_Battery -ErrorAction SilentlyContinue; if ($b) { "Battery: $($b.EstimatedChargeRemaining)%" } else { "Battery: N/A (desktop)" }`,
  ]

  try {
    const result = await executePowerShell(commands.join('; '))
    if (!result.stdout.trim() && result.stderr.trim()) {
      return `Error: ${result.stderr.trim()}`
    }
    if (result.timedOut) {
      return 'Error: timeout getting system info'
    }
    return result.stdout.trim() || 'System info unavailable.'
  } catch (err) {
    return `Error: ${err instanceof Error ? err.message : String(err)}`
  }
}

/**
 * Get today's date/time info. Cross-platform (pure JS).
 */
export async function getDateTimeInfo(): Promise<string> {
  const now = new Date()
  const lines: string[] = []

  const weekday = now.toLocaleDateString('pt-BR', { weekday: 'long' })
  const date = now.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' })
  const time = now.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })

  lines.push(`${weekday}, ${date} — ${time}`)

  // ISO 8601 week number calculation
  const target = new Date(now.valueOf())
  target.setDate(target.getDate() + 3 - ((target.getDay() + 6) % 7))
  const jan4 = new Date(target.getFullYear(), 0, 4)
  const weekNum = 1 + Math.round(((target.getTime() - jan4.getTime()) / 86_400_000 - 3 + ((jan4.getDay() + 6) % 7)) / 7)
  lines.push(`Semana ${weekNum} do ano`)

  // Business hours check
  const hour = now.getHours()
  if (hour >= 8 && hour < 18) {
    lines.push('Status: horario comercial')
  } else if (hour >= 18 && hour < 22) {
    lines.push('Status: pos-expediente')
  } else {
    lines.push('Status: fora do horario comercial')
  }

  return lines.join('\n')
}

// ─── Outlook Calendar (if available) ────────────────────────

/**
 * Get today's Outlook calendar events (read-only).
 * Falls back gracefully if Outlook is not installed.
 * Uses olFolderCalendar = 9 from the Outlook COM object model.
 */
export async function getOutlookEvents(): Promise<string> {
  if (!IS_WINDOWS) return 'Outlook integration only available on Windows.'

  const cmd = [
    'try {',
    '  $outlook = New-Object -ComObject Outlook.Application -ErrorAction Stop',
    '  $ns = $outlook.GetNamespace("MAPI")',
    '  $cal = $ns.GetDefaultFolder(9)',  // olFolderCalendar
    '  $today = (Get-Date).Date',
    '  $tomorrow = $today.AddDays(1)',
    '  $items = $cal.Items',
    '  $items.Sort("[Start]")',
    '  $items.IncludeRecurrences = $true',
    '  $filter = "[Start] >= \'$($today.ToString(\'g\'))\' AND [Start] < \'$($tomorrow.ToString(\'g\'))\'"',
    '  $events = $items.Restrict($filter)',
    '  $results = @()',
    '  foreach ($e in $events) {',
    '    $start = ([DateTime]$e.Start).ToString("HH:mm")',
    '    $end = ([DateTime]$e.End).ToString("HH:mm")',
    '    $results += "$start-$end $($e.Subject)"',
    '  }',
    '  if ($results.Count -eq 0) { "Nenhum evento hoje." }',
    '  else { $results -join [char]10 }',
    '} catch {',
    '  "Outlook nao disponivel ou sem eventos."',
    '}',
  ].join('\n')

  try {
    // Outlook COM operations can be slow
    const result = await executePowerShell(cmd, { timeout: 30_000 })
    if (result.timedOut) {
      return 'Outlook timeout - pode estar em processo de inicializacao.'
    }
    return result.stdout.trim() || 'Outlook nao disponivel.'
  } catch {
    return 'Outlook nao disponivel.'
  }
}

// ─── Exports ────────────────────────────────────────────────

export function getKnownApps(): readonly string[] {
  return Object.keys(KNOWN_APPS)
}
