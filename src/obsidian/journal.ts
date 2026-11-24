/**
 * Daily activity journal in the vault: what the engine did, in plain Markdown.
 * Same rule as the audit log: never the raw input, which may carry e-mail
 * bodies or amounts into a vault that is often synced to a cloud.
 */
import { appendFileSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import type { AuditRecord, AuditSink } from '../engine/audit'
import { ownedPath, type VaultRoot } from './paths'
import { JOURNAL_DIR, localDate, localTime, weekdayDate } from './markdown'
import { describeTool } from './describe'

/** Strip what could turn engine text into Markdown: links, embeds, code spans, HTML. */
function inert(text: string, max: number): string {
  return text.replace(/\s+/g, ' ').replace(/[`[\]|<>!]/g, '').slice(0, max)
}

/** Escape a title so it reads as typed: "[P0]" stays visible instead of vanishing or linking. */
function escapeMarkdown(text: string, max: number): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, max).replace(/[\\`*_[\]|<>!#~=%$]/g, '\\$&')
}

/** What happened, in words, when the call did not succeed. */
function failureText(record: AuditRecord, tool: string): string {
  // Engine-generated validation text is safe to show; tool failure text may echo input, so it is omitted.
  const detail = record.error ? ` — ${inert(record.error, 200)}` : ''
  switch (record.decision) {
    case 'executed': return `⚠️ Falhou ao executar \`${tool}\``
    case 'denied': return `🚫 Bloqueado pela política: \`${tool}\``
    case 'invalid': return `⚠️ Pedido inválido para \`${tool}\`${detail}`
    case 'unknown': return '⚠️ Pedido para uma ferramenta desconhecida'
    default: return `\`${tool}\`: ${String(record.decision)}`
  }
}

export function journalLine(record: AuditRecord, when: Date): string {
  // An unknown tool name is caller-controlled text; catalog names are not.
  const tool = record.decision === 'unknown' ? 'desconhecido' : record.tool.replace(/[^\w.-]/g, '').slice(0, 64)
  const hhmm = localTime(when).slice(0, 5)
  const what = record.decision === 'dry-run'
    ? `Simulou \`${tool}\` sem executar (dry-run)`
    : record.ok
      ? (record.summary ? escapeMarkdown(record.summary, 200) : describeTool(tool) ?? `Executou \`${tool}\``)
      : failureText(record, tool)
  // The tool name stays in a hidden comment: invisible when reading, still searchable.
  return `- **${hhmm}** ${what} %%${tool}%%\n`
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
  return [
    `# Diário — ${weekdayDate(when)}`,
    '',
    '> O que o smolerclaw fez neste dia: o que foi criado, concluído ou alterado, e o que falhou. Consultas não aparecem.',
    '',
    '',
  ].join('\n')
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

// ─── Older journals ─────────────────────────────────────────

const OLD_HEADER = /^# Diário smolerclaw — (\d{4})-(\d{2})-(\d{2})\n\n/
const OLD_LINE = /^- (\d{2}):(\d{2}):\d{2} · `([\w.()-]+)` · (ok|falhou|negado pela política|entrada inválida|simulado \(dry-run\)|tool desconhecido)(?: — (.*))?$/
const OLD_AUTO_SYNC = /^- (\d{2}):(\d{2}):\d{2} · sync automático do Obsidian · (.*)$/
const OLD_OUTCOME: Readonly<Record<string, Pick<AuditRecord, 'decision' | 'ok'>>> = {
  ok: { decision: 'executed', ok: true },
  falhou: { decision: 'executed', ok: false },
  'negado pela política': { decision: 'denied', ok: false },
  'entrada inválida': { decision: 'invalid', ok: false },
  'simulado (dry-run)': { decision: 'dry-run', ok: true },
  'tool desconhecido': { decision: 'unknown', ok: false },
}

function upgradeLine(line: string, day: Date): string {
  const at = (h: string, m: string): Date => new Date(day.getFullYear(), day.getMonth(), day.getDate(), Number(h), Number(m))
  const sync = OLD_AUTO_SYNC.exec(line)
  if (sync) return `- **${sync[1]}:${sync[2]}** Trouxe edições do Obsidian: ${sync[3]} %%sync-automatico%%`
  const old = OLD_LINE.exec(line)
  if (!old) return line
  const [, h, m, tool, outcome, detail] = old
  const record: AuditRecord = {
    ts: at(h, m).toISOString(), tool: tool === '(desconhecido)' ? 'desconhecido' : tool, inputHash: '', risk: 'n/a', durationMs: 0,
    ...OLD_OUTCOME[outcome], ...(detail ? { error: detail } : {}),
  }
  return journalLine(record, at(h, m)).trimEnd()
}

/**
 * Rewrite journals written in the old terse format ("`tool` · ok") into the
 * readable one. Only lines in the old format change; anything typed by hand
 * stays. Older lines lack the call's data, so they get the generic sentence.
 */
export function upgradeJournals(vr: VaultRoot): string[] {
  const upgraded: string[] = []
  try {
    const dir = ownedPath(vr, JOURNAL_DIR)
    if (!existsSync(dir)) return upgraded
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue
      const file = ownedPath(vr, `${JOURNAL_DIR}/${entry.name}`)
      const text = readFileSync(file, 'utf-8').replace(/\r\n/g, '\n')
      const header = OLD_HEADER.exec(text)
      if (!header) continue
      const day = new Date(Number(header[1]), Number(header[2]) - 1, Number(header[3]))
      const body = text.slice(header[0].length).split('\n').map((line) => upgradeLine(line, day)).join('\n')
      writeFileSync(file, journalHeader(day) + body)
      upgraded.push(`${JOURNAL_DIR}/${entry.name}`)
    }
  } catch (err) {
    process.stderr.write(`smolerclaw: journal upgrade failed: ${err instanceof Error ? err.message : String(err)}\n`)
  }
  return upgraded
}
