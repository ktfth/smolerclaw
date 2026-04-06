/**
 * M365 Integration — barrel exports.
 *
 * Microsoft 365 CLI integration for smolerclaw.
 * Provides intelligent wrapper around the m365 CLI with caching,
 * parallel fetching, and composite actions.
 */

// Auth
export {
  m365Login, m365Logout, getM365Status, isM365Connected,
  getCachedM365Status, formatM365Status, getConsentUrl,
} from './auth'

// Executor
export { checkM365Installed, executeM365, executeM365Streaming, resetM365Check } from './executor'

// Cache
export { cacheClear, cacheStats } from './cache'

// Outlook
export {
  listEmails, getEmail, sendEmail,
  listEvents, createEvent,
  listContacts,
  formatEmailList, formatEventList, formatContactList,
} from './outlook'

// To Do
export {
  listTodoTasks, listTodoLists, createTodo, completeTodo,
  formatTodoList, formatTodoLists,
} from './todo'

// OneDrive
export { listFiles, formatFileList } from './onedrive'

// OneNote
export { listNotebooks, listPages, formatNotebookList, formatPageList } from './onenote'

// Composite
export { m365Briefing, m365Digest, m365Search } from './composite'

// Tools (Claude integration)
export { M365_TOOLS, executeM365Tool } from './tools'

// Commands (TUI integration)
export { handleM365Command } from './commands'

// Types
export type {
  M365Result, M365AuthStatus, M365ConnectionInfo,
  M365Email, M365EmailDetail, M365SendEmailParams,
  M365Event, M365CreateEventParams,
  M365Contact, M365TodoList, M365TodoTask, M365CreateTodoParams,
  M365DriveItem, M365Notebook, M365OneNotePage,
  M365Briefing, M365Digest,
} from './types'
