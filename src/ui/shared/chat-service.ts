/**
 * Shared Chat Service
 * Wraps the Claude provider for use in the web UI.
 * Delegates session persistence to SessionManager (shared with CLI).
 */

import type { Message, ChatEvent } from '../../types'
import type { UIMessage, UIToolCall, UISession, ChatRequest } from './types'
import type { SessionManager } from '../../session'
import { eventBus } from '../../core/event-bus'
import { estimateCost } from '../../tokens'

/**
 * Generic provider interface matching both ClaudeProvider and OpenAICompatProvider
 */
interface ChatProvider {
  chat(messages: Message[], systemPrompt: string, enableTools?: boolean): AsyncGenerator<ChatEvent>
  setApprovalCallback?(cb: (name: string, input: Record<string, unknown>, riskLevel: string) => Promise<boolean>): void
  setConversationKey?(key: string): void
}

export interface ChatServiceConfig {
  provider: ChatProvider
  model: string
  systemPrompt: string
  enableTools: boolean
  sessionManager: SessionManager
  onApprovalRequired?: (name: string, input: Record<string, unknown>, riskLevel: string) => Promise<boolean>
}

export class ChatService {
  private provider: ChatProvider
  private systemPrompt: string
  private enableTools: boolean
  private sessionManager: SessionManager
  private model: string
  private currentSessionName: string | null = null
  private messages: Message[] = []

  constructor(config: ChatServiceConfig) {
    this.provider = config.provider
    this.model = config.model
    this.systemPrompt = config.systemPrompt
    this.enableTools = config.enableTools
    this.sessionManager = config.sessionManager

    if (config.onApprovalRequired && this.provider.setApprovalCallback) {
      this.provider.setApprovalCallback(config.onApprovalRequired)
    }
  }

  getSessions(): UISession[] {
    return this.sessionManager.listAll().map((s) => ({
      id: s.name,
      name: s.name,
      messageCount: s.messageCount,
      created: s.created,
      updated: s.updated,
      isActive: s.name === this.currentSessionName,
    }))
  }

  loadSession(sessionId: string): UIMessage[] {
    const session = this.sessionManager.getSession(sessionId)
    if (!session) return []

    this.currentSessionName = sessionId
    this.messages = [...session.messages]
    this.provider.setConversationKey?.(sessionId)

    // Keep the shared SessionManager in sync so tools see the correct active session
    this.sessionManager.switchTo(sessionId)

    return this.messages.map((m) => this.toUIMessage(m))
  }

  /**
   * Resume an existing session by name (loads messages, syncs SessionManager).
   * Returns null if the session doesn't exist.
   */
  resumeSession(name: string): UISession | null {
    const session = this.sessionManager.getSession(name)
    if (!session) return null

    this.currentSessionName = name
    this.messages = [...session.messages]
    this.sessionManager.switchTo(name)
    this.provider.setConversationKey?.(name)

    return {
      id: session.name,
      name: session.name,
      messageCount: session.messages.length,
      created: session.created,
      updated: session.updated,
      isActive: true,
    }
  }

  newSession(name?: string): UISession {
    const sessionName = name || `chat-${Date.now()}`
    const previous = this.currentSessionName
    this.currentSessionName = sessionName
    this.messages = []
    this.provider.setConversationKey?.(sessionName)

    const session = this.sessionManager.createSession(sessionName)

    // Keep the shared SessionManager in sync
    this.sessionManager.switchTo(sessionName)

    eventBus.emit('session:changed', {
      previousSession: previous || undefined,
      currentSession: sessionName,
      timestamp: Date.now(),
    })

    return {
      id: session.name,
      name: session.name,
      messageCount: session.messages.length,
      created: session.created,
      updated: session.updated,
      isActive: true,
    }
  }

  deleteSessionById(sessionId: string): void {
    this.sessionManager.delete(sessionId)
    if (this.currentSessionName === sessionId) {
      this.currentSessionName = null
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

    // Persist user message
    if (this.currentSessionName) {
      this.sessionManager.addMessageTo(this.currentSessionName, userMessage)
    }

    // Yield message start
    yield { type: 'message_start', messageId }

    let assistantContent = ''
    const toolCalls: UIToolCall[] = []
    let inputTokens = 0
    let outputTokens = 0

    try {
      this.provider.setConversationKey?.(this.currentSessionName || 'default')
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
            const tc = toolCalls.find((t) => t.id === event.id)
            if (tc) {
              tc.result = event.result
              tc.status = 'complete'
            }
            yield { type: 'tool_result', messageId, data: { id: event.id, name: event.name, result: event.result } }
            break

          case 'tool_blocked':
            const blocked = toolCalls.find((t) => t.id === event.id)
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

          case 'done': {
            // Save assistant message
            const assistantMessage: Message = {
              role: 'assistant',
              content: assistantContent,
              toolCalls: toolCalls.map((t) => ({
                id: t.id,
                name: t.name,
                input: t.input,
                result: t.result || '',
              })),
              usage: { inputTokens, outputTokens, costCents: this.calculateCost(inputTokens, outputTokens) },
              timestamp: Date.now(),
            }
            this.messages.push(assistantMessage)

            // Persist assistant message
            if (this.currentSessionName) {
              this.sessionManager.addMessageTo(this.currentSessionName, assistantMessage)
            }
            yield { type: 'done', messageId }
            break
          }

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
    return estimateCost({ inputTokens, outputTokens }, this.model).totalCostCents
  }

  private toUIMessage(msg: Message): UIMessage {
    return {
      id: `msg_${msg.timestamp}`,
      role: msg.role,
      content: msg.content,
      timestamp: msg.timestamp,
      status: 'complete',
      toolCalls: msg.toolCalls?.map((tc) => ({
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
    return this.messages.map((m) => this.toUIMessage(m))
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
