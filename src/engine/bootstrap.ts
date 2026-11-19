import { join } from 'node:path'
import { loadConfig } from '../config'
import { initI18n } from '../i18n'
import { engineCatalog, executeToolResult } from '../tools'
import { READ_ONLY_TOOL_NAMES } from '../tools/read-only'
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
 * Boot the engine with real data modules and the personal-management catalog.
 * No model, no credentials: nothing here talks to an LLM provider.
 */
export async function bootstrapEngine(
  env: Record<string, string | undefined> = process.env,
): Promise<EngineRuntime> {
  const config = loadConfig()
  initI18n(config.language)

  await registerToolCatalog(config.dataDir)
  initCoreModules(config.dataDir)

  const policy = policyFromEnv(env)
  const allowedPlugins = new Set(policy.plugins)
  const engine = createEngine({
    catalog: () => engineCatalog(allowedPlugins),
    execute: executeToolResult,
    policy,
    audit: createFileAuditSink(join(config.dataDir, 'audit')),
    isReadOnly: (name) => READ_ONLY_TOOL_NAMES.has(name),
  })

  return { engine, dataDir: config.dataDir }
}
