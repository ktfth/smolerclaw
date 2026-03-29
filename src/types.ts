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

export interface Material {
  id: string
  title: string
  content: string
  category: string
  tags: string[]
  createdAt: string
  updatedAt: string
}

export interface TinyClawConfig {
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

// ─── Event Bus Types ─────────────────────────────────────────

/**
 * Context change event — emitted when the active working context changes.
 * Used by Windows Agent when detecting directory or window changes.
 */
export interface ContextChangedEvent {
  previousDir?: string
  currentDir: string
  foregroundWindow?: string
  timestamp: number
}

/**
 * File saved event — emitted after any file write operation.
 * Used to trigger backup routines and RAG re-indexing.
 */
export interface FileSavedEvent {
  filePath: string
  size: number
  isTracked: boolean // true if part of TRACKED_FILES in vault
  timestamp: number
}

/**
 * Telemetry alert event — emitted when metrics exceed thresholds.
 * Used for cost warnings, token limits, and performance alerts.
 */
export interface TelemetryAlertEvent {
  alertType: 'cost_warning' | 'token_limit' | 'rate_limit' | 'error_rate' | 'performance'
  message: string
  value?: number
  threshold?: number
  timestamp: number
}

/**
 * Task completed event — emitted when a background or user task finishes.
 * Used to update TUI status and trigger follow-up actions.
 */
export interface TaskCompletedEvent {
  taskId: string
  taskType: 'backup' | 'rag_index' | 'pomodoro' | 'monitor' | 'workflow' | 'user_task'
  success: boolean
  message?: string
  duration?: number
  timestamp: number
}

/**
 * Status update event — generic event for TUI status bar updates.
 * Used for non-blocking UI updates from any module.
 */
export interface StatusUpdateEvent {
  source: string
  message: string
  level: 'info' | 'warning' | 'error' | 'success'
  timestamp: number
}

/**
 * Session changed event — emitted when switching sessions.
 */
export interface SessionChangedEvent {
  previousSession?: string
  currentSession: string
  timestamp: number
}

// ─── Insight Types ───────────────────────────────────────────

/**
 * Proactive insight from the Docs Engine.
 * Represents a pattern detected that could help the user.
 */
export interface Insight {
  id: string
  title: string
  explanation: string
  category: 'efficiency' | 'pattern' | 'shortcut' | 'warning' | 'learning'
  /** Suggested action to execute if accepted */
  suggestedAction?: {
    label: string
    command: string
  }
  /** Priority for ordering (higher = more important) */
  priority: number
  /** Source of the insight (e.g., 'docs-engine', 'usage-analytics') */
  source: string
  timestamp: number
}

/**
 * Event emitted when user accepts an insight suggestion.
 */
export interface InsightAcceptedEvent {
  insightId: string
  insight: Insight
  timestamp: number
}

/**
 * Event emitted when a new insight is available for display.
 */
export interface InsightAvailableEvent {
  insight: Insight
  timestamp: number
}

/**
 * Map of event names to their payload types.
 * This enables strict typing for the event bus.
 */
export interface EventBusEvents {
  'context:changed': ContextChangedEvent
  'file:saved': FileSavedEvent
  'telemetry:alert': TelemetryAlertEvent
  'task:completed': TaskCompletedEvent
  'status:update': StatusUpdateEvent
  'session:changed': SessionChangedEvent
  'insight:accepted': InsightAcceptedEvent
  'insight:available': InsightAvailableEvent
}
