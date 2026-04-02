/**
 * Shared Chat Service
 * Wraps the Claude provider for use in both desktop and web UIs
 */

import type { Message, ChatEvent, Session } from '../../types'
import type { UIMessage, UIToolCall, UISession, ChatRequest } from './types'
import { eventBus } from '../../core/event-bus'

/**
 * Generic provider interface matching both ClaudeProvider and OpenAICompatProvider
 */
interface ChatProvider {
  chat(messages: Message[], systemPrompt: string, enableTools?: boolean): AsyncGenerator<ChatEvent>
  setApprovalCallback?(cb: (name: string, input: Record<string, unknown>, riskLevel: string) => Promise<boolean>): void
}

export interface ChatServiceConfig {
  provider: ChatProvider
  systemPrompt: string
  enableTools: boolean
  onApprovalRequired?: (name: string, input: Record<string, unknown>, riskLevel: string) => Promise<boolean>
}

export class ChatService {
  private provider: ChatProvider
  private systemPrompt: string
  private enableTools: boolean
  private messages: Message[] = []
  private sessions: Map<string, Session> = new Map()
  private currentSessionId: string | null = null

  constructor(config: ChatServiceConfig) {
    this.provider = config.provider
    this.systemPrompt = config.systemPrompt
    this.enableTools = config.enableTools

    if (config.onApprovalRequired && this.provider.setApprovalCallback) {
      this.provider.setApprovalCallback(config.onApprovalRequired)
    }
  }

  getSessions(): UISession[] {
    return Array.from(this.sessions.values()).map(s => ({
      id: s.id,
      name: s.name,
      messageCount: s.messages.length,
      created: s.created,
      updated: s.updated,
      isActive: s.id === this.currentSessionId,
    }))
  }

  loadSession(sessionId: string): UIMessage[] {
    const session = this.sessions.get(sessionId)
    if (!session) return []

    this.currentSessionId = sessionId
    this.messages = [...session.messages]

    return this.messages.map(m => this.toUIMessage(m))
  }

  newSession(name?: string): UISession {
    const id = `session_${Date.now()}`
    const session: Session = {
      id,
      name: name || `Chat ${new Date().toLocaleDateString()}`,
      messages: [],
      created: Date.now(),
      updated: Date.now(),
    }

    this.sessions.set(id, session)
    this.currentSessionId = id
    this.messages = []

    eventBus.emit('session:changed', {
      previousSession: this.currentSessionId,
      currentSession: id,
      timestamp: Date.now(),
    })

    return {
      id: session.id,
      name: session.name,
      messageCount: 0,
      created: session.created,
      updated: session.updated,
      isActive: true,
    }
  }

  deleteSessionById(sessionId: string): void {
    this.sessions.delete(sessionId)
    if (this.currentSessionId === sessionId) {
      this.currentSessionId = null
      this.messages = []
    }
  }

  async *chat(request: ChatRequest): AsyncGenerator<{
    type: 'message_start' | 'text' | 'tool_call' | 'tool_result' | 'tool_blocked' | 'usage' | 'done' | 'error'
    messageId?: string
    data?: unknown
  }> {
    const messageId = `msg_${Date.now()}`

    // Add user message
    const userMessage: Message = {
      role: 'user',
      content: request.message,
      images: request.images,
      timestamp: Date.now(),
    }
    this.messages.push(userMessage)

    // Yield message start
    yield { type: 'message_start', messageId }

    let assistantContent = ''
    const toolCalls: UIToolCall[] = []
    let inputTokens = 0
    let outputTokens = 0

    try {
      for await (const event of this.provider.chat(this.messages, this.systemPrompt, this.enableTools)) {
        switch (event.type) {
          case 'text':
            assistantContent += event.text
            yield { type: 'text', messageId, data: event.text }
            break

          case 'tool_call':
            toolCalls.push({
              id: event.id,
              name: event.name,
              input: event.input as Record<string, unknown>,
              status: 'running',
            })
            yield { type: 'tool_call', messageId, data: { id: event.id, name: event.name, input: event.input } }
            break

          case 'tool_result':
            const tc = toolCalls.find(t => t.id === event.id)
            if (tc) {
              tc.result = event.result
              tc.status = 'complete'
            }
            yield { type: 'tool_result', messageId, data: { id: event.id, name: event.name, result: event.result } }
            break

          case 'tool_blocked':
            const blocked = toolCalls.find(t => t.id === event.id)
            if (blocked) {
              blocked.status = 'rejected'
            }
            yield { type: 'tool_blocked', messageId, data: { id: event.id, name: event.name, reason: event.reason } }
            break

          case 'usage':
            inputTokens = event.inputTokens
            outputTokens = event.outputTokens
            yield { type: 'usage', messageId, data: { inputTokens, outputTokens } }
            break

          case 'done':
            // Save assistant message
            const assistantMessage: Message = {
              role: 'assistant',
              content: assistantContent,
              toolCalls: toolCalls.map(t => ({
                id: t.id,
                name: t.name,
                input: t.input,
                result: t.result || '',
              })),
              usage: { inputTokens, outputTokens, costCents: this.calculateCost(inputTokens, outputTokens) },
              timestamp: Date.now(),
            }
            this.messages.push(assistantMessage)
            this.saveCurrentSession()
            yield { type: 'done', messageId }
            break

          case 'error':
            yield { type: 'error', messageId, data: event.error }
            break
        }
      }
    } catch (err) {
      yield { type: 'error', messageId, data: err instanceof Error ? err.message : String(err) }
    }
  }

  private calculateCost(inputTokens: number, outputTokens: number): number {
    // Approximate cost in cents (Claude 3.5 Sonnet pricing)
    const inputCost = (inputTokens / 1_000_000) * 300 // $3/MTok
    const outputCost = (outputTokens / 1_000_000) * 1500 // $15/MTok
    return Math.round((inputCost + outputCost) * 100) / 100
  }

  private saveCurrentSession(): void {
    if (!this.currentSessionId) {
      this.newSession()
    }

    const session = this.sessions.get(this.currentSessionId!)
    if (session) {
      session.messages = [...this.messages]
      session.updated = Date.now()
    }
  }

  private toUIMessage(msg: Message): UIMessage {
    return {
      id: `msg_${msg.timestamp}`,
      role: msg.role,
      content: msg.content,
      timestamp: msg.timestamp,
      status: 'complete',
      toolCalls: msg.toolCalls?.map(tc => ({
        id: tc.id,
        name: tc.name,
        input: tc.input,
        result: tc.result,
        status: 'complete' as const,
      })),
      usage: msg.usage,
    }
  }

  getMessages(): UIMessage[] {
    return this.messages.map(m => this.toUIMessage(m))
  }

  clearMessages(): void {
    this.messages = []
  }

  setSystemPrompt(prompt: string): void {
    this.systemPrompt = prompt
  }

  setEnableTools(enable: boolean): void {
    this.enableTools = enable
  }
}
