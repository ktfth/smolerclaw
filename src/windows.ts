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
  executePowerShellAsFile,
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

// ─── Calendar (Outlook COM + WinRT fallback) ────────────────

/**
 * Get today's calendar events.
 *
 * Strategy:
 *   1. Try Outlook COM (classic desktop Outlook)
 *   2. If COM fails (new Outlook / no classic install), fall back to
 *      Windows Calendar API (WinRT AppointmentManager) which works with
 *      any calendar provider: new Outlook, Windows Calendar, Google, etc.
 */
export async function getOutlookEvents(): Promise<string> {
  if (!IS_WINDOWS) return 'Outlook integration only available on Windows.'

  // --- Strategy 1: Classic Outlook COM ---
  const comResult = await tryOutlookCOM()
  if (comResult.success) return comResult.data

  // --- Strategy 2: WinRT Calendar API (new Outlook / Windows Calendar) ---
  const winrtResult = await tryWinRTCalendar()
  if (winrtResult.success) return winrtResult.data

  // Both failed — return the most informative error
  return winrtResult.data || comResult.data || 'Calendario nao disponivel.'
}

async function tryOutlookCOM(): Promise<{ success: boolean; data: string }> {
  const cmd = [
    'try {',
    '  $outlook = New-Object -ComObject Outlook.Application -ErrorAction Stop',
    '  $ns = $outlook.GetNamespace("MAPI")',
    '  $cal = $ns.GetDefaultFolder(9)',
    '  $today = (Get-Date).Date',
    '  $tomorrow = $today.AddDays(1)',
    '  $items = $cal.Items',
    '  $items.Sort("[Start]")',
    '  $items.IncludeRecurrences = $true',
    '  $todayStr = $today.ToString("MM/dd/yyyy HH:mm")',
    '  $tomorrowStr = $tomorrow.ToString("MM/dd/yyyy HH:mm")',
    '  $filter = "[Start] >= \'$todayStr\' AND [Start] < \'$tomorrowStr\'"',
    '  $events = $items.Restrict($filter)',
    '  $results = @()',
    '  foreach ($e in $events) {',
    '    $start = ([DateTime]$e.Start).ToString("HH:mm")',
    '    $end = ([DateTime]$e.End).ToString("HH:mm")',
    '    $results += "$start-$end $($e.Subject)"',
    '  }',
    '  if ($results.Count -eq 0) { Write-Output "Nenhum evento hoje." }',
    '  else { Write-Output ($results -join [char]10) }',
    '} catch {',
    '  Write-Error $_.Exception.Message',
    '  exit 1',
    '}',
  ].join('\n')

  try {
    const result = await executePowerShell(cmd, { timeout: 30_000, sta: true })
    if (result.timedOut) {
      return { success: false, data: 'Outlook timeout.' }
    }
    if (result.exitCode === 0 && result.stdout.trim()) {
      return { success: true, data: result.stdout.trim() }
    }
    return { success: false, data: result.stderr.trim() || 'Outlook COM indisponivel.' }
  } catch {
    return { success: false, data: 'Outlook COM indisponivel.' }
  }
}

async function tryWinRTCalendar(): Promise<{ success: boolean; data: string }> {
  // Windows Calendar API via WinRT — accesses calendars synced to Windows.
  // Requires the Microsoft account to be added in Windows Settings > Accounts.
  // Uses executePowerShellAsFile to avoid -Command parsing issues with long scripts.
  const script = `
try {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime -ErrorAction Stop

  $asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods()) | Where-Object {
    $_.Name -eq "AsTask" -and
    $_.GetParameters().Count -eq 1 -and
    $_.GetParameters()[0].ParameterType.Name -eq "IAsyncOperation\`\`1"
  } | Select-Object -First 1

  if ($null -eq $asTaskGeneric) {
    Write-Error "WinRT AsTask nao encontrado"
    exit 1
  }

  function AwaitOp($op, [Type]$rt) {
    $t = $asTaskGeneric.MakeGenericMethod($rt).Invoke($null, @($op))
    $t.Wait(15000) | Out-Null
    return $t.Result
  }

  [void][Windows.ApplicationModel.Appointments.AppointmentManager, Windows.Foundation.UniversalApiContract, ContentType=WindowsRuntime]

  $store = AwaitOp ([Windows.ApplicationModel.Appointments.AppointmentManager]::RequestStoreAsync(
    [Windows.ApplicationModel.Appointments.AppointmentStoreAccessType]::AllCalendarsReadOnly
  )) ([Windows.ApplicationModel.Appointments.AppointmentStore])

  if ($null -eq $store) {
    Write-Error "Store nulo - conta nao sincronizada no Windows"
    exit 1
  }

  $cals = AwaitOp ($store.FindAppointmentCalendarsAsync()) ([System.Collections.Generic.IReadOnlyList[Windows.ApplicationModel.Appointments.AppointmentCalendar]])

  if ($cals.Count -eq 0) {
    Write-Error "Nenhum calendario sincronizado. Adicione sua conta em Configuracoes > Contas > Email e contas."
    exit 1
  }

  # Use 2-param overload (no FindAppointmentsOptions) — avoids WinRT IVector
  # COM interop issues. Subject, StartTime, Duration are populated by default.
  $appts = AwaitOp ($store.FindAppointmentsAsync(
    [DateTimeOffset]::Now.Date,
    [TimeSpan]::FromDays(1)
  )) ([System.Collections.Generic.IReadOnlyList[Windows.ApplicationModel.Appointments.Appointment]])

  $results = @()
  if ($null -ne $appts) {
    foreach ($a in $appts) {
      $s = $a.StartTime.LocalDateTime.ToString("HH:mm")
      $e = $a.StartTime.Add($a.Duration).LocalDateTime.ToString("HH:mm")
      $subj = if ($a.Subject) { $a.Subject } else { "(sem titulo)" }
      $results += "$s-$e $subj"
    }
  }

  $calNames = @()
  foreach ($c in $cals) { $calNames += $c.DisplayName }

  if ($results.Count -eq 0) {
    Write-Output "Nenhum evento hoje. Calendarios: $($calNames -join ', ')"
  } else {
    Write-Output ($results -join [char]10)
  }
} catch {
  Write-Error $_.Exception.Message
  exit 1
}
`

  try {
    const result = await executePowerShellAsFile(script, { timeout: 30_000, sta: true })
    if (result.timedOut) {
      return { success: false, data: 'Calendario timeout.' }
    }
    if (result.exitCode === 0 && result.stdout.trim()) {
      return { success: true, data: result.stdout.trim() }
    }
    return { success: false, data: result.stderr.trim() || 'Calendario Windows indisponivel.' }
  } catch {
    return { success: false, data: 'Calendario Windows indisponivel.' }
  }
}

// ─── Exports ────────────────────────────────────────────────

export function getKnownApps(): readonly string[] {
  return Object.keys(KNOWN_APPS)
}
