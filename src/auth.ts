import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { parseModelString, type ProviderType } from './providers'

const CLAUDE_CRED_PATH = join(homedir(), '.claude', '.credentials.json')
const CODEX_AUTH_PATH = join(homedir(), '.codex', 'auth.json')

interface ClaudeOAuth {
  accessToken: string
  expiresAt: number
  subscriptionType: string
}

interface ClaudeCredentials {
  claudeAiOauth?: ClaudeOAuth
}

interface CodexTokens {
  access_token?: string
}

interface CodexAuthFile {
  OPENAI_API_KEY?: string | null
  tokens?: CodexTokens
}

export interface AuthResult {
  provider: ProviderType
  kind: 'subscription' | 'chatgpt' | 'api-key' | 'local'
  token?: string
  expiresAt: number | null
  label: string
  source: string
  subscriptionType?: string
}

/**
 * Resolve authentication for the active model/provider.
 * Returns null for providers that don't require local credentials.
 */
export function resolveAuthForModel(model: string): AuthResult | null {
  return resolveAuthForProvider(parseModelString(model).provider)
}

export function resolveAuthForProvider(provider: ProviderType): AuthResult | null {
  switch (provider) {
    case 'anthropic':
      return resolveClaudeAuth()
    case 'codex':
      return resolveCodexAuth()
    case 'openai':
      return resolveOpenAIAuth()
    case 'ollama':
      return {
        provider: 'ollama',
        kind: 'local',
        expiresAt: null,
        label: 'local:ollama',
        source: 'http://localhost:11434',
      }
  }
}

/**
 * Backward-compatible Claude auth resolver.
 */
export function resolveAuth(): AuthResult {
  return resolveClaudeAuth()
}

/**
 * Backward-compatible Claude auth refresh.
 */
export function refreshAuth(): AuthResult | null {
  return refreshAuthForProvider('anthropic')
}

export function refreshAuthForProvider(provider: ProviderType): AuthResult | null {
  try {
    return resolveAuthForProvider(provider)
  } catch {
    return null
  }
}

/** Human-readable label for the TUI header */
export function authLabel(auth: AuthResult | null): string {
  if (!auth) return ''
  if (auth.provider === 'anthropic') return `sub:${auth.subscriptionType || 'pro'}`
  return auth.label
}

function resolveClaudeAuth(): AuthResult {
  const result = readClaudeSubscription()
  if (result) return result

  throw new Error(
    'Claude Code subscription not found or expired.\n' +
    'Install Claude Code with a Pro/Max subscription and run `claude` to authenticate.',
  )
}

function readClaudeSubscription(): AuthResult | null {
  if (!existsSync(CLAUDE_CRED_PATH)) return null

  try {
    const raw: ClaudeCredentials = JSON.parse(readFileSync(CLAUDE_CRED_PATH, 'utf-8'))
    const oauth = raw.claudeAiOauth
    if (!oauth?.accessToken) return null

    if (Date.now() > oauth.expiresAt - 60_000) return null

    return {
      provider: 'anthropic',
      kind: 'subscription',
      token: oauth.accessToken,
      subscriptionType: oauth.subscriptionType,
      expiresAt: oauth.expiresAt,
      label: `sub:${oauth.subscriptionType || 'pro'}`,
      source: CLAUDE_CRED_PATH,
    }
  } catch {
    return null
  }
}

function resolveCodexAuth(): AuthResult {
  const result = readCodexAuth()
  if (result) return result

  throw new Error(
    'Codex login not found or expired.\n' +
    'Run `codex --login` (or `codex`) to authenticate with ChatGPT/OpenAI.',
  )
}

function readCodexAuth(): AuthResult | null {
  if (!existsSync(CODEX_AUTH_PATH)) return null

  try {
    const raw: CodexAuthFile = JSON.parse(readFileSync(CODEX_AUTH_PATH, 'utf-8'))

    if (typeof raw.OPENAI_API_KEY === 'string' && raw.OPENAI_API_KEY.trim()) {
      return {
        provider: 'codex',
        kind: 'api-key',
        token: raw.OPENAI_API_KEY.trim(),
        expiresAt: null,
        label: 'codex:key',
        source: CODEX_AUTH_PATH,
      }
    }

    const accessToken = raw.tokens?.access_token
    if (!accessToken) return null

    const expiresAt = parseJwtExpiry(accessToken)
    if (expiresAt && Date.now() > expiresAt - 60_000) return null

    return {
      provider: 'codex',
      kind: 'chatgpt',
      token: accessToken,
      expiresAt,
      label: 'codex:chatgpt',
      source: CODEX_AUTH_PATH,
    }
  } catch {
    return null
  }
}

function resolveOpenAIAuth(): AuthResult {
  const token = process.env.OPENAI_API_KEY?.trim()
  if (token) {
    return {
      provider: 'openai',
      kind: 'api-key',
      token,
      expiresAt: null,
      label: 'api:openai',
      source: 'OPENAI_API_KEY',
    }
  }

  const codexApiKey = readCodexApiKey()
  if (codexApiKey) {
    return {
      provider: 'openai',
      kind: 'api-key',
      token: codexApiKey,
      expiresAt: null,
      label: 'api:codex',
      source: CODEX_AUTH_PATH,
    }
  }

  throw new Error(
    'OpenAI API key not found.\n' +
    'Set OPENAI_API_KEY or run `codex login` so the OpenAI Agents SDK can reuse the Codex API key.',
  )
}

function parseJwtExpiry(token: string): number | null {
  try {
    const parts = token.split('.')
    if (parts.length < 2) return null
    const payload = JSON.parse(decodeBase64Url(parts[1])) as { exp?: number }
    return typeof payload.exp === 'number' ? payload.exp * 1000 : null
  } catch {
    return null
  }
}

function readCodexApiKey(): string | null {
  if (!existsSync(CODEX_AUTH_PATH)) return null

  try {
    const raw: CodexAuthFile = JSON.parse(readFileSync(CODEX_AUTH_PATH, 'utf-8'))
    const apiKey = raw.OPENAI_API_KEY?.trim()
    return apiKey ? apiKey : null
  } catch {
    return null
  }
}

function decodeBase64Url(value: string): string {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/')
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4)
  return Buffer.from(padded, 'base64').toString('utf-8')
}
