/**
 * Decision Engine — stochastic strategy layer for architectural risk mitigation
 * and automated learning from past incidents.
 *
 * Features:
 * - Trade-off Analyzer: Weighted evaluation matrix for architectural decisions
 * - Post-Mortem Correlator: Pattern matching against historical incidents
 */

import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { atomicWriteFile } from '../vault'
import { searchDecisions, listDecisions, type Decision } from '../decisions'
import { searchMaterials } from '../materials'
import type { Material } from '../types'

// ─── Types ──────────────────────────────────────────────────

/** Evaluation criteria for architectural trade-offs */
export interface TradeoffCriterion {
  name: string
  weight: number  // 0.0 - 1.0, must sum to 1.0 across all criteria
  description: string
}

/** Default evaluation criteria following industry standards */
export const DEFAULT_CRITERIA: TradeoffCriterion[] = [
  {
    name: 'maintainability',
    weight: 0.30,
    description: 'Code readability, modularity, ease of modification',
  },
  {
    name: 'performance',
    weight: 0.25,
    description: 'Response time, throughput, resource efficiency',
  },
  {
    name: 'learning_curve',
    weight: 0.20,
    description: 'Team familiarity, documentation quality, community support',
  },
  {
    name: 'infrastructure_cost',
    weight: 0.25,
    description: 'Hosting, licensing, operational overhead',
  },
]

/** A single option being evaluated */
export interface TradeoffOption {
  name: string
  description: string
  scores: Record<string, number>  // criterion name -> score (1-5)
  pros: string[]
  cons: string[]
}

/** Context for a trade-off analysis */
export interface TradeoffContext {
  title: string
  background: string
  constraints: string[]
  stakeholders: string[]
}

/** Result of a trade-off analysis */
export interface TradeoffResult {
  id: string
  context: TradeoffContext
  options: TradeoffOption[]
  criteria: TradeoffCriterion[]
  recommendation: string
  weightedScores: Record<string, number>  // option name -> weighted score
  adr: string  // Architecture Decision Record in Markdown
  createdAt: string
}

/** Historical incident for correlation */
export interface Incident {
  id: string
  title: string
  description: string
  stacktrace?: string
  rootCause: string
  solution: string
  relatedDecisions: string[]  // decision IDs
  tags: string[]
  createdAt: string
  resolvedAt?: string
}

/** Correlation result when matching current issues to past incidents */
export interface CorrelationMatch {
  incident: Incident
  similarity: number  // 0.0 - 1.0
  matchedKeywords: string[]
  relatedDecisions: Decision[]
  suggestedActions: string[]
}

export interface CorrelationResult {
  query: string
  matches: CorrelationMatch[]
  materialsFound: Material[]
  summary: string
}

// ─── Storage ────────────────────────────────────────────────

let _dataDir = ''
let _tradeoffs: TradeoffResult[] = []
let _incidents: Incident[] = []

const TRADEOFFS_FILE = () => join(_dataDir, 'engine-tradeoffs.json')
const INCIDENTS_FILE = () => join(_dataDir, 'engine-incidents.json')

function saveTradeoffs(): void {
  atomicWriteFile(TRADEOFFS_FILE(), JSON.stringify(_tradeoffs, null, 2))
}

function saveIncidents(): void {
  atomicWriteFile(INCIDENTS_FILE(), JSON.stringify(_incidents, null, 2))
}

function loadTradeoffs(): void {
  const file = TRADEOFFS_FILE()
  if (!existsSync(file)) {
    _tradeoffs = []
    return
  }
  try {
    _tradeoffs = JSON.parse(readFileSync(file, 'utf-8'))
  } catch {
    _tradeoffs = []
  }
}

function loadIncidents(): void {
  const file = INCIDENTS_FILE()
  if (!existsSync(file)) {
    _incidents = []
    return
  }
  try {
    _incidents = JSON.parse(readFileSync(file, 'utf-8'))
  } catch {
    _incidents = []
  }
}

// ─── Init ───────────────────────────────────────────────────

export function initDecisionEngine(dataDir: string): void {
  _dataDir = dataDir
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true })
  loadTradeoffs()
  loadIncidents()
}

// ─── Trade-off Analyzer ─────────────────────────────────────

/**
 * Analyze architectural trade-offs between multiple options.
 * Returns a weighted evaluation matrix and ADR recommendation.
 */
export function analyzeTradeoffs(
  context: TradeoffContext,
  options: TradeoffOption[],
  criteria: TradeoffCriterion[] = DEFAULT_CRITERIA,
): TradeoffResult {
  // Validate criteria weights sum to ~1.0
  const totalWeight = criteria.reduce((sum, c) => sum + c.weight, 0)
  if (Math.abs(totalWeight - 1.0) > 0.01) {
    // Normalize weights
    const normalizedCriteria = criteria.map((c) => ({
      ...c,
      weight: c.weight / totalWeight,
    }))
    criteria = normalizedCriteria
  }

  // Calculate weighted scores for each option
  const weightedScores: Record<string, number> = {}

  for (const option of options) {
    let score = 0
    for (const criterion of criteria) {
      const rawScore = option.scores[criterion.name] ?? 3  // default to middle score
      score += rawScore * criterion.weight
    }
    weightedScores[option.name] = Math.round(score * 100) / 100
  }

  // Find recommendation (highest weighted score)
  const sortedOptions = Object.entries(weightedScores)
    .sort(([, a], [, b]) => b - a)
  const recommendedOption = sortedOptions[0]?.[0] || options[0]?.name || 'N/A'
  const recommendedObj = options.find((o) => o.name === recommendedOption)

  // Generate ADR (Architecture Decision Record) in Markdown
  const adr = generateADR(context, options, criteria, weightedScores, recommendedOption, recommendedObj)

  const result: TradeoffResult = {
    id: genId(),
    context,
    options,
    criteria,
    recommendation: recommendedOption,
    weightedScores,
    adr,
    createdAt: new Date().toISOString(),
  }

  // Persist the analysis
  _tradeoffs = [..._tradeoffs, result]
  saveTradeoffs()

  return result
}

/**
 * Generate an Architecture Decision Record (ADR) in Markdown format.
 */
function generateADR(
  context: TradeoffContext,
  options: TradeoffOption[],
  criteria: TradeoffCriterion[],
  weightedScores: Record<string, number>,
  recommendation: string,
  recommendedObj?: TradeoffOption,
): string {
  const now = new Date()
  const dateStr = now.toISOString().split('T')[0]

  const lines: string[] = [
    `# ADR: ${context.title}`,
    '',
    `**Date:** ${dateStr}`,
    `**Status:** Proposed`,
    '',
    '## Context',
    '',
    context.background,
    '',
  ]

  if (context.constraints.length > 0) {
    lines.push('### Constraints')
    lines.push('')
    for (const constraint of context.constraints) {
      lines.push(`- ${constraint}`)
    }
    lines.push('')
  }

  if (context.stakeholders.length > 0) {
    lines.push('### Stakeholders')
    lines.push('')
    for (const stakeholder of context.stakeholders) {
      lines.push(`- ${stakeholder}`)
    }
    lines.push('')
  }

  lines.push('## Options Considered')
  lines.push('')

  for (const option of options) {
    lines.push(`### ${option.name}`)
    lines.push('')
    lines.push(option.description)
    lines.push('')

    if (option.pros.length > 0) {
      lines.push('**Pros:**')
      for (const pro of option.pros) {
        lines.push(`- ${pro}`)
      }
      lines.push('')
    }

    if (option.cons.length > 0) {
      lines.push('**Cons:**')
      for (const con of option.cons) {
        lines.push(`- ${con}`)
      }
      lines.push('')
    }
  }

  // Evaluation matrix table
  lines.push('## Evaluation Matrix')
  lines.push('')

  const headerCols = ['Criterion (Weight)', ...options.map((o) => o.name)]
  lines.push(`| ${headerCols.join(' | ')} |`)
  lines.push(`| ${headerCols.map(() => '---').join(' | ')} |`)

  for (const criterion of criteria) {
    const weightPct = Math.round(criterion.weight * 100)
    const row = [
      `${criterion.name} (${weightPct}%)`,
      ...options.map((o) => {
        const score = o.scores[criterion.name] ?? 3
        return `${score}/5`
      }),
    ]
    lines.push(`| ${row.join(' | ')} |`)
  }

  // Weighted totals row
  const totalsRow = [
    '**Weighted Total**',
    ...options.map((o) => `**${weightedScores[o.name]?.toFixed(2) ?? '0.00'}**`),
  ]
  lines.push(`| ${totalsRow.join(' | ')} |`)
  lines.push('')

  lines.push('## Decision')
  lines.push('')
  lines.push(`**Recommended:** ${recommendation}`)
  lines.push('')

  if (recommendedObj) {
    lines.push(`Based on the weighted evaluation, **${recommendation}** scores highest with a weighted total of ${weightedScores[recommendation]?.toFixed(2)}.`)
    lines.push('')

    if (recommendedObj.pros.length > 0) {
      lines.push('Key advantages:')
      for (const pro of recommendedObj.pros.slice(0, 3)) {
        lines.push(`- ${pro}`)
      }
      lines.push('')
    }
  }

  lines.push('## Consequences')
  lines.push('')
  lines.push('### Positive')
  lines.push('')
  if (recommendedObj && recommendedObj.pros.length > 0) {
    for (const pro of recommendedObj.pros) {
      lines.push(`- ${pro}`)
    }
  } else {
    lines.push('- *To be determined based on implementation*')
  }
  lines.push('')

  lines.push('### Negative')
  lines.push('')
  if (recommendedObj && recommendedObj.cons.length > 0) {
    for (const con of recommendedObj.cons) {
      lines.push(`- ${con}`)
    }
  } else {
    lines.push('- *To be determined based on implementation*')
  }
  lines.push('')

  lines.push('---')
  lines.push('')
  lines.push('*Generated by Decision Engine*')

  return lines.join('\n')
}

// ─── Post-Mortem Correlator ─────────────────────────────────

/**
 * Extract keywords from text for matching.
 */
function extractKeywords(text: string): string[] {
  const lower = text.toLowerCase()

  // Common error-related keywords
  const errorPatterns = [
    /error/gi, /exception/gi, /fail/gi, /crash/gi, /timeout/gi,
    /null/gi, /undefined/gi, /nan/gi, /overflow/gi, /underflow/gi,
    /memory/gi, /leak/gi, /deadlock/gi, /race/gi, /condition/gi,
    /connection/gi, /refused/gi, /denied/gi, /unauthorized/gi,
    /invalid/gi, /missing/gi, /corrupt/gi, /malformed/gi,
  ]

  const keywords: Set<string> = new Set()

  // Extract matched patterns
  for (const pattern of errorPatterns) {
    const matches = lower.match(pattern)
    if (matches) {
      for (const match of matches) {
        keywords.add(match.toLowerCase())
      }
    }
  }

  // Extract file paths and class names
  const pathPattern = /[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*/g
  const paths = text.match(pathPattern) || []
  for (const path of paths) {
    if (path.length > 3 && !path.match(/^(the|and|for|with|from|this|that)$/i)) {
      keywords.add(path.toLowerCase())
    }
  }

  // Extract error codes
  const codePattern = /[A-Z]{2,}_[A-Z0-9_]+|E[0-9]{3,}/g
  const codes = text.match(codePattern) || []
  for (const code of codes) {
    keywords.add(code.toLowerCase())
  }

  return [...keywords]
}

/**
 * Calculate similarity between two keyword sets using Jaccard index.
 */
function calculateSimilarity(keywords1: string[], keywords2: string[]): number {
  if (keywords1.length === 0 || keywords2.length === 0) return 0

  const set1 = new Set(keywords1)
  const set2 = new Set(keywords2)

  let intersection = 0
  for (const kw of set1) {
    if (set2.has(kw)) intersection++
  }

  const union = set1.size + set2.size - intersection
  return union > 0 ? intersection / union : 0
}

/**
 * Correlate a current error/bug with historical incidents and decisions.
 */
export function correlateIncident(
  query: string,
  stacktrace?: string,
): CorrelationResult {
  const fullText = stacktrace ? `${query}\n${stacktrace}` : query
  const queryKeywords = extractKeywords(fullText)

  const matches: CorrelationMatch[] = []

  // Search past incidents
  for (const incident of _incidents) {
    const incidentText = `${incident.title} ${incident.description} ${incident.stacktrace || ''} ${incident.rootCause} ${incident.solution}`
    const incidentKeywords = extractKeywords(incidentText)

    const similarity = calculateSimilarity(queryKeywords, incidentKeywords)

    if (similarity > 0.1) {
      // Find matched keywords
      const matchedKeywords = queryKeywords.filter((kw) =>
        incidentKeywords.includes(kw),
      )

      // Fetch related decisions
      const relatedDecisions: Decision[] = []
      for (const decisionId of incident.relatedDecisions) {
        const decisions = searchDecisions(decisionId)
        if (decisions.length > 0) {
          relatedDecisions.push(decisions[0]!)
        }
      }

      // Generate suggested actions
      const suggestedActions: string[] = []
      if (incident.solution) {
        suggestedActions.push(`Apply solution: ${incident.solution}`)
      }
      if (incident.rootCause) {
        suggestedActions.push(`Investigate root cause: ${incident.rootCause}`)
      }
      for (const decision of relatedDecisions) {
        suggestedActions.push(`Review decision: ${decision.title}`)
      }

      matches.push({
        incident,
        similarity,
        matchedKeywords,
        relatedDecisions,
        suggestedActions,
      })
    }
  }

  // Sort by similarity
  matches.sort((a, b) => b.similarity - a.similarity)

  // Also search decisions for relevant context
  const recentDecisions = searchDecisions(query.slice(0, 50))

  // Search materials (RAG local)
  const materialsFound = searchMaterials(query.slice(0, 50))

  // Generate summary
  const summary = generateCorrelationSummary(query, matches, recentDecisions, materialsFound)

  return {
    query,
    matches: matches.slice(0, 5),  // Top 5 matches
    materialsFound: materialsFound.slice(0, 5),
    summary,
  }
}

/**
 * Generate a human-readable summary of correlation results.
 */
function generateCorrelationSummary(
  query: string,
  matches: CorrelationMatch[],
  decisions: Decision[],
  materials: Material[],
): string {
  const lines: string[] = ['# Incident Correlation Report', '']

  lines.push('## Query')
  lines.push('')
  lines.push(`\`\`\``)
  lines.push(query.slice(0, 500))
  lines.push(`\`\`\``)
  lines.push('')

  if (matches.length > 0) {
    lines.push('## Similar Past Incidents')
    lines.push('')

    for (const match of matches.slice(0, 3)) {
      const similarityPct = Math.round(match.similarity * 100)
      lines.push(`### ${match.incident.title} (${similarityPct}% match)`)
      lines.push('')
      lines.push(`**Root Cause:** ${match.incident.rootCause}`)
      lines.push('')
      lines.push(`**Solution:** ${match.incident.solution}`)
      lines.push('')

      if (match.matchedKeywords.length > 0) {
        lines.push(`**Matched Keywords:** ${match.matchedKeywords.slice(0, 5).join(', ')}`)
        lines.push('')
      }

      if (match.suggestedActions.length > 0) {
        lines.push('**Suggested Actions:**')
        for (const action of match.suggestedActions.slice(0, 3)) {
          lines.push(`- ${action}`)
        }
        lines.push('')
      }
    }
  } else {
    lines.push('## Similar Past Incidents')
    lines.push('')
    lines.push('*No matching incidents found in the database.*')
    lines.push('')
  }

  if (decisions.length > 0) {
    lines.push('## Related Decisions')
    lines.push('')

    for (const decision of decisions.slice(0, 3)) {
      lines.push(`- **${decision.title}** (${decision.date.split('T')[0]}): ${decision.chosen}`)
    }
    lines.push('')
  }

  if (materials.length > 0) {
    lines.push('## Relevant Materials')
    lines.push('')

    for (const material of materials.slice(0, 3)) {
      const preview = material.content.length > 100
        ? material.content.slice(0, 100).replace(/\n/g, ' ') + '...'
        : material.content.replace(/\n/g, ' ')
      lines.push(`- **${material.title}** (${material.category}): ${preview}`)
    }
    lines.push('')
  }

  lines.push('---')
  lines.push('')
  lines.push('*Generated by Decision Engine Post-Mortem Correlator*')

  return lines.join('\n')
}

// ─── Incident Management ────────────────────────────────────

/**
 * Log a new incident for future correlation.
 */
export function logIncident(
  title: string,
  description: string,
  rootCause: string,
  solution: string,
  stacktrace?: string,
  relatedDecisions: string[] = [],
  tags: string[] = [],
): Incident {
  const incident: Incident = {
    id: genId(),
    title: title.trim(),
    description: description.trim(),
    stacktrace: stacktrace?.trim(),
    rootCause: rootCause.trim(),
    solution: solution.trim(),
    relatedDecisions,
    tags: tags.map((t) => t.toLowerCase()),
    createdAt: new Date().toISOString(),
  }

  _incidents = [..._incidents, incident]
  saveIncidents()

  return incident
}

/**
 * Mark an incident as resolved.
 */
export function resolveIncident(id: string): Incident | null {
  const found = _incidents.find((i) => i.id === id)
  if (!found) return null

  const updated: Incident = {
    ...found,
    resolvedAt: new Date().toISOString(),
  }

  _incidents = _incidents.map((i) => (i.id === id ? updated : i))
  saveIncidents()

  return updated
}

/**
 * Search incidents by query.
 */
export function searchIncidents(query: string): Incident[] {
  const lower = query.toLowerCase()
  return _incidents
    .filter((i) =>
      i.title.toLowerCase().includes(lower) ||
      i.description.toLowerCase().includes(lower) ||
      i.rootCause.toLowerCase().includes(lower) ||
      i.solution.toLowerCase().includes(lower) ||
      i.tags.some((t) => t.includes(lower)),
    )
    .sort((a, b) =>
      new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    )
}

/**
 * List recent incidents.
 */
export function listIncidents(limit = 10): Incident[] {
  return [..._incidents]
    .sort((a, b) =>
      new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    )
    .slice(0, limit)
}

// ─── Trade-off History ──────────────────────────────────────

/**
 * Get past trade-off analyses.
 */
export function listTradeoffs(limit = 10): TradeoffResult[] {
  return [..._tradeoffs]
    .sort((a, b) =>
      new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    )
    .slice(0, limit)
}

/**
 * Search trade-off analyses.
 */
export function searchTradeoffs(query: string): TradeoffResult[] {
  const lower = query.toLowerCase()
  return _tradeoffs
    .filter((t) =>
      t.context.title.toLowerCase().includes(lower) ||
      t.context.background.toLowerCase().includes(lower) ||
      t.recommendation.toLowerCase().includes(lower) ||
      t.options.some((o) =>
        o.name.toLowerCase().includes(lower) ||
        o.description.toLowerCase().includes(lower),
      ),
    )
    .sort((a, b) =>
      new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    )
}

/**
 * Get a specific trade-off by ID.
 */
export function getTradeoff(id: string): TradeoffResult | null {
  return _tradeoffs.find((t) => t.id === id) || null
}

// ─── Formatting ─────────────────────────────────────────────

export function formatTradeoffList(tradeoffs: TradeoffResult[]): string {
  if (tradeoffs.length === 0) return 'Nenhuma analise de trade-off registrada.'

  const lines = tradeoffs.map((t) => {
    const date = new Date(t.createdAt).toLocaleDateString('pt-BR', {
      day: '2-digit',
      month: '2-digit',
    })
    return `  [${date}] ${t.context.title} → ${t.recommendation}  {${t.id}}`
  })

  return `Trade-offs (${tradeoffs.length}):\n${lines.join('\n')}`
}

export function formatIncidentList(incidents: Incident[]): string {
  if (incidents.length === 0) return 'Nenhum incidente registrado.'

  const lines = incidents.map((i) => {
    const date = new Date(i.createdAt).toLocaleDateString('pt-BR', {
      day: '2-digit',
      month: '2-digit',
    })
    const status = i.resolvedAt ? '✓' : '○'
    const tags = i.tags.length > 0 ? ` [${i.tags.join(', ')}]` : ''
    return `  ${status} [${date}] ${i.title}${tags}  {${i.id}}`
  })

  return `Incidentes (${incidents.length}):\n${lines.join('\n')}`
}

export function formatIncidentDetail(incident: Incident): string {
  const created = new Date(incident.createdAt).toLocaleDateString('pt-BR')
  const resolved = incident.resolvedAt
    ? new Date(incident.resolvedAt).toLocaleDateString('pt-BR')
    : 'Pendente'

  const lines = [
    `--- Incidente {${incident.id}} ---`,
    `Titulo: ${incident.title}`,
    `Criado: ${created}`,
    `Resolvido: ${resolved}`,
    '',
    `Descricao:`,
    incident.description,
    '',
    `Causa Raiz:`,
    incident.rootCause,
    '',
    `Solucao:`,
    incident.solution,
  ]

  if (incident.stacktrace) {
    lines.push('')
    lines.push('Stacktrace:')
    lines.push('```')
    lines.push(incident.stacktrace.slice(0, 1000))
    lines.push('```')
  }

  if (incident.tags.length > 0) {
    lines.push('')
    lines.push(`Tags: ${incident.tags.join(', ')}`)
  }

  if (incident.relatedDecisions.length > 0) {
    lines.push('')
    lines.push(`Decisoes Relacionadas: ${incident.relatedDecisions.join(', ')}`)
  }

  return lines.join('\n')
}

// ─── Helpers ────────────────────────────────────────────────

function genId(): string {
  return randomUUID().slice(0, 8)
}

// ─── Exports for External Access ────────────────────────────

export { DEFAULT_CRITERIA as defaultCriteria }
