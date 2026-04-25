/**
 * Model registry with aliases and metadata.
 */
import { parseModelString, type ProviderType } from './providers'

export interface ModelInfo {
  id: string
  alias: string
  name: string
  contextWindow: number
  tier: 'fast' | 'balanced' | 'powerful'
  provider: ProviderType
}

export const MODELS: ModelInfo[] = [
  {
    id: 'claude-haiku-4-5-20251001',
    alias: 'haiku',
    name: 'Claude Haiku 4.5',
    contextWindow: 200_000,
    tier: 'fast',
    provider: 'anthropic',
  },
  {
    id: 'claude-sonnet-4-20250514',
    alias: 'sonnet',
    name: 'Claude Sonnet 4',
    contextWindow: 200_000,
    tier: 'balanced',
    provider: 'anthropic',
  },
  {
    id: 'claude-sonnet-4-6-20250627',
    alias: 'sonnet-4.6',
    name: 'Claude Sonnet 4.6',
    contextWindow: 200_000,
    tier: 'balanced',
    provider: 'anthropic',
  },
  {
    id: 'claude-opus-4-20250514',
    alias: 'opus',
    name: 'Claude Opus 4',
    contextWindow: 200_000,
    tier: 'powerful',
    provider: 'anthropic',
  },
  {
    id: 'claude-opus-4-6-20250318',
    alias: 'opus-4.6',
    name: 'Claude Opus 4.6',
    contextWindow: 200_000,
    tier: 'powerful',
    provider: 'anthropic',
  },
  {
    id: 'codex:gpt-5.4',
    alias: 'codex',
    name: 'Codex GPT-5.4',
    contextWindow: 200_000,
    tier: 'powerful',
    provider: 'codex',
  },
  {
    id: 'codex:codex-mini-latest',
    alias: 'codex-mini',
    name: 'Codex Mini Latest',
    contextWindow: 200_000,
    tier: 'fast',
    provider: 'codex',
  },
]

/**
 * Resolve a model name or alias to a full model ID.
 * Accepts: full ID, alias, or partial match.
 */
export function resolveModel(input: string): string {
  // Exact match on ID
  const exact = MODELS.find((m) => m.id === input)
  if (exact) return exact.id

  // Alias match
  const lower = input.toLowerCase()
  const byAlias = MODELS.find((m) => m.alias === lower)
  if (byAlias) return byAlias.id

  // Provider-prefixed models and raw OpenAI/Ollama IDs should pass through untouched.
  if (input.includes(':')) {
    const { provider, model } = parseModelString(input)
    return provider === 'anthropic' ? resolveAnthropicModel(model) : input
  }
  if (lower.startsWith('gpt-') || lower.startsWith('o1') || lower.startsWith('o3')) return input
  if (lower.startsWith('llama') || lower.startsWith('mistral') || lower.startsWith('codellama') || lower.startsWith('deepseek')) return input

  // Partial match (e.g., "haiku" matches "claude-haiku-4-5-*")
  const partial = MODELS.find((m) => m.id.includes(lower) || m.name.toLowerCase().includes(lower))
  if (partial) return partial.id

  // Unknown model — pass through as-is (custom/fine-tuned models)
  return input
}

/**
 * Get display name for a model ID.
 */
export function modelDisplayName(id: string): string {
  const info = MODELS.find((m) => m.id === id)
  return info ? `${info.name} (${info.alias})` : id
}

/**
 * Format model list for display.
 */
export function formatModelList(currentModel: string): string {
  const lines = ['Available models:']
  for (const m of MODELS) {
    const marker = m.id === currentModel ? ' *' : '  '
    const tier = m.tier === 'fast' ? '⚡' : m.tier === 'balanced' ? '⚖️' : '🧠'
    lines.push(`${marker} ${m.alias.padEnd(12)} ${tier} ${m.name} [${m.provider}]`)
  }
  lines.push('')
  lines.push('Use: /model <alias>  (e.g., /model sonnet or /model codex)')
  return lines.join('\n')
}

export function defaultModelForProvider(provider: ProviderType): string {
  switch (provider) {
    case 'anthropic':
      return 'claude-sonnet-4-20250514'
    case 'codex':
      return 'codex:gpt-5.4'
    case 'openai':
      return 'openai:gpt-5.4'
    case 'ollama':
      return 'ollama:llama3'
  }
}

function resolveAnthropicModel(input: string): string {
  const exact = MODELS.find((m) => m.provider === 'anthropic' && m.id === input)
  if (exact) return exact.id

  const lower = input.toLowerCase()
  const byAlias = MODELS.find((m) => m.provider === 'anthropic' && m.alias === lower)
  if (byAlias) return byAlias.id

  const partial = MODELS.find((m) =>
    m.provider === 'anthropic' &&
    (m.id.includes(lower) || m.name.toLowerCase().includes(lower))
  )
  return partial ? partial.id : input
}
