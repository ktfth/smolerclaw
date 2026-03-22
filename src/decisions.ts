/**
 * Decision log — record important decisions with context and rationale.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// ─── Types ──────────────────────────────────────────────────

export interface Decision {
  id: string
  title: string
  context: string         // why this decision was needed
  chosen: string          // what was decided
  alternatives?: string   // what was considered but rejected
  tags: string[]
  date: string
}

// ─── Storage ────────────────────────────────────────────────

let _dataDir = ''
let _decisions: Decision[] = []

const DATA_FILE = () => join(_dataDir, 'decisions.json')

function save(): void {
  writeFileSync(DATA_FILE(), JSON.stringify(_decisions, null, 2))
}

function load(): void {
  const file = DATA_FILE()
  if (!existsSync(file)) { _decisions = []; return }
  try { _decisions = JSON.parse(readFileSync(file, 'utf-8')) }
  catch { _decisions = [] }
}

// ─── Init ───────────────────────────────────────────────────

export function initDecisions(dataDir: string): void {
  _dataDir = dataDir
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true })
  load()
}

// ─── Operations ─────────────────────────────────────────────

export function logDecision(
  title: string,
  context: string,
  chosen: string,
  alternatives?: string,
  tags: string[] = [],
): Decision {
  const decision: Decision = {
    id: genId(),
    title: title.trim(),
    context: context.trim(),
    chosen: chosen.trim(),
    alternatives: alternatives?.trim(),
    tags: tags.map((t) => t.toLowerCase()),
    date: new Date().toISOString(),
  }
  _decisions = [..._decisions, decision]
  save()
  return decision
}

export function searchDecisions(query: string): Decision[] {
  const lower = query.toLowerCase()
  return _decisions.filter((d) =>
    d.title.toLowerCase().includes(lower) ||
    d.chosen.toLowerCase().includes(lower) ||
    d.context.toLowerCase().includes(lower) ||
    d.tags.some((t) => t.includes(lower)),
  ).sort((a, b) =>
    new Date(b.date).getTime() - new Date(a.date).getTime(),
  )
}

export function listDecisions(limit = 15): Decision[] {
  return [..._decisions]
    .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
    .slice(0, limit)
}

// ─── Formatting ─────────────────────────────────────────────

export function formatDecisionList(decisions: Decision[]): string {
  if (decisions.length === 0) return 'Nenhuma decisao registrada.'

  const lines = decisions.map((d) => {
    const date = new Date(d.date).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' })
    const tags = d.tags.length > 0 ? ` [${d.tags.join(', ')}]` : ''
    return `  [${date}] ${d.title}${tags}  {${d.id}}`
  })

  return `Decisoes (${decisions.length}):\n${lines.join('\n')}`
}

export function formatDecisionDetail(d: Decision): string {
  const date = new Date(d.date).toLocaleDateString('pt-BR')
  const lines = [
    `--- Decisao {${d.id}} ---`,
    `Titulo: ${d.title}`,
    `Data: ${date}`,
    `\nContexto: ${d.context}`,
    `\nEscolha: ${d.chosen}`,
  ]
  if (d.alternatives) lines.push(`\nAlternativas descartadas: ${d.alternatives}`)
  if (d.tags.length > 0) lines.push(`\nTags: ${d.tags.join(', ')}`)
  return lines.join('\n')
}

// ─── Helpers ────────────────────────────────────────────────

function genId(): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789'
  let id = ''
  for (let i = 0; i < 6; i++) id += chars[Math.floor(Math.random() * chars.length)]
  return id
}
