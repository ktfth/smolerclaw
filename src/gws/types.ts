/**
 * Shared types for the Google Workspace CLI integration.
 */

// ─── Executor Types ─────────────────────────────────────────

export interface GwsResult<T = unknown> {
  readonly success: boolean
  readonly data: T | null
  readonly error: string | null
  readonly raw: string
  readonly duration: number
}

export interface GwsExecOptions {
  /** Timeout in milliseconds. Default: 30000 */
  readonly timeout?: number
  /** Skip cache and fetch fresh data */
  readonly fresh?: boolean
  /** Cache TTL override in milliseconds */
  readonly cacheTtl?: number
}

// ─── Auth Types ─────────────────────────────────────────────

export type GwsAuthStatus = 'connected' | 'disconnected' | 'expired'

export interface GwsConnectionInfo {
  readonly status: GwsAuthStatus
  readonly connectedAs: string | null
  readonly scopes: string[]
}

// ─── Gmail Types ────────────────────────────────────────────

export interface GwsEmail {
  readonly id: string
  readonly threadId: string
  readonly subject: string
  readonly from: string
  readonly date: string
  readonly snippet: string
  readonly isUnread: boolean
  readonly labelIds: string[]
}

export interface GwsEmailDetail {
  readonly id: string
  readonly threadId: string
  readonly subject: string
  readonly from: string
  readonly to: string[]
  readonly cc: string[]
  readonly date: string
  readonly body: string
  readonly isUnread: boolean
  readonly hasAttachments: boolean
}

export interface GwsSendEmailParams {
  readonly to: string
  readonly subject: string
  readonly body: string
  readonly cc?: string
}

// ─── Calendar Types ─────────────────────────────────────────

export interface GwsEvent {
  readonly id: string
  readonly summary: string
  readonly start: string
  readonly end: string
  readonly location: string
  readonly organizer: string
  readonly status: string
  readonly htmlLink: string
}

export interface GwsCreateEventParams {
  readonly summary: string
  readonly start: string
  readonly end: string
  readonly location?: string
  readonly description?: string
}

// ─── Drive Types ────────────────────────────────────────────

export interface GwsDriveFile {
  readonly id: string
  readonly name: string
  readonly mimeType: string
  readonly size: number
  readonly modifiedTime: string
  readonly webViewLink: string
  readonly parents: string[]
}

// ─── Composite Types ────────────────────────────────────────

export interface GwsBriefing {
  readonly unreadEmails: GwsEmail[]
  readonly todayEvents: GwsEvent[]
  readonly recentFiles: GwsDriveFile[]
  readonly timestamp: number
}

// ─── Cache Types ────────────────────────────────────────────

export interface GwsCacheEntry<T = unknown> {
  readonly data: T
  readonly expiresAt: number
  readonly key: string
}

/** TTL in milliseconds per resource type */
export const GWS_CACHE_TTL: Record<string, number> = {
  gmail: 2 * 60_000,
  calendar: 5 * 60_000,
  drive: 5 * 60_000,
  status: 60_000,
}
