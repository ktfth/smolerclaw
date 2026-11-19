/**
 * Tool dispatch. Every entry returns a ToolResult; string-returning handlers
 * (workstation primitives, integrations, plugins) go through fromLegacyText.
 */
import { UndoStack } from '../undo'
import { type Plugin, executePlugin } from '../plugins'
import { executePluginTool } from '../plugin-system'
import { fail, fromLegacyText, type CatalogEntry, type ToolResult } from '../core/result'
import { toolReadFile, toolWriteFile, toolEditFile } from './file-tools'
import { toolSearchFiles, toolFindFiles, toolListDirectory } from './search-tools'
import { toolRunCommand } from './command-tools'
import { toolFetchUrl } from './network-tools'
import { INTEGRATION_TOOLS } from './integrations'
import { WORKSTATION_SCHEMAS } from './schemas'
import { DOMAIN_TOOLS } from './domain'
import { InputValidator } from '../engine/validate'

type LegacyRunner = (input: Record<string, unknown>) => string | Promise<string>

const WORKSTATION_READS: ReadonlySet<string> = new Set(['read_file', 'search_files', 'find_files', 'list_directory'])

function legacy(schemas: readonly CatalogEntry['schema'][], runner: (name: string) => LegacyRunner): CatalogEntry[] {
  return schemas.map((schema) => ({
    schema,
    readOnly: WORKSTATION_READS.has(schema.name),
    run: async (input) => fromLegacyText(await runner(schema.name)({ ...input })),
  }))
}

/**
 * Agent primitives (files, shell, HTTP). Only the built-in chat loop gets
 * these: an external agent such as Claude Code already has its own, and
 * exposing a second, differently-policed shell over MCP is pure attack surface.
 */
export function workstationTools(undoStack: UndoStack): CatalogEntry[] {
  const runners: Record<string, LegacyRunner> = {
    read_file: (i) => toolReadFile(i),
    write_file: (i) => toolWriteFile(i, undoStack),
    edit_file: (i) => toolEditFile(i, undoStack),
    search_files: (i) => toolSearchFiles(i),
    find_files: (i) => toolFindFiles(i),
    list_directory: (i) => toolListDirectory(i),
    run_command: (i) => toolRunCommand(i),
    fetch_url: (i) => toolFetchUrl(i),
  }
  return legacy(WORKSTATION_SCHEMAS, (name) => runners[name])
}

export const ENGINE_TOOLS: readonly CatalogEntry[] = [...DOMAIN_TOOLS, ...INTEGRATION_TOOLS]

// Every caller (chat loop included) gets schema validation, not only the engine.
const validator = new InputValidator()

/** Resolve and run a tool. Never throws: handler exceptions become failures. */
export async function dispatchTool(
  entries: ReadonlyMap<string, CatalogEntry>,
  name: string,
  input: Record<string, unknown>,
  plugins: readonly Plugin[],
): Promise<ToolResult> {
  try {
    const entry = entries.get(name)
    if (entry) {
      const check = validator.validate(entry.schema, input)
      if (!check.valid) return fail(`invalid input for "${name}": ${check.errors.join('; ')}`)
      return await entry.run(input)
    }

    const pluginResult = await executePluginTool(name, input)
    if (pluginResult !== null) return fromLegacyText(pluginResult)

    const plugin = plugins.find((p) => p.name === name)
    if (plugin) return fromLegacyText(await executePlugin(plugin, input))

    return fail(`unknown tool "${name}"`)
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err))
  }
}
