import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const CRED_PATH = join(homedir(), '.claude', '.credentials.json')

interface ClaudeOAuth {
  accessToken: string
  refreshToken: string
  expiresAt: number
  subscriptionType: string
  rateLimitTier: string
}

interface ClaudeCredentials {
  claudeAiOauth?: ClaudeOAuth
}

export interface AuthResult {
  apiKey: string
  source: 'api-key' | 'subscription'
  subscriptionType?: string
  expiresAt?: number
}

/**
 * Resolve authentication in priority order:
 *   1. ANTHROPIC_API_KEY env var
 *   2. Claude Code subscription (OAuth token from ~/.claude/.credentials.json)
 *   3. apiKey from smolerclaw config file
 *
 * authMode overrides: "api-key" skips subscription, "subscription" skips api-key.
 */
export function resolveAuth(
  configApiKey: string,
  authMode: 'auto' | 'api-key' | 'subscription' = 'auto',
): AuthResult {
  if (authMode === 'subscription') {
    const sub = trySubscription()
    if (sub) return sub
    throw new Error(
      'Claude Code credentials not found or expired.\n' +
      'Run `claude` to refresh, then restart smolerclaw.',
    )
  }

  if (authMode === 'api-key') {
    const key = process.env.ANTHROPIC_API_KEY || configApiKey
    if (key) return { apiKey: key, source: 'api-key' }
    throw new Error(
      'No API key found.\n' +
      'Set ANTHROPIC_API_KEY env var or add apiKey to config.',
    )
  }

  // auto mode: try all sources in order

  // 1. Explicit env var always wins
  if (process.env.ANTHROPIC_API_KEY) {
    return { apiKey: process.env.ANTHROPIC_API_KEY, source: 'api-key' }
  }

  // 2. Claude Code subscription
  const sub = trySubscription()
  if (sub) return sub

  // 3. Config file API key
  if (configApiKey) {
    return { apiKey: configApiKey, source: 'api-key' }
  }

  throw new Error(
    'No authentication found.\n' +
    'Options:\n' +
    '  1. Install Claude Code with a Pro/Max subscription (auto-detected)\n' +
    '  2. Set ANTHROPIC_API_KEY env var\n' +
    '  3. Add apiKey to ~/.config/smolerclaw/config.json',
  )
}

function trySubscription(): AuthResult | null {
  if (!existsSync(CRED_PATH)) return null

  try {
    const raw: ClaudeCredentials = JSON.parse(readFileSync(CRED_PATH, 'utf-8'))
    const oauth = raw.claudeAiOauth
    if (!oauth?.accessToken) return null

    // Check expiration with 60s buffer
    if (Date.now() > oauth.expiresAt - 60_000) return null

    return {
      apiKey: oauth.accessToken,
      source: 'subscription',
      subscriptionType: oauth.subscriptionType,
      expiresAt: oauth.expiresAt,
    }
  } catch {
    return null
  }
}

/**
 * Re-read credentials from disk. Useful when the OAuth token expires
 * mid-session — Claude Code auto-refreshes it, so a re-read often works.
 * Returns null if no valid credentials are found.
 */
export function refreshAuth(
  configApiKey: string,
  authMode: 'auto' | 'api-key' | 'subscription' = 'auto',
): AuthResult | null {
  try {
    return resolveAuth(configApiKey, authMode)
  } catch {
    return null
  }
}

/** Human-readable label for the TUI header */
export function authLabel(auth: AuthResult): string {
  if (auth.source === 'subscription') {
    return `sub:${auth.subscriptionType || 'pro'}`
  }
  return 'api-key'
}
