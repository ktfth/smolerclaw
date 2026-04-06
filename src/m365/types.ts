/**
 * Shared types for the Microsoft 365 CLI integration.
 */

// ─── Executor Types ─────────────────────────────────────────

export interface M365Result<T = unknown> {
  readonly success: boolean
  readonly data: T | null
  readonly error: string | null
  readonly raw: string
  readonly duration: number
}

export interface M365ExecOptions {
  /** Timeout in milliseconds. Default: 30000 */
  readonly timeout?: number
  /** Skip cache and fetch fresh data */
  readonly fresh?: boolean
  /** Cache TTL override in milliseconds */
  readonly cacheTtl?: number
}

// ─── Auth Types ─────────────────────────────────────────────

export type M365AuthStatus = 'connected' | 'disconnected' | 'expired'

export interface M365ConnectionInfo {
  readonly status: M365AuthStatus
  readonly connectedAs: string | null
  readonly tenantId: string | null
  readonly authType: string | null
}

// ─── Outlook Types ──────────────────────────────────────────

export interface M365Email {
  readonly id: string
  readonly subject: string
  readonly from: string
  readonly receivedDateTime: string
  readonly isRead: boolean
  readonly bodyPreview: string
  readonly importance: string
}

export interface M365EmailDetail {
  readonly id: string
  readonly subject: string
  readonly from: string
  readonly to: string[]
  readonly cc: string[]
  readonly receivedDateTime: string
  readonly isRead: boolean
  readonly body: string
  readonly importance: string
  readonly hasAttachments: boolean
}

export interface M365SendEmailParams {
  readonly to: string
  readonly subject: string
  readonly body: string
  readonly cc?: string
  readonly importance?: 'low' | 'normal' | 'high'
}

export interface M365Event {
  readonly id: string
  readonly subject: string
  readonly start: string
  readonly end: string
  readonly location: string
  readonly organizer: string
  readonly isAllDay: boolean
  readonly status: string
}

export interface M365CreateEventParams {
  readonly subject: string
  readonly start: string
  readonly end: string
  readonly location?: string
  readonly body?: string
  readonly isAllDay?: boolean
}

export interface M365Contact {
  readonly id: string
  readonly displayName: string
  readonly emailAddresses: string[]
  readonly phoneNumbers: string[]
  readonly company: string | null
  readonly jobTitle: string | null
}

// ─── To Do Types ────────────────────────────────────────────

export interface M365TodoList {
  readonly id: string
  readonly displayName: string
  readonly isOwner: boolean
  readonly isShared: boolean
}

export interface M365TodoTask {
  readonly id: string
  readonly title: string
  readonly status: 'notStarted' | 'inProgress' | 'completed'
  readonly importance: 'low' | 'normal' | 'high'
  readonly dueDateTime: string | null
  readonly createdDateTime: string
  readonly listId: string
  readonly listName?: string
}

export interface M365CreateTodoParams {
  readonly title: string
  readonly listId?: string
  readonly dueDateTime?: string
  readonly importance?: 'low' | 'normal' | 'high'
}

// ─── OneDrive Types ─────────────────────────────────────────

export interface M365DriveItem {
  readonly id: string
  readonly name: string
  readonly size: number
  readonly lastModifiedDateTime: string
  readonly isFolder: boolean
  readonly webUrl: string
  readonly path: string
}

// ─── OneNote Types ──────────────────────────────────────────

export interface M365Notebook {
  readonly id: string
  readonly displayName: string
  readonly createdDateTime: string
  readonly lastModifiedDateTime: string
  readonly isShared: boolean
}

export interface M365OneNotePage {
  readonly id: string
  readonly title: string
  readonly createdDateTime: string
  readonly lastModifiedDateTime: string
  readonly contentUrl: string
}

// ─── Composite Types ────────────────────────────────────────

export interface M365Briefing {
  readonly unreadEmails: M365Email[]
  readonly todayEvents: M365Event[]
  readonly pendingTodos: M365TodoTask[]
  readonly timestamp: number
}

export interface M365Digest {
  readonly emailsReceived: number
  readonly emailsSent: number
  readonly meetingsAttended: number
  readonly tasksCompleted: number
  readonly period: string
  readonly timestamp: number
}

// ─── Cache Types ────────────────────────────────────────────

export interface CacheEntry<T = unknown> {
  readonly data: T
  readonly expiresAt: number
  readonly key: string
}

/** TTL in milliseconds per resource type */
export const CACHE_TTL: Record<string, number> = {
  emails: 2 * 60_000,
  calendar: 5 * 60_000,
  files: 5 * 60_000,
  contacts: 30 * 60_000,
  todo: 3 * 60_000,
  onenote: 10 * 60_000,
  status: 60_000,
}
