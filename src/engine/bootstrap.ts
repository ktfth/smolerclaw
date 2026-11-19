import { join } from 'node:path'
import { loadConfig } from '../config'
import { initI18n } from '../i18n'
import { SessionManager } from '../session'
import { TOOLS, executeTool } from '../tools'
import { registerToolCatalog } from '../init/tools'
import { initCoreModules } from '../init/modules'
import { createEngine, type Engine } from './engine'
import { policyFromEnv } from './policy'
import { createFileAuditSink } from './audit'

export interface EngineRuntime {
  engine: Engine
  dataDir: string
}

/**
 * Boot the engine with real data modules and the full tool catalog.
 * No model, no credentials: nothing here talks to an LLM provider.
 */
export async function bootstrapEngine(
  env: Record<string, string | undefined> = process.env,
): Promise<EngineRuntime> {
  const config = loadConfig()
  initI18n(config.language)

  const sessions = new SessionManager(config.dataDir)
  await registerToolCatalog(config.dataDir)
  initCoreModules(config.dataDir, sessions)

  const engine = createEngine({
    catalog: () => TOOLS,
    execute: executeTool,
    policy: policyFromEnv(env),
    audit: createFileAuditSink(join(config.dataDir, 'audit')),
  })

  return { engine, dataDir: config.dataDir }
}
