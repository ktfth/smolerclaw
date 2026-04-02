/**
 * Hono Web Server for smolerclaw UI
 * Provides a web-based chat interface
 */

import { Hono } from 'hono'
import { serveStatic } from 'hono/bun'
import { cors } from 'hono/cors'
import { logger } from 'hono/logger'
import type { Message, ChatEvent } from '../../types'
import type { SessionManager } from '../../session'
import { ChatService } from '../shared/chat-service'
import type { WSClientMessage, WSServerMessage, UIState, UISettings } from '../shared/types'
import { t, getTranslations } from '../../i18n'

/**
 * Generic provider interface matching both ClaudeProvider and OpenAICompatProvider
 */
interface ChatProvider {
  chat(messages: Message[], systemPrompt: string, enableTools?: boolean): AsyncGenerator<ChatEvent>
  setApprovalCallback?(cb: (name: string, input: Record<string, unknown>, riskLevel: string) => Promise<boolean>): void
}

interface WebServerConfig {
  port: number
  provider: ChatProvider
  systemPrompt: string
  enableTools: boolean
  sessionManager: SessionManager
}

interface ClientConnection {
  chatService: ChatService
  settings: UISettings
}

const DEFAULT_SETTINGS: UISettings = {
  theme: 'system',
  fontSize: 'medium',
  showToolCalls: true,
  showCosts: true,
  autoScroll: true,
  enableSounds: false,
}

export function createWebServer(config: WebServerConfig) {
  const app = new Hono()
  const clients = new Map<string, ClientConnection>()

  // Middleware
  app.use('*', logger())
  app.use('*', cors())

  // Static files
  app.use('/static/*', serveStatic({ root: './src/ui/web' }))

  // Main page — inject current locale translations
  app.get('/', (c) => {
    return c.html(getIndexHtml(getTranslations()))
  })

  // API routes
  app.get('/api/health', (c) => c.json({ status: 'ok' }))

  // WebSocket handler for Bun.serve
  function handleWebSocket(ws: WebSocket, clientId: string) {
    const chatService = new ChatService({
      provider: config.provider,
      systemPrompt: config.systemPrompt,
      enableTools: config.enableTools,
      sessionManager: config.sessionManager,
      onApprovalRequired: async (name, input, riskLevel) => {
        send(ws, {
          type: 'tool_approval_required',
          payload: {
            toolCallId: `tool_${Date.now()}`,
            name,
            input,
            riskLevel: riskLevel as 'safe' | 'moderate' | 'high',
          },
        })
        return true
      },
    })

    const client: ClientConnection = {
      chatService,
      settings: { ...DEFAULT_SETTINGS },
    }
    clients.set(clientId, client)

    // Resume the last active session instead of always creating a new one
    const currentName = config.sessionManager.getCurrentName()
    const session = chatService.resumeSession(currentName) || chatService.newSession()
    send(ws, { type: 'connected', payload: { sessionId: session.id } })
    sendState(ws, chatService, client.settings)

    return client
  }

  async function handleMessage(ws: WebSocket, chatService: ChatService, settings: UISettings, msg: WSClientMessage) {
    switch (msg.type) {
      case 'chat': {
        const messageId = `msg_${Date.now()}`
        send(ws, { type: 'message_start', payload: { messageId } })

        for await (const event of chatService.chat(msg.payload)) {
          switch (event.type) {
            case 'text':
              send(ws, { type: 'text_delta', payload: { messageId, text: event.data as string } })
              break
            case 'tool_call':
              const tc = event.data as { id: string; name: string; input: Record<string, unknown> }
              send(ws, {
                type: 'tool_call',
                payload: { messageId, id: tc.id, name: tc.name, input: tc.input, status: 'running' },
              })
              break
            case 'tool_result':
              const tr = event.data as { id: string; name: string; result: string }
              send(ws, { type: 'tool_result', payload: { messageId, toolCallId: tr.id, result: tr.result } })
              break
            case 'tool_blocked':
              const tb = event.data as { id: string; reason: string }
              send(ws, { type: 'tool_blocked', payload: { messageId, toolCallId: tb.id, reason: tb.reason } })
              break
            case 'usage':
              const usage = event.data as { inputTokens: number; outputTokens: number }
              send(ws, { type: 'usage', payload: { messageId, ...usage } })
              break
            case 'done':
              send(ws, { type: 'message_complete', payload: { messageId } })
              break
            case 'error':
              send(ws, { type: 'error', payload: { error: event.data as string } })
              break
          }
        }
        break
      }

      case 'new_session': {
        const session = chatService.newSession(msg.payload?.name)
        send(ws, { type: 'connected', payload: { sessionId: session.id } })
        sendState(ws, chatService, settings)
        break
      }

      case 'load_session': {
        chatService.loadSession(msg.payload.sessionId)
        sendState(ws, chatService, settings)
        break
      }

      case 'delete_session': {
        chatService.deleteSessionById(msg.payload.sessionId)
        send(ws, { type: 'sessions_updated', payload: chatService.getSessions() })
        break
      }

      case 'update_settings': {
        Object.assign(settings, msg.payload)
        sendState(ws, chatService, settings)
        break
      }
    }
  }

  function send(ws: WebSocket, msg: WSServerMessage) {
    ws.send(JSON.stringify(msg))
  }

  function sendState(ws: WebSocket, chatService: ChatService, settings: UISettings) {
    const sessions = chatService.getSessions()
    const currentSession = sessions.find(s => s.isActive) || null
    const messages = chatService.getMessages()

    const state: UIState = {
      currentSession,
      sessions,
      messages,
      isStreaming: false,
      model: 'claude-sonnet-4-20250514',
      systemPrompt: config.systemPrompt,
      totalCostCents: messages.reduce((acc, m) => acc + (m.usage?.costCents || 0), 0),
      settings,
    }

    send(ws, { type: 'state', payload: state })
  }

  return {
    app,
    start: () => {
      console.log(`\n  ${t('ui.running_at', { url: `http://localhost:${config.port}` })}\n`)

      const wsClients = new Map<WebSocket, { clientId: string; client: ClientConnection }>()

      return Bun.serve({
        port: config.port,
        fetch(req, server) {
          if (req.headers.get('upgrade') === 'websocket') {
            const upgraded = server.upgrade(req)
            if (upgraded) return undefined
            return new Response('WebSocket upgrade failed', { status: 400 })
          }
          return app.fetch(req, server)
        },
        websocket: {
          open(ws) {
            const clientId = `client_${Date.now()}_${Math.random().toString(36).slice(2)}`
            const client = handleWebSocket(ws as unknown as WebSocket, clientId)
            wsClients.set(ws as unknown as WebSocket, { clientId, client })
          },
          async message(ws, data) {
            const entry = wsClients.get(ws as unknown as WebSocket)
            if (!entry) return
            try {
              const msg = JSON.parse(data.toString()) as WSClientMessage
              await handleMessage(ws as unknown as WebSocket, entry.client.chatService, entry.client.settings, msg)
            } catch (err) {
              send(ws as unknown as WebSocket, {
                type: 'error',
                payload: { error: err instanceof Error ? err.message : 'Unknown error' },
              })
            }
          },
          close(ws) {
            const entry = wsClients.get(ws as unknown as WebSocket)
            if (entry) {
              clients.delete(entry.clientId)
              wsClients.delete(ws as unknown as WebSocket)
            }
          },
        },
      })
    },
  }
}

function getIndexHtml(translations: Record<string, string>): string {
  const T = (key: string) => translations[key] || key
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>smolerclaw</title>
  <style>
    :root {
      --bg-primary: #0d1117;
      --bg-secondary: #161b22;
      --bg-tertiary: #21262d;
      --border-color: #30363d;
      --text-primary: #e6edf3;
      --text-secondary: #8b949e;
      --accent: #e5484d;
      --accent-hover: #ff6b6b;
      --success: #3fb950;
      --warning: #d29922;
      --error: #f85149;
      --user-bg: #c93c37;
      --assistant-bg: #21262d;
      --code-bg: #161b22;
      --scrollbar-track: #21262d;
      --scrollbar-thumb: #484f58;
      --font-mono: 'SF Mono', 'Cascadia Code', 'Fira Code', Consolas, monospace;
      --font-sans: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif;
      --radius: 12px;
      --radius-sm: 8px;
      --shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
    }

    [data-theme="light"] {
      --bg-primary: #ffffff;
      --bg-secondary: #f6f8fa;
      --bg-tertiary: #eaeef2;
      --border-color: #d0d7de;
      --text-primary: #1f2328;
      --text-secondary: #656d76;
      --user-bg: #cf2e2e;
      --assistant-bg: #f6f8fa;
      --code-bg: #f6f8fa;
      --scrollbar-track: #f6f8fa;
      --scrollbar-thumb: #d0d7de;
    }

    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }

    html, body {
      height: 100%;
      font-family: var(--font-sans);
      background: var(--bg-primary);
      color: var(--text-primary);
    }

    .app {
      display: flex;
      height: 100vh;
      overflow: hidden;
    }

    /* Sidebar */
    .sidebar {
      width: 280px;
      background: var(--bg-secondary);
      border-right: 1px solid var(--border-color);
      display: flex;
      flex-direction: column;
      flex-shrink: 0;
    }

    .sidebar-header {
      padding: 20px;
      border-bottom: 1px solid var(--border-color);
    }

    .logo {
      display: flex;
      align-items: center;
      gap: 12px;
      font-size: 18px;
      font-weight: 600;
    }

    .logo-icon {
      width: 32px;
      height: 32px;
      background: linear-gradient(135deg, var(--accent), #f97316);
      border-radius: var(--radius-sm);
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 20px;
    }

    .new-chat-btn {
      width: 100%;
      margin-top: 16px;
      padding: 12px 16px;
      background: var(--accent);
      color: white;
      border: none;
      border-radius: var(--radius-sm);
      font-size: 14px;
      font-weight: 500;
      cursor: pointer;
      transition: background 0.2s;
    }

    .new-chat-btn:hover {
      background: var(--accent-hover);
    }

    .sessions-list {
      flex: 1;
      overflow-y: auto;
      padding: 12px;
    }

    .session-item {
      padding: 12px 16px;
      border-radius: var(--radius-sm);
      cursor: pointer;
      margin-bottom: 4px;
      transition: background 0.2s;
    }

    .session-item:hover {
      background: var(--bg-tertiary);
    }

    .session-item.active {
      background: var(--bg-tertiary);
      border: 1px solid var(--border-color);
    }

    .session-name {
      font-size: 14px;
      font-weight: 500;
      margin-bottom: 4px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .session-meta {
      font-size: 12px;
      color: var(--text-secondary);
    }

    .sidebar-footer {
      padding: 16px;
      border-top: 1px solid var(--border-color);
    }

    .settings-btn {
      width: 100%;
      padding: 10px 16px;
      background: transparent;
      color: var(--text-secondary);
      border: 1px solid var(--border-color);
      border-radius: var(--radius-sm);
      font-size: 14px;
      cursor: pointer;
      transition: all 0.2s;
    }

    .settings-btn:hover {
      background: var(--bg-tertiary);
      color: var(--text-primary);
    }

    /* Main Content */
    .main {
      flex: 1;
      display: flex;
      flex-direction: column;
      min-width: 0;
    }

    .header {
      padding: 16px 24px;
      border-bottom: 1px solid var(--border-color);
      display: flex;
      align-items: center;
      justify-content: space-between;
      background: var(--bg-secondary);
    }

    .model-selector {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 16px;
      background: var(--bg-tertiary);
      border: 1px solid var(--border-color);
      border-radius: var(--radius-sm);
      font-size: 14px;
      cursor: pointer;
    }

    .model-badge {
      padding: 2px 8px;
      background: var(--accent);
      color: white;
      border-radius: 4px;
      font-size: 12px;
      font-weight: 500;
    }

    .header-actions {
      display: flex;
      gap: 8px;
    }

    .icon-btn {
      width: 36px;
      height: 36px;
      display: flex;
      align-items: center;
      justify-content: center;
      background: transparent;
      border: 1px solid var(--border-color);
      border-radius: var(--radius-sm);
      cursor: pointer;
      color: var(--text-secondary);
      transition: all 0.2s;
    }

    .icon-btn:hover {
      background: var(--bg-tertiary);
      color: var(--text-primary);
    }

    /* Messages */
    .messages-container {
      flex: 1;
      overflow-y: auto;
      padding: 24px;
    }

    .messages-container::-webkit-scrollbar {
      width: 8px;
    }

    .messages-container::-webkit-scrollbar-track {
      background: var(--scrollbar-track);
    }

    .messages-container::-webkit-scrollbar-thumb {
      background: var(--scrollbar-thumb);
      border-radius: 4px;
    }

    .message {
      max-width: 800px;
      margin: 0 auto 24px;
      animation: fadeIn 0.3s ease;
    }

    @keyframes fadeIn {
      from { opacity: 0; transform: translateY(10px); }
      to { opacity: 1; transform: translateY(0); }
    }

    .message-header {
      display: flex;
      align-items: center;
      gap: 12px;
      margin-bottom: 12px;
    }

    .avatar {
      width: 32px;
      height: 32px;
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 16px;
      flex-shrink: 0;
    }

    .avatar.user {
      background: var(--user-bg);
      color: white;
    }

    .avatar.assistant {
      background: linear-gradient(135deg, var(--accent), #f97316);
      color: white;
    }

    .message-author {
      font-weight: 600;
      font-size: 14px;
    }

    .message-time {
      font-size: 12px;
      color: var(--text-secondary);
    }

    .message-content {
      padding-left: 44px;
    }

    .message-text {
      line-height: 1.6;
      white-space: pre-wrap;
      word-wrap: break-word;
    }

    .message-text p {
      margin-bottom: 12px;
    }

    .message-text p:last-child {
      margin-bottom: 0;
    }

    .message-text code {
      font-family: var(--font-mono);
      background: var(--code-bg);
      padding: 2px 6px;
      border-radius: 4px;
      font-size: 13px;
    }

    .message-text pre {
      background: var(--code-bg);
      border: 1px solid var(--border-color);
      border-radius: var(--radius-sm);
      padding: 16px;
      overflow-x: auto;
      margin: 12px 0;
    }

    .message-text pre code {
      background: none;
      padding: 0;
    }

    /* Tool calls */
    .tool-call {
      background: var(--bg-tertiary);
      border: 1px solid var(--border-color);
      border-radius: var(--radius-sm);
      margin: 12px 0;
      overflow: hidden;
    }

    .tool-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 12px 16px;
      background: var(--bg-secondary);
      border-bottom: 1px solid var(--border-color);
    }

    .tool-name {
      font-family: var(--font-mono);
      font-size: 13px;
      font-weight: 500;
    }

    .tool-status {
      font-size: 12px;
      padding: 2px 8px;
      border-radius: 4px;
    }

    .tool-status.running {
      background: var(--warning);
      color: white;
    }

    .tool-status.complete {
      background: var(--success);
      color: white;
    }

    .tool-status.error {
      background: var(--error);
      color: white;
    }

    .tool-content {
      padding: 12px 16px;
      font-family: var(--font-mono);
      font-size: 12px;
      max-height: 200px;
      overflow-y: auto;
    }

    /* Streaming indicator */
    .streaming-indicator {
      display: inline-flex;
      gap: 4px;
      margin-left: 8px;
    }

    .streaming-indicator span {
      width: 6px;
      height: 6px;
      background: var(--accent);
      border-radius: 50%;
      animation: pulse 1.4s ease-in-out infinite;
    }

    .streaming-indicator span:nth-child(2) { animation-delay: 0.2s; }
    .streaming-indicator span:nth-child(3) { animation-delay: 0.4s; }

    @keyframes pulse {
      0%, 80%, 100% { transform: scale(0.8); opacity: 0.5; }
      40% { transform: scale(1); opacity: 1; }
    }

    /* Input */
    .input-container {
      padding: 16px 24px 24px;
      background: var(--bg-secondary);
      border-top: 1px solid var(--border-color);
    }

    .input-wrapper {
      max-width: 800px;
      margin: 0 auto;
    }

    .input-box {
      display: flex;
      align-items: flex-end;
      gap: 12px;
      background: var(--bg-primary);
      border: 1px solid var(--border-color);
      border-radius: var(--radius);
      padding: 12px 16px;
      transition: border-color 0.2s, box-shadow 0.2s;
    }

    .input-box:focus-within {
      border-color: var(--accent);
      box-shadow: 0 0 0 3px rgba(229, 72, 77, 0.2);
    }

    .input-box textarea {
      flex: 1;
      background: transparent;
      border: none;
      outline: none;
      color: var(--text-primary);
      font-family: var(--font-sans);
      font-size: 15px;
      line-height: 1.5;
      resize: none;
      min-height: 24px;
      max-height: 200px;
    }

    .input-box textarea::placeholder {
      color: var(--text-secondary);
    }

    .send-btn {
      width: 40px;
      height: 40px;
      display: flex;
      align-items: center;
      justify-content: center;
      background: var(--accent);
      border: none;
      border-radius: var(--radius-sm);
      cursor: pointer;
      color: white;
      transition: background 0.2s, transform 0.1s;
    }

    .send-btn:hover:not(:disabled) {
      background: var(--accent-hover);
    }

    .send-btn:active:not(:disabled) {
      transform: scale(0.95);
    }

    .send-btn:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }

    .input-hint {
      text-align: center;
      font-size: 12px;
      color: var(--text-secondary);
      margin-top: 8px;
    }

    /* Welcome screen */
    .welcome {
      max-width: 600px;
      margin: auto;
      text-align: center;
      padding: 40px;
    }

    .welcome-icon {
      font-size: 64px;
      margin-bottom: 24px;
    }

    .welcome h1 {
      font-size: 28px;
      margin-bottom: 12px;
    }

    .welcome p {
      color: var(--text-secondary);
      line-height: 1.6;
      margin-bottom: 32px;
    }

    .suggestions {
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      gap: 12px;
    }

    .suggestion {
      padding: 16px;
      background: var(--bg-secondary);
      border: 1px solid var(--border-color);
      border-radius: var(--radius-sm);
      text-align: left;
      cursor: pointer;
      transition: all 0.2s;
    }

    .suggestion:hover {
      background: var(--bg-tertiary);
      border-color: var(--accent);
    }

    .suggestion-title {
      font-weight: 500;
      margin-bottom: 4px;
    }

    .suggestion-desc {
      font-size: 13px;
      color: var(--text-secondary);
    }

    /* Cost display */
    .cost-display {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 12px;
      color: var(--text-secondary);
    }

    .cost-value {
      font-family: var(--font-mono);
      color: var(--success);
    }

    /* Empty state */
    .empty-sessions {
      padding: 40px 20px;
      text-align: center;
      color: var(--text-secondary);
    }

    /* Responsive */
    @media (max-width: 768px) {
      .sidebar {
        display: none;
      }

      .messages-container {
        padding: 16px;
      }

      .message-content {
        padding-left: 0;
      }

      .suggestions {
        grid-template-columns: 1fr;
      }
    }
  </style>
</head>
<body>
  <div class="app" id="app">
    <!-- Sidebar -->
    <aside class="sidebar">
      <div class="sidebar-header">
        <div class="logo">
          <div class="logo-icon">S</div>
          <span>smolerclaw</span>
        </div>
        <button class="new-chat-btn" onclick="newSession()">
          ${T('web.new_chat')}
        </button>
      </div>

      <div class="sessions-list" id="sessions-list">
        <div class="empty-sessions">${T('web.no_sessions')}</div>
      </div>

      <div class="sidebar-footer">
        <div class="cost-display">
          <span>${T('web.total_cost')}</span>
          <span class="cost-value" id="total-cost">$0.00</span>
        </div>
      </div>
    </aside>

    <!-- Main Content -->
    <main class="main">
      <header class="header">
        <div class="model-selector">
          <span class="model-badge">Claude</span>
          <span id="model-name">claude-sonnet-4</span>
        </div>
        <div class="header-actions">
          <button class="icon-btn" onclick="toggleTheme()" title="${T('web.toggle_theme')}">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="12" cy="12" r="5"/>
              <path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/>
            </svg>
          </button>
          <button class="icon-btn" onclick="clearChat()" title="${T('web.clear_chat')}">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2"/>
            </svg>
          </button>
        </div>
      </header>

      <div class="messages-container" id="messages-container">
        <div class="welcome">
          <div class="welcome-icon">S</div>
          <h1>${T('web.welcome_title')}</h1>
          <p>${T('web.welcome_desc')}</p>
          <div class="suggestions">
            <div class="suggestion" onclick="sendSuggestion(window.__i18n['web.suggestion_start_prompt'])">
              <div class="suggestion-title">${T('web.suggestion_start_title')}</div>
              <div class="suggestion-desc">${T('web.suggestion_start_desc')}</div>
            </div>
            <div class="suggestion" onclick="sendSuggestion(window.__i18n['web.suggestion_tasks_prompt'])">
              <div class="suggestion-title">${T('web.suggestion_tasks_title')}</div>
              <div class="suggestion-desc">${T('web.suggestion_tasks_desc')}</div>
            </div>
            <div class="suggestion" onclick="sendSuggestion(window.__i18n['web.suggestion_system_prompt'])">
              <div class="suggestion-title">${T('web.suggestion_system_title')}</div>
              <div class="suggestion-desc">${T('web.suggestion_system_desc')}</div>
            </div>
            <div class="suggestion" onclick="sendSuggestion(window.__i18n['web.suggestion_briefing_prompt'])">
              <div class="suggestion-title">${T('web.suggestion_briefing_title')}</div>
              <div class="suggestion-desc">${T('web.suggestion_briefing_desc')}</div>
            </div>
          </div>
        </div>
      </div>

      <div class="input-container">
        <div class="input-wrapper">
          <div class="input-box">
            <textarea
              id="input"
              placeholder="${T('web.placeholder')}"
              rows="1"
              onkeydown="handleKeyDown(event)"
              oninput="autoResize(this)"
            ></textarea>
            <button class="send-btn" id="send-btn" onclick="sendMessage()">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z"/>
              </svg>
            </button>
          </div>
          <div class="input-hint">${T('web.input_hint')}</div>
        </div>
      </div>
    </main>
  </div>

  <script>
    // i18n translations injected from server
    window.__i18n = ${JSON.stringify(Object.fromEntries(
      Object.entries(translations).filter(([k]) => k.startsWith('web.'))
    ))};
    const __t = (key) => window.__i18n[key] || key;

    // State
    let ws = null;
    let state = {
      messages: [],
      sessions: [],
      currentSession: null,
      isStreaming: false,
      totalCostCents: 0,
    };
    let currentMessageId = null;
    let currentMessageContent = '';

    // Theme
    function getTheme() {
      return localStorage.getItem('theme') || 'dark';
    }

    function setTheme(theme) {
      localStorage.setItem('theme', theme);
      document.documentElement.dataset.theme = theme;
    }

    function toggleTheme() {
      setTheme(getTheme() === 'dark' ? 'light' : 'dark');
    }

    // Initialize
    setTheme(getTheme());

    // WebSocket
    function connect() {
      const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      ws = new WebSocket(protocol + '//' + location.host + '/ws');

      ws.onopen = () => {
        console.log(__t('web.connected'));
      };

      ws.onmessage = (event) => {
        const msg = JSON.parse(event.data);
        handleServerMessage(msg);
      };

      ws.onclose = () => {
        console.log(__t('web.disconnected'));
        setTimeout(connect, 1000);
      };

      ws.onerror = (err) => {
        console.error('WebSocket error:', err);
      };
    }

    function handleServerMessage(msg) {
      switch (msg.type) {
        case 'connected':
          console.log('Session:', msg.payload.sessionId);
          break;

        case 'state':
          state = { ...state, ...msg.payload };
          renderSessions();
          renderMessages();
          updateCost();
          break;

        case 'message_start':
          currentMessageId = msg.payload.messageId;
          currentMessageContent = '';
          state.isStreaming = true;
          addStreamingMessage();
          break;

        case 'text_delta':
          currentMessageContent += msg.payload.text;
          updateStreamingMessage();
          break;

        case 'tool_call':
          addToolCall(msg.payload);
          break;

        case 'tool_result':
          updateToolResult(msg.payload);
          break;

        case 'usage':
          state.totalCostCents += calculateCost(msg.payload.inputTokens, msg.payload.outputTokens);
          updateCost();
          break;

        case 'message_complete':
          finalizeMessage();
          break;

        case 'error':
          showError(msg.payload.error);
          break;

        case 'sessions_updated':
          state.sessions = msg.payload;
          renderSessions();
          break;
      }
    }

    function calculateCost(inputTokens, outputTokens) {
      const inputCost = (inputTokens / 1_000_000) * 300;
      const outputCost = (outputTokens / 1_000_000) * 1500;
      return Math.round((inputCost + outputCost) * 100) / 100;
    }

    // UI Functions
    function renderSessions() {
      const container = document.getElementById('sessions-list');
      if (state.sessions.length === 0) {
        container.innerHTML = '<div class="empty-sessions">' + __t('web.no_sessions') + '</div>';
        return;
      }

      container.innerHTML = state.sessions.map(s => \`
        <div class="session-item \${s.isActive ? 'active' : ''}" onclick="loadSession(\${JSON.stringify(s.id)})">
          <div class="session-name">\${escapeHtml(s.name)}</div>
          <div class="session-meta">\${s.messageCount} \${__t('web.messages_count').replace('{{count}}', '')}</div>
        </div>
      \`).join('');
    }

    function renderMessages() {
      const container = document.getElementById('messages-container');

      if (state.messages.length === 0) {
        container.innerHTML = getWelcomeHtml();
        return;
      }

      container.innerHTML = state.messages.map(m => renderMessage(m)).join('');
      scrollToBottom();
    }

    function renderMessage(msg) {
      const isUser = msg.role === 'user';
      const avatar = isUser ? '👤' : 'S';
      const author = isUser ? __t('web.you') : __t('web.assistant');
      const time = new Date(msg.timestamp).toLocaleTimeString();

      let toolCallsHtml = '';
      if (msg.toolCalls && msg.toolCalls.length > 0) {
        toolCallsHtml = msg.toolCalls.map(tc => \`
          <div class="tool-call">
            <div class="tool-header">
              <span class="tool-name">\${escapeHtml(tc.name)}</span>
              <span class="tool-status \${tc.status}">\${tc.status}</span>
            </div>
            \${tc.result ? \`<div class="tool-content">\${escapeHtml(tc.result.substring(0, 500))}\${tc.result.length > 500 ? '...' : ''}</div>\` : ''}
          </div>
        \`).join('');
      }

      return \`
        <div class="message">
          <div class="message-header">
            <div class="avatar \${isUser ? 'user' : 'assistant'}">\${avatar}</div>
            <span class="message-author">\${author}</span>
            <span class="message-time">\${time}</span>
          </div>
          <div class="message-content">
            <div class="message-text">\${formatMessage(msg.content)}</div>
            \${toolCallsHtml}
          </div>
        </div>
      \`;
    }

    function addStreamingMessage() {
      const container = document.getElementById('messages-container');

      // Remove welcome if present
      const welcome = container.querySelector('.welcome');
      if (welcome) welcome.remove();

      // Add user message
      const userMsg = {
        id: 'user-' + currentMessageId,
        role: 'user',
        content: document.getElementById('input').value,
        timestamp: Date.now(),
      };
      state.messages.push(userMsg);
      container.insertAdjacentHTML('beforeend', renderMessage(userMsg));

      // Add streaming assistant message
      const streamingHtml = \`
        <div class="message" id="streaming-message">
          <div class="message-header">
            <div class="avatar assistant">S</div>
            <span class="message-author">\${__t('web.assistant')}</span>
            <div class="streaming-indicator">
              <span></span><span></span><span></span>
            </div>
          </div>
          <div class="message-content">
            <div class="message-text" id="streaming-content"></div>
            <div id="streaming-tools"></div>
          </div>
        </div>
      \`;
      container.insertAdjacentHTML('beforeend', streamingHtml);
      scrollToBottom();
    }

    function updateStreamingMessage() {
      const content = document.getElementById('streaming-content');
      if (content) {
        content.innerHTML = formatMessage(currentMessageContent);
        scrollToBottom();
      }
    }

    function addToolCall(tc) {
      const tools = document.getElementById('streaming-tools');
      if (tools) {
        tools.insertAdjacentHTML('beforeend', \`
          <div class="tool-call" id="tool-\${tc.id}">
            <div class="tool-header">
              <span class="tool-name">\${escapeHtml(tc.name)}</span>
              <span class="tool-status running">\${__t('web.running')}</span>
            </div>
          </div>
        \`);
        scrollToBottom();
      }
    }

    function updateToolResult(payload) {
      const tool = document.getElementById('tool-' + payload.toolCallId);
      if (tool) {
        tool.querySelector('.tool-status').className = 'tool-status complete';
        tool.querySelector('.tool-status').textContent = __t('web.complete');
        tool.insertAdjacentHTML('beforeend', \`
          <div class="tool-content">\${escapeHtml(payload.result.substring(0, 500))}\${payload.result.length > 500 ? '...' : ''}</div>
        \`);
        scrollToBottom();
      }
    }

    function finalizeMessage() {
      const streaming = document.getElementById('streaming-message');
      if (streaming) {
        const indicator = streaming.querySelector('.streaming-indicator');
        if (indicator) indicator.remove();

        const time = document.createElement('span');
        time.className = 'message-time';
        time.textContent = new Date().toLocaleTimeString();
        streaming.querySelector('.message-header').appendChild(time);
      }

      state.messages.push({
        id: currentMessageId,
        role: 'assistant',
        content: currentMessageContent,
        timestamp: Date.now(),
        status: 'complete',
      });

      state.isStreaming = false;
      currentMessageId = null;
      currentMessageContent = '';
      updateSendButton();
    }

    function showError(error) {
      const streaming = document.getElementById('streaming-message');
      if (streaming) {
        streaming.querySelector('.streaming-indicator')?.remove();
        const content = streaming.querySelector('.message-content');
        content.innerHTML = \`<div style="color: var(--error)">\${escapeHtml(error)}</div>\`;
      }
      state.isStreaming = false;
      updateSendButton();
    }

    function updateCost() {
      const costEl = document.getElementById('total-cost');
      costEl.textContent = '$' + (state.totalCostCents / 100).toFixed(4);
    }

    function scrollToBottom() {
      const container = document.getElementById('messages-container');
      container.scrollTop = container.scrollHeight;
    }

    // Input handling
    function handleKeyDown(event) {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        sendMessage();
      }
    }

    function autoResize(textarea) {
      textarea.style.height = 'auto';
      textarea.style.height = Math.min(textarea.scrollHeight, 200) + 'px';
    }

    function sendMessage() {
      const input = document.getElementById('input');
      const message = input.value.trim();

      if (!message || state.isStreaming) return;

      ws.send(JSON.stringify({
        type: 'chat',
        payload: { message },
      }));

      input.value = '';
      autoResize(input);
      updateSendButton();
    }

    function sendSuggestion(text) {
      document.getElementById('input').value = text;
      sendMessage();
    }

    function updateSendButton() {
      const btn = document.getElementById('send-btn');
      const input = document.getElementById('input');
      btn.disabled = state.isStreaming || !input.value.trim();
    }

    // Session management
    function newSession() {
      ws.send(JSON.stringify({ type: 'new_session' }));
    }

    function loadSession(sessionId) {
      ws.send(JSON.stringify({ type: 'load_session', payload: { sessionId } }));
    }

    function clearChat() {
      if (confirm(__t('web.confirm_new_chat'))) {
        newSession();
      }
    }

    // Utilities
    function escapeHtml(text) {
      const div = document.createElement('div');
      div.textContent = text;
      return div.innerHTML;
    }

    function formatMessage(text) {
      if (!text) return '';

      // Simple markdown-like formatting
      let html = escapeHtml(text);

      // Code blocks
      html = html.replace(/\\\`\\\`\\\`([\\s\\S]*?)\\\`\\\`\\\`/g, '<pre><code>$1</code></pre>');

      // Inline code
      html = html.replace(/\\\`([^\\\`]+)\\\`/g, '<code>$1</code>');

      // Bold
      html = html.replace(/\\*\\*([^*]+)\\*\\*/g, '<strong>$1</strong>');

      // Italic
      html = html.replace(/\\*([^*]+)\\*/g, '<em>$1</em>');

      // Line breaks
      html = html.replace(/\\n/g, '<br>');

      return html;
    }

    function getWelcomeHtml() {
      return \`
        <div class="welcome">
          <div class="welcome-icon">S</div>
          <h1>${T('web.welcome_title')}</h1>
          <p>${T('web.welcome_desc')}</p>
          <div class="suggestions">
            <div class="suggestion" onclick="sendSuggestion(window.__i18n['web.suggestion_start_prompt'])">
              <div class="suggestion-title">${T('web.suggestion_start_title')}</div>
              <div class="suggestion-desc">${T('web.suggestion_start_desc')}</div>
            </div>
            <div class="suggestion" onclick="sendSuggestion(window.__i18n['web.suggestion_tasks_prompt'])">
              <div class="suggestion-title">${T('web.suggestion_tasks_title')}</div>
              <div class="suggestion-desc">${T('web.suggestion_tasks_desc')}</div>
            </div>
            <div class="suggestion" onclick="sendSuggestion(window.__i18n['web.suggestion_system_prompt'])">
              <div class="suggestion-title">${T('web.suggestion_system_title')}</div>
              <div class="suggestion-desc">${T('web.suggestion_system_desc')}</div>
            </div>
            <div class="suggestion" onclick="sendSuggestion(window.__i18n['web.suggestion_briefing_prompt'])">
              <div class="suggestion-title">${T('web.suggestion_briefing_title')}</div>
              <div class="suggestion-desc">${T('web.suggestion_briefing_desc')}</div>
            </div>
          </div>
        </div>
      \`;
    }

    // Start
    connect();
    document.getElementById('input').addEventListener('input', updateSendButton);
  </script>
</body>
</html>`
}
