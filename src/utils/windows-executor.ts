/**
 * Windows Executor - Centralized module for Windows system calls.
 *
 * Provides hardened PowerShell execution with:
 * - Mandatory flags: -NoProfile -NonInteractive -ExecutionPolicy Bypass
 * - UTF-8 output encoding
 * - Configurable timeout (default 15s) with anti-zombie protection
 * - Automatic path quoting for spaces
 * - Debug logging to file (not TUI)
 * - Executable existence validation
 *
 * SECURITY: All commands go through this single entry point.
 */

import { existsSync, appendFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir, homedir } from 'node:os'

// ─── Constants ──────────────────────────────────────────────

/** Default timeout in milliseconds (15 seconds) */
export const DEFAULT_TIMEOUT_MS = 15_000

/** Maximum output length before truncation */
const MAX_OUTPUT_LENGTH = 100_000

/** ANSI escape sequence regex for cleaning output */
const ANSI_RE = /[\x1b\x9b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nq-uy=><~]/g

/** Log file location */
const LOG_DIR = join(homedir(), '.smolerclaw', 'logs')
const LOG_FILE = join(LOG_DIR, 'windows-executor.log')

/** Mandatory PowerShell flags for safe execution */
const PS_BASE_FLAGS = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass'] as const

// ─── Types ──────────────────────────────────────────────────

export interface ExecutionResult {
  stdout: string
  stderr: string
  exitCode: number
  duration: number
  timedOut: boolean
}

export interface ExecutionOptions {
  /** Timeout in milliseconds. Default: 15000 */
  timeout?: number
  /** Working directory for the command */
  cwd?: string
  /** Enable debug logging to file */
  debug?: boolean
  /** Use STA apartment (required for clipboard/UI operations) */
  sta?: boolean
}

export interface CommandCheckResult {
  exists: boolean
  path?: string
  error?: string
}

// ─── Logging ────────────────────────────────────────────────

let _debugEnabled = false

export function enableDebugLogging(enabled: boolean): void {
  _debugEnabled = enabled
  if (enabled) {
    try {
      if (!existsSync(LOG_DIR)) {
        mkdirSync(LOG_DIR, { recursive: true })
      }
    } catch {
      // Best effort
    }
  }
}

function debugLog(level: 'INFO' | 'ERROR' | 'WARN', message: string, data?: Record<string, unknown>): void {
  if (!_debugEnabled) return

  const timestamp = new Date().toISOString()
  const entry = data
    ? `[${timestamp}] [${level}] ${message} ${JSON.stringify(data)}\n`
    : `[${timestamp}] [${level}] ${message}\n`

  try {
    appendFileSync(LOG_FILE, entry)
  } catch {
    // Best effort - don't crash on log failure
  }
}

// ─── Path Utilities ─────────────────────────────────────────

/**
 * Quote a path for safe embedding in PowerShell commands.
 * Handles paths with spaces and special characters.
 */
export function quotePath(path: string): string {
  // Already quoted
  if ((path.startsWith('"') && path.endsWith('"')) ||
      (path.startsWith("'") && path.endsWith("'"))) {
    return path
  }

  // Use single quotes for PowerShell (literal string, no interpolation)
  // Escape any existing single quotes by doubling them
  const escaped = path.replace(/'/g, "''")
  return `'${escaped}'`
}

/**
 * Validate and normalize a file path.
 * Returns the quoted path ready for PowerShell.
 */
export function normalizePathForPS(path: string): string {
  // Normalize separators to Windows style
  const normalized = path.replace(/\//g, '\\')
  return quotePath(normalized)
}

// ─── Executable Validation ──────────────────────────────────

/** Cache for executable lookups */
const _executableCache = new Map<string, CommandCheckResult>()

/**
 * Check if an executable exists in PATH or at a specific location.
 * Results are cached for performance.
 */
export async function checkExecutable(name: string): Promise<CommandCheckResult> {
  const cached = _executableCache.get(name.toLowerCase())
  if (cached) return cached

  // Check if it's an absolute path
  if (name.includes('\\') || name.includes('/')) {
    if (existsSync(name)) {
      const result: CommandCheckResult = { exists: true, path: name }
      _executableCache.set(name.toLowerCase(), result)
      return result
    }
    return { exists: false, error: `File not found: ${name}` }
  }

  // Use PowerShell Get-Command to find the executable
  const cmd = `(Get-Command '${name}' -ErrorAction SilentlyContinue).Source`

  try {
    const result = await executePowerShell(cmd, { timeout: 5000 })

    if (result.exitCode === 0 && result.stdout.trim()) {
      const found: CommandCheckResult = { exists: true, path: result.stdout.trim() }
      _executableCache.set(name.toLowerCase(), found)
      return found
    }

    const notFound: CommandCheckResult = { exists: false, error: `'${name}' not found in PATH` }
    _executableCache.set(name.toLowerCase(), notFound)
    return notFound
  } catch (err) {
    return { exists: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * Clear the executable cache (useful for testing).
 */
export function clearExecutableCache(): void {
  _executableCache.clear()
}

// ─── Core Execution ─────────────────────────────────────────

/**
 * Execute a PowerShell command with all safety guards.
 *
 * This is the ONLY entry point for PowerShell execution in the codebase.
 * All calls are guaranteed to have:
 * - -NoProfile -NonInteractive -ExecutionPolicy Bypass
 * - UTF-8 output encoding
 * - Timeout protection
 * - ANSI sequence stripping
 */
export async function executePowerShell(
  command: string,
  options: ExecutionOptions = {},
): Promise<ExecutionResult> {
  const {
    timeout = DEFAULT_TIMEOUT_MS,
    cwd,
    debug = _debugEnabled,
    sta = false,
  } = options

  const startTime = performance.now()

  // Build command with UTF-8 output encoding
  // Wrap the command to force UTF-8 console output
  const utf8Wrapper = `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; ${command}`

  // Build args array
  const args: string[] = ['powershell', ...PS_BASE_FLAGS]
  if (sta) {
    args.push('-STA')
  }
  args.push('-Command', utf8Wrapper)

  if (debug) {
    debugLog('INFO', 'Executing PowerShell command', {
      command: command.slice(0, 500),
      timeout,
      cwd,
      sta,
    })
  }

  let proc: ReturnType<typeof Bun.spawn>

  try {
    proc = Bun.spawn(args, {
      stdout: 'pipe',
      stderr: 'pipe',
      cwd,
    })
  } catch (err) {
    const errorResult: ExecutionResult = {
      stdout: '',
      stderr: `Failed to spawn PowerShell: ${err instanceof Error ? err.message : String(err)}`,
      exitCode: 1,
      duration: Math.round(performance.now() - startTime),
      timedOut: false,
    }

    if (debug) {
      debugLog('ERROR', 'Failed to spawn process', { error: errorResult.stderr })
    }

    return errorResult
  }

  // Setup timeout with process kill
  let timedOut = false
  const timeoutId = setTimeout(() => {
    timedOut = true
    try {
      proc.kill()
    } catch {
      // Process may have already exited
    }
  }, timeout)

  try {
    // Drain both pipes concurrently to prevent deadlock
    const [stdout, stderr] = await Promise.all([
      proc.stdout instanceof ReadableStream ? new Response(proc.stdout).text() : '',
      proc.stderr instanceof ReadableStream ? new Response(proc.stderr).text() : '',
    ])

    const exitCode = await proc.exited
    clearTimeout(timeoutId)

    const duration = Math.round(performance.now() - startTime)

    const result: ExecutionResult = {
      stdout: cleanOutput(stdout),
      stderr: cleanOutput(stderr),
      exitCode: timedOut ? -1 : exitCode,
      duration,
      timedOut,
    }

    if (debug) {
      debugLog(
        result.exitCode === 0 ? 'INFO' : 'WARN',
        'Command completed',
        {
          exitCode: result.exitCode,
          duration,
          timedOut,
          stdoutLength: result.stdout.length,
          stderrLength: result.stderr.length,
        },
      )
    }

    return result
  } catch (err) {
    clearTimeout(timeoutId)

    const errorResult: ExecutionResult = {
      stdout: '',
      stderr: `Execution error: ${err instanceof Error ? err.message : String(err)}`,
      exitCode: 1,
      duration: Math.round(performance.now() - startTime),
      timedOut,
    }

    if (debug) {
      debugLog('ERROR', 'Execution failed', { error: errorResult.stderr, timedOut })
    }

    return errorResult
  }
}

/**
 * Execute a PowerShell script file with all safety guards.
 */
export async function executePowerShellScript(
  scriptPath: string,
  options: ExecutionOptions = {},
): Promise<ExecutionResult> {
  const quotedPath = normalizePathForPS(scriptPath)
  const command = `& ${quotedPath}`
  return executePowerShell(command, options)
}

/**
 * Execute a generic command (non-PowerShell) with timeout protection.
 * Used for schtasks, git, and other CLI tools.
 */
export async function executeCommand(
  args: string[],
  options: ExecutionOptions = {},
): Promise<ExecutionResult> {
  const {
    timeout = DEFAULT_TIMEOUT_MS,
    cwd,
    debug = _debugEnabled,
  } = options

  const startTime = performance.now()

  if (debug) {
    debugLog('INFO', 'Executing command', { args, timeout, cwd })
  }

  let proc: ReturnType<typeof Bun.spawn>

  try {
    proc = Bun.spawn(args, {
      stdout: 'pipe',
      stderr: 'pipe',
      cwd,
    })
  } catch (err) {
    return {
      stdout: '',
      stderr: `Failed to spawn: ${err instanceof Error ? err.message : String(err)}`,
      exitCode: 1,
      duration: Math.round(performance.now() - startTime),
      timedOut: false,
    }
  }

  let timedOut = false
  const timeoutId = setTimeout(() => {
    timedOut = true
    try {
      proc.kill()
    } catch { /* ignore */ }
  }, timeout)

  try {
    const [stdout, stderr] = await Promise.all([
      proc.stdout instanceof ReadableStream ? new Response(proc.stdout).text() : '',
      proc.stderr instanceof ReadableStream ? new Response(proc.stderr).text() : '',
    ])

    const exitCode = await proc.exited
    clearTimeout(timeoutId)

    return {
      stdout: cleanOutput(stdout),
      stderr: cleanOutput(stderr),
      exitCode: timedOut ? -1 : exitCode,
      duration: Math.round(performance.now() - startTime),
      timedOut,
    }
  } catch (err) {
    clearTimeout(timeoutId)

    return {
      stdout: '',
      stderr: `Execution error: ${err instanceof Error ? err.message : String(err)}`,
      exitCode: 1,
      duration: Math.round(performance.now() - startTime),
      timedOut,
    }
  }
}

// ─── Specialized Executors ──────────────────────────────────

/**
 * Execute a PowerShell command that requires STA apartment model.
 * Required for clipboard operations and Windows Forms.
 */
export async function executePowerShellSTA(
  command: string,
  options: Omit<ExecutionOptions, 'sta'> = {},
): Promise<ExecutionResult> {
  return executePowerShell(command, { ...options, sta: true })
}

/**
 * Execute schtasks command for Task Scheduler operations.
 */
export async function executeSchtasks(
  action: 'Create' | 'Delete' | 'Query' | 'Run',
  taskName: string,
  additionalArgs: string[] = [],
  options: Omit<ExecutionOptions, 'sta'> = {},
): Promise<ExecutionResult> {
  const args = ['schtasks', `/${action}`, '/TN', taskName, ...additionalArgs]

  // schtasks operations should be fast
  const timeout = options.timeout ?? 10_000

  return executeCommand(args, { ...options, timeout })
}

/**
 * Start a process without waiting for it to complete.
 * Used for opening applications, URLs, etc.
 */
export async function startProcess(
  target: string,
  args?: string,
  options: ExecutionOptions = {},
): Promise<ExecutionResult> {
  const quotedTarget = quotePath(target)
  const cmd = args
    ? `Start-Process ${quotedTarget} -ArgumentList '${args.replace(/'/g, "''")}'`
    : `Start-Process ${quotedTarget}`

  return executePowerShell(cmd, options)
}

/**
 * Open a file with its default application.
 */
export async function invokeItem(
  path: string,
  options: ExecutionOptions = {},
): Promise<ExecutionResult> {
  const quotedPath = normalizePathForPS(path)
  return executePowerShell(`Invoke-Item ${quotedPath}`, options)
}

// ─── Toast Notifications ────────────────────────────────────

/**
 * Show a Windows toast notification.
 * Handles XML encoding and escaping automatically.
 */
export async function showToast(
  title: string,
  body: string,
  options: ExecutionOptions = {},
): Promise<ExecutionResult> {
  // XML-encode to prevent injection
  const safeTitle = xmlEncode(title)
  const safeBody = xmlEncode(body)

  const cmd = [
    '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null',
    '[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null',
    `$template = '<toast><visual><binding template="ToastText02"><text id="1">${safeTitle}</text><text id="2">${safeBody}</text></binding></visual><audio src="ms-winsoundevent:Notification.Default"/></toast>'`,
    '$xml = New-Object Windows.Data.Xml.Dom.XmlDocument',
    '$xml.LoadXml($template)',
    '$toast = [Windows.UI.Notifications.ToastNotification]::new($xml)',
    '[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier("smolerclaw").Show($toast)',
  ].join('; ')

  // Toasts should be quick
  const timeout = options.timeout ?? 10_000

  return executePowerShell(cmd, { ...options, timeout })
}

// ─── Process Queries ────────────────────────────────────────

/**
 * Check if a process is running by name.
 */
export async function isProcessRunning(
  processName: string,
  options: ExecutionOptions = {},
): Promise<boolean> {
  const safeName = processName.replace(/'/g, "''")
  const cmd = `(Get-Process -Name '${safeName}' -ErrorAction SilentlyContinue) -ne $null`

  const result = await executePowerShell(cmd, { ...options, timeout: options.timeout ?? 5_000 })

  return result.stdout.trim().toLowerCase() === 'true'
}

/**
 * Get list of running processes with visible windows.
 */
export async function getVisibleProcesses(
  limit = 15,
  options: ExecutionOptions = {},
): Promise<ExecutionResult> {
  const cmd = `Get-Process | Where-Object {$_.MainWindowTitle -ne ''} | Sort-Object -Property WorkingSet64 -Descending | Select-Object -First ${limit} Name, @{N='Memory(MB)';E={[math]::Round($_.WorkingSet64/1MB,1)}}, MainWindowTitle | Format-Table -AutoSize | Out-String -Width 200`

  return executePowerShell(cmd, options)
}

// ─── Helpers ────────────────────────────────────────────────

/**
 * Strip ANSI escape sequences and trim output length.
 */
function cleanOutput(text: string): string {
  const stripped = text.replace(ANSI_RE, '')
  if (stripped.length > MAX_OUTPUT_LENGTH) {
    return stripped.slice(0, MAX_OUTPUT_LENGTH) + `\n... (truncated, ${stripped.length} total chars)`
  }
  return stripped
}

/**
 * XML-encode a string for safe embedding in XML.
 */
function xmlEncode(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

/**
 * Escape a string for embedding in a PowerShell single-quoted string.
 */
export function psSingleQuoteEscape(s: string): string {
  return s.replace(/'/g, "''")
}

/**
 * Escape a string for embedding in a PowerShell double-quoted string.
 */
export function psDoubleQuoteEscape(s: string): string {
  return s.replace(/"/g, '""').replace(/`/g, '``').replace(/\$/g, '`$')
}
