/**
 * M365 CLI Executor — subprocess wrapper for the m365 CLI.
 *
 * Runs `m365 <command> --output json` via Bun.spawn, parses JSON output,
 * handles timeouts, and detects auth expiration.
 *
 * Resolves the m365 binary from the local node_modules/.bin first,
 * falling back to the global PATH.
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { M365Result } from './types'

// ─── Constants ──────────────────────────────────────────────

const DEFAULT_TIMEOUT_MS = 30_000
const MAX_OUTPUT_LENGTH = 200_000

/** Error messages that indicate the user is NOT logged in (not permission errors) */
const NOT_LOGGED_IN_PATTERNS = [
  /^Log in to Microsoft 365 first$/i,
  /not logged in/i,
  /token has expired/i,
]

// ─── State ──────────────────────────────────────────────────

let _m365Available: boolean | null = null
let _m365Binary: string = 'm365'

// ─── Binary Resolution ─────────────────────────────────────

/**
 * Resolve the m365 binary path. Prefers local node_modules/.bin over global.
 * Bun generates .exe on Windows, npm/yarn generate .cmd shims.
 */
function resolveM365Binary(): string {
  const binDir = join(process.cwd(), 'node_modules', '.bin')

  // Bun on Windows: .exe
  const localExe = join(binDir, 'm365.exe')
  if (existsSync(localExe)) return localExe

  // npm/yarn on Windows: .cmd shim
  const localCmd = join(binDir, 'm365.cmd')
  if (existsSync(localCmd)) return localCmd

  // Unix / Bun .bunx
  const localBunx = join(binDir, 'm365.bunx')
  if (existsSync(localBunx)) return localBunx

  // Plain binary (Unix)
  const localBin = join(binDir, 'm365')
  if (existsSync(localBin)) return localBin

  // Fallback to global PATH
  return 'm365'
}

// ─── Core ───────────────────────────────────────────────────

/**
 * Check if the m365 CLI is installed and available.
 */
export async function checkM365Installed(): Promise<boolean> {
  if (_m365Available !== null) return _m365Available

  _m365Binary = resolveM365Binary()

  try {
    const proc = Bun.spawn([_m365Binary, '--version'], {
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const timer = setTimeout(() => proc.kill(), 5_000)
    await new Response(proc.stdout).text()
    await proc.exited
    clearTimeout(timer)
    _m365Available = proc.exitCode === 0
  } catch {
    _m365Available = false
  }

  return _m365Available
}

/**
 * Reset the cached availability check (useful after install).
 */
export function resetM365Check(): void {
  _m365Available = null
  _m365Binary = 'm365'
}

/**
 * Execute an m365 CLI command and return parsed results.
 *
 * @param args - Command arguments (e.g., ['outlook', 'mail', 'list'])
 * @param options - Execution options
 */
export async function executeM365<T = unknown>(
  args: readonly string[],
  options: { timeout?: number; jsonOutput?: boolean } = {},
): Promise<M365Result<T>> {
  const timeout = options.timeout ?? DEFAULT_TIMEOUT_MS
  const useJson = options.jsonOutput !== false

  const installed = await checkM365Installed()
  if (!installed) {
    return {
      success: false,
      data: null,
      error: 'M365 CLI not found. Run: bun install',
      raw: '',
      duration: 0,
    }
  }

  const cmdArgs = [_m365Binary, ...args]
  if (useJson) {
    cmdArgs.push('--output', 'json')
  }

  const startTime = performance.now()

  try {
    const proc = Bun.spawn(cmdArgs, {
      stdout: 'pipe',
      stderr: 'pipe',
    })

    const timer = setTimeout(() => proc.kill(), timeout)

    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])

    await proc.exited
    clearTimeout(timer)

    const duration = Math.round(performance.now() - startTime)
    const raw = stdout.trim().slice(0, MAX_OUTPUT_LENGTH)

    if (proc.exitCode !== 0) {
      const errorMsg = stderr.trim() || raw || 'Unknown error'

      // Only override message if user is clearly not logged in
      if (isNotLoggedIn(errorMsg)) {
        return {
          success: false,
          data: null,
          error: 'Not logged in. Run /m365 login first.',
          raw: errorMsg,
          duration,
        }
      }

      // Pass through the actual error message
      return {
        success: false,
        data: null,
        error: errorMsg,
        raw: errorMsg,
        duration,
      }
    }

    // Parse JSON output
    if (useJson && raw) {
      try {
        const data = JSON.parse(raw) as T
        return { success: true, data, error: null, raw, duration }
      } catch {
        // JSON parse failed — return raw text
        return {
          success: true,
          data: raw as unknown as T,
          error: null,
          raw,
          duration,
        }
      }
    }

    return { success: true, data: raw as unknown as T, error: null, raw, duration }
  } catch (err) {
    const duration = Math.round(performance.now() - startTime)
    const message = err instanceof Error ? err.message : String(err)

    return {
      success: false,
      data: null,
      error: message.includes('timed out') || message.includes('killed')
        ? `Command timed out after ${timeout}ms`
        : message,
      raw: '',
      duration,
    }
  }
}

/**
 * Execute an m365 command that returns plain text (no JSON parsing).
 */
export async function executeM365Text(
  args: readonly string[],
  timeout?: number,
): Promise<M365Result<string>> {
  return executeM365<string>(args, { timeout, jsonOutput: false })
}

/**
 * Execute an m365 command with streaming output.
 *
 * Reads stdout and stderr incrementally, calling `onOutput` with each
 * chunk as it arrives. This lets the TUI display the device code URL
 * immediately while the process waits for browser-based auth.
 *
 * Used for `m365 login` and `m365 setup`.
 */
export async function executeM365Streaming(
  args: readonly string[],
  onOutput: (text: string) => void,
  timeout: number = 180_000,
): Promise<{ success: boolean; exitCode: number; output: string }> {
  const installed = await checkM365Installed()
  if (!installed) {
    return { success: false, exitCode: 1, output: 'M365 CLI not found.' }
  }

  const cmdArgs = [_m365Binary, ...args]
  const chunks: string[] = []

  try {
    const proc = Bun.spawn(cmdArgs, {
      stdout: 'pipe',
      stderr: 'pipe',
    })

    const timer = setTimeout(() => proc.kill(), timeout)
    const decoder = new TextDecoder()

    // Stream stderr (device code URL goes here)
    const stderrReader = (async () => {
      const reader = proc.stderr.getReader()
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        const text = decoder.decode(value, { stream: true })
        chunks.push(text)
        onOutput(text)
      }
    })()

    // Stream stdout (result goes here)
    const stdoutReader = (async () => {
      const reader = proc.stdout.getReader()
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        const text = decoder.decode(value, { stream: true })
        chunks.push(text)
        onOutput(text)
      }
    })()

    await Promise.all([stderrReader, stdoutReader])
    await proc.exited
    clearTimeout(timer)

    return {
      success: proc.exitCode === 0,
      exitCode: proc.exitCode ?? 1,
      output: chunks.join(''),
    }
  } catch {
    return { success: false, exitCode: 1, output: chunks.join('') }
  }
}

/**
 * Get the resolved m365 binary path (for external use).
 */
export function getM365Binary(): string {
  if (_m365Available === null) {
    _m365Binary = resolveM365Binary()
  }
  return _m365Binary
}

// ─── Helpers ────────────────────────────────────────────────

function isNotLoggedIn(message: string): boolean {
  return NOT_LOGGED_IN_PATTERNS.some((p) => p.test(message))
}
