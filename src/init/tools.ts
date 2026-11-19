import { registerWindowsTools, registerPlugins, TOOLS } from '../tools'
import { loadPlugins, pluginsToTools, getPluginDir } from '../plugins'
import { initPluginSystem, getPluginTools } from '../plugin-system'
import { getConfigDir } from '../config'

/**
 * Register the full tool catalog: built-in, Windows/business, legacy JSON
 * plugins and enhanced plugins. Shared by the chat modes and the engine.
 * Returns the legacy plugins so callers can hand them to the TUI.
 */
export async function registerToolCatalog(dataDir: string): Promise<ReturnType<typeof loadPlugins>> {
  registerWindowsTools()

  const pluginDir = getPluginDir(getConfigDir())
  const plugins = loadPlugins(pluginDir)
  if (plugins.length > 0) {
    registerPlugins(plugins)
    TOOLS.push(...pluginsToTools(plugins))
  }

  await initPluginSystem(pluginDir, dataDir)
  const existingNames = new Set(TOOLS.map((t) => t.name))
  for (const tool of getPluginTools()) {
    if (!existingNames.has(tool.name)) {
      TOOLS.push(tool)
    }
  }

  return plugins
}
