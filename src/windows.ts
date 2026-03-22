/**
 * Windows-specific utilities for the business assistant.
 * All operations are non-destructive (read-only or open-only).
 */

import { IS_WINDOWS } from './platform'

// ─── App Launcher ───────────────────────────────────────────

/** Known Windows applications with their executable paths/commands */
const KNOWN_APPS: Record<string, string> = {
  // Microsoft Office
  excel: 'excel',
  word: 'winword',
  powerpoint: 'powerpnt',
  outlook: 'outlook',
  onenote: 'onenote',
  teams: 'msteams',

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
}

/**
 * Open a Windows application by name. Non-destructive.
 */
export async function openApp(name: string, args?: string): Promise<string> {
  if (!IS_WINDOWS) return 'Error: this command is only available on Windows.'

  const key = name.toLowerCase().replace(/\s+/g, '')
  const exe = KNOWN_APPS[key]

  if (!exe) {
    const available = Object.keys(KNOWN_APPS).join(', ')
    return `Unknown app: "${name}". Available: ${available}`
  }

  const cmd = args ? `Start-Process "${exe}" -ArgumentList "${args}"` : `Start-Process "${exe}"`

  try {
    const proc = Bun.spawn(
      ['powershell', '-NoProfile', '-NonInteractive', '-Command', cmd],
      { stdout: 'pipe', stderr: 'pipe' },
    )
    await proc.exited
    return `Opened: ${name}`
  } catch (err) {
    return `Error opening ${name}: ${err instanceof Error ? err.message : String(err)}`
  }
}

/**
 * Open a URL in the default browser.
 */
export async function openUrl(url: string): Promise<string> {
  if (!IS_WINDOWS) return 'Error: this command is only available on Windows.'

  try {
    const proc = Bun.spawn(
      ['powershell', '-NoProfile', '-NonInteractive', '-Command', `Start-Process "${url}"`],
      { stdout: 'pipe', stderr: 'pipe' },
    )
    await proc.exited
    return `Opened in browser: ${url}`
  } catch (err) {
    return `Error: ${err instanceof Error ? err.message : String(err)}`
  }
}

/**
 * Open a file with its default application.
 */
export async function openFile(filePath: string): Promise<string> {
  if (!IS_WINDOWS) return 'Error: this command is only available on Windows.'

  try {
    const proc = Bun.spawn(
      ['powershell', '-NoProfile', '-NonInteractive', '-Command', `Invoke-Item "${filePath}"`],
      { stdout: 'pipe', stderr: 'pipe' },
    )
    await proc.exited
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
    const proc = Bun.spawn(
      ['powershell', '-NoProfile', '-NonInteractive', '-Command', cmd],
      { stdout: 'pipe', stderr: 'pipe' },
    )
    const stdout = await new Response(proc.stdout).text()
    await proc.exited
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
    // CPU usage
    `$cpu = (Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average; "CPU: $cpu%"`,
    // RAM
    `$os = Get-CimInstance Win32_OperatingSystem; $total = [math]::Round($os.TotalVisibleMemorySize/1MB,1); $free = [math]::Round($os.FreePhysicalMemory/1MB,1); $used = $total - $free; "RAM: $used GB / $total GB (Free: $free GB)"`,
    // Disk
    `Get-CimInstance Win32_LogicalDisk -Filter "DriveType=3" | ForEach-Object { $free = [math]::Round($_.FreeSpace/1GB,1); $total = [math]::Round($_.Size/1GB,1); "$($_.DeviceID) $free GB free / $total GB" }`,
    // Uptime
    `$uptime = (Get-Date) - (Get-CimInstance Win32_OperatingSystem).LastBootUpTime; "Uptime: $($uptime.Days)d $($uptime.Hours)h $($uptime.Minutes)m"`,
    // Battery (if laptop)
    `$b = Get-CimInstance Win32_Battery -ErrorAction SilentlyContinue; if ($b) { "Battery: $($b.EstimatedChargeRemaining)%" } else { "Battery: N/A (desktop)" }`,
  ]

  const fullCmd = commands.join('; ')

  try {
    const proc = Bun.spawn(
      ['powershell', '-NoProfile', '-NonInteractive', '-Command', fullCmd],
      { stdout: 'pipe', stderr: 'pipe' },
    )
    const stdout = await new Response(proc.stdout).text()
    await proc.exited
    return stdout.trim()
  } catch (err) {
    return `Error: ${err instanceof Error ? err.message : String(err)}`
  }
}

/**
 * Get today's date/time info including upcoming calendar events
 * from Outlook (if available).
 */
export async function getDateTimeInfo(): Promise<string> {
  const now = new Date()
  const lines: string[] = []

  const weekday = now.toLocaleDateString('pt-BR', { weekday: 'long' })
  const date = now.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' })
  const time = now.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })

  lines.push(`${weekday}, ${date} — ${time}`)

  // Week number
  const start = new Date(now.getFullYear(), 0, 1)
  const diff = now.getTime() - start.getTime()
  const oneWeek = 7 * 24 * 60 * 60 * 1000
  const weekNum = Math.ceil(((diff / oneWeek) + start.getDay() + 1) / 1)
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
 */
export async function getOutlookEvents(): Promise<string> {
  if (!IS_WINDOWS) return 'Outlook integration only available on Windows.'

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
    const proc = Bun.spawn(
      ['powershell', '-NoProfile', '-NonInteractive', '-Command', cmd],
      { stdout: 'pipe', stderr: 'pipe' },
    )
    const stdout = await new Response(proc.stdout).text()
    await proc.exited
    return stdout.trim()
  } catch {
    return 'Outlook nao disponivel.'
  }
}

// ─── Quick Notes (non-destructive — appends only) ───────────

export function getKnownApps(): string[] {
  return Object.keys(KNOWN_APPS)
}
