import type { Message, ChatEvent, ToolApprovalMode } from './types'
import type { ApprovalCallback } from './approval'
import type { LLMProvider } from './providers'

const OPENAI_BASE = 'https://api.openai.com/v1'
const OLLAMA_BASE = 'http://localhost:11434/v1'

/**
 * OpenAI-compatible provider.
 * Works with OpenAI API, Ollama (local), and any OpenAI-compatible endpoint.
 */
export class OpenAICompatProvider implements LLMProvider {
  readonly name: string
  private apiKey: string
  private baseUrl: string
  private model: string
  private maxTokens: number
  private approvalMode: ToolApprovalMode = 'auto'
  private approvalCallback: ApprovalCallback | null = null
  private autoApproveAll = false

  constructor(
    provider: 'openai' | 'ollama',
    model: string,
    maxTokens: number,
  ) {
    this.name = provider
    this.model = model
    this.maxTokens = maxTokens

    if (provider === 'ollama') {
      this.apiKey = 'ollama' // Ollama doesn't need a real key
      this.baseUrl = process.env.OLLAMA_BASE_URL || OLLAMA_BASE
    } else {
      this.apiKey = process.env.OPENAI_API_KEY || ''
      this.baseUrl = process.env.OPENAI_BASE_URL || OPENAI_BASE
    }
  }

  setModel(model: string): void { this.model = model }
  setApprovalMode(mode: ToolApprovalMode): void { this.approvalMode = mode }
  setApprovalCallback(cb: ApprovalCallback): void { this.approvalCallback = cb }
  setAutoApproveAll(value: boolean): void { this.autoApproveAll = value }

  async *chat(
    messages: Message[],
    systemPrompt: string,
    enableTools = true,
  ): AsyncGenerator<ChatEvent> {
    if (!this.apiKey && this.name !== 'ollama') {
      yield { type: 'error', error: `No API key found. Set OPENAI_API_KEY env var.` }
      return
    }

    const apiMessages = [
      { role: 'system', content: systemPrompt },
      ...messages.map((m) => ({ role: m.role, content: m.content })),
    ]

    try {
      const resp = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          messages: apiMessages,
          max_tokens: this.maxTokens,
          stream: true,
        }),
      })

      if (!resp.ok) {
        const err = await resp.text()
        yield { type: 'error', error: `${this.name} API error ${resp.status}: ${err.slice(0, 200)}` }
        return
      }

      if (!resp.body) {
        yield { type: 'error', error: 'No response body' }
        return
      }

      const reader = resp.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      let inputEstimate = systemPrompt.length + messages.reduce((s, m) => s + m.content.length, 0)
      let outputChars = 0

      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() || ''

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue
          const data = line.slice(6).trim()
          if (data === '[DONE]') continue

          try {
            const parsed = JSON.parse(data)
            const delta = parsed.choices?.[0]?.delta
            if (delta?.content) {
              yield { type: 'text', text: delta.content }
              outputChars += delta.content.length
            }
          } catch { /* skip malformed SSE */ }
        }
      }

      // Estimate token usage (rough: 4 chars per token)
      yield {
        type: 'usage',
        inputTokens: Math.ceil(inputEstimate / 3.5),
        outputTokens: Math.ceil(outputChars / 3.5),
      }
      yield { type: 'done' }
    } catch (err) {
      yield { type: 'error', error: err instanceof Error ? err.message : String(err) }
    }
  }
}
