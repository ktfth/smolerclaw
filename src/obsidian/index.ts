/**
 * Obsidian mirror: module state and the hooks the rest of the app calls.
 * Disabled unless SMOLERCLAW_OBSIDIAN_VAULT (or config `obsidianVault`) is set.
 */
import { ownedPath, resolveVault, type VaultRoot } from './paths'
import { pendingChanges, pull, push, type PullReport } from './sync'
import { INBOX_DIR, localTime } from './markdown'
import { appendJournal } from './journal'
import { parsePullMode, resolvePullMode, type PullMode, type PullModeSetting } from './mode'

export { push, pull, sync, status, pendingChanges } from './sync'
export { createJournalSink, teeAudit } from './journal'
export { PULL_MODES, parsePullMode, writePullMode, type PullMode, type PullModeSetting } from './mode'
export type { VaultRoot } from './paths'

const NOTICE_LIST_MAX = 5

/** The vault to mirror: SMOLERCLAW_OBSIDIAN_VAULT wins over config `obsidianVault`. */
export function obsidianSetting(env: Record<string, string | undefined>, config: { obsidianVault: string }): string {
  return env.SMOLERCLAW_OBSIDIAN_VAULT?.trim() || config.obsidianVault
}

let _vault: VaultRoot | null = null
let _error: string | null = null
let _envPull: PullMode | null = null
/** Last pending set announced in "ask" mode, so the same edits are announced once. */
let _announced = ''

const warn = (msg: string): void => {
  process.stderr.write(`smolerclaw: obsidian: ${msg}\n`)
}

/**
 * Configure the mirror and project the current state once. Empty path disables it.
 * `envPull` is SMOLERCLAW_OBSIDIAN_PULL, which overrides the mode stored in the vault.
 */
export function initObsidian(rawPath: string | undefined, envPull?: string): void {
  _vault = null
  _error = null
  _announced = ''
  _envPull = parsePullMode(envPull)
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

export function obsidianPullMode(vr: VaultRoot): PullModeSetting {
  return resolvePullMode(vr, _envPull ?? undefined)
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

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`
}

function describePull(report: PullReport): string[] {
  return [
    report.updated.length ? plural(report.updated.length, 'nota atualizada', 'notas atualizadas') : '',
    report.created.length ? plural(report.created.length, 'nota criada pela Inbox', 'notas criadas pela Inbox') : '',
    report.deleted.length ? plural(report.deleted.length, 'nota apagada', 'notas apagadas') : '',
    report.completed.length ? plural(report.completed.length, 'tarefa concluída', 'tarefas concluídas') : '',
    report.tasksCreated.length ? plural(report.tasksCreated.length, 'tarefa criada', 'tarefas criadas') : '',
    report.conflicts.length ? plural(report.conflicts.length, 'conflito', 'conflitos') : '',
  ].filter(Boolean)
}

function autoPull(vr: VaultRoot): string | null {
  const now = new Date()
  const report = pull(vr, { now })
  const pushed = push(vr, now)
  for (const error of [...report.errors, ...pushed.errors]) warn(error)
  const applied = describePull(report)
  if (!applied.length) return null
  const summary = applied.join(', ')
  appendJournal(vr, now, `- ${localTime(now)} · sync automático do Obsidian · ${summary}\n`)
  return `[obsidian] Sincronizado automaticamente antes desta chamada: ${summary}.`
}

function askNotice(pending: readonly string[]): string | null {
  const key = pending.join('|')
  if (key === _announced) return null
  _announced = key
  const shown = pending.slice(0, NOTICE_LIST_MAX).join(', ')
  const more = pending.length > NOTICE_LIST_MAX ? ` e mais ${pending.length - NOTICE_LIST_MAX}` : ''
  return (
    `[obsidian] ${plural(pending.length, 'alteração no vault ainda não sincronizada', 'alterações no vault ainda não sincronizadas')}: ` +
    `${shown}${more}. Pergunte ao usuário se deve rodar obsidian_sync agora ` +
    '(ou obsidian_mode com pull "auto" para sincronizar sempre).'
  )
}

/**
 * The per-round check, run before every note or task tool. Cheap: it reads a
 * file only when its mtime changed. Returns a line to append to the tool's
 * result, or null. Never throws.
 */
export function checkObsidianBeforeTool(): string | null {
  const vr = _vault
  if (!vr) return null
  try {
    const { mode } = obsidianPullMode(vr)
    if (mode === 'off') return null
    const { edits, inbox } = pendingChanges(vr)
    const pending = [...edits, ...inbox]
    if (!pending.length) {
      _announced = ''
      return null
    }
    return mode === 'auto' ? autoPull(vr) : askNotice(pending)
  } catch (err) {
    warn(err instanceof Error ? err.message : String(err))
    return null
  }
}
