import { SessionManager } from '../session'
import { loadSkills, buildSystemPrompt } from '../skills'
import { buildMaterialsContext } from '../materials'
import { registerWindowsTools, registerPlugins, TOOLS } from '../tools'
import { loadPlugins, pluginsToTools, getPluginDir } from '../plugins'
import { initPluginSystem, getPluginTools } from '../plugin-system'
import { getConfigDir, type loadConfig } from '../config'

export interface SessionSetup {
  sessions: SessionManager
  sessionName: string
  skills: ReturnType<typeof loadSkills>
  systemPrompt: string
  activeSystemPrompt: string
  enableTools: boolean
  plugins: ReturnType<typeof loadPlugins>
}

export async function initSession(
  config: ReturnType<typeof loadConfig>,
  cliSession: string | undefined,
  cliNoTools: boolean,
): Promise<SessionSetup> {
  const sessions = new SessionManager(config.dataDir)
  const sessionName = cliSession || sessions.getLastSession() || 'default'
  if (sessionName !== 'default') sessions.switchTo(sessionName)

  const skills = loadSkills(config.skillsDir)
  const systemPrompt = buildSystemPrompt(config.systemPrompt, skills, config.language)
  const enableTools = !cliNoTools

  // Register Windows/business tools
  registerWindowsTools()

  // Load plugins (legacy JSON)
  const pluginDir = getPluginDir(getConfigDir())
  const plugins = loadPlugins(pluginDir)
  if (plugins.length > 0) {
    registerPlugins(plugins)
    TOOLS.push(...pluginsToTools(plugins))
  }

  // Initialize enhanced plugin system (JSON + script plugins)
  await initPluginSystem(pluginDir, config.dataDir)
  const enhancedTools = getPluginTools()
  // Add script plugin tools that aren't already registered from JSON plugins
  const existingNames = new Set(TOOLS.map((t) => t.name))
  for (const tool of enhancedTools) {
    if (!existingNames.has(tool.name)) {
      TOOLS.push(tool)
    }
  }

  // Append materials context to system prompt so the AI knows about saved reference materials
  const materialsCtx = buildMaterialsContext()
  const activeSystemPrompt = materialsCtx ? `${systemPrompt}\n\n${materialsCtx}` : systemPrompt

  return {
    sessions,
    sessionName,
    skills,
    systemPrompt,
    activeSystemPrompt,
    enableTools,
    plugins,
  }
}
