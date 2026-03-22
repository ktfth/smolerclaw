export interface MessageImage {
  mediaType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'
  base64: string
}

export interface Message {
  role: 'user' | 'assistant'
  content: string
  images?: MessageImage[]
  toolCalls?: ToolCall[]
  usage?: { inputTokens: number; outputTokens: number; costCents: number }
  timestamp: number
}

export interface ToolCall {
  id: string
  name: string
  input: Record<string, unknown>
  result: string
}

export interface Session {
  id: string
  name: string
  messages: Message[]
  created: number
  updated: number
}

export interface TinyClawConfig {
  apiKey: string
  authMode: 'auto' | 'api-key' | 'subscription'
  model: string
  maxTokens: number
  maxHistory: number
  systemPrompt: string
  skillsDir: string
  dataDir: string
  toolApproval: ToolApprovalMode
  language: string
  maxSessionCost: number // max cost in cents per session. 0 = unlimited
}

export type ToolApprovalMode = 'auto' | 'confirm-writes' | 'confirm-all'

export type ChatEvent =
  | { type: 'text'; text: string }
  | { type: 'tool_call'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; id: string; name: string; result: string }
  | { type: 'tool_blocked'; id: string; name: string; reason: string }
  | { type: 'usage'; inputTokens: number; outputTokens: number }
  | { type: 'retry'; attempt: number; waitMs: number; reason: string }
  | { type: 'context_trimmed'; dropped: number }
  | { type: 'done' }
  | { type: 'error'; error: string }
