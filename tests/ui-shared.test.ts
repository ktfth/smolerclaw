import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { ChatService } from '../src/ui/shared/chat-service'
import { SessionManager } from '../src/session'
import { initI18n } from '../src/i18n'
import type { ChatEvent, Message } from '../src/types'
import { mkdirSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'

// Initialize i18n for tests
initI18n('en')

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

// Temp directory for test sessions
const TEST_DATA_DIR = join(process.cwd(), `.test-ui-shared-${Date.now()}`)

function createTestService() {
  const mockProvider = createMockProvider()
  const sessionManager = new SessionManager(TEST_DATA_DIR)
  return {
    service: new ChatService({
      provider: mockProvider,
      systemPrompt: 'Test system prompt',
      enableTools: true,
      sessionManager,
    }),
    mockProvider,
    sessionManager,
  }
}

describe('ChatService', () => {
  beforeEach(() => {
    if (existsSync(TEST_DATA_DIR)) rmSync(TEST_DATA_DIR, { recursive: true })
    mkdirSync(TEST_DATA_DIR, { recursive: true })
  })

  afterEach(() => {
    if (existsSync(TEST_DATA_DIR)) rmSync(TEST_DATA_DIR, { recursive: true })
  })

  describe('newSession', () => {
    it('creates a new session', () => {
      const { service } = createTestService()
      const session = service.newSession('test-session')
      expect(session.name).toBe('test-session')
      expect(session.messageCount).toBe(0)
      expect(session.isActive).toBe(true)
    })

    it('creates session with auto name', () => {
      const { service } = createTestService()
      const session = service.newSession()
      expect(session.name).toMatch(/^chat-\d+$/)
    })
  })

  describe('getSessions', () => {
    it('returns sessions from SessionManager', () => {
      const { service } = createTestService()
      // SessionManager always creates 'default' session
      const sessions = service.getSessions()
      expect(sessions.length).toBeGreaterThanOrEqual(1)
    })

    it('includes newly created sessions', () => {
      const { service } = createTestService()
      service.newSession('session-1')
      service.newSession('session-2')
      const sessions = service.getSessions()
      const names = sessions.map((s) => s.name)
      expect(names).toContain('session-1')
      expect(names).toContain('session-2')
    })
  })

  describe('loadSession', () => {
    it('loads messages from session', () => {
      const { service } = createTestService()
      const session = service.newSession('test')
      const messages = service.loadSession(session.id)
      expect(messages).toEqual([])
    })

    it('returns empty for non-existent session', () => {
      const { service } = createTestService()
      const messages = service.loadSession('non-existent')
      expect(messages).toEqual([])
    })
  })

  describe('deleteSessionById', () => {
    it('deletes a session', () => {
      const { service } = createTestService()
      const session = service.newSession('to-delete')
      service.deleteSessionById(session.id)
      // Session should be gone from SessionManager
      const sessions = service.getSessions()
      const names = sessions.map((s) => s.name)
      expect(names).not.toContain('to-delete')
    })

    it('clears messages when deleting current session', () => {
      const { service } = createTestService()
      const session = service.newSession('to-delete')
      service.deleteSessionById(session.id)
      expect(service.getMessages()).toEqual([])
    })
  })

  describe('chat', () => {
    it('yields streaming events', async () => {
      const { service } = createTestService()
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
      const { service } = createTestService()
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

    it('persists messages to SessionManager', async () => {
      const { service, sessionManager } = createTestService()
      const session = service.newSession('persist-test')

      for await (const _ of service.chat({ message: 'Hello' })) {
        // consume events
      }

      // Read directly from SessionManager to verify persistence
      const saved = sessionManager.getSession('persist-test')
      expect(saved).not.toBeNull()
      expect(saved!.messages.length).toBe(2)
      expect(saved!.messages[0].content).toBe('Hello')
      expect(saved!.messages[1].content).toBe('Hello, world!')
    })
  })

  describe('getMessages', () => {
    it('returns empty array initially', () => {
      const { service } = createTestService()
      expect(service.getMessages()).toEqual([])
    })
  })

  describe('clearMessages', () => {
    it('clears all messages', async () => {
      const { service } = createTestService()
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
      const { service } = createTestService()
      service.setSystemPrompt('New prompt')
      // Internal state is private, just verify no error
    })
  })

  describe('setEnableTools', () => {
    it('updates enable tools flag', () => {
      const { service } = createTestService()
      service.setEnableTools(false)
      // Internal state is private, just verify no error
    })
  })
})

describe('Shared data between CLI and UI', () => {
  beforeEach(() => {
    if (existsSync(TEST_DATA_DIR)) rmSync(TEST_DATA_DIR, { recursive: true })
    mkdirSync(TEST_DATA_DIR, { recursive: true })
  })

  afterEach(() => {
    if (existsSync(TEST_DATA_DIR)) rmSync(TEST_DATA_DIR, { recursive: true })
  })

  it('sessions created by CLI SessionManager are visible in ChatService', () => {
    const sessionManager = new SessionManager(TEST_DATA_DIR)

    // Simulate CLI creating a session
    sessionManager.switchTo('cli-session')
    sessionManager.addMessage({ role: 'user', content: 'From CLI', timestamp: Date.now() })

    // Now create a ChatService pointing at the same SessionManager
    const service = new ChatService({
      provider: createMockProvider(),
      systemPrompt: 'Test',
      enableTools: true,
      sessionManager,
    })

    const sessions = service.getSessions()
    const names = sessions.map((s) => s.name)
    expect(names).toContain('cli-session')

    // Load the CLI session and verify messages
    const messages = service.loadSession('cli-session')
    expect(messages).toHaveLength(1)
    expect(messages[0].content).toBe('From CLI')
  })

  it('sessions created by ChatService are visible in SessionManager', async () => {
    const sessionManager = new SessionManager(TEST_DATA_DIR)
    const service = new ChatService({
      provider: createMockProvider(),
      systemPrompt: 'Test',
      enableTools: true,
      sessionManager,
    })

    // Create session via ChatService
    service.newSession('ui-session')
    for await (const _ of service.chat({ message: 'From UI' })) {}

    // Verify via SessionManager
    const session = sessionManager.getSession('ui-session')
    expect(session).not.toBeNull()
    expect(session!.messages.length).toBe(2)
    expect(session!.messages[0].content).toBe('From UI')
  })
})
