import type { ChatEvent, Message, ToolApprovalMode } from './types'
import type { ApprovalCallback } from './approval'

export type ProviderType = 'anthropic' | 'openai' | 'ollama' | 'codex'

/**
 * Abstract provider interface.
 * All LLM providers implement this contract.
 */
export interface LLMProvider {
  readonly name: string
  setModel(model: string): void
  setApprovalMode(mode: ToolApprovalMode): void
  setApprovalCallback(cb: ApprovalCallback): void
  setAutoApproveAll(value: boolean): void
  setConversationKey?(key: string): void
  chat(messages: Message[], systemPrompt: string, enableTools?: boolean): AsyncGenerator<ChatEvent>
}

/**
 * Detect provider from model string.
 * Convention: "provider:model" (e.g., "openai:gpt-4o", "ollama:llama3")
 * Default: anthropic (no prefix needed).
 */
export function parseModelString(input: string): { provider: ProviderType; model: string } {
  if (input.includes(':')) {
    const [provider, ...rest] = input.split(':')
    return { provider: normalizeProvider(provider), model: rest.join(':') }
  }

  // Auto-detect from model name
  const lower = input.toLowerCase()
  if (lower.startsWith('gpt-') || lower.startsWith('o1') || lower.startsWith('o3')) {
    return { provider: 'openai', model: input }
  }
  if (lower.startsWith('llama') || lower.startsWith('mistral') || lower.startsWith('codellama') || lower.startsWith('deepseek')) {
    return { provider: 'ollama', model: input }
  }

  return { provider: 'anthropic', model: input }
}

/**
 * Available provider info for display.
 */
export const PROVIDER_INFO: Record<ProviderType, { name: string; authHint: string; description: string }> = {
  anthropic: {
    name: 'Anthropic',
    authHint: 'Claude Code login',
    description: 'Claude models (default, via subscription)',
  },
  codex: {
    name: 'Codex',
    authHint: 'Codex CLI login',
    description: 'Codex CLI models via ChatGPT/OpenAI login',
  },
  openai: {
    name: 'OpenAI',
    authHint: 'OPENAI_API_KEY / Codex login',
    description: 'GPT and o-series models via OpenAI Agents SDK',
  },
  ollama: {
    name: 'Ollama',
    authHint: 'local',
    description: 'Local models via Ollama (no API key needed)',
  },
}

export function formatProviderList(): string {
  const lines = ['Providers:']
  for (const [key, info] of Object.entries(PROVIDER_INFO)) {
    const keyInfo = info.authHint ? ` (${info.authHint})` : ''
    lines.push(`  ${key.padEnd(12)} ${info.description}${keyInfo}`)
  }
  lines.push('')
  lines.push('Use: /model provider:model (e.g., /model codex:gpt-5.4)')
  return lines.join('\n')
}

export function assistantNameForProvider(provider: ProviderType): string {
  switch (provider) {
    case 'anthropic':
      return 'Claude'
    case 'codex':
      return 'Codex'
    case 'openai':
      return 'OpenAI'
    case 'ollama':
      return 'Ollama'
  }
}

function normalizeProvider(input: string): ProviderType {
  const lower = input.toLowerCase()
  if (lower === 'anthropic' || lower === 'openai' || lower === 'ollama' || lower === 'codex') {
    return lower
  }
  throw new Error(`Unsupported provider: ${input}`)
}
