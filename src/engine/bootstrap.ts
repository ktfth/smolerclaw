import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { loadConfig } from '../config'
import { initI18n } from '../i18n'
import { engineCatalog, executeToolResult } from '../tools'
import { READ_ONLY_TOOL_NAMES, DESTRUCTIVE_TOOL_NAMES, OPEN_WORLD_TOOL_NAMES } from '../tools/read-only'
import { checkRateLimit } from '../tool-safety'
import { registerToolCatalog } from '../init/tools'
import { initCoreModules } from '../init/modules'
import { closeStore } from '../core/store'
import { createEngine, type Engine } from './engine'
import { policyFromEnv, type EnginePolicy } from './policy'
import { createFileAuditSink, type AuditSink } from './audit'
import { describeCall } from '../obsidian/describe'
import { createJournalSink, obsidianSetting, obsidianVault, teeAudit } from '../obsidian'

const DEFAULT_TIMEOUT_MS = 60_000

export interface BootstrapOptions {
  env?: Record<string, string | undefined>
  dataDir?: string
  caller?: string
  runId?: string
  dryRun?: boolean
  timeoutMs?: number
}

export interface EngineRuntime {
  engine: Engine
  policy: EnginePolicy
  audit: AuditSink
  dataDir: string
  runId: string
  caller?: string
  dryRun: boolean
  /** Release open resources (SQLite connections) on shutdown. */
  dispose: () => void
}

function resolveTimeoutMs(explicit: number | undefined, rawEnv: string | undefined): number {
  if (typeof explicit === 'number' && Number.isFinite(explicit) && explicit >= 0) return explicit
  if (rawEnv !== undefined && rawEnv.trim() !== '') {
    const parsed = Number(rawEnv)
    if (Number.isFinite(parsed) && parsed >= 0) return parsed
  }
  return DEFAULT_TIMEOUT_MS
}

/**
 * Boot the engine with real data modules and the personal-management catalog.
 * No model, no credentials: nothing here talks to an LLM provider.
 */
export async function bootstrapEngine(
  envOrOptions: Record<string, string | undefined> | BootstrapOptions = process.env,
): Promise<EngineRuntime> {
  const opts: BootstrapOptions = isBootstrapOptions(envOrOptions) ? envOrOptions : { env: envOrOptions }
  const baseEnv = opts.env ?? process.env
  const effectiveEnv = opts.dataDir ? { ...baseEnv, SMOLERCLAW_DATA_DIR: opts.dataDir } : baseEnv

  const config = loadConfig(effectiveEnv)
  initI18n(config.language)

  await registerToolCatalog(config.dataDir)
  initCoreModules(config.dataDir, obsidianSetting(effectiveEnv, config), effectiveEnv.SMOLERCLAW_OBSIDIAN_PULL)

  const policy = policyFromEnv(effectiveEnv)
  const allowedPlugins = new Set(policy.plugins)
  const audit = teeAudit(
    createFileAuditSink(join(config.dataDir, 'audit')),
    createJournalSink(obsidianVault, (name) => READ_ONLY_TOOL_NAMES.has(name)),
  )
  const runId = opts.runId ?? effectiveEnv.SMOLERCLAW_RUN_ID?.trim() ?? randomUUID().slice(0, 12)
  const dryRun = opts.dryRun ?? effectiveEnv.SMOLERCLAW_DRY_RUN === '1'
  const timeoutMs = resolveTimeoutMs(opts.timeoutMs, effectiveEnv.SMOLERCLAW_TIMEOUT_MS)

  const engine = createEngine({
    catalog: () => engineCatalog(allowedPlugins),
    execute: executeToolResult,
    policy,
    audit,
    isReadOnly: (name) => READ_ONLY_TOOL_NAMES.has(name),
    isDestructive: (name) => DESTRUCTIVE_TOOL_NAMES.has(name),
    isOpenWorld: (name) => OPEN_WORLD_TOOL_NAMES.has(name),
    runId,
    caller: opts.caller,
    dryRun,
    timeoutMs,
    checkRateLimit,
    describe: describeCall,
  })

  return {
    engine,
    policy,
    audit,
    dataDir: config.dataDir,
    runId,
    caller: opts.caller,
    dryRun,
    dispose: () => {
      closeStore()
    },
  }
}

function isBootstrapOptions(value: Record<string, string | undefined> | BootstrapOptions): value is BootstrapOptions {
  return (
    'env' in value ||
    'dataDir' in value ||
    'caller' in value ||
    'runId' in value ||
    'dryRun' in value ||
    'timeoutMs' in value
  )
}
