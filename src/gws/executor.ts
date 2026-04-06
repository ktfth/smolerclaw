/**
 * GWS CLI Executor — subprocess wrapper for the gws CLI.
 *
 * Runs `gws <command>` via Bun.spawn, parses JSON output,
 * handles timeouts, and detects auth expiration.
 *
 * Resolves the gws binary from the local node_modules/.bin first,
 * falling back to the global PATH.
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { GwsResult } from './types'

// ─── Constants ──────────────────────────────────────────────

const DEFAULT_TIMEOUT_MS = 30_000
const MAX_OUTPUT_LENGTH = 200_000

/** Error messages that indicate the user is NOT logged in */
const NOT_LOGGED_IN_PATTERNS = [
  /not authenticated/i,
  /no credentials/i,
  /token.*expired/i,
  /login required/i,
  /auth.*required/i,
]

// ─── State ──────────────────────────────────────────────────

let _gwsAvailable: boolean | null = null
let _gwsBinary: string = 'gws'

// ─── Binary Resolution ─────────────────────────────────────

/**
 * Resolve the gws binary path. Prefers local node_modules/.bin over global.
 */
function resolveGwsBinary(): string {
  const binDir = join(process.cwd(), 'node_modules', '.bin')

  // Windows: .exe
  const localExe = join(binDir, 'gws.exe')
  if (existsSync(localExe)) return localExe

  // Windows: .cmd shim
  const localCmd = join(binDir, 'gws.cmd')
  if (existsSync(localCmd)) return localCmd

  // Bun .bunx
  const localBunx = join(binDir, 'gws.bunx')
  if (existsSync(localBunx)) return localBunx

  // Plain binary (Unix)
  const localBin = join(binDir, 'gws')
  if (existsSync(localBin)) return localBin

  // Fallback to global PATH
  return 'gws'
}

// ─── Core ───────────────────────────────────────────────────

/**
 * Check if the gws CLI is installed and available.
 */
export async function checkGwsInstalled(): Promise<boolean> {
  if (_gwsAvailable !== null) return _gwsAvailable

  _gwsBinary = resolveGwsBinary()

  try {
    const proc = Bun.spawn([_gwsBinary, '--version'], {
      stdout: 'pipe',
      stderr: 'pipe',
      env: buildGwsEnv(),
    })
    const timer = setTimeout(() => proc.kill(), 5_000)
    await new Response(proc.stdout).text()
    await proc.exited
    clearTimeout(timer)
    _gwsAvailable = proc.exitCode === 0
  } catch {
    _gwsAvailable = false
  }

  return _gwsAvailable
}

/**
 * Reset the cached availability check (useful after install).
 */
export function resetGwsCheck(): void {
  _gwsAvailable = null
  _gwsBinary = 'gws'
}

/**
 * Execute a gws CLI command and return parsed results.
 *
 * gws outputs JSON by default, so we parse stdout as JSON.
 *
 * @param args - Command arguments (e.g., ['gmail', 'users', 'messages', 'list'])
 * @param options - Execution options
 */
export async function executeGws<T = unknown>(
  args: readonly string[],
  options: { timeout?: number } = {},
): Promise<GwsResult<T>> {
  const timeout = options.timeout ?? DEFAULT_TIMEOUT_MS

  const installed = await checkGwsInstalled()
  if (!installed) {
    return {
      success: false,
      data: null,
      error: 'GWS CLI not found. Run: npm install -g @googleworkspace/cli',
      raw: '',
      duration: 0,
    }
  }

  const cmdArgs = [_gwsBinary, ...args]
  const startTime = performance.now()

  try {
    const proc = Bun.spawn(cmdArgs, {
      stdout: 'pipe',
      stderr: 'pipe',
      env: buildGwsEnv(),
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

      if (isNotLoggedIn(errorMsg)) {
        return {
          success: false,
          data: null,
          error: 'Not logged in. Run /gws login first.',
          raw: errorMsg,
          duration,
        }
      }

      return {
        success: false,
        data: null,
        error: errorMsg,
        raw: errorMsg,
        duration,
      }
    }

    // Parse JSON output (gws outputs JSON by default)
    if (raw) {
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

    return { success: true, data: null, error: null, raw, duration }
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
 * Execute a gws command with streaming output.
 *
 * Used for `gws auth login` and `gws auth setup` where real-time
 * output to the TUI is needed (OAuth URLs, progress, etc.).
 */
export async function executeGwsStreaming(
  args: readonly string[],
  onOutput: (text: string) => void,
  timeout: number = 180_000,
): Promise<{ success: boolean; exitCode: number; output: string }> {
  const installed = await checkGwsInstalled()
  if (!installed) {
    return { success: false, exitCode: 1, output: 'GWS CLI not found.' }
  }

  const cmdArgs = [_gwsBinary, ...args]
  const chunks: string[] = []

  try {
    const proc = Bun.spawn(cmdArgs, {
      stdout: 'pipe',
      stderr: 'pipe',
      env: buildGwsEnv(),
    })

    const timer = setTimeout(() => proc.kill(), timeout)
    const decoder = new TextDecoder()

    // Stream stderr (auth URLs and progress go here)
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

    // Stream stdout
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
 * Get the resolved gws binary path (for external use).
 */
export function getGwsBinary(): string {
  if (_gwsAvailable === null) {
    _gwsBinary = resolveGwsBinary()
  }
  return _gwsBinary
}

// ─── Credential Injection ───────────────────────────────────

interface OAuthCredentials {
  readonly clientId: string
  readonly clientSecret: string
}

let _cachedCredentials: OAuthCredentials | null | undefined = undefined

/**
 * Read client_secret.json and extract client_id + client_secret.
 * Caches the result so we only read the file once.
 */
function loadClientCredentials(): OAuthCredentials | null {
  if (_cachedCredentials !== undefined) return _cachedCredentials

  const paths = getClientSecretPaths()

  for (const filePath of paths) {
    if (!existsSync(filePath)) continue

    try {
      const raw = readFileSync(filePath, 'utf-8')
      const json = JSON.parse(raw) as Record<string, unknown>

      // Standard Google Cloud Console format: { "installed": { ... } } or { "web": { ... } }
      const section = (json.installed ?? json.web) as Record<string, unknown> | undefined
      if (section?.client_id && section?.client_secret) {
        _cachedCredentials = {
          clientId: String(section.client_id),
          clientSecret: String(section.client_secret),
        }
        return _cachedCredentials
      }

      // Flat format: { "client_id": "...", "client_secret": "..." }
      if (json.client_id && json.client_secret) {
        _cachedCredentials = {
          clientId: String(json.client_id),
          clientSecret: String(json.client_secret),
        }
        return _cachedCredentials
      }
    } catch {
      // Ignore parse errors, try next path
    }
  }

  _cachedCredentials = null
  return null
}

/**
 * Get all possible paths where client_secret.json might be.
 */
function getClientSecretPaths(): string[] {
  const paths: string[] = []

  // gws default config dir
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA ?? join(process.env.USERPROFILE ?? '', 'AppData', 'Roaming')
    paths.push(join(appData, 'gws', 'client_secret.json'))
    // Also check Unix-style path on Windows (gws uses this)
    const home = process.env.USERPROFILE ?? process.env.HOME ?? ''
    paths.push(join(home, '.config', 'gws', 'client_secret.json'))
  } else {
    const home = process.env.HOME ?? '/root'
    paths.push(join(home, '.config', 'gws', 'client_secret.json'))
  }

  // Env override
  const configDir = process.env.GOOGLE_WORKSPACE_CLI_CONFIG_DIR
  if (configDir) {
    paths.push(join(configDir, 'client_secret.json'))
  }

  // Credentials file override
  const credFile = process.env.GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE
  if (credFile) {
    paths.push(credFile)
  }

  return paths
}

/**
 * Build environment variables for the gws subprocess.
 * Injects client credentials and access token so gws always
 * has them, regardless of its own file detection logic.
 */
function buildGwsEnv(): Record<string, string | undefined> {
  const env = { ...process.env }

  // Inject credentials if not already set and file exists
  if (!env.GOOGLE_WORKSPACE_CLI_CLIENT_ID || !env.GOOGLE_WORKSPACE_CLI_CLIENT_SECRET) {
    const creds = loadClientCredentials()
    if (creds) {
      env.GOOGLE_WORKSPACE_CLI_CLIENT_ID = creds.clientId
      env.GOOGLE_WORKSPACE_CLI_CLIENT_SECRET = creds.clientSecret
    }
  }

  // Inject access token from our own OAuth flow
  if (!env.GOOGLE_WORKSPACE_CLI_TOKEN && _injectedToken) {
    env.GOOGLE_WORKSPACE_CLI_TOKEN = _injectedToken
  }

  return env
}

// Token injection — set by auth module after login
let _injectedToken: string | null = null

/**
 * Set the access token to inject into gws subprocess env.
 */
export function setInjectedToken(token: string | null): void {
  _injectedToken = token
}

/**
 * Get the currently injected token.
 */
export function getInjectedToken(): string | null {
  return _injectedToken
}

/**
 * Reset cached credentials (call after user places client_secret.json).
 */
export function resetCredentialCache(): void {
  _cachedCredentials = undefined
}

// ─── Helpers ────────────────────────────────────────────────

function isNotLoggedIn(message: string): boolean {
  return NOT_LOGGED_IN_PATTERNS.some((p) => p.test(message))
}
