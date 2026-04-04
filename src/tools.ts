/**
 * Forwarding module — re-exports the modular tools/ directory.
 *
 * All original imports from './tools' continue to work because this file
 * re-exports the full API surface from the new modular structure.
 */
export {
  undoStack,
  registerPlugins,
  registerSessionManager,
  registerWindowsTools,
  executeTool,
  TOOLS,
  WINDOWS_TOOLS,
  AGENT_TOOLS,
  NOTIFICATION_TOOLS,
  NEWS_TOOL,
  TASK_TOOLS,
  SCHEDULER_TOOLS,
  PEOPLE_TOOLS,
  MEMO_TOOLS,
  EMAIL_TOOL,
  TIER2_TOOLS,
  INVESTIGATE_TOOLS,
  MATERIAL_TOOLS,
  PROJECT_TOOLS,
  PITWALL_TOOLS,
  BLAST_RADIUS_TOOLS,
  DECISION_ENGINE_TOOLS,
  NEWSFEED_TOOLS,
  ARCHIVE_TOOLS,
  META_LEARNING_TOOLS,
  VAULT_TOOLS,
  MEMORY_TOOLS,
  AGENCY_TOOLS,
  NEIGHBORHOOD_TOOLS,
  ENERGY_TOOLS,
} from './tools/index'
