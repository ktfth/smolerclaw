/**
 * TUI commands that go through the deterministic engine: the same pipeline
 * as MCP and the CLI (validation → policy → execution → audit), so what is
 * done by hand lands in the audit log, the vault journal and the vault.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { wireEngine, type EngineRuntime } from '../engine/bootstrap'
import type { InvokeResult, ToolDescriptor } from '../engine/engine'
import type { AuditRecord } from '../engine/audit'
import { obsidianVault } from '../obsidian'
import { journalLine } from '../obsidian/journal'
import { JOURNAL_DIR, localDate } from '../obsidian/markdown'
import { ownedPath } from '../obsidian/paths'

let _runtime: EngineRuntime | null = null
let _runtimeDir: string | null = null

/** One engine per data dir, created on first use; modules are already initialised by the TUI. */
function runtime(dataDir: string): EngineRuntime {
  if (!_runtime || _runtimeDir !== dataDir) {
    _runtime = wireEngine(dataDir, process.env, { caller: 'tui' })
    _runtimeDir = dataDir
  }
  return _runtime
}

export type RunRequest = { ok: true; tool: string; input: Record<string, unknown> } | { ok: false; error: string }

/** "<tool> {json}" → tool and input. The JSON is optional and must be an object. */
export function parseRunArgs(text: string): RunRequest {
  const trimmed = text.trim()
  const match = /^([\w.-]+)\s*([\s\S]*)$/.exec(trimmed)
  if (!match) return { ok: false, error: 'Uso: /run <tool> {json}   (ex.: /run create_task {"title":"pagar luz"})' }
  const [, tool, rest] = match
  if (!rest.trim()) return { ok: true, tool, input: {} }
  try {
    const input: unknown = JSON.parse(rest)
    if (!input || typeof input !== 'object' || Array.isArray(input)) return { ok: false, error: 'A entrada precisa ser um objeto JSON: {"campo": "valor"}' }
    return { ok: true, tool, input: input as Record<string, unknown> }
  } catch (err) {
    return { ok: false, error: `JSON inválido: ${err instanceof Error ? err.message : String(err)}` }
  }
}

export function formatToolList(tools: readonly ToolDescriptor[], filter = ''): string {
  const needle = filter.trim().toLowerCase()
  const shown = tools.filter((t) => !needle || t.name.includes(needle) || t.description.toLowerCase().includes(needle))
  if (!shown.length) return `Nenhuma ferramenta com "${filter}".`
  const lines = shown.map((t) => {
    const kind = t.readOnly ? 'leitura' : t.destructive ? 'apaga' : 'escrita'
    const summary = t.description.split(/(?<=\.)\s/)[0].slice(0, 90)
    return `  ${t.name.padEnd(28)} ${kind.padEnd(8)} ${summary}`
  })
  return [`Ferramentas (${shown.length}):`, ...lines, '', 'Executar: /run <tool> {json}   Validar sem executar: /simular <tool> {json}'].join('\n')
}

const DECISION_LABEL: Readonly<Record<string, string>> = {
  executed: 'executado',
  'dry-run': 'validado, não executado',
  denied: 'bloqueado pela política',
  invalid: 'entrada inválida',
  unknown: 'ferramenta desconhecida',
}

export function formatRunResult(result: InvokeResult): string {
  const mark = result.ok ? '✓' : '✗'
  const status = result.decision === 'executed' && !result.ok ? 'falhou' : DECISION_LABEL[result.decision] ?? result.decision
  return `${mark} ${result.tool} — ${status} (risco: ${result.risk}, ${result.durationMs} ms)\n${result.output}`
}

export function listEngineTools(dataDir: string): ToolDescriptor[] {
  return runtime(dataDir).engine.listTools()
}

export function invokeEngineTool(dataDir: string, tool: string, input: Record<string, unknown>, dryRun = false): Promise<InvokeResult> {
  return runtime(dataDir).engine.invoke(tool, input, { dryRun })
}

// ─── Journal ────────────────────────────────────────────────

const DATE = /^\d{4}-\d{2}-\d{2}$/

/** Lines from the file audit log for a UTC day, rendered like the vault journal (without summaries). */
function auditJournal(dataDir: string, day: string): string | null {
  const file = join(dataDir, 'audit', `engine-${day}.jsonl`)
  if (!existsSync(file)) return null
  const lines = readFileSync(file, 'utf-8').split('\n').flatMap((raw) => {
    if (!raw.trim()) return []
    try {
      const record = JSON.parse(raw) as AuditRecord
      return [journalLine(record, new Date(record.ts)).trimEnd()]
    } catch {
      return []
    }
  })
  return [`Log de auditoria de ${day} (sem vault do Obsidian configurado):`, ...lines].join('\n')
}

/**
 * The day's activity: the vault journal when a vault is configured, otherwise
 * the file audit log. `day` is YYYY-MM-DD; default today.
 */
export function readDayJournal(dataDir: string, day = ''): string {
  const wanted = day.trim() || localDate(new Date())
  if (!DATE.test(wanted)) return 'Uso: /diario [AAAA-MM-DD]'
  const vr = obsidianVault()
  if (vr) {
    try {
      const file = ownedPath(vr, `${JOURNAL_DIR}/${wanted}.md`)
      if (existsSync(file)) return readFileSync(file, 'utf-8').trimEnd()
      return `Nada registrado em ${wanted}.`
    } catch (err) {
      return `Não consegui ler o Diário: ${err instanceof Error ? err.message : String(err)}`
    }
  }
  return auditJournal(dataDir, wanted) ?? `Nada registrado em ${wanted}.`
}
