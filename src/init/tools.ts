import { registerPlugins, TOOLS } from '../tools'
import { loadPlugins, pluginsToTools, getPluginDir } from '../plugins'
import { initPluginSystem, getPluginTools } from '../plugin-system'
import { getConfigDir } from '../config'

let _registered: ReturnType<typeof loadPlugins> | null = null

/**
 * Append plugin tools (legacy JSON and enhanced plugins) to the catalog.
 * Shared by the chat modes and the engine. Idempotent. Returns the legacy
 * plugins so callers can hand them to the TUI.
 */
export async function registerToolCatalog(dataDir: string): Promise<ReturnType<typeof loadPlugins>> {
  if (_registered) return _registered

  const pluginDir = getPluginDir(getConfigDir())
  const plugins = loadPlugins(pluginDir)
  const existingNames = new Set(TOOLS.map((t) => t.name))
  if (plugins.length > 0) {
    registerPlugins(plugins)
    for (const tool of pluginsToTools(plugins)) {
      if (!existingNames.has(tool.name)) {
        TOOLS.push(tool)
        existingNames.add(tool.name)
      }
    }
  }

  await initPluginSystem(pluginDir, dataDir)
  for (const tool of getPluginTools()) {
    if (!existingNames.has(tool.name)) {
      TOOLS.push(tool)
      existingNames.add(tool.name)
    }
  }

  _registered = plugins
  return plugins
}
