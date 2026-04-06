/**
 * Tool module barrel — re-exports everything to maintain backward compatibility.
 *
 * All consumers that import from './tools' will continue to work exactly the same
 * since this file preserves the original API surface.
 */
import type { Plugin } from '../plugins'
import { UndoStack } from '../undo'
import { IS_WINDOWS } from '../platform'
import { TOOLS } from './schemas'
import {
  WINDOWS_TOOLS, AGENT_TOOLS, NOTIFICATION_TOOLS, NEWS_TOOL,
} from './windows-tools'
import {
  TASK_TOOLS, SCHEDULER_TOOLS, PEOPLE_TOOLS, MEMO_TOOLS, EMAIL_TOOL,
  TIER2_TOOLS, INVESTIGATE_TOOLS, MATERIAL_TOOLS, PROJECT_TOOLS,
  PITWALL_TOOLS, BLAST_RADIUS_TOOLS, DECISION_ENGINE_TOOLS,
  NEWSFEED_TOOLS, ARCHIVE_TOOLS, META_LEARNING_TOOLS,
  RECOMMENDATION_TOOLS, NEIGHBORHOOD_TOOLS, ENERGY_TOOLS,
} from './business-tools'
import { VAULT_TOOLS } from './vault-tools'
import { MEMORY_TOOLS } from './memory-tools'
import { AGENCY_TOOLS } from './agency-tools'
import { M365_TOOLS } from '../m365'
import { GWS_TOOLS } from '../gws'
import { executeTool as _executeTool } from './execute'

// ─── Global shared state ─────────────────────────────────────

// Global undo stack shared across tool calls
export const undoStack = new UndoStack()

// Registered plugins (set from index.ts at startup)
let _plugins: Plugin[] = []
export function registerPlugins(plugins: Plugin[]): void {
  _plugins = plugins
}

// SessionManager reference for archive tools
let _sessionManager: {
  archive: (n: string) => boolean
  archiveAll: () => string[]
  unarchive: (n: string) => boolean
  listArchived: () => string[]
  getArchivedInfo: (n: string) => { messageCount: number; updated: number } | null
} | null = null

export function registerSessionManager(sm: typeof _sessionManager): void {
  _sessionManager = sm
}

let _windowsToolsRegistered = false

/** Register Windows tools and task tools. Idempotent. */
export function registerWindowsTools(): void {
  if (_windowsToolsRegistered) return
  _windowsToolsRegistered = true

  if (IS_WINDOWS) {
    TOOLS.push(...WINDOWS_TOOLS)
    TOOLS.push(...AGENT_TOOLS)
    TOOLS.push(...NOTIFICATION_TOOLS)
  } else {
    // Add get_news on all platforms (it's network-only)
    TOOLS.push(NEWS_TOOL)
  }

  // Task, people, memo, and email tools are cross-platform
  TOOLS.push(...TASK_TOOLS)
  TOOLS.push(...SCHEDULER_TOOLS)
  TOOLS.push(...PEOPLE_TOOLS)
  TOOLS.push(...MEMO_TOOLS)
  TOOLS.push(EMAIL_TOOL)
  TOOLS.push(...TIER2_TOOLS)
  TOOLS.push(...INVESTIGATE_TOOLS)
  TOOLS.push(...MATERIAL_TOOLS)
  TOOLS.push(...MEMORY_TOOLS)
  TOOLS.push(...NEWSFEED_TOOLS)
  TOOLS.push(...VAULT_TOOLS)
  TOOLS.push(...PROJECT_TOOLS)
  TOOLS.push(...PITWALL_TOOLS)
  TOOLS.push(...BLAST_RADIUS_TOOLS)
  TOOLS.push(...ARCHIVE_TOOLS)
  TOOLS.push(...DECISION_ENGINE_TOOLS)
  TOOLS.push(...META_LEARNING_TOOLS)
  TOOLS.push(...AGENCY_TOOLS)
  TOOLS.push(...RECOMMENDATION_TOOLS)
  TOOLS.push(...NEIGHBORHOOD_TOOLS)
  TOOLS.push(...ENERGY_TOOLS)
  TOOLS.push(...M365_TOOLS)
  TOOLS.push(...GWS_TOOLS)
}

// ─── executeTool wrapper (preserves original signature) ──────

/**
 * Execute a tool by name. This wrapper captures the shared state (undoStack, plugins,
 * sessionManager) and delegates to the modular execute.ts dispatcher.
 */
export async function executeTool(
  name: string,
  input: Record<string, unknown>,
): Promise<string> {
  return _executeTool(name, input, undoStack, _plugins, _sessionManager)
}

// ─── Re-exports ──────────────────────────────────────────────

export { TOOLS } from './schemas'

// Schema arrays (for consumers that reference them directly)
export {
  WINDOWS_TOOLS, AGENT_TOOLS, NOTIFICATION_TOOLS, NEWS_TOOL,
} from './windows-tools'
export {
  TASK_TOOLS, SCHEDULER_TOOLS, PEOPLE_TOOLS, MEMO_TOOLS, EMAIL_TOOL,
  TIER2_TOOLS, INVESTIGATE_TOOLS, MATERIAL_TOOLS, PROJECT_TOOLS,
  PITWALL_TOOLS, BLAST_RADIUS_TOOLS, DECISION_ENGINE_TOOLS,
  NEWSFEED_TOOLS, ARCHIVE_TOOLS, META_LEARNING_TOOLS,
  RECOMMENDATION_TOOLS, NEIGHBORHOOD_TOOLS, ENERGY_TOOLS,
} from './business-tools'
export { VAULT_TOOLS } from './vault-tools'
export { MEMORY_TOOLS } from './memory-tools'
export { AGENCY_TOOLS } from './agency-tools'
export { M365_TOOLS } from '../m365'
export { GWS_TOOLS } from '../gws'
