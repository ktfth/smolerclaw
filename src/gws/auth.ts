/**
 * GWS Auth — login, status, logout for the gws CLI.
 *
 * Token management is delegated to the gws CLI.
 * smolerclaw handles TUI integration and status display.
 *
 * Auth flow:
 *   1. First time: `gws auth setup` creates project, enables APIs, runs OAuth
 *   2. Subsequent: `gws auth login` with optional scope selection
 *   3. Logout: `gws auth logout`
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { createServer, type Server } from 'node:http'
import { executeGws, executeGwsStreaming, resetCredentialCache, setInjectedToken } from './executor'
import { gwsCacheClear } from './cache'
import type { GwsConnectionInfo } from './types'

// ─── State ──────────────────────────────────────────────────

let _lastStatus: GwsConnectionInfo | null = null

// ─── Public API ─────────────────────────────────────────────

/**
 * Get the current GWS connection status.
 *
 * Attempts a lightweight Gmail profile fetch to verify credentials.
 * If it succeeds the user is connected; otherwise disconnected.
 */
export async function getGwsStatus(): Promise<GwsConnectionInfo> {
  const result = await executeGws<Record<string, unknown>>(
    ['gmail', 'users', 'getProfile', '--params', JSON.stringify({ userId: 'me' })],
    { timeout: 15_000 },
  )

  if (!result.success) {
    const info: GwsConnectionInfo = {
      status: 'disconnected',
      connectedAs: null,
      scopes: [],
    }
    _lastStatus = info
    return info
  }

  const data = result.data
  const email = data && typeof data === 'object' && 'emailAddress' in data
    ? String((data as Record<string, unknown>).emailAddress)
    : null

  const info: GwsConnectionInfo = {
    status: email ? 'connected' : 'disconnected',
    connectedAs: email,
    scopes: [],
  }

  _lastStatus = info
  return info
}

/**
 * Check if currently authenticated (uses cached status if available).
 */
export async function isGwsConnected(): Promise<boolean> {
  const status = _lastStatus ?? await getGwsStatus()
  return status.status === 'connected'
}

/**
 * Get the cached status without a network call (may be stale).
 */
export function getCachedGwsStatus(): GwsConnectionInfo | null {
  return _lastStatus
}

/**
 * Run first-time setup: creates Cloud project, enables APIs, runs OAuth.
 *
 * If `gws auth setup` fails at OAuth client creation (common),
 * automatically falls back to the guided manual setup.
 *
 * @param onMessage - callback to display output in the TUI in real time
 */
export async function gwsSetup(
  onMessage?: (text: string) => void,
): Promise<string> {
  const result = await executeGwsStreaming(
    ['auth', 'setup'],
    (text) => {
      const trimmed = text.trim()
      if (trimmed && onMessage) {
        onMessage(trimmed)
      }
    },
    300_000,
  )

  _lastStatus = null

  if (result.success) {
    return 'Google Workspace setup complete. Use /gws status to verify.'
  }

  // Detect OAuth client creation failure — fall back to guided setup
  const output = result.output.trim()
  if (output.includes('OAuth client creation') || output.includes('validationError') || output.includes('manual setup')) {
    onMessage?.('\nOAuth client auto-creation failed. Starting guided setup...\n')
    return gwsSetupGuided(onMessage)
  }

  if (output) {
    return `Setup failed: ${output.split('\n')[0]}`
  }

  return 'Setup failed or timed out. Try again with /gws setup'
}

// ─── Guided Setup (gcloud-assisted) ────────────────────────

/** Google Workspace APIs required by smolerclaw */
const REQUIRED_APIS = [
  'gmail.googleapis.com',
  'calendar-json.googleapis.com',
  'drive.googleapis.com',
  'people.googleapis.com',
]

/**
 * Guided setup using gcloud CLI to enable APIs, then manual OAuth instructions.
 *
 * Steps:
 *   1. Detect gcloud project
 *   2. Enable required APIs via `gcloud services enable`
 *   3. Show instructions for OAuth consent screen + client creation
 *   4. Detect client_secret.json placement
 */
export async function gwsSetupGuided(
  onMessage?: (text: string) => void,
): Promise<string> {
  const msg = (text: string) => onMessage?.(text)

  // Step 1: Check gcloud available and get project
  msg('Step 1/4: Checking gcloud CLI...')
  const project = await getGcloudProject()
  if (!project) {
    return [
      'gcloud CLI not found or no project configured.',
      '',
      'Install: https://cloud.google.com/sdk/docs/install',
      'Then: gcloud auth login && gcloud config set project <your-project>',
    ].join('\n')
  }
  msg(`  Project: ${project}`)

  // Step 2: Enable APIs via gcloud
  msg('\nStep 2/4: Enabling Google Workspace APIs...')
  const apiResults = await enableGoogleApis(project, msg)
  const allEnabled = apiResults.every((r) => r.success)
  if (!allEnabled) {
    const failed = apiResults.filter((r) => !r.success)
    msg(`  Warning: ${failed.length} API(s) failed to enable. You may need to enable them manually.`)
  }

  // Step 3: Check if client_secret.json already exists
  const gwsConfigDir = getGwsConfigDir()
  const clientSecretPath = join(gwsConfigDir, 'client_secret.json')
  if (existsSync(clientSecretPath)) {
    msg('\nStep 3/4: client_secret.json found!')
    msg('Step 4/4: Ready to login.')
    return [
      'APIs enabled and client_secret.json detected.',
      'Run /gws login to authenticate.',
    ].join('\n')
  }

  // Step 4: Show manual OAuth instructions
  msg('\nStep 3/4: OAuth client setup needed (manual step)')
  const consoleUrl = `https://console.cloud.google.com/apis/credentials?project=${project}`

  return [
    '--- APIs enabled successfully ---',
    '',
    'Now create an OAuth client in Google Cloud Console:',
    '',
    `1. Open: ${consoleUrl}`,
    '',
    '2. Configure OAuth consent screen (if not done):',
    '   - User type: External (or Internal for Workspace)',
    '   - App name: smolerclaw',
    '   - Scopes: Gmail, Calendar, Drive, People',
    '   - Test users: add your email',
    '',
    '3. Create OAuth client:',
    '   - Click "Create Credentials" > "OAuth client ID"',
    '   - Application type: Desktop app',
    '   - Name: smolerclaw',
    '   - Download the JSON file',
    '',
    `4. Save the downloaded JSON as:`,
    `   ${clientSecretPath}`,
    '',
    '5. Then run: /gws login',
    '',
    '--- Waiting for client_secret.json ---',
  ].join('\n')
}

/**
 * Enable required Google APIs via gcloud services enable.
 */
async function enableGoogleApis(
  project: string,
  onMessage?: (text: string) => void,
): Promise<Array<{ api: string; success: boolean }>> {
  const results: Array<{ api: string; success: boolean }> = []

  for (const api of REQUIRED_APIS) {
    onMessage?.(`  Enabling ${api}...`)
    try {
      const proc = Bun.spawn(
        ['gcloud', 'services', 'enable', api, '--project', project],
        { stdout: 'pipe', stderr: 'pipe' },
      )
      const timer = setTimeout(() => proc.kill(), 30_000)
      await proc.exited
      clearTimeout(timer)
      const success = proc.exitCode === 0
      onMessage?.(success ? `  ✓ ${api}` : `  ✗ ${api} (exit ${proc.exitCode})`)
      results.push({ api, success })
    } catch {
      onMessage?.(`  ✗ ${api} (error)`)
      results.push({ api, success: false })
    }
  }

  return results
}

/**
 * Get the current gcloud project ID.
 */
async function getGcloudProject(): Promise<string | null> {
  try {
    const proc = Bun.spawn(['gcloud', 'config', 'get-value', 'project'], {
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const timer = setTimeout(() => proc.kill(), 10_000)
    const stdout = await new Response(proc.stdout).text()
    await proc.exited
    clearTimeout(timer)
    if (proc.exitCode !== 0) return null
    const project = stdout.trim()
    return project && project !== '(unset)' ? project : null
  } catch {
    return null
  }
}

/**
 * Get the gws config directory path.
 * gws uses ~/.config/gws/ on ALL platforms (including Windows).
 */
function getGwsConfigDir(): string {
  const home = process.env.USERPROFILE ?? process.env.HOME ?? '/root'
  return join(home, '.config', 'gws')
}

/**
 * Check if the OAuth client_secret.json is present.
 */
export function hasClientSecret(): boolean {
  const clientSecretPath = join(getGwsConfigDir(), 'client_secret.json')
  return existsSync(clientSecretPath)
}

/**
 * Get the path where client_secret.json should be placed.
 */
export function getClientSecretPath(): string {
  return join(getGwsConfigDir(), 'client_secret.json')
}

// ─── OAuth Scopes ──────────────────────────────────────────

const DEFAULT_SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/drive.readonly',
]

const REDIRECT_PATH = '/'

// ─── Token State ───────────────────────────────────────────

let _accessToken: string | null = null
let _refreshToken: string | null = null
let _tokenExpiry: number = 0

/**
 * Get the current access token, refreshing if expired.
 */
export async function getAccessToken(): Promise<string | null> {
  // Try loading saved tokens
  if (!_accessToken) {
    loadSavedTokens()
  }

  // Check if token is still valid (with 60s buffer)
  if (_accessToken && Date.now() < _tokenExpiry - 60_000) {
    return _accessToken
  }

  // Try to refresh
  if (_refreshToken) {
    const creds = readClientCredentials()
    if (creds) {
      const refreshed = await refreshAccessToken(creds.clientId, creds.clientSecret, _refreshToken)
      if (refreshed) {
        _accessToken = refreshed.access_token
        _tokenExpiry = Date.now() + (refreshed.expires_in * 1000)
        saveTokens()
        return _accessToken
      }
    }
  }

  return null
}

/**
 * Login via our own OAuth flow.
 *
 * The gws CLI has a bug where it generates OAuth URLs without response_type.
 * This function implements a correct OAuth2 Authorization Code flow:
 *   1. Read client credentials from client_secret.json
 *   2. Start a local HTTP server for the OAuth callback
 *   3. Build a correct authorization URL with response_type=code
 *   4. User authenticates in browser, Google redirects to local server
 *   5. Exchange the code for tokens
 *   6. Save tokens for gws CLI to use
 *
 * @param onMessage - callback to display output in the TUI in real time
 * @param scopes - optional comma-separated scopes override
 */
export async function gwsLogin(
  onMessage?: (text: string) => void,
  _scopes?: string,
): Promise<string> {
  resetCredentialCache()

  const msg = (text: string) => onMessage?.(text)

  // Step 1: Read client credentials
  msg('Reading client credentials...')
  const creds = readClientCredentials()
  if (!creds) {
    return [
      'client_secret.json not found or invalid.',
      `Expected at: ${getClientSecretPath()}`,
      'Run /gws setup-guide for instructions.',
    ].join('\n')
  }
  msg(`  Client ID: ${creds.clientId.slice(0, 20)}...`)

  // Step 2: Start local callback server
  msg('Starting local OAuth callback server...')
  const { port, codePromise, server } = await startCallbackServer()
  // Must match the registered redirect URI scheme — client has "http://localhost"
  const redirectUri = `http://localhost:${port}`
  msg(`  Listening on ${redirectUri}`)

  // Step 3: Build correct OAuth URL and open browser
  const authUrl = buildAuthUrl(creds.clientId, redirectUri, DEFAULT_SCOPES)
  msg('\nOpening browser for authentication...')
  msg(`(URL: ${authUrl.slice(0, 60)}...)\n`)

  // Auto-open browser on Windows/Mac/Linux
  // On Windows, cmd.exe treats & as command separator, so use rundll32 instead
  try {
    if (process.platform === 'win32') {
      Bun.spawn(['rundll32', 'url.dll,FileProtocolHandler', authUrl], {
        stdout: 'ignore', stderr: 'ignore',
      })
    } else if (process.platform === 'darwin') {
      Bun.spawn(['open', authUrl], { stdout: 'ignore', stderr: 'ignore' })
    } else {
      Bun.spawn(['xdg-open', authUrl], { stdout: 'ignore', stderr: 'ignore' })
    }
  } catch {
    // Fallback: show full URL if browser open fails
    msg('Could not open browser. Open this URL manually:\n')
    msg(authUrl)
  }

  msg('Waiting for authentication...')

  // Step 4: Wait for the callback with the auth code
  let code: string
  try {
    code = await Promise.race([
      codePromise,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('timeout')), 180_000),
      ),
    ])
  } catch (err) {
    server.close()
    if (err instanceof Error && err.message === 'timeout') {
      return 'Login timed out (3 minutes). Try /gws login again.'
    }
    return `Login failed: ${err instanceof Error ? err.message : String(err)}`
  } finally {
    server.close()
  }

  msg('\nAuthorization code received. Exchanging for tokens...')

  // Step 5: Exchange code for tokens
  const tokens = await exchangeCodeForTokens(creds.clientId, creds.clientSecret, code, redirectUri)
  if (!tokens) {
    return 'Failed to exchange authorization code for tokens.'
  }

  // Step 6: Save tokens
  _accessToken = tokens.access_token
  _refreshToken = tokens.refresh_token ?? null
  _tokenExpiry = Date.now() + (tokens.expires_in * 1000)
  saveTokens()
  setInjectedToken(_accessToken)

  _lastStatus = null

  msg('Tokens saved successfully.')
  return 'Login successful. Use /gws status to verify.'
}

// ─── OAuth Helpers ─────────────────────────────────────────

/**
 * Build the Google OAuth2 authorization URL with all required parameters.
 */
function buildAuthUrl(clientId: string, redirectUri: string, scopes: string[]): string {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: scopes.join(' '),
    access_type: 'offline',
    prompt: 'consent',
  })
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`
}

/**
 * Start a local HTTP server that listens for the OAuth callback.
 * Returns the port, a promise that resolves with the auth code, and the server.
 */
function startCallbackServer(): Promise<{
  port: number
  codePromise: Promise<string>
  server: Server
}> {
  return new Promise((resolve, reject) => {
    let resolveCode: (code: string) => void
    let rejectCode: (err: Error) => void

    const codePromise = new Promise<string>((res, rej) => {
      resolveCode = res
      rejectCode = rej
    })

    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', `http://127.0.0.1`)

      const code = url.searchParams.get('code')
      const error = url.searchParams.get('error')

      if (error) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(`<html><body><h2>Authentication failed</h2><p>${error}</p><p>You can close this tab.</p></body></html>`)
        rejectCode(new Error(`OAuth error: ${error}`))
        return
      }

      if (code) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end('<html><body><h2>Authentication successful!</h2><p>You can close this tab and return to smolerclaw.</p></body></html>')
        resolveCode(code)
        return
      }

      // No code or error — could be favicon or other request, ignore
      res.writeHead(200, { 'Content-Type': 'text/plain' })
      res.end('Waiting for OAuth callback...')
    })

    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      if (addr && typeof addr === 'object') {
        resolve({ port: addr.port, codePromise, server })
      } else {
        reject(new Error('Failed to start callback server'))
      }
    })

    server.on('error', reject)
  })
}

interface TokenResponse {
  readonly access_token: string
  readonly refresh_token?: string
  readonly expires_in: number
  readonly token_type: string
  readonly scope?: string
}

/**
 * Exchange an authorization code for access and refresh tokens.
 */
async function exchangeCodeForTokens(
  clientId: string,
  clientSecret: string,
  code: string,
  redirectUri: string,
): Promise<TokenResponse | null> {
  try {
    const response = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
      }),
    })

    if (!response.ok) {
      return null
    }

    return await response.json() as TokenResponse
  } catch {
    return null
  }
}

/**
 * Refresh an expired access token using the refresh token.
 */
async function refreshAccessToken(
  clientId: string,
  clientSecret: string,
  refreshToken: string,
): Promise<{ access_token: string; expires_in: number } | null> {
  try {
    const response = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
      }),
    })

    if (!response.ok) return null
    return await response.json() as { access_token: string; expires_in: number }
  } catch {
    return null
  }
}

// ─── Client Credentials ────────────────────────────────────

/**
 * Read client_id and client_secret from client_secret.json.
 */
function readClientCredentials(): { clientId: string; clientSecret: string } | null {
  const filePath = getClientSecretPath()
  if (!existsSync(filePath)) return null

  try {
    const raw = readFileSync(filePath, 'utf-8')
    const json = JSON.parse(raw) as Record<string, unknown>

    // Standard format: { "installed": { ... } } or { "web": { ... } }
    const section = (json.installed ?? json.web) as Record<string, unknown> | undefined
    if (section?.client_id && section?.client_secret) {
      return {
        clientId: String(section.client_id),
        clientSecret: String(section.client_secret),
      }
    }

    // Flat format
    if (json.client_id && json.client_secret) {
      return { clientId: String(json.client_id), clientSecret: String(json.client_secret) }
    }
  } catch {
    // Ignore
  }

  return null
}

// ─── Token Persistence ─────────────────────────────────────

const TOKEN_FILE = 'smolerclaw_tokens.json'

/**
 * Save tokens to the gws config directory.
 */
function saveTokens(): void {
  if (!_accessToken) return

  const dir = getGwsConfigDir()
  mkdirSync(dir, { recursive: true })

  const data = {
    access_token: _accessToken,
    refresh_token: _refreshToken,
    token_expiry: _tokenExpiry,
    saved_at: Date.now(),
  }

  writeFileSync(join(dir, TOKEN_FILE), JSON.stringify(data, null, 2), 'utf-8')
}

/**
 * Load previously saved tokens from disk.
 */
function loadSavedTokens(): void {
  const filePath = join(getGwsConfigDir(), TOKEN_FILE)
  if (!existsSync(filePath)) return

  try {
    const raw = readFileSync(filePath, 'utf-8')
    const data = JSON.parse(raw) as Record<string, unknown>
    _accessToken = data.access_token ? String(data.access_token) : null
    _refreshToken = data.refresh_token ? String(data.refresh_token) : null
    _tokenExpiry = typeof data.token_expiry === 'number' ? data.token_expiry : 0

    if (_accessToken) {
      setInjectedToken(_accessToken)
    }
  } catch {
    // Ignore corrupt file
  }
}

/**
 * Logout from Google Workspace.
 */
export async function gwsLogout(): Promise<string> {
  const result = await executeGwsStreaming(
    ['auth', 'logout'],
    () => {},
    15_000,
  )

  gwsCacheClear()
  _lastStatus = {
    status: 'disconnected',
    connectedAs: null,
    scopes: [],
  }

  if (result.success) {
    return 'Disconnected from Google Workspace.'
  }

  return result.output.trim() || 'Logout completed.'
}

/**
 * Format connection status for TUI display.
 */
export function formatGwsStatus(info: GwsConnectionInfo): string {
  if (info.status === 'connected') {
    const lines = [
      '--- Google Workspace ---',
      `Status: Connected`,
      `Account: ${info.connectedAs}`,
    ]
    if (info.scopes.length > 0) {
      lines.push(`Scopes: ${info.scopes.join(', ')}`)
    }
    lines.push('------------------------')
    return lines.join('\n')
  }

  return [
    '--- Google Workspace ---',
    'Status: Disconnected',
    'Run /gws login to connect.',
    'First time? Run /gws setup',
    '------------------------',
  ].join('\n')
}
