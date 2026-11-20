/**
 * Daily activity journal in the vault: what the engine did, in plain Markdown.
 * Same rule as the audit log: never the raw input, which may carry e-mail
 * bodies or amounts into a vault that is often synced to a cloud.
 */
import { appendFileSync, existsSync } from 'node:fs'
import type { AuditRecord, AuditSink } from '../engine/audit'
import { ownedPath, type VaultRoot } from './paths'
import { JOURNAL_DIR, localDate, localTime } from './markdown'

// Keyed by string so new engine decisions degrade to their raw name instead of breaking.
const OUTCOME: Readonly<Record<string, string>> = {
  executed: 'ok',
  'dry-run': 'simulado (dry-run)',
  denied: 'negado pela política',
  invalid: 'entrada inválida',
  unknown: 'tool desconhecido',
}

/** Strip what could turn a log line into Markdown: links, embeds, code spans, HTML. */
function inert(text: string, max: number): string {
  return text.replace(/\s+/g, ' ').replace(/[`[\]|<>!]/g, '').slice(0, max)
}

export function journalLine(record: AuditRecord, when: Date): string {
  const outcome = record.decision === 'executed' && !record.ok ? 'falhou' : OUTCOME[record.decision] ?? record.decision
  // An unknown tool name is caller-controlled text; catalog names are not.
  const tool = record.decision === 'unknown' ? '(desconhecido)' : record.tool.replace(/[^\w.-]/g, '').slice(0, 64)
  // Engine-generated validation text is safe to show; tool failure text may echo input, so it is omitted.
  const detail = record.error && record.decision !== 'executed' && record.decision !== 'unknown'
    ? ` — ${inert(record.error, 200)}`
    : ''
  return `- ${localTime(when)} · \`${tool}\` · ${outcome}${detail}\n`
}

/**
 * Audit sink that appends to `Diário/<date>.md`. Successful reads are skipped:
 * the journal is for following what changed, not every lookup.
 */
export function createJournalSink(
  vault: () => VaultRoot | null,
  isReadOnly: (tool: string) => boolean,
): AuditSink {
  return {
    write(record: AuditRecord): void {
      const vr = vault()
      if (!vr) return
      if (record.decision === 'executed' && record.ok && isReadOnly(record.tool)) return
      const stamped = new Date(record.ts)
      const when = Number.isNaN(stamped.getTime()) ? new Date() : stamped
      appendJournal(vr, when, journalLine(record, when))
    },
  }
}

function journalHeader(when: Date): string {
  return `# Diário smolerclaw — ${localDate(when)}\n\n`
}

/** Append one line to the day's journal file, creating it with a header. Never throws. */
export function appendJournal(vr: VaultRoot, when: Date, line: string): void {
  try {
    const file = ownedPath(vr, `${JOURNAL_DIR}/${localDate(when)}.md`)
    const header = existsSync(file) ? '' : journalHeader(when)
    appendFileSync(file, header + line)
  } catch (err) {
    process.stderr.write(`smolerclaw: journal write failed: ${err instanceof Error ? err.message : String(err)}\n`)
  }
}

/**
 * Create the day's journal with just its header when it does not exist yet,
 * so the panel's embed of it is never a broken link. Never throws.
 */
export function ensureJournal(vr: VaultRoot, when: Date): void {
  appendJournal(vr, when, '')
}

/** Fan one audit record out to several sinks. */
export function teeAudit(...sinks: readonly AuditSink[]): AuditSink {
  return { write: (record) => sinks.forEach((sink) => sink.write(record)) }
}
