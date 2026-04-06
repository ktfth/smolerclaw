/**
 * GWS Integration — barrel exports.
 *
 * Google Workspace CLI integration for smolerclaw.
 * Provides intelligent wrapper around the gws CLI with caching,
 * parallel fetching, composite actions, and dashboard panels.
 */

// Auth
export {
  gwsSetup, gwsSetupGuided, gwsLogin, gwsLogout, getGwsStatus, isGwsConnected,
  getCachedGwsStatus, formatGwsStatus, hasClientSecret, getClientSecretPath,
  getAccessToken,
} from './auth'

// Executor
export { checkGwsInstalled, executeGws, executeGwsStreaming, resetGwsCheck, resetCredentialCache, setInjectedToken } from './executor'

// Cache
export { gwsCacheClear, gwsCacheStats } from './cache'

// Gmail
export {
  listGmailMessages, getGmailMessage, sendGmailMessage,
  formatGmailList,
} from './gmail'

// Calendar
export {
  listCalendarEvents, createCalendarEvent,
  formatCalendarEventList,
} from './calendar'

// Drive
export { listDriveFiles, searchDriveFiles, formatDriveFileList } from './drive'

// Composite
export { gwsBriefing, gwsDashboard, gwsSearch } from './composite'

// Tools (Claude integration)
export { GWS_TOOLS, executeGwsTool } from './tools'

// Commands (TUI integration)
export { handleGwsCommand } from './commands'

// Types
export type {
  GwsResult, GwsAuthStatus, GwsConnectionInfo,
  GwsEmail, GwsEmailDetail, GwsSendEmailParams,
  GwsEvent, GwsCreateEventParams,
  GwsDriveFile, GwsBriefing,
} from './types'
