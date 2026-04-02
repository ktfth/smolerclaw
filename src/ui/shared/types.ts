/**
 * Shared types for Desktop and Web UI
 */

export interface UIMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  timestamp: number
  status: 'pending' | 'streaming' | 'complete' | 'error'
  toolCalls?: UIToolCall[]
  usage?: {
    inputTokens: number
    outputTokens: number
    costCents: number
  }
}

export interface UIToolCall {
  id: string
  name: string
  input: Record<string, unknown>
  result?: string
  status: 'pending' | 'running' | 'approved' | 'rejected' | 'complete' | 'error'
  riskLevel?: 'safe' | 'moderate' | 'high' | 'dangerous'
}

export interface UISession {
  id: string
  name: string
  messageCount: number
  created: number
  updated: number
  isActive: boolean
}

export interface UIState {
  currentSession: UISession | null
  sessions: UISession[]
  messages: UIMessage[]
  isStreaming: boolean
  model: string
  systemPrompt: string
  totalCostCents: number
  settings: UISettings
}

export interface UISettings {
  theme: 'light' | 'dark' | 'system'
  fontSize: 'small' | 'medium' | 'large'
  showToolCalls: boolean
  showCosts: boolean
  autoScroll: boolean
  enableSounds: boolean
}

export interface ChatRequest {
  message: string
  images?: {
    mediaType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'
    base64: string
  }[]
  sessionId?: string
}

export interface ChatStreamEvent {
  type: 'text' | 'tool_call' | 'tool_result' | 'tool_blocked' | 'usage' | 'done' | 'error'
  data: unknown
}

export interface ToolApprovalRequest {
  toolCallId: string
  name: string
  input: Record<string, unknown>
  riskLevel: 'safe' | 'moderate' | 'high'
}

export interface APIResponse<T> {
  success: boolean
  data?: T
  error?: string
}

// WebSocket message types
export type WSClientMessage =
  | { type: 'chat'; payload: ChatRequest }
  | { type: 'approve_tool'; payload: { toolCallId: string; approved: boolean } }
  | { type: 'cancel' }
  | { type: 'new_session'; payload?: { name?: string } }
  | { type: 'load_session'; payload: { sessionId: string } }
  | { type: 'delete_session'; payload: { sessionId: string } }
  | { type: 'update_settings'; payload: Partial<UISettings> }

export type WSServerMessage =
  | { type: 'connected'; payload: { sessionId: string } }
  | { type: 'state'; payload: UIState }
  | { type: 'message_start'; payload: { messageId: string } }
  | { type: 'text_delta'; payload: { messageId: string; text: string } }
  | { type: 'tool_call'; payload: UIToolCall & { messageId: string } }
  | { type: 'tool_result'; payload: { messageId: string; toolCallId: string; result: string } }
  | { type: 'tool_blocked'; payload: { messageId: string; toolCallId: string; reason: string } }
  | { type: 'tool_approval_required'; payload: ToolApprovalRequest }
  | { type: 'usage'; payload: { messageId: string; inputTokens: number; outputTokens: number } }
  | { type: 'message_complete'; payload: { messageId: string } }
  | { type: 'error'; payload: { error: string } }
  | { type: 'sessions_updated'; payload: UISession[] }
