import type { ChatEvent, Message, ToolApprovalMode } from './types'
import type { ApprovalCallback } from './approval'

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
  chat(messages: Message[], systemPrompt: string, enableTools?: boolean): AsyncGenerator<ChatEvent>
}

/**
 * Detect provider from model string.
 * Convention: "provider:model" (e.g., "openai:gpt-4o", "ollama:llama3")
 * Default: anthropic (no prefix needed).
 */
export function parseModelString(input: string): { provider: string; model: string } {
  if (input.includes(':')) {
    const [provider, ...rest] = input.split(':')
    return { provider: provider.toLowerCase(), model: rest.join(':') }
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
export const PROVIDER_INFO: Record<string, { name: string; envKey: string; description: string }> = {
  anthropic: {
    name: 'Anthropic',
    envKey: '',
    description: 'Claude models (default, via subscription)',
  },
  openai: {
    name: 'OpenAI',
    envKey: 'OPENAI_API_KEY',
    description: 'GPT and o-series models',
  },
  ollama: {
    name: 'Ollama',
    envKey: '',
    description: 'Local models via Ollama (no API key needed)',
  },
}

export function formatProviderList(): string {
  const lines = ['Providers:']
  for (const [key, info] of Object.entries(PROVIDER_INFO)) {
    const keyInfo = info.envKey ? ` (${info.envKey})` : ' (local)'
    lines.push(`  ${key.padEnd(12)} ${info.description}${keyInfo}`)
  }
  lines.push('')
  lines.push('Use: /model provider:model (e.g., /model openai:gpt-4o)')
  return lines.join('\n')
}
