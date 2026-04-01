import { SessionManager } from '../session'
import { loadSkills, buildSystemPrompt } from '../skills'
import { buildMaterialsContext } from '../materials'
import { registerWindowsTools, registerPlugins, TOOLS } from '../tools'
import { loadPlugins, pluginsToTools, getPluginDir } from '../plugins'
import { join } from 'node:path'
import type { loadConfig } from '../config'

export interface SessionSetup {
  sessions: SessionManager
  sessionName: string
  skills: ReturnType<typeof loadSkills>
  systemPrompt: string
  activeSystemPrompt: string
  enableTools: boolean
  plugins: ReturnType<typeof loadPlugins>
}

export function initSession(
  config: ReturnType<typeof loadConfig>,
  cliSession: string | undefined,
  cliNoTools: boolean,
): SessionSetup {
  const sessions = new SessionManager(config.dataDir)
  const sessionName = cliSession || sessions.getLastSession() || 'default'
  if (sessionName !== 'default') sessions.switchTo(sessionName)

  const skills = loadSkills(config.skillsDir)
  const systemPrompt = buildSystemPrompt(config.systemPrompt, skills, config.language)
  const enableTools = !cliNoTools

  // Register Windows/business tools
  registerWindowsTools()

  // Load plugins
  const pluginDir = getPluginDir(join(config.dataDir, '..'))
  const plugins = loadPlugins(pluginDir)
  if (plugins.length > 0) {
    registerPlugins(plugins)
    TOOLS.push(...pluginsToTools(plugins))
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
