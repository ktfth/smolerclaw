/**
 * executeTool() dispatch function — routes tool calls to the appropriate handler.
 */
import { UndoStack } from '../undo'
import { type Plugin, executePlugin } from '../plugins'
import { executePluginTool } from '../plugin-system'
import { observeEvent } from '../services/docs-engine'
import { toolReadFile, toolWriteFile, toolEditFile } from './file-tools'
import { toolSearchFiles, toolFindFiles, toolListDirectory } from './search-tools'
import { toolRunCommand } from './command-tools'
import { toolFetchUrl } from './network-tools'
import { executeVaultTool } from './vault-tools'
import { executeMemoryTool } from './memory-tools'
import { executeAgencyTool } from './agency-tools'
import { executeBusinessTool } from './business-tools'

/**
 * Execute a tool and observe the execution for meta-learning.
 */
export async function executeTool(
  name: string,
  input: Record<string, unknown>,
  undoStack: UndoStack,
  plugins: Plugin[],
  sessionManager: { archive: (n: string) => boolean; archiveAll: () => string[]; unarchive: (n: string) => boolean; listArchived: () => string[]; getArchivedInfo: (n: string) => { messageCount: number; updated: number } | null } | null,
): Promise<string> {
  const startTime = performance.now()

  try {
    const result = await executeToolInternal(name, input, undoStack, plugins, sessionManager)

    // Observe tool execution for meta-learning (non-blocking)
    setImmediate(() => {
      observeEvent({
        type: 'tool:executed',
        name,
        input,
        durationMs: Math.round(performance.now() - startTime),
        success: !result.startsWith('Error:'),
      })
    })

    return result
  } catch (err) {
    // Observe failed execution
    setImmediate(() => {
      observeEvent({
        type: 'tool:executed',
        name,
        input,
        durationMs: Math.round(performance.now() - startTime),
        success: false,
      })
    })
    return `Error: ${err instanceof Error ? err.message : String(err)}`
  }
}

async function executeToolInternal(
  name: string,
  input: Record<string, unknown>,
  undoStack: UndoStack,
  plugins: Plugin[],
  sessionManager: { archive: (n: string) => boolean; archiveAll: () => string[]; unarchive: (n: string) => boolean; listArchived: () => string[]; getArchivedInfo: (n: string) => { messageCount: number; updated: number } | null } | null,
): Promise<string> {
  // Core file tools
  switch (name) {
    case 'read_file':
      return toolReadFile(input)
    case 'write_file':
      return toolWriteFile(input, undoStack)
    case 'edit_file':
      return toolEditFile(input, undoStack)
    case 'search_files':
      return await toolSearchFiles(input)
    case 'find_files':
      return await toolFindFiles(input)
    case 'list_directory':
      return toolListDirectory(input)
    case 'run_command':
      return await toolRunCommand(input)
    case 'fetch_url':
      return await toolFetchUrl(input)
  }

  // Vault tools
  const vaultResult = await executeVaultTool(name, input)
  if (vaultResult !== null) return vaultResult

  // Memory tools
  const memResult = executeMemoryTool(name, input)
  if (memResult !== null) return memResult

  // Agency tools
  const agencyResult = await executeAgencyTool(name, input)
  if (agencyResult !== null) return agencyResult

  // Business tools (all the rest)
  const bizResult = await executeBusinessTool(name, input, sessionManager)
  if (bizResult !== null) return bizResult

  // Check enhanced plugin system first (supports both JSON and script plugins)
  const pluginResult = await executePluginTool(name, input)
  if (pluginResult !== null) return pluginResult

  // Fallback: legacy JSON plugins passed as parameter
  const plugin = plugins.find((p) => p.name === name)
  if (plugin) return await executePlugin(plugin, input)

  return `Error: unknown tool "${name}"`
}
