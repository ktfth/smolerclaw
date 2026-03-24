/**
 * Windows-specific utilities for the business assistant.
 * All operations are non-destructive (read-only or open-only).
 *
 * getDateTimeInfo() is cross-platform (pure JS, no Windows APIs).
 */

import { IS_WINDOWS } from './platform'

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

// ─── Process helpers with timeout and deadlock prevention ───

const SPAWN_TIMEOUT_MS = 15_000

/**
 * Spawn a PowerShell command with timeout and concurrent pipe drainage.
 * Returns { stdout, stderr, exitCode }.
 */
async function runPowerShell(cmd: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn(
    ['powershell', '-NoProfile', '-NonInteractive', '-Command', cmd],
    { stdout: 'pipe', stderr: 'pipe' },
  )

  const timer = setTimeout(() => proc.kill(), SPAWN_TIMEOUT_MS)

  // Drain both pipes concurrently to prevent deadlock
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  const exitCode = await proc.exited
  clearTimeout(timer)

  return { stdout, stderr, exitCode }
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

  const cmd = args
    ? `Start-Process '${exe}' -ArgumentList '${args}'`
    : `Start-Process '${exe}'`

  try {
    const { exitCode, stderr } = await runPowerShell(cmd)
    if (exitCode !== 0 && stderr.trim()) {
      return `Error opening ${name}: ${stderr.trim()}`
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
    const { exitCode, stderr } = await runPowerShell(`Start-Process '${url}'`)
    if (exitCode !== 0 && stderr.trim()) {
      return `Error: ${stderr.trim()}`
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
    const { exitCode, stderr } = await runPowerShell(`Invoke-Item '${filePath}'`)
    if (exitCode !== 0 && stderr.trim()) {
      return `Error: ${stderr.trim()}`
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
    const cmd = `Get-Process | Where-Object {$_.MainWindowTitle -ne ''} | Sort-Object -Property WorkingSet64 -Descending | Select-Object -First 15 Name, @{N='Memory(MB)';E={[math]::Round($_.WorkingSet64/1MB,1)}}, MainWindowTitle | Format-Table -AutoSize | Out-String -Width 200`
    const { stdout, stderr } = await runPowerShell(cmd)
    if (stderr.trim()) {
      return `Error: ${stderr.trim()}`
    }
    return stdout.trim() || 'No windowed applications running.'
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
    const { stdout, stderr } = await runPowerShell(commands.join('; '))
    if (!stdout.trim() && stderr.trim()) {
      return `Error: ${stderr.trim()}`
    }
    return stdout.trim() || 'System info unavailable.'
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
    const { stdout } = await runPowerShell(cmd)
    return stdout.trim() || 'Outlook nao disponivel.'
  } catch {
    return 'Outlook nao disponivel.'
  }
}

// ─── Exports ────────────────────────────────────────────────

export function getKnownApps(): readonly string[] {
  return Object.keys(KNOWN_APPS)
}
