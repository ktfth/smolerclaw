import { describe, it, expect, beforeEach, mock } from 'bun:test'
import { ChatService } from '../src/ui/shared/chat-service'
import type { ChatEvent, Message } from '../src/types'

// Mock provider
function createMockProvider() {
  return {
    approvalCallback: null as ((name: string, input: Record<string, unknown>, riskLevel: string) => Promise<boolean>) | null,
    setApprovalCallback(cb: (name: string, input: Record<string, unknown>, riskLevel: string) => Promise<boolean>) {
      this.approvalCallback = cb
    },
    async *chat(messages: Message[], systemPrompt: string, enableTools: boolean): AsyncGenerator<ChatEvent> {
      yield { type: 'text', text: 'Hello, ' }
      yield { type: 'text', text: 'world!' }
      yield { type: 'usage', inputTokens: 10, outputTokens: 5 }
      yield { type: 'done' }
    },
  }
}

describe('ChatService', () => {
  let service: ChatService
  let mockProvider: ReturnType<typeof createMockProvider>

  beforeEach(() => {
    mockProvider = createMockProvider()
    service = new ChatService({
      provider: mockProvider,
      systemPrompt: 'Test system prompt',
      enableTools: true,
    })
  })

  describe('newSession', () => {
    it('creates a new session', () => {
      const session = service.newSession('Test Session')
      expect(session.id).toMatch(/^session_\d+$/)
      expect(session.name).toBe('Test Session')
      expect(session.messageCount).toBe(0)
      expect(session.isActive).toBe(true)
    })

    it('creates session with default name', () => {
      const session = service.newSession()
      expect(session.name).toMatch(/^Chat \d+/)
    })
  })

  describe('getSessions', () => {
    it('returns empty array initially', () => {
      expect(service.getSessions()).toEqual([])
    })

    it('returns created sessions', async () => {
      service.newSession('Session 1')
      // Small delay to ensure different timestamps
      await new Promise(resolve => setTimeout(resolve, 2))
      service.newSession('Session 2')
      const sessions = service.getSessions()
      // Both sessions should be tracked
      expect(sessions).toHaveLength(2)
      const names = sessions.map(s => s.name)
      expect(names).toContain('Session 1')
      expect(names).toContain('Session 2')
    })
  })

  describe('loadSession', () => {
    it('loads messages from session', () => {
      const session = service.newSession('Test')
      const messages = service.loadSession(session.id)
      expect(messages).toEqual([])
    })

    it('returns empty for non-existent session', () => {
      const messages = service.loadSession('non-existent')
      expect(messages).toEqual([])
    })
  })

  describe('deleteSessionById', () => {
    it('deletes a session', () => {
      const session = service.newSession('Test')
      expect(service.getSessions()).toHaveLength(1)
      service.deleteSessionById(session.id)
      expect(service.getSessions()).toHaveLength(0)
    })

    it('clears messages when deleting current session', () => {
      const session = service.newSession('Test')
      service.deleteSessionById(session.id)
      expect(service.getMessages()).toEqual([])
    })
  })

  describe('chat', () => {
    it('yields streaming events', async () => {
      service.newSession()

      const events: unknown[] = []
      for await (const event of service.chat({ message: 'Hello' })) {
        events.push(event)
      }

      expect(events).toHaveLength(5)
      expect(events[0]).toMatchObject({ type: 'message_start' })
      expect(events[1]).toMatchObject({ type: 'text', data: 'Hello, ' })
      expect(events[2]).toMatchObject({ type: 'text', data: 'world!' })
      expect(events[3]).toMatchObject({ type: 'usage', data: { inputTokens: 10, outputTokens: 5 } })
      expect(events[4]).toMatchObject({ type: 'done' })
    })

    it('adds messages to history', async () => {
      service.newSession()

      for await (const _ of service.chat({ message: 'Hello' })) {
        // consume events
      }

      const messages = service.getMessages()
      expect(messages).toHaveLength(2)
      expect(messages[0].role).toBe('user')
      expect(messages[0].content).toBe('Hello')
      expect(messages[1].role).toBe('assistant')
      expect(messages[1].content).toBe('Hello, world!')
    })
  })

  describe('getMessages', () => {
    it('returns empty array initially', () => {
      expect(service.getMessages()).toEqual([])
    })
  })

  describe('clearMessages', () => {
    it('clears all messages', async () => {
      service.newSession()
      for await (const _ of service.chat({ message: 'Hello' })) {
        // consume
      }
      expect(service.getMessages()).toHaveLength(2)
      service.clearMessages()
      expect(service.getMessages()).toEqual([])
    })
  })

  describe('setSystemPrompt', () => {
    it('updates system prompt', () => {
      service.setSystemPrompt('New prompt')
      // Internal state is private, just verify no error
    })
  })

  describe('setEnableTools', () => {
    it('updates enable tools flag', () => {
      service.setEnableTools(false)
      // Internal state is private, just verify no error
    })
  })
})

describe('UIMessage types', () => {
  it('has correct structure', async () => {
    const mockProvider = createMockProvider()
    const service = new ChatService({
      provider: mockProvider,
      systemPrompt: 'Test',
      enableTools: true,
    })

    service.newSession()
    for await (const _ of service.chat({ message: 'Test' })) {}

    const messages = service.getMessages()
    const msg = messages[0]

    expect(msg).toHaveProperty('id')
    expect(msg).toHaveProperty('role')
    expect(msg).toHaveProperty('content')
    expect(msg).toHaveProperty('timestamp')
    expect(msg).toHaveProperty('status')
  })
})
