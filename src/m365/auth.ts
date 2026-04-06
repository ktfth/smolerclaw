/**
 * M365 Auth — login, status, logout for the m365 CLI.
 *
 * Token management is delegated to the m365 CLI.
 * smolerclaw handles config setup, app ID resolution, and TUI integration.
 *
 * Auth flow:
 *   1. ensureSetup() disables auto-open/clipboard to prevent CLI crashes
 *   2. Resolves appId: explicit arg > m365 config > guides user to create one
 *   3. Runs device code login with streaming output to TUI
 */

import { executeM365, executeM365Text, executeM365Streaming } from './executor'
import { cacheClear } from './cache'
import type { M365ConnectionInfo } from './types'

// ─── Constants ──────────────────────────────────────────────

/**
 * Microsoft Graph PowerShell SDK app ID.
 * First-party Microsoft app — works in any tenant without registration.
 * Supports device code flow and delegated Graph API permissions.
 */
const MS_GRAPH_PS_APP_ID = '14d82eec-204b-4c2f-b7e8-296a70dab67e'

// ─── State ──────────────────────────────────────────────────

let _lastStatus: M365ConnectionInfo | null = null
let _setupDone = false

// ─── Public API ─────────────────────────────────────────────

/**
 * Get the current M365 connection status.
 */
export async function getM365Status(): Promise<M365ConnectionInfo> {
  const result = await executeM365<Record<string, unknown>>(['status'])

  if (!result.success) {
    const info: M365ConnectionInfo = {
      status: 'disconnected',
      connectedAs: null,
      tenantId: null,
      authType: null,
    }
    _lastStatus = info
    return info
  }

  const data = result.data
  const connected = data && typeof data === 'object' && 'connectedAs' in data

  const info: M365ConnectionInfo = {
    status: connected ? 'connected' : 'disconnected',
    connectedAs: connected ? String((data as Record<string, unknown>).connectedAs ?? '') : null,
    tenantId: connected ? String((data as Record<string, unknown>).tenantId ?? '') : null,
    authType: connected ? String((data as Record<string, unknown>).authType ?? '') : null,
  }

  _lastStatus = info
  return info
}

/**
 * Check if currently authenticated (uses cached status if available).
 */
export async function isM365Connected(): Promise<boolean> {
  const status = _lastStatus ?? await getM365Status()
  return status.status === 'connected'
}

/**
 * Get the cached status without a network call (may be stale).
 */
export function getCachedM365Status(): M365ConnectionInfo | null {
  return _lastStatus
}

/**
 * Ensure m365 CLI output is JSON (required for parsing) and disable
 * features that crash in TUI context (auto-open browser, clipboard copy).
 * Preserves user-configured auth settings (clientId, tenantId, secret, authType).
 */
async function ensureSetup(): Promise<void> {
  if (_setupDone) return

  // Read current config to avoid overwriting user's auth setup
  const configResult = await executeM365<Record<string, unknown>>(['cli', 'config', 'list'])
  const config = configResult.success && configResult.data ? configResult.data as Record<string, unknown> : {}

  // Only set safety configs — never overwrite auth-related settings
  if (config.autoOpenLinksInBrowser !== false) {
    await executeM365Text(['cli', 'config', 'set', '--key', 'autoOpenLinksInBrowser', '--value', 'false'], 10_000)
  }
  if (config.copyDeviceCodeToClipboard !== false) {
    await executeM365Text(['cli', 'config', 'set', '--key', 'copyDeviceCodeToClipboard', '--value', 'false'], 10_000)
  }
  // Force JSON output for parsing (smolerclaw needs this)
  if (config.output !== 'json') {
    await executeM365Text(['cli', 'config', 'set', '--key', 'output', '--value', 'json'], 10_000)
  }

  _setupDone = true
}

/**
 * Read the configured clientId from m365 CLI config.
 */
async function getConfiguredAppId(): Promise<string | null> {
  const result = await executeM365<Record<string, unknown>>(['cli', 'config', 'list'])
  if (!result.success || !result.data) return null
  const data = result.data as Record<string, unknown>
  const clientId = data.clientId ?? data.appId
  return clientId ? String(clientId) : null
}

/**
 * Initiate login using the auth method configured in m365 CLI config.
 *
 * If the user ran `m365 setup` with authType=secret, clientId, tenantId,
 * and clientSecret, the CLI will use those automatically — no extra args needed.
 *
 * If no config exists, falls back to device code flow with the
 * Microsoft Graph PowerShell app ID.
 *
 * @param onMessage - callback to display output in the TUI in real time
 * @param appId - optional override for the Entra app ID
 */
export async function m365Login(
  onMessage?: (text: string) => void,
  appId?: string,
): Promise<string> {
  await ensureSetup()

  // Read config to determine auth strategy
  const configResult = await executeM365<Record<string, unknown>>(['cli', 'config', 'list'])
  const config = configResult.success && configResult.data ? configResult.data as Record<string, unknown> : {}

  const hasUserConfig = Boolean(config.clientId)
  const configuredAuthType = config.authType ? String(config.authType) : null

  // Build login args
  const loginArgs: string[] = ['login']

  if (appId) {
    // Explicit app ID override
    loginArgs.push('--appId', appId, '--authType', 'deviceCode')
  } else if (hasUserConfig && configuredAuthType) {
    // User ran m365 setup — CLI will use config values (clientId, secret, etc.)
    // No extra args needed, m365 CLI reads from its own config
  } else {
    // No config — use Microsoft Graph PowerShell app with device code
    loginArgs.push('--appId', MS_GRAPH_PS_APP_ID, '--authType', 'deviceCode')
  }

  const result = await executeM365Streaming(
    loginArgs,
    (text) => {
      const trimmed = text.trim()
      if (trimmed && onMessage) {
        onMessage(trimmed)
      }
    },
    180_000,
  )

  _lastStatus = null

  if (result.success) {
    return 'Login successful. Use /m365 status to verify.'
  }

  const output = result.output.trim()

  // Parse common errors
  if (output.includes('AADSTS7000215') || output.includes('Invalid client secret')) {
    return [
      'Invalid client secret. In Azure Portal:',
      'App registrations > your app > Certificates & secrets',
      'Copy the secret VALUE (not the Secret ID).',
      'Then: m365 cli config set --key clientSecret --value <secret-value>',
    ].join('\n')
  }

  if (output.includes('invalid_grant') || output.includes('AADSTS')) {
    return `Login failed: ${output.split('\n')[0]}`
  }

  if (output.includes('clipboardy') || output.includes('Expected a string')) {
    return 'Login crashed. Run /m365 login again (clipboard issue fixed).'
  }

  if (output) {
    return `Login failed: ${output.split('\n')[0]}`
  }

  return 'Login failed or timed out. Try again with /m365 login'
}

/**
 * Logout from M365.
 */
export async function m365Logout(): Promise<string> {
  const result = await executeM365Text(['logout'])

  cacheClear()
  _lastStatus = {
    status: 'disconnected',
    connectedAs: null,
    tenantId: null,
    authType: null,
  }

  if (result.success) {
    return 'Disconnected from Microsoft 365.'
  }

  return result.error ?? 'Logout completed.'
}

/**
 * Generate a consent URL so the user can grant Graph API permissions.
 * Opens the Microsoft consent prompt for the required scopes.
 */
export function getConsentUrl(appId?: string): string {
  const effectiveAppId = appId ?? MS_GRAPH_PS_APP_ID
  const scopes = [
    'Mail.Read',
    'Mail.Send',
    'Calendars.ReadWrite',
    'Tasks.ReadWrite',
    'Files.Read',
    'Notes.Read',
    'User.Read',
  ].join(' ')

  const params = new URLSearchParams({
    client_id: effectiveAppId,
    response_type: 'code',
    scope: scopes,
    redirect_uri: 'https://login.microsoftonline.com/common/oauth2/nativeclient',
    prompt: 'consent',
  })

  return `https://login.microsoftonline.com/common/oauth2/v2.0/authorize?${params.toString()}`
}

/**
 * Format connection status for TUI display.
 */
export function formatM365Status(info: M365ConnectionInfo): string {
  if (info.status === 'connected') {
    const lines = [
      '--- Microsoft 365 ---',
      `Status: Connected`,
      `Account: ${info.connectedAs}`,
    ]
    if (info.tenantId) lines.push(`Tenant: ${info.tenantId}`)
    if (info.authType) lines.push(`Auth: ${info.authType}`)
    lines.push('---------------------')
    return lines.join('\n')
  }

  return [
    '--- Microsoft 365 ---',
    'Status: Disconnected',
    'Run /m365 login to connect.',
    '---------------------',
  ].join('\n')
}
