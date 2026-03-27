/**
 * Investigation system — collect evidence, analyze, and produce structured reports.
 *
 * Types of investigation:
 *   bug         — malfunction diagnosis
 *   feature     — material gathering for feature construction
 *   test        — collecting scenarios and test material
 *   audit       — code/system audit
 *   incident    — runtime/production incident
 */

import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join, resolve, relative } from 'node:path'
import { randomUUID } from 'node:crypto'
import { atomicWriteFile } from './vault'

// ─── Types ──────────────────────────────────────────────────

export type InvestigationType = 'bug' | 'feature' | 'test' | 'audit' | 'incident'
export type InvestigationStatus = 'aberta' | 'em_andamento' | 'concluida' | 'arquivada'
export type EvidenceSource = 'file' | 'command' | 'log' | 'diff' | 'url' | 'observation'

export interface Evidence {
  id: string
  source: EvidenceSource
  label: string            // short description
  content: string          // the actual evidence data
  path?: string            // file path or URL (when applicable)
  timestamp: string
}

export interface Finding {
  id: string
  severity: 'critical' | 'high' | 'medium' | 'low' | 'info'
  title: string
  description: string
  evidence_ids: string[]   // references to evidence that supports this finding
  timestamp: string
}

export interface Investigation {
  id: string
  title: string
  type: InvestigationType
  status: InvestigationStatus
  hypothesis?: string      // initial theory to test
  tags: string[]
  evidence: Evidence[]
  findings: Finding[]
  summary?: string         // final summary when closed
  recommendations?: string // action items when closed
  created: string
  updated: string
}

// ─── Storage ────────────────────────────────────────────────

let _dataDir = ''
let _investigations: Investigation[] = []

const DATA_FILE = () => join(_dataDir, 'investigations.json')

function save(): void {
  atomicWriteFile(DATA_FILE(), JSON.stringify(_investigations, null, 2))
}

function load(): void {
  const file = DATA_FILE()
  if (!existsSync(file)) { _investigations = []; return }
  try { _investigations = JSON.parse(readFileSync(file, 'utf-8')) }
  catch { _investigations = [] }
}

// ─── Init ───────────────────────────────────────────────────

export function initInvestigations(dataDir: string): void {
  _dataDir = dataDir
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true })
  load()
}

// ─── Operations ─────────────────────────────────────────────

export function openInvestigation(
  title: string,
  type: InvestigationType,
  hypothesis?: string,
  tags: string[] = [],
): Investigation {
  const now = new Date().toISOString()
  const inv: Investigation = {
    id: genId(),
    title: title.trim(),
    type,
    status: 'aberta',
    hypothesis: hypothesis?.trim(),
    tags: tags.map((t) => t.toLowerCase()),
    evidence: [],
    findings: [],
    created: now,
    updated: now,
  }
  _investigations = [..._investigations, inv]
  save()
  return inv
}

const MAX_EVIDENCE_SIZE = 50_000 // 50 KB max per evidence item

export function collectEvidence(
  investigationRef: string,
  source: EvidenceSource,
  label: string,
  content: string,
  path?: string,
): Evidence | null {
  const inv = findInvestigation(investigationRef)
  if (!inv) return null

  // Cap content size to prevent unbounded memory/disk growth
  let trimmedContent = content.trim()
  if (trimmedContent.length > MAX_EVIDENCE_SIZE) {
    trimmedContent = trimmedContent.slice(0, MAX_EVIDENCE_SIZE) + `\n...(truncated, ${content.length} total chars)`
  }

  const ev: Evidence = {
    id: genId(),
    source,
    label: label.trim(),
    content: trimmedContent,
    path: path?.trim(),
    timestamp: new Date().toISOString(),
  }

  const updated: Investigation = {
    ...inv,
    evidence: [...inv.evidence, ev],
    status: inv.status === 'aberta' ? 'em_andamento' : inv.status,
    updated: new Date().toISOString(),
  }
  _investigations = _investigations.map((i) => i.id === inv.id ? updated : i)
  save()
  return ev
}

export function addFinding(
  investigationRef: string,
  severity: Finding['severity'],
  title: string,
  description: string,
  evidenceIds: string[] = [],
): Finding | null {
  const inv = findInvestigation(investigationRef)
  if (!inv) return null

  // Validate evidence IDs exist
  const validIds = evidenceIds.filter((eid) =>
    inv.evidence.some((e) => e.id === eid),
  )

  const finding: Finding = {
    id: genId(),
    severity,
    title: title.trim(),
    description: description.trim(),
    evidence_ids: validIds,
    timestamp: new Date().toISOString(),
  }

  const updated: Investigation = {
    ...inv,
    findings: [...inv.findings, finding],
    updated: new Date().toISOString(),
  }
  _investigations = _investigations.map((i) => i.id === inv.id ? updated : i)
  save()
  return finding
}

export function closeInvestigation(
  investigationRef: string,
  summary: string,
  recommendations?: string,
): Investigation | null {
  const inv = findInvestigation(investigationRef)
  if (!inv) return null

  const updated: Investigation = {
    ...inv,
    status: 'concluida',
    summary: summary.trim(),
    recommendations: recommendations?.trim(),
    updated: new Date().toISOString(),
  }
  _investigations = _investigations.map((i) => i.id === inv.id ? updated : i)
  save()
  return updated
}

export function getInvestigation(ref: string): Investigation | null {
  return findInvestigation(ref)
}

export function listInvestigations(
  status?: InvestigationStatus,
  type?: InvestigationType,
  limit = 20,
): Investigation[] {
  let filtered = [..._investigations]
  if (status) filtered = filtered.filter((i) => i.status === status)
  if (type) filtered = filtered.filter((i) => i.type === type)
  return filtered
    .sort((a, b) => new Date(b.updated).getTime() - new Date(a.updated).getTime())
    .slice(0, limit)
}

export function searchInvestigations(query: string): Investigation[] {
  const lower = query.toLowerCase()
  return _investigations.filter((inv) =>
    inv.title.toLowerCase().includes(lower) ||
    inv.hypothesis?.toLowerCase().includes(lower) ||
    inv.tags.some((t) => t.includes(lower)) ||
    inv.findings.some((f) => f.title.toLowerCase().includes(lower)) ||
    inv.summary?.toLowerCase().includes(lower),
  ).sort((a, b) => new Date(b.updated).getTime() - new Date(a.updated).getTime())
}

// ─── Report Generation ──────────────────────────────────────

export function generateReport(investigationRef: string): string | null {
  const inv = findInvestigation(investigationRef)
  if (!inv) return null

  const lines: string[] = []
  const date = (iso: string) => new Date(iso).toLocaleDateString('pt-BR', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  })
  const typeLabels: Record<InvestigationType, string> = {
    bug: 'Bug / Mal funcionamento',
    feature: 'Construcao de funcionalidade',
    test: 'Material para testes',
    audit: 'Auditoria',
    incident: 'Incidente',
  }
  const severityOrder: Record<string, number> = {
    critical: 0, high: 1, medium: 2, low: 3, info: 4,
  }

  lines.push(`# Investigacao: ${inv.title}`)
  lines.push('')
  lines.push(`**Tipo:** ${typeLabels[inv.type]}`)
  lines.push(`**Status:** ${inv.status}`)
  lines.push(`**Abertura:** ${date(inv.created)}`)
  lines.push(`**Ultima atualizacao:** ${date(inv.updated)}`)
  if (inv.tags.length) lines.push(`**Tags:** ${inv.tags.join(', ')}`)
  lines.push(`**ID:** ${inv.id}`)

  if (inv.hypothesis) {
    lines.push('')
    lines.push(`## Hipotese`)
    lines.push(inv.hypothesis)
  }

  // Evidence
  if (inv.evidence.length > 0) {
    lines.push('')
    lines.push(`## Evidencias (${inv.evidence.length})`)
    for (const ev of inv.evidence) {
      const ts = date(ev.timestamp)
      lines.push('')
      lines.push(`### [${ev.id}] ${ev.label}`)
      lines.push(`- Fonte: ${ev.source}${ev.path ? ` (${ev.path})` : ''}`)
      lines.push(`- Coletada: ${ts}`)
      // Show content, truncated if very large
      const content = ev.content.length > 2000
        ? ev.content.slice(0, 2000) + '\n... (truncado)'
        : ev.content
      lines.push('```')
      lines.push(content)
      lines.push('```')
    }
  }

  // Findings
  if (inv.findings.length > 0) {
    const sorted = [...inv.findings].sort((a, b) =>
      (severityOrder[a.severity] ?? 4) - (severityOrder[b.severity] ?? 4),
    )
    lines.push('')
    lines.push(`## Conclusoes (${inv.findings.length})`)
    for (const f of sorted) {
      const badge = severityBadge(f.severity)
      lines.push('')
      lines.push(`### ${badge} ${f.title}`)
      lines.push(f.description)
      if (f.evidence_ids.length > 0) {
        lines.push(`- Evidencias: ${f.evidence_ids.join(', ')}`)
      }
    }
  }

  // Summary & recommendations
  if (inv.summary) {
    lines.push('')
    lines.push(`## Resumo`)
    lines.push(inv.summary)
  }
  if (inv.recommendations) {
    lines.push('')
    lines.push(`## Recomendacoes`)
    lines.push(inv.recommendations)
  }

  return lines.join('\n')
}

// ─── Formatting (for TUI display) ──────────────────────────

export function formatInvestigationList(investigations: Investigation[]): string {
  if (investigations.length === 0) return 'Nenhuma investigacao encontrada.'

  const lines = investigations.map((inv) => {
    const date = new Date(inv.updated).toLocaleDateString('pt-BR', {
      day: '2-digit', month: '2-digit',
    })
    const status = statusBadge(inv.status)
    const evCount = inv.evidence.length
    const fCount = inv.findings.length
    const tags = inv.tags.length > 0 ? ` [${inv.tags.join(', ')}]` : ''
    return `  ${status} [${date}] ${inv.title} (${inv.type}) — ${evCount} ev, ${fCount} concl${tags}  {${inv.id}}`
  })

  return `Investigacoes (${investigations.length}):\n${lines.join('\n')}`
}

export function formatInvestigationDetail(inv: Investigation): string {
  const date = (iso: string) => new Date(iso).toLocaleDateString('pt-BR')
  const status = statusBadge(inv.status)
  const lines = [
    `--- Investigacao {${inv.id}} ---`,
    `Titulo: ${inv.title}`,
    `Tipo: ${inv.type} | Status: ${status}`,
    `Criada: ${date(inv.created)} | Atualizada: ${date(inv.updated)}`,
  ]

  if (inv.hypothesis) lines.push(`Hipotese: ${inv.hypothesis}`)
  if (inv.tags.length) lines.push(`Tags: ${inv.tags.join(', ')}`)

  lines.push(`\nEvidencias: ${inv.evidence.length}`)
  for (const ev of inv.evidence.slice(-5)) {
    const preview = ev.content.slice(0, 80).replace(/\n/g, ' ')
    lines.push(`  [${ev.id}] ${ev.source}: ${ev.label} — "${preview}..."`)
  }
  if (inv.evidence.length > 5) {
    lines.push(`  ... (${inv.evidence.length - 5} mais)`)
  }

  lines.push(`\nConclusoes: ${inv.findings.length}`)
  for (const f of inv.findings) {
    lines.push(`  ${severityBadge(f.severity)} ${f.title}`)
  }

  if (inv.summary) lines.push(`\nResumo: ${inv.summary}`)
  if (inv.recommendations) lines.push(`Recomendacoes: ${inv.recommendations}`)

  return lines.join('\n')
}

export function formatEvidenceDetail(ev: Evidence): string {
  const ts = new Date(ev.timestamp).toLocaleDateString('pt-BR', {
    day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
  })
  const lines = [
    `--- Evidencia {${ev.id}} ---`,
    `Label: ${ev.label}`,
    `Fonte: ${ev.source}${ev.path ? ` (${ev.path})` : ''}`,
    `Coletada: ${ts}`,
    '',
    ev.content.length > 3000
      ? ev.content.slice(0, 3000) + '\n... (truncado)'
      : ev.content,
  ]
  return lines.join('\n')
}

// ─── Helpers ────────────────────────────────────────────────

function findInvestigation(ref: string): Investigation | null {
  const lower = ref.toLowerCase().trim()
  // Exact ID match
  const byId = _investigations.find((i) => i.id === lower)
  if (byId) return byId
  // Partial title match (most recent)
  const byTitle = _investigations
    .filter((i) => i.title.toLowerCase().includes(lower))
    .sort((a, b) => new Date(b.updated).getTime() - new Date(a.updated).getTime())
  return byTitle[0] || null
}

function statusBadge(status: InvestigationStatus): string {
  switch (status) {
    case 'aberta': return '○'
    case 'em_andamento': return '◉'
    case 'concluida': return '●'
    case 'arquivada': return '◌'
  }
}

function severityBadge(severity: Finding['severity']): string {
  switch (severity) {
    case 'critical': return '[CRITICO]'
    case 'high': return '[ALTO]'
    case 'medium': return '[MEDIO]'
    case 'low': return '[BAIXO]'
    case 'info': return '[INFO]'
  }
}

function genId(): string {
  return randomUUID().slice(0, 8)
}
