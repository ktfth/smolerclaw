/**
 * How edits made in Obsidian come back (pull mode):
 *  - off:  nothing happens until obsidian_sync is run (default)
 *  - ask:  each round reports unsynced edits so the agent can ask the person
 *  - auto: each round pulls them before the tool runs
 * Stored in the vault, so the TUI and the MCP server share it.
 * SMOLERCLAW_OBSIDIAN_PULL overrides it.
 */
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ownedPath, type VaultRoot } from './paths'

export const PULL_MODES = ['off', 'ask', 'auto'] as const
export type PullMode = (typeof PULL_MODES)[number]

export interface PullModeSetting {
  mode: PullMode
  source: 'env' | 'vault' | 'default'
}

const SETTINGS_FILE = '.smolerclaw-settings.json'

export function parsePullMode(raw: unknown): PullMode | null {
  return PULL_MODES.find((m) => m === (typeof raw === 'string' ? raw.trim().toLowerCase() : raw)) ?? null
}

function readSettings(vr: VaultRoot): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(vr.root, SETTINGS_FILE), 'utf-8'))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

export function resolvePullMode(vr: VaultRoot, envValue: string | undefined): PullModeSetting {
  const fromEnv = parsePullMode(envValue)
  if (fromEnv) return { mode: fromEnv, source: 'env' }
  const fromVault = parsePullMode(readSettings(vr).pullMode)
  return fromVault ? { mode: fromVault, source: 'vault' } : { mode: 'off', source: 'default' }
}

export function writePullMode(vr: VaultRoot, mode: PullMode): void {
  const target = ownedPath(vr, SETTINGS_FILE)
  const tmp = `${target}.tmp`
  writeFileSync(tmp, JSON.stringify({ ...readSettings(vr), pullMode: mode }, null, 2))
  renameSync(tmp, target)
}
