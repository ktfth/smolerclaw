import { SessionManager } from '../session'
import { loadSkills, buildSystemPrompt } from '../skills'
import { buildReferenceContext } from '../notes'
import type { loadPlugins } from '../plugins'
import type { loadConfig } from '../config'
import { registerToolCatalog } from './tools'

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

  const plugins = await registerToolCatalog(config.dataDir)

  // Append materials context to system prompt so the AI knows about saved reference materials
  const materialsCtx = buildReferenceContext()
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
