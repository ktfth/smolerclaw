/**
 * Tool catalog and dispatch.
 *
 * Two views over one registry:
 *  - TOOLS: everything the built-in chat loop may call (workstation
 *    primitives + personal-management catalog + plugins).
 *  - engineCatalog(): what the deterministic engine exposes over CLI/MCP
 *    (personal-management catalog; plugins only when allow-listed).
 */
import type Anthropic from '@anthropic-ai/sdk'
import type { Plugin } from '../plugins'
import { UndoStack } from '../undo'
import { toChatText, type CatalogEntry, type ToolResult } from '../core/result'
import { dispatchTool, workstationTools, ENGINE_TOOLS } from './execute'
import { NOTE_TOOLS } from './domain/notes'
import { TASK_TOOLS } from './domain/tasks'
import { checkObsidianBeforeTool, refreshObsidian } from '../obsidian'

// Global undo stack shared across file-editing tool calls
export const undoStack = new UndoStack()

const WORKSTATION = workstationTools(undoStack)
const WORKSTATION_NAMES: ReadonlySet<string> = new Set(WORKSTATION.map((t) => t.schema.name))
const ENTRIES: ReadonlyMap<string, CatalogEntry> = new Map(
  [...WORKSTATION, ...ENGINE_TOOLS].map((t) => [t.schema.name, t]),
)

/**
 * Schemas offered to the chat model. Mutable on purpose: plugin tools are
 * appended at startup by registerToolCatalog.
 */
export const TOOLS: Anthropic.Tool[] = [...WORKSTATION, ...ENGINE_TOOLS].map((t) => t.schema)

// Registered legacy JSON plugins (set at startup)
let _plugins: Plugin[] = []
export function registerPlugins(plugins: Plugin[]): void {
  _plugins = plugins
}

/** Note and task tools: they read or change what the Obsidian mirror shows. */
const MIRRORED = [...NOTE_TOOLS, ...TASK_TOOLS]
const MIRRORED_TOOLS: ReadonlySet<string> = new Set(MIRRORED.map((t) => t.schema.name))
const MIRRORED_WRITES: ReadonlySet<string> = new Set(MIRRORED.filter((t) => !t.readOnly).map((t) => t.schema.name))

const ENGINE_NAMES: ReadonlySet<string> = new Set(ENGINE_TOOLS.map((t) => t.schema.name))

/**
 * Engine view: the personal-management catalog. Plugin tools run arbitrary
 * commands, so they are included only when named in `allowedPlugins`.
 */
export function engineCatalog(allowedPlugins: ReadonlySet<string> = new Set()): Anthropic.Tool[] {
  return TOOLS.filter((t) => ENGINE_NAMES.has(t.name) || (!WORKSTATION_NAMES.has(t.name) && allowedPlugins.has(t.name)))
}

/**
 * Run a tool and return its structured outcome. Note and task tools first
 * check the Obsidian mirror for unsynced edits (per its pull mode), and
 * writes refresh it afterwards.
 */
export async function executeToolResult(name: string, input: Record<string, unknown>): Promise<ToolResult> {
  const notice = MIRRORED_TOOLS.has(name) ? checkObsidianBeforeTool() : null
  const result = await dispatchTool(ENTRIES, name, input, _plugins)
  if (result.ok && MIRRORED_WRITES.has(name)) refreshObsidian()
  return notice ? { ...result, text: `${result.text}\n\n${notice}` } : result
}

/** Chat-loop entry point: failures are rendered with the "Error:" prefix. */
export async function executeTool(name: string, input: Record<string, unknown>): Promise<string> {
  return toChatText(await executeToolResult(name, input))
}

export { DOMAIN_TOOLS } from './domain'
