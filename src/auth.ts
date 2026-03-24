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
  token: string
  subscriptionType: string
  expiresAt: number
}

/**
 * Resolve authentication from Claude Code subscription.
 * Reads the OAuth token from ~/.claude/.credentials.json.
 */
export function resolveAuth(): AuthResult {
  const result = readSubscription()
  if (result) return result

  throw new Error(
    'Claude Code subscription not found or expired.\n' +
    'Install Claude Code with a Pro/Max subscription and run `claude` to authenticate.',
  )
}

function readSubscription(): AuthResult | null {
  if (!existsSync(CRED_PATH)) return null

  try {
    const raw: ClaudeCredentials = JSON.parse(readFileSync(CRED_PATH, 'utf-8'))
    const oauth = raw.claudeAiOauth
    if (!oauth?.accessToken) return null

    // Check expiration with 60s buffer
    if (Date.now() > oauth.expiresAt - 60_000) return null

    return {
      token: oauth.accessToken,
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
export function refreshAuth(): AuthResult | null {
  try {
    return resolveAuth()
  } catch {
    return null
  }
}

/** Human-readable label for the TUI header */
export function authLabel(auth: AuthResult): string {
  return `sub:${auth.subscriptionType || 'pro'}`
}
