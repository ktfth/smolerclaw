/**
 * Meta-Learning Engine — Self-documenting workflow observer.
 *
 * Observes user interactions and tool executions to identify:
 * - Repetitive tasks that could be automated
 * - Underutilized tools/features
 * - Inefficient command patterns
 *
 * Generates insights and updates the living manual at
 * ~/.config/smolerclaw/materials/manual/
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { createHash } from 'node:crypto'
import { atomicWriteFile } from '../vault'

// ─── Types ──────────────────────────────────────────────────

export type EventType = 'tool:executed' | 'command:run' | 'session:end'

export interface ObservedEvent {
  type: EventType
  name: string              // tool name or command
  input?: Record<string, unknown>
  timestamp: number
  durationMs?: number
  success: boolean
}

export interface ActionBuffer {
  events: ObservedEvent[]
  sessionStart: number
}

export interface UsagePattern {
  action: string
  count: number
  avgDurationMs: number
  lastUsed: number
}

export interface Insight {
  id: string
  type: 'repetitive_task' | 'underutilized_tool' | 'inefficient_pattern' | 'tip'
  title: string
  description: string
  recommendation: string
  relatedActions: string[]
  confidence: number         // 0-1 score
  createdAt: string
}

export interface LivingManualEntry {
  id: string
  title: string
  category: 'workflow' | 'tool' | 'shortcut' | 'best_practice'
  content: string
  tags: string[]
  source: 'auto_generated' | 'user_edited'
  version: number
  createdAt: string
  updatedAt: string
}

export interface ReflectionResult {
  insightsGenerated: number
  patternsDetected: number
  manualUpdates: number
  summary: string
}

// ─── Constants ──────────────────────────────────────────────

const MAX_BUFFER_SIZE = 20
const MIN_PATTERN_COUNT = 3        // Min occurrences to detect pattern
const PATTERN_CONFIDENCE_THRESHOLD = 0.6

// Tool categories for underutilization detection
const TOOL_CATEGORIES: Record<string, string[]> = {
  productivity: ['create_task', 'complete_task', 'save_memo', 'search_memos'],
  automation: ['create_workflow', 'run_workflow', 'run_command'],
  knowledge: ['save_material', 'search_materials', 'query_memory'],
  people: ['delegate_to_person', 'log_interaction', 'get_people_dashboard'],
}

// Efficient alternatives for common patterns
const EFFICIENT_ALTERNATIVES: Record<string, { pattern: RegExp; suggestion: string }> = {
  multiple_file_reads: {
    pattern: /read_file.*read_file.*read_file/,
    suggestion: 'Use search_files or find_files to locate content across multiple files at once.',
  },
  manual_git_flow: {
    pattern: /run_command.*git add.*run_command.*git commit/,
    suggestion: 'Use /commit command for AI-assisted commit messages.',
  },
  repetitive_search: {
    pattern: /search_files.*search_files.*search_files/,
    suggestion: 'Consider creating a workflow to automate this search pattern.',
  },
}

// ─── Singleton State ────────────────────────────────────────

let _dataDir = ''
let _manualDir = ''
let _buffer: ActionBuffer = { events: [], sessionStart: Date.now() }
let _patterns: Map<string, UsagePattern> = new Map()
let _insights: Insight[] = []
let _manualEntries: LivingManualEntry[] = []
let _initialized = false
let _onInsight: ((insight: Insight) => void) | null = null

const PATTERNS_FILE = () => join(_dataDir, 'usage-patterns.json')
const INSIGHTS_FILE = () => join(_dataDir, 'insights.json')

// ─── Initialization ─────────────────────────────────────────

export function initDocsEngine(
  dataDir: string,
  onInsight?: (insight: Insight) => void,
): void {
  _dataDir = join(dataDir, 'docs-engine')
  _manualDir = join(homedir(), '.config', 'smolerclaw', 'materials', 'manual')
  _onInsight = onInsight || null

  if (!existsSync(_dataDir)) mkdirSync(_dataDir, { recursive: true })
  if (!existsSync(_manualDir)) mkdirSync(_manualDir, { recursive: true })

  loadPatterns()
  loadInsights()
  loadManualEntries()

  _buffer = { events: [], sessionStart: Date.now() }
  _initialized = true
}

export function isDocsEngineInitialized(): boolean {
  return _initialized
}

// ─── Workflow Observer ──────────────────────────────────────

/**
 * Observe an event (tool execution or command).
 * Maintains a rolling buffer of the last 20 actions.
 */
export function observeEvent(event: Omit<ObservedEvent, 'timestamp'>): void {
  if (!_initialized) return

  const fullEvent: ObservedEvent = {
    ...event,
    timestamp: Date.now(),
  }

  // Add to buffer with immutable update
  const newEvents = [..._buffer.events, fullEvent].slice(-MAX_BUFFER_SIZE)
  _buffer = { ..._buffer, events: newEvents }

  // Update patterns incrementally
  updatePattern(fullEvent)

  // Check for immediate insights (non-blocking)
  setImmediate(() => checkImmediateInsights(fullEvent))
}

/**
 * Update usage patterns based on observed event.
 */
function updatePattern(event: ObservedEvent): void {
  const key = `${event.type}:${event.name}`
  const existing = _patterns.get(key)

  if (existing) {
    const newCount = existing.count + 1
    const newAvgDuration = existing.avgDurationMs
      ? ((existing.avgDurationMs * existing.count) + (event.durationMs || 0)) / newCount
      : event.durationMs || 0

    _patterns.set(key, {
      action: key,
      count: newCount,
      avgDurationMs: newAvgDuration,
      lastUsed: event.timestamp,
    })
  } else {
    _patterns.set(key, {
      action: key,
      count: 1,
      avgDurationMs: event.durationMs || 0,
      lastUsed: event.timestamp,
    })
  }
}

/**
 * Check for insights that can be generated immediately.
 */
function checkImmediateInsights(event: ObservedEvent): void {
  // Check for repetitive pattern in recent buffer
  const recentActions = _buffer.events
    .slice(-5)
    .map(e => e.name)
    .join(' ')

  for (const [id, { pattern, suggestion }] of Object.entries(EFFICIENT_ALTERNATIVES)) {
    if (pattern.test(recentActions)) {
      const existingInsight = _insights.find(i =>
        i.type === 'inefficient_pattern' &&
        i.relatedActions.includes(event.name) &&
        Date.now() - new Date(i.createdAt).getTime() < 3600_000 // within 1 hour
      )

      if (!existingInsight) {
        const insight: Insight = {
          id: genId(),
          type: 'inefficient_pattern',
          title: `Padrao detectado: ${id.replace(/_/g, ' ')}`,
          description: `Detectamos um padrao de uso que pode ser otimizado.`,
          recommendation: suggestion,
          relatedActions: _buffer.events.slice(-5).map(e => e.name),
          confidence: 0.8,
          createdAt: new Date().toISOString(),
        }

        addInsight(insight)
      }
    }
  }
}

// ─── Self-Reflection ────────────────────────────────────────

/**
 * Run self-reflection analysis on the current session.
 * Analyzes the buffer for patterns, generates insights,
 * and optionally updates the living manual.
 */
export async function runSelfReflection(): Promise<ReflectionResult> {
  if (!_initialized) {
    return { insightsGenerated: 0, patternsDetected: 0, manualUpdates: 0, summary: 'Engine not initialized' }
  }

  const result: ReflectionResult = {
    insightsGenerated: 0,
    patternsDetected: 0,
    manualUpdates: 0,
    summary: '',
  }

  // 1. Detect repetitive tasks
  const repetitiveInsights = detectRepetitiveTasks()
  result.insightsGenerated += repetitiveInsights.length
  result.patternsDetected += repetitiveInsights.length

  // 2. Detect underutilized tools
  const underutilizedInsights = detectUnderutilizedTools()
  result.insightsGenerated += underutilizedInsights.length

  // 3. Generate tips based on usage
  const tips = generateUsageTips()
  result.insightsGenerated += tips.length

  // 4. Update living manual with new insights
  for (const insight of [...repetitiveInsights, ...underutilizedInsights, ...tips]) {
    addInsight(insight)
    const updated = await updateManualFromInsight(insight)
    if (updated) result.manualUpdates++
  }

  // Save state
  savePatterns()
  saveInsights()

  // Clear buffer after reflection
  _buffer = { events: [], sessionStart: Date.now() }

  result.summary = [
    `Reflexao concluida:`,
    `  ${result.patternsDetected} padroes detectados`,
    `  ${result.insightsGenerated} insights gerados`,
    `  ${result.manualUpdates} atualizacoes no manual`,
  ].join('\n')

  return result
}

/**
 * Detect repetitive task patterns.
 */
function detectRepetitiveTasks(): Insight[] {
  const insights: Insight[] = []
  const sequences = findRepeatingSequences(_buffer.events)

  for (const seq of sequences) {
    if (seq.count >= MIN_PATTERN_COUNT) {
      const insight: Insight = {
        id: genId(),
        type: 'repetitive_task',
        title: `Tarefa repetitiva: ${seq.actions.slice(0, 3).join(' -> ')}`,
        description: `Este padrao de acoes foi executado ${seq.count} vezes nesta sessao.`,
        recommendation: `Considere criar um workflow para automatizar esta sequencia.`,
        relatedActions: seq.actions,
        confidence: Math.min(0.5 + (seq.count * 0.1), 1),
        createdAt: new Date().toISOString(),
      }
      insights.push(insight)
    }
  }

  return insights
}

/**
 * Detect underutilized tools based on category usage.
 */
function detectUnderutilizedTools(): Insight[] {
  const insights: Insight[] = []
  const usedTools = new Set<string>()

  for (const event of _buffer.events) {
    if (event.type === 'tool:executed') {
      usedTools.add(event.name)
    }
  }

  for (const [category, tools] of Object.entries(TOOL_CATEGORIES)) {
    const usedInCategory = tools.filter(t => usedTools.has(t))
    const unusedInCategory = tools.filter(t => !usedTools.has(t))

    // If using some tools in category but not others
    if (usedInCategory.length > 0 && unusedInCategory.length > 0) {
      const confidence = usedInCategory.length / tools.length

      if (confidence >= PATTERN_CONFIDENCE_THRESHOLD) {
        const insight: Insight = {
          id: genId(),
          type: 'underutilized_tool',
          title: `Ferramentas subutilizadas: ${category}`,
          description: `Voce usa ${usedInCategory.join(', ')} mas nao ${unusedInCategory.join(', ')}.`,
          recommendation: `Experimente as ferramentas ${unusedInCategory.slice(0, 2).join(' e ')} para aumentar sua produtividade.`,
          relatedActions: unusedInCategory,
          confidence,
          createdAt: new Date().toISOString(),
        }
        insights.push(insight)
      }
    }
  }

  return insights
}

/**
 * Generate tips based on usage patterns.
 */
function generateUsageTips(): Insight[] {
  const insights: Insight[] = []
  const sessionDurationMs = Date.now() - _buffer.sessionStart

  // Tip: Long session without memos
  if (sessionDurationMs > 1800_000 && !_buffer.events.some(e => e.name === 'save_memo')) {
    insights.push({
      id: genId(),
      type: 'tip',
      title: 'Dica: Capture insights em memos',
      description: 'Sessao longa detectada sem uso de memos.',
      recommendation: 'Use save_memo ou /memo para capturar ideias importantes durante o trabalho.',
      relatedActions: ['save_memo'],
      confidence: 0.6,
      createdAt: new Date().toISOString(),
    })
  }

  // Tip: Many commands without workflow
  const commandCount = _buffer.events.filter(e => e.name === 'run_command').length
  if (commandCount >= 5 && !_buffer.events.some(e => e.name.includes('workflow'))) {
    insights.push({
      id: genId(),
      type: 'tip',
      title: 'Dica: Automatize com workflows',
      description: `${commandCount} comandos executados nesta sessao.`,
      recommendation: 'Crie um workflow para automatizar sequencias de comandos frequentes.',
      relatedActions: ['create_workflow', 'run_workflow'],
      confidence: 0.7,
      createdAt: new Date().toISOString(),
    })
  }

  return insights
}

/**
 * Find repeating sequences of actions in the buffer.
 */
function findRepeatingSequences(events: ObservedEvent[]): { actions: string[]; count: number }[] {
  const sequences: Map<string, { actions: string[]; count: number }> = new Map()
  const actions = events.map(e => e.name)

  // Look for sequences of length 2-4
  for (let seqLen = 2; seqLen <= 4; seqLen++) {
    for (let i = 0; i <= actions.length - seqLen; i++) {
      const seq = actions.slice(i, i + seqLen)
      const key = seq.join('|')

      const existing = sequences.get(key)
      if (existing) {
        sequences.set(key, { ...existing, count: existing.count + 1 })
      } else {
        sequences.set(key, { actions: seq, count: 1 })
      }
    }
  }

  return [...sequences.values()].filter(s => s.count >= MIN_PATTERN_COUNT)
}

// ─── Insight Management ─────────────────────────────────────

function addInsight(insight: Insight): void {
  // Avoid duplicates
  const isDuplicate = _insights.some(i =>
    i.type === insight.type &&
    i.title === insight.title &&
    Date.now() - new Date(i.createdAt).getTime() < 86400_000 // within 24 hours
  )

  if (!isDuplicate) {
    _insights = [..._insights, insight]
    _onInsight?.(insight)
  }
}

export function getRecentInsights(count: number = 5): Insight[] {
  return [..._insights]
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .slice(0, count)
}

export function clearInsights(): void {
  _insights = []
  saveInsights()
}

// ─── Living Manual ──────────────────────────────────────────

/**
 * Update the living manual based on an insight.
 * Writes/updates a markdown file in the manual directory.
 */
async function updateManualFromInsight(insight: Insight): Promise<boolean> {
  try {
    const category = insightTypeToCategory(insight.type)
    const filename = `${insight.id}.md`
    const filepath = join(_manualDir, filename)

    const existingEntry = _manualEntries.find(e => e.id === insight.id)
    const version = existingEntry ? existingEntry.version + 1 : 1

    const entry: LivingManualEntry = {
      id: insight.id,
      title: insight.title,
      category,
      content: formatInsightAsMarkdown(insight),
      tags: extractTags(insight),
      source: 'auto_generated',
      version,
      createdAt: existingEntry?.createdAt || insight.createdAt,
      updatedAt: new Date().toISOString(),
    }

    // Write markdown file
    const markdown = formatManualEntryAsMarkdown(entry)
    writeFileSync(filepath, markdown, 'utf-8')

    // Update in-memory entries
    _manualEntries = _manualEntries.filter(e => e.id !== entry.id)
    _manualEntries = [..._manualEntries, entry]

    return true
  } catch {
    return false
  }
}

/**
 * Update manual with a structured insight (called by the tool).
 */
export async function updateLivingManual(
  title: string,
  content: string,
  category: LivingManualEntry['category'] = 'best_practice',
  tags: string[] = [],
): Promise<{ success: boolean; path: string; entry?: LivingManualEntry }> {
  if (!_initialized) {
    return { success: false, path: '' }
  }

  try {
    const id = genId()
    const filename = `${slugify(title)}-${id.slice(0, 4)}.md`
    const filepath = join(_manualDir, filename)

    const entry: LivingManualEntry = {
      id,
      title,
      category,
      content,
      tags,
      source: 'auto_generated',
      version: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }

    const markdown = formatManualEntryAsMarkdown(entry)
    writeFileSync(filepath, markdown, 'utf-8')

    _manualEntries = [..._manualEntries, entry]

    return { success: true, path: filepath, entry }
  } catch {
    return { success: false, path: '' }
  }
}

/**
 * Search the living manual for relevant content.
 */
export function searchLivingManual(query: string): LivingManualEntry[] {
  const lower = query.toLowerCase()
  const queryWords = lower.split(/\s+/).filter(w => w.length > 2)

  return _manualEntries
    .map(entry => {
      let score = 0
      const searchText = `${entry.title} ${entry.content} ${entry.tags.join(' ')}`.toLowerCase()

      for (const word of queryWords) {
        if (searchText.includes(word)) score++
      }

      return { entry, score }
    })
    .filter(r => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .map(r => r.entry)
}

/**
 * Get all manual entries.
 */
export function listManualEntries(): LivingManualEntry[] {
  return [..._manualEntries]
}

/**
 * Generate an interactive tutorial from manual entries.
 */
export function generateOptimalUsageTutorial(query?: string): string {
  const entries = query ? searchLivingManual(query) : _manualEntries

  if (entries.length === 0) {
    return 'Nenhum conteudo encontrado no manual. Execute /reflect para gerar insights baseados no seu uso.'
  }

  const sections = entries.slice(0, 5).map(entry => {
    const categoryLabel = categoryLabels[entry.category] || entry.category
    return [
      `## ${entry.title}`,
      `*Categoria: ${categoryLabel}*`,
      '',
      entry.content,
      '',
      entry.tags.length > 0 ? `Tags: ${entry.tags.map(t => `#${t}`).join(' ')}` : '',
    ].filter(Boolean).join('\n')
  })

  return [
    '# Manual de Uso Otimizado',
    '',
    `Baseado em ${_manualEntries.length} entradas do manual vivo.`,
    '',
    ...sections,
  ].join('\n')
}

const categoryLabels: Record<string, string> = {
  workflow: 'Workflow',
  tool: 'Ferramenta',
  shortcut: 'Atalho',
  best_practice: 'Boa Pratica',
}

// ─── Formatting ─────────────────────────────────────────────

function formatInsightAsMarkdown(insight: Insight): string {
  return [
    insight.description,
    '',
    '### Recomendacao',
    insight.recommendation,
    '',
    `**Confianca:** ${Math.round(insight.confidence * 100)}%`,
    `**Acoes relacionadas:** ${insight.relatedActions.join(', ')}`,
  ].join('\n')
}

function formatManualEntryAsMarkdown(entry: LivingManualEntry): string {
  const categoryLabel = categoryLabels[entry.category] || entry.category
  return [
    `# ${entry.title}`,
    '',
    `> Categoria: ${categoryLabel}`,
    `> Atualizado: ${new Date(entry.updatedAt).toLocaleDateString('pt-BR')}`,
    `> Versao: ${entry.version}`,
    '',
    entry.content,
    '',
    entry.tags.length > 0 ? `---\nTags: ${entry.tags.map(t => `#${t}`).join(' ')}` : '',
  ].filter(Boolean).join('\n')
}

function insightTypeToCategory(type: Insight['type']): LivingManualEntry['category'] {
  switch (type) {
    case 'repetitive_task':
      return 'workflow'
    case 'underutilized_tool':
      return 'tool'
    case 'inefficient_pattern':
      return 'best_practice'
    case 'tip':
      return 'shortcut'
    default:
      return 'best_practice'
  }
}

function extractTags(insight: Insight): string[] {
  const tags = new Set<string>()
  tags.add(insight.type.replace(/_/g, '-'))

  for (const action of insight.relatedActions) {
    if (action.includes('_')) {
      tags.add(action.split('_')[0])
    }
  }

  return [...tags]
}

export function formatReflectionResult(result: ReflectionResult): string {
  return result.summary
}

export function formatInsightList(insights: Insight[]): string {
  if (insights.length === 0) return 'Nenhum insight disponivel.'

  const lines = insights.map(i => {
    const typeLabel = {
      repetitive_task: 'Tarefa Repetitiva',
      underutilized_tool: 'Ferramenta Subutilizada',
      inefficient_pattern: 'Padrao Ineficiente',
      tip: 'Dica',
    }[i.type] || i.type

    return [
      `[${typeLabel}] ${i.title}`,
      `  ${i.recommendation}`,
      `  Confianca: ${Math.round(i.confidence * 100)}%`,
    ].join('\n')
  })

  return `Insights (${insights.length}):\n\n${lines.join('\n\n')}`
}

// ─── Persistence ────────────────────────────────────────────

function savePatterns(): void {
  if (!_initialized) return
  const data = Object.fromEntries(_patterns)
  atomicWriteFile(PATTERNS_FILE(), JSON.stringify(data, null, 2))
}

function loadPatterns(): void {
  const file = PATTERNS_FILE()
  if (!existsSync(file)) {
    _patterns = new Map()
    return
  }

  try {
    const data = JSON.parse(readFileSync(file, 'utf-8'))
    _patterns = new Map(Object.entries(data))
  } catch {
    _patterns = new Map()
  }
}

function saveInsights(): void {
  if (!_initialized) return
  atomicWriteFile(INSIGHTS_FILE(), JSON.stringify(_insights, null, 2))
}

function loadInsights(): void {
  const file = INSIGHTS_FILE()
  if (!existsSync(file)) {
    _insights = []
    return
  }

  try {
    const data = JSON.parse(readFileSync(file, 'utf-8'))
    _insights = Array.isArray(data) ? data : []
  } catch {
    _insights = []
  }
}

function loadManualEntries(): void {
  if (!existsSync(_manualDir)) {
    _manualEntries = []
    return
  }

  try {
    const files = readdirSync(_manualDir, { withFileTypes: true })
      .filter(d => d.isFile() && d.name.endsWith('.md'))

    const entries: LivingManualEntry[] = []

    for (const file of files) {
      const filepath = join(_manualDir, file.name)
      const content = readFileSync(filepath, 'utf-8')
      const entry = parseManualEntry(file.name, content)
      if (entry) entries.push(entry)
    }

    _manualEntries = entries
  } catch {
    _manualEntries = []
  }
}

function parseManualEntry(filename: string, content: string): LivingManualEntry | null {
  try {
    const lines = content.split('\n')
    const title = lines[0]?.replace(/^#\s*/, '') || filename.replace('.md', '')

    // Extract metadata from blockquotes
    let category: LivingManualEntry['category'] = 'best_practice'
    let version = 1
    const tags: string[] = []

    for (const line of lines.slice(1, 6)) {
      if (line.startsWith('> Categoria:')) {
        const cat = line.replace('> Categoria:', '').trim().toLowerCase()
        if (cat === 'workflow' || cat === 'tool' || cat === 'shortcut' || cat === 'best_practice') {
          category = cat
        }
      }
      if (line.startsWith('> Versao:')) {
        version = parseInt(line.replace('> Versao:', '').trim()) || 1
      }
    }

    // Extract tags from end
    const lastLines = lines.slice(-3).join('\n')
    const tagMatch = lastLines.match(/Tags:\s*(.+)/)
    if (tagMatch) {
      const tagStr = tagMatch[1]
      const extractedTags = tagStr.match(/#[\w-]+/g)
      if (extractedTags) {
        tags.push(...extractedTags.map(t => t.slice(1)))
      }
    }

    // Extract ID from filename
    const idMatch = filename.match(/-([a-z0-9]{4,8})\.md$/)
    const id = idMatch ? idMatch[1] : genId()

    return {
      id,
      title,
      category,
      content: lines.slice(5).join('\n').trim(),
      tags,
      source: 'auto_generated',
      version,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }
  } catch {
    return null
  }
}

// ─── Helpers ────────────────────────────────────────────────

function genId(): string {
  return createHash('sha256')
    .update(`${Date.now()}-${Math.random()}`)
    .digest('hex')
    .slice(0, 8)
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 50)
}

// ─── Buffer Access (for debugging/testing) ──────────────────

export function getBufferEvents(): ObservedEvent[] {
  return [..._buffer.events]
}

export function getBufferStats(): { eventCount: number; sessionDurationMs: number } {
  return {
    eventCount: _buffer.events.length,
    sessionDurationMs: Date.now() - _buffer.sessionStart,
  }
}
