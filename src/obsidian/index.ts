/**
 * Obsidian mirror: module state and the hooks the rest of the app calls.
 * Disabled unless SMOLERCLAW_OBSIDIAN_VAULT (or config `obsidianVault`) is set.
 */
import { ownedPath, resolveVault, type VaultRoot } from './paths'
import { push } from './sync'
import { INBOX_DIR } from './markdown'

export { push, pull, sync, status } from './sync'
export { createJournalSink, teeAudit } from './journal'
export type { VaultRoot } from './paths'

/** The vault to mirror: SMOLERCLAW_OBSIDIAN_VAULT wins over config `obsidianVault`. */
export function obsidianSetting(env: Record<string, string | undefined>, config: { obsidianVault: string }): string {
  return env.SMOLERCLAW_OBSIDIAN_VAULT?.trim() || config.obsidianVault
}

let _vault: VaultRoot | null = null
let _error: string | null = null

const warn = (msg: string): void => {
  process.stderr.write(`smolerclaw: obsidian: ${msg}\n`)
}

/** Configure the mirror and project the current state once. Empty path disables it. */
export function initObsidian(rawPath: string | undefined): void {
  _vault = null
  _error = null
  if (!rawPath?.trim()) return
  const check = resolveVault(rawPath)
  if (!check.ok) {
    _error = check.error
    warn(check.error)
    return
  }
  _vault = check.value
  try {
    // The README promises an Inbox; create it so it is there to drop files into.
    ownedPath(_vault, `${INBOX_DIR}/.keep`)
  } catch (err) {
    warn(err instanceof Error ? err.message : String(err))
  }
  refreshObsidian()
}

export function obsidianVault(): VaultRoot | null {
  return _vault
}

/** Why the mirror is off, when it was configured but rejected. */
export function obsidianError(): string | null {
  return _error
}

/** Re-project after a write. Never throws: the vault is a view, not a dependency. */
export function refreshObsidian(): void {
  if (!_vault) return
  try {
    const report = push(_vault)
    for (const error of report.errors) warn(error)
  } catch (err) {
    warn(err instanceof Error ? err.message : String(err))
  }
}

