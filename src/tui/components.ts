/**
 * TUI Visual Components — Reusable terminal UI elements using ANSI escape codes.
 *
 * Components:
 *   - StatusBar: Sticky bar for system info (model, project, tokens, vault status)
 *   - Sparkline: Inline mini-charts for telemetry data
 *   - BarChart: Horizontal bar charts for metrics
 *   - ProgressBar: Visual progress indicator
 */

import { A, C, w, stripAnsi, visibleLength, wrapText } from '../ansi'
import type { Insight } from '../types'

// ─── Types ────────────────────────────────────────────────────

export interface StatusBarConfig {
  model: string
  project?: string
  tokens?: { input: number; output: number }
  vaultStatus?: 'ok' | 'warn' | 'error'
  sessionCost?: string
  customItems?: StatusBarItem[]
}

export interface StatusBarItem {
  label: string
  value: string
  color?: string
}

export interface SparklineOptions {
  width?: number
  min?: number
  max?: number
  color?: string
  showBounds?: boolean
}

export interface BarChartOptions {
  width?: number
  maxValue?: number
  showValue?: boolean
  color?: string
  label?: string
}

export interface ProgressBarOptions {
  width?: number
  showPercent?: boolean
  fillChar?: string
  emptyChar?: string
  color?: string
}

// ─── Sparkline Chars ──────────────────────────────────────────

// Unicode block elements for sparklines (8 levels)
const SPARK_BLOCKS = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█']
const EMPTY_BLOCK = ' '

/**
 * Render a sparkline from numeric data.
 * Returns a string with Unicode block characters.
 */
export function renderSparkline(
  data: number[],
  options: SparklineOptions = {},
): string {
  const {
    width = data.length,
    min = Math.min(...data),
    max = Math.max(...data),
    color = '',
    showBounds = false,
  } = options

  if (data.length === 0) return ''

  // Sample data if width is smaller than data length
  const samples = sampleData(data, width)

  // Normalize to 0-7 range for block selection
  const range = max - min || 1
  const blocks = samples.map((v) => {
    if (v === 0 && min === 0) return EMPTY_BLOCK
    const normalized = (v - min) / range
    const idx = Math.min(7, Math.floor(normalized * 8))
    return SPARK_BLOCKS[idx]
  })

  const sparkStr = blocks.join('')
  const coloredSparkline = color
    ? `${color}${sparkStr}${A.reset}`
    : sparkStr

  if (showBounds) {
    return `${A.dim}${min.toFixed(0)}${A.reset}${coloredSparkline}${A.dim}${max.toFixed(0)}${A.reset}`
  }

  return coloredSparkline
}

/**
 * Create a sparkline with labeled axis.
 */
export function renderLabeledSparkline(
  label: string,
  data: number[],
  options: SparklineOptions = {},
): string {
  const sparkline = renderSparkline(data, options)
  const current = data.length > 0 ? data[data.length - 1].toFixed(1) : '?'
  return `${A.dim}${label}:${A.reset} ${sparkline} ${A.dim}${current}${A.reset}`
}

// ─── Bar Chart ────────────────────────────────────────────────

const BAR_FULL = '█'
const BAR_SEVEN_EIGHTHS = '▉'
const BAR_THREE_QUARTERS = '▊'
const BAR_FIVE_EIGHTHS = '▋'
const BAR_HALF = '▌'
const BAR_THREE_EIGHTHS = '▍'
const BAR_QUARTER = '▎'
const BAR_EIGHTH = '▏'
const BAR_EMPTY = '░'

const SUB_BLOCKS = [' ', BAR_EIGHTH, BAR_QUARTER, BAR_THREE_EIGHTHS, BAR_HALF, BAR_FIVE_EIGHTHS, BAR_THREE_QUARTERS, BAR_SEVEN_EIGHTHS]

/**
 * Render a horizontal bar chart for a single value.
 */
export function renderBar(
  value: number,
  options: BarChartOptions = {},
): string {
  const {
    width = 20,
    maxValue = 100,
    showValue = true,
    color = A.fg(75),
    label = '',
  } = options

  const ratio = Math.min(1, Math.max(0, value / maxValue))
  const fullBlocks = Math.floor(ratio * width)
  const remainder = (ratio * width) - fullBlocks
  const partialIdx = Math.floor(remainder * 8)

  let bar = BAR_FULL.repeat(fullBlocks)
  if (partialIdx > 0 && fullBlocks < width) {
    bar += SUB_BLOCKS[partialIdx]
  }
  const emptyCount = width - visibleLength(bar)
  bar += BAR_EMPTY.repeat(Math.max(0, emptyCount))

  const coloredBar = color ? `${color}${bar}${A.reset}` : bar

  const parts: string[] = []
  if (label) parts.push(`${A.dim}${label.padEnd(12)}${A.reset}`)
  parts.push(coloredBar)
  if (showValue) parts.push(` ${A.dim}${value.toFixed(1)}%${A.reset}`)

  return parts.join('')
}

/**
 * Render multiple bars as a chart.
 */
export function renderBarChart(
  items: Array<{ label: string; value: number; color?: string }>,
  options: { width?: number; maxValue?: number } = {},
): string[] {
  const { width = 20, maxValue = Math.max(...items.map((i) => i.value), 100) } = options

  return items.map((item) =>
    renderBar(item.value, {
      width,
      maxValue,
      label: item.label,
      color: item.color || A.fg(75),
      showValue: true,
    }),
  )
}

// ─── Progress Bar ─────────────────────────────────────────────

/**
 * Render a progress bar.
 */
export function renderProgressBar(
  current: number,
  total: number,
  options: ProgressBarOptions = {},
): string {
  const {
    width = 20,
    showPercent = true,
    fillChar = '█',
    emptyChar = '░',
    color = A.fg(114),
  } = options

  const ratio = total > 0 ? Math.min(1, current / total) : 0
  const filled = Math.round(ratio * width)
  const empty = width - filled

  const bar = fillChar.repeat(filled) + emptyChar.repeat(empty)
  const coloredBar = color ? `${color}${bar}${A.reset}` : bar

  if (showPercent) {
    const pct = Math.round(ratio * 100)
    return `${coloredBar} ${A.dim}${pct}%${A.reset}`
  }

  return coloredBar
}

// ─── Status Bar ───────────────────────────────────────────────

/**
 * Render a status bar as a string.
 * This returns the content; positioning is handled by the TUI.
 */
export function renderStatusBar(
  config: StatusBarConfig,
  width: number,
): string {
  const items: string[] = []

  // Model
  items.push(`${C.ai}${config.model}${A.reset}`)

  // Project (if active)
  if (config.project) {
    items.push(`${C.heading}${config.project}${A.reset}`)
  }

  // Tokens (if available)
  if (config.tokens) {
    const { input, output } = config.tokens
    items.push(`${A.dim}${formatTokens(input)}/${formatTokens(output)} tok${A.reset}`)
  }

  // Session cost
  if (config.sessionCost) {
    items.push(`${A.dim}${config.sessionCost}${A.reset}`)
  }

  // Vault status
  if (config.vaultStatus) {
    const icon = config.vaultStatus === 'ok' ? '●'
      : config.vaultStatus === 'warn' ? '◐'
        : '○'
    const color = config.vaultStatus === 'ok' ? A.fg(114)
      : config.vaultStatus === 'warn' ? A.fg(220)
        : A.fg(196)
    items.push(`${color}${icon}${A.reset}`)
  }

  // Custom items
  if (config.customItems) {
    for (const item of config.customItems) {
      const colorCode = item.color || ''
      items.push(`${A.dim}${item.label}:${A.reset}${colorCode}${item.value}${A.reset}`)
    }
  }

  const content = items.join(` ${A.dim}│${A.reset} `)
  const plainLen = visibleLength(content)
  const padding = Math.max(0, width - plainLen - 2)

  return `${A.inv} ${content}${' '.repeat(padding)} ${A.reset}`
}

/**
 * Write the status bar at a specific row.
 */
export function drawStatusBar(
  config: StatusBarConfig,
  row: number,
  width: number,
): void {
  w(A.to(row, 1))
  w(renderStatusBar(config, width))
}

// ─── Sticky Footer Status Bar ─────────────────────────────────

export interface StickyStatusState {
  model: string
  project: string
  inputTokens: number
  outputTokens: number
  sessionCost: string
  vaultStatus: 'ok' | 'warn' | 'error'
}

/**
 * Render a sticky footer status bar.
 * Uses ANSI cursor positioning to draw at the bottom of the screen.
 */
export function drawStickyStatusBar(
  state: StickyStatusState,
  row: number,
  width: number,
): void {
  const config: StatusBarConfig = {
    model: state.model,
    project: state.project || undefined,
    tokens: { input: state.inputTokens, output: state.outputTokens },
    sessionCost: state.sessionCost || undefined,
    vaultStatus: state.vaultStatus,
  }
  drawStatusBar(config, row, width)
}

// ─── Telemetry Mini-Dashboard ─────────────────────────────────

export interface TelemetryData {
  cpu: number[]
  memory: number[]
  currentCpu: number
  currentMem: number
}

/**
 * Render a compact telemetry panel.
 */
export function renderTelemetryPanel(
  data: TelemetryData,
  width: number = 40,
): string[] {
  const lines: string[] = []

  // Header
  lines.push(`${A.dim}${'─'.repeat(width)}${A.reset}`)
  lines.push(`${C.heading}${A.bold} System${A.reset}`)

  // CPU sparkline + bar
  const cpuSpark = renderSparkline(data.cpu, { width: 15, color: A.fg(75) })
  const cpuBar = renderBar(data.currentCpu, { width: 10, showValue: false, color: A.fg(75) })
  lines.push(`  ${A.dim}CPU:${A.reset} ${cpuSpark} ${cpuBar} ${data.currentCpu.toFixed(0)}%`)

  // Memory sparkline + bar
  const memSpark = renderSparkline(data.memory, { width: 15, color: A.fg(114) })
  const memBar = renderBar(data.currentMem, { width: 10, showValue: false, color: A.fg(114) })
  lines.push(`  ${A.dim}MEM:${A.reset} ${memSpark} ${memBar} ${data.currentMem.toFixed(0)}%`)

  lines.push(`${A.dim}${'─'.repeat(width)}${A.reset}`)

  return lines
}

// ─── Utilities ────────────────────────────────────────────────

/**
 * Sample data array to a target width.
 */
function sampleData(data: number[], width: number): number[] {
  if (data.length <= width) {
    // Pad with zeros if data is shorter than width
    const padded = [...data]
    while (padded.length < width) padded.unshift(0)
    return padded
  }

  // Downsample by averaging buckets
  const bucketSize = data.length / width
  const result: number[] = []

  for (let i = 0; i < width; i++) {
    const start = Math.floor(i * bucketSize)
    const end = Math.floor((i + 1) * bucketSize)
    const bucket = data.slice(start, end)
    const avg = bucket.reduce((a, b) => a + b, 0) / bucket.length
    result.push(avg)
  }

  return result
}

/**
 * Format token count to K/M notation.
 */
function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}

// ─── Box Drawing ──────────────────────────────────────────────

export interface BoxOptions {
  title?: string
  padding?: number
  borderColor?: string
  titleColor?: string
}

/**
 * Draw a box around content.
 */
export function renderBox(
  content: string[],
  width: number,
  options: BoxOptions = {},
): string[] {
  const {
    title = '',
    padding = 1,
    borderColor = A.dim,
    titleColor = C.heading,
  } = options

  const innerWidth = width - 2 - (padding * 2)
  const lines: string[] = []

  // Top border
  if (title) {
    const titleLen = visibleLength(title)
    const leftPad = 2
    const rightPad = Math.max(1, width - titleLen - leftPad - 4)
    lines.push(`${borderColor}┌${'─'.repeat(leftPad)}${A.reset}${titleColor}${A.bold} ${title} ${A.reset}${borderColor}${'─'.repeat(rightPad)}┐${A.reset}`)
  } else {
    lines.push(`${borderColor}┌${'─'.repeat(width - 2)}┐${A.reset}`)
  }

  // Content with padding — wrap lines that exceed innerWidth
  const paddingLine = ' '.repeat(padding)
  for (const line of content) {
    const wrapped = visibleLength(line) > innerWidth ? wrapText(line, innerWidth) : [line]
    for (const wLine of wrapped) {
      const plainLen = visibleLength(wLine)
      const fill = Math.max(0, innerWidth - plainLen)
      lines.push(`${borderColor}│${A.reset}${paddingLine}${wLine}${' '.repeat(fill)}${paddingLine}${borderColor}│${A.reset}`)
    }
  }

  // Bottom border
  lines.push(`${borderColor}└${'─'.repeat(width - 2)}┘${A.reset}`)

  return lines
}

/**
 * Draw a panel (box with title) at a specific position.
 */
export function drawPanel(
  content: string[],
  row: number,
  col: number,
  width: number,
  options: BoxOptions = {},
): void {
  const boxLines = renderBox(content, width, options)
  for (let i = 0; i < boxLines.length; i++) {
    w(A.to(row + i, col))
    w(boxLines[i])
  }
}

// ─── Horizontal Split ─────────────────────────────────────────

/**
 * Create a horizontal divider.
 */
export function renderDivider(
  width: number,
  label?: string,
  color: string = A.dim,
): string {
  if (!label) {
    return `${color}${'─'.repeat(width)}${A.reset}`
  }

  const labelLen = visibleLength(label)
  const leftPad = 2
  const rightPad = Math.max(1, width - labelLen - leftPad - 2)
  return `${color}${'─'.repeat(leftPad)}${A.reset} ${label} ${color}${'─'.repeat(rightPad)}${A.reset}`
}

// ─── Insight Snippet ──────────────────────────────────────────

/** ANSI codes for subtle insight styling */
const INSIGHT_STYLE = {
  /** Dim yellow for subtle highlight */
  dimYellow: '\x1b[2;33m',
  /** Italic text */
  italic: '\x1b[3m',
  /** Bold italic */
  boldItalic: '\x1b[1;3m',
  /** Dim cyan for action hints */
  dimCyan: '\x1b[2;36m',
}

/** Category icons for insights */
const INSIGHT_ICONS: Record<string, string> = {
  efficiency: '💡',
  pattern: '🔄',
  shortcut: '⚡',
  warning: '⚠️',
  learning: '📚',
}

export interface InsightSnippetOptions {
  /** Maximum width for the snippet */
  width?: number
  /** Show action hints (Y/N) */
  showActions?: boolean
  /** Compact mode (single line) */
  compact?: boolean
}

/**
 * Render a proactive insight snippet with elegant, non-intrusive styling.
 *
 * Uses dim yellow + italic for a subtle visual distinction that
 * doesn't compete with the main chat content.
 *
 * @example
 * ```
 * 💡 Dica de Eficiencia
 *    Detectado padrao repetitivo: /commit -m "fix"
 *    Considere usar aliases para comandos frequentes.
 *    [Y] Aceitar  [N] Ignorar
 * ```
 */
export function renderInsightSnippet(
  insight: Insight,
  options: InsightSnippetOptions = {},
): string[] {
  const { width = 60, showActions = true, compact = false } = options
  const lines: string[] = []

  const icon = INSIGHT_ICONS[insight.category] || '💡'
  const style = INSIGHT_STYLE.dimYellow + INSIGHT_STYLE.italic

  if (compact) {
    // Single-line compact mode
    const title = insight.title.length > width - 10
      ? insight.title.slice(0, width - 13) + '...'
      : insight.title
    lines.push(`  ${style}${icon} ${title}${A.reset}`)
    return lines
  }

  // Full snippet mode
  // Title line
  lines.push(`  ${style}${icon} ${insight.title}${A.reset}`)

  // Explanation (wrapped)
  const explanationWidth = width - 6
  const wrappedExplanation = wrapText(insight.explanation, explanationWidth)
  for (const line of wrappedExplanation) {
    lines.push(`  ${style}   ${stripAnsi(line)}${A.reset}`)
  }

  // Suggested action
  if (insight.suggestedAction) {
    lines.push(`  ${INSIGHT_STYLE.dimCyan}   → ${insight.suggestedAction.label}${A.reset}`)
  }

  // Action hints
  if (showActions) {
    lines.push(`  ${A.dim}   [Y] Aceitar  [N] Ignorar${A.reset}`)
  }

  return lines
}

/**
 * Calculate the number of lines an insight snippet will occupy.
 */
export function getInsightSnippetHeight(
  insight: Insight,
  options: InsightSnippetOptions = {},
): number {
  return renderInsightSnippet(insight, options).length
}

/**
 * Create ANSI escape sequences to clear insight snippet from terminal.
 * Uses cursor up and clear line commands.
 */
export function clearInsightSnippet(lineCount: number): string {
  const moves: string[] = []
  for (let i = 0; i < lineCount; i++) {
    // Move up one line and clear it
    moves.push('\x1b[1A\x1b[2K')
  }
  return moves.join('')
}

// ─── Meta-Learning Panel ──────────────────────────────────────

export interface MetaLearningEntry {
  title: string
  description: string
  frequency: number // times detected
  lastSeen: number  // timestamp
}

/**
 * Render the Meta-Aprendizado (Meta-Learning) panel for the dashboard.
 * Shows top efficiency tips based on usage patterns.
 */
export function renderMetaLearningPanel(
  entries: MetaLearningEntry[],
  width: number = 40,
): string[] {
  const lines: string[] = []

  // Sort by frequency (most common first), take top 3
  const topEntries = [...entries]
    .sort((a, b) => b.frequency - a.frequency)
    .slice(0, 3)

  if (topEntries.length === 0) {
    lines.push(`${A.dim}  Nenhuma dica disponivel ainda.${A.reset}`)
    lines.push(`${A.dim}  Continue usando para gerar insights.${A.reset}`)
    return lines
  }

  for (let i = 0; i < topEntries.length; i++) {
    const entry = topEntries[i]
    const num = i + 1
    const icon = num === 1 ? '🥇' : num === 2 ? '🥈' : '🥉'

    // Title line
    const titleMaxLen = width - 8
    const title = entry.title.length > titleMaxLen
      ? entry.title.slice(0, titleMaxLen - 3) + '...'
      : entry.title
    lines.push(`${icon} ${INSIGHT_STYLE.dimYellow}${title}${A.reset}`)

    // Description (truncated)
    const descMaxLen = width - 4
    const desc = entry.description.length > descMaxLen
      ? entry.description.slice(0, descMaxLen - 3) + '...'
      : entry.description
    lines.push(`   ${A.dim}${desc}${A.reset}`)

    // Frequency indicator
    const freqLabel = entry.frequency === 1 ? 'vez' : 'vezes'
    lines.push(`   ${A.dim}Detectado ${entry.frequency}x${A.reset}`)

    // Add spacing between entries (except last)
    if (i < topEntries.length - 1) {
      lines.push('')
    }
  }

  return lines
}

/**
 * Create a DashboardPanel configuration for Meta-Learning section.
 */
export function createMetaLearningDashboardPanel(
  entries: MetaLearningEntry[],
  width: number = 40,
): { id: string; title: string; content: string[] } {
  return {
    id: 'meta-learning',
    title: 'Meta-Aprendizado',
    content: renderMetaLearningPanel(entries, width),
  }
}
