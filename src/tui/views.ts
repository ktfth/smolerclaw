/**
 * TUI View Mode System — Manages different display modes for the terminal UI.
 *
 * View Modes:
 *   - ChatMode: Standard conversational interface with streaming
 *   - DashboardMode: Multi-panel dashboard with side-by-side content
 *
 * Features:
 *   - Clean transitions between modes
 *   - Readline history preservation
 *   - SIGWINCH handling for resize
 *   - Panel layout management
 */

import { A, C, w, stripAnsi, visibleLength } from '../ansi'
import {
  renderStatusBar, drawPanel, renderBox, renderDivider,
  renderSparkline, renderTelemetryPanel, type StatusBarConfig, type TelemetryData,
} from './components'
import { renderTable, type TableOptions } from './tables'

// ─── Types ────────────────────────────────────────────────────

export type ViewMode = 'chat' | 'dashboard'

export interface ViewState {
  mode: ViewMode
  width: number
  height: number
  statusBarRow: number
  contentStartRow: number
  contentEndRow: number
  inputRow: number
}

export interface DashboardPanel {
  id: string
  title: string
  content: string[]
  width?: number          // Percentage or fixed
  row?: number
  col?: number
  height?: number
}

export interface DashboardLayout {
  panels: DashboardPanel[]
  columns?: number        // Number of columns (default: 2)
  gap?: number            // Gap between panels
}

// ─── View Manager ─────────────────────────────────────────────

export class ViewManager {
  private mode: ViewMode = 'chat'
  private width: number
  private height: number
  private statusBarEnabled = true
  private statusConfig: StatusBarConfig | null = null
  private dashboardLayout: DashboardLayout | null = null
  private savedChatLines: string[] = []
  private resizeCallbacks: Array<() => void> = []

  constructor() {
    this.width = process.stdout.columns || 80
    this.height = process.stdout.rows || 24
  }

  // ── Mode Management ───────────────────────────────────────

  getMode(): ViewMode {
    return this.mode
  }

  getViewState(): ViewState {
    const hasStatusBar = this.statusBarEnabled && this.statusConfig
    const statusBarRow = hasStatusBar ? this.height : 0

    return {
      mode: this.mode,
      width: this.width,
      height: this.height,
      statusBarRow,
      contentStartRow: 3,           // After header
      contentEndRow: this.height - 2, // Before input line
      inputRow: this.height,
    }
  }

  /**
   * Switch to chat mode.
   */
  enterChatMode(): void {
    if (this.mode === 'chat') return

    this.mode = 'chat'
    this.clearScreen()
  }

  /**
   * Switch to dashboard mode.
   */
  enterDashboardMode(layout: DashboardLayout): void {
    this.mode = 'dashboard'
    this.dashboardLayout = layout
    this.clearScreen()
    this.renderDashboard()
  }

  /**
   * Toggle between modes.
   */
  toggleMode(): void {
    if (this.mode === 'chat') {
      // Need layout to enter dashboard
      return
    }
    this.enterChatMode()
  }

  // ── Status Bar ────────────────────────────────────────────

  setStatusBar(config: StatusBarConfig | null): void {
    this.statusConfig = config
  }

  enableStatusBar(enabled: boolean): void {
    this.statusBarEnabled = enabled
  }

  renderStatusBar(): void {
    if (!this.statusBarEnabled || !this.statusConfig) return

    // Draw status bar at the bottom, above input line
    const row = this.height - 1
    w(A.to(row, 1))
    w(renderStatusBar(this.statusConfig, this.width))
  }

  // ── Screen Management ─────────────────────────────────────

  clearScreen(): void {
    w(A.clear)
    w(A.to(1, 1))
  }

  /**
   * Clear only the content area (preserve header, status bar, input).
   */
  clearContentArea(): void {
    const state = this.getViewState()
    for (let row = state.contentStartRow; row <= state.contentEndRow; row++) {
      w(A.to(row, 1))
      w(A.clearLine)
    }
  }

  // ── Resize Handling ───────────────────────────────────────

  updateDimensions(width: number, height: number): void {
    this.width = width
    this.height = height

    // Notify callbacks
    for (const cb of this.resizeCallbacks) {
      cb()
    }
  }

  onResize(callback: () => void): void {
    this.resizeCallbacks.push(callback)
  }

  removeResizeCallback(callback: () => void): void {
    this.resizeCallbacks = this.resizeCallbacks.filter((cb) => cb !== callback)
  }

  // ── Dashboard Rendering ───────────────────────────────────

  renderDashboard(): void {
    if (this.mode !== 'dashboard' || !this.dashboardLayout) return

    this.clearContentArea()

    const { panels, columns = 2, gap = 1 } = this.dashboardLayout
    const state = this.getViewState()
    const contentHeight = state.contentEndRow - state.contentStartRow

    // Calculate panel dimensions
    const panelWidth = Math.floor((this.width - (gap * (columns + 1))) / columns)

    let currentRow = state.contentStartRow
    let currentCol = 1 + gap

    for (let i = 0; i < panels.length; i++) {
      const panel = panels[i]

      // Use explicit position if provided, otherwise auto-layout
      const row = panel.row ?? currentRow
      const col = panel.col ?? currentCol
      const width = panel.width ?? panelWidth
      const height = panel.height ?? Math.floor(contentHeight / Math.ceil(panels.length / columns))

      // Render panel
      this.drawDashboardPanel(panel, row, col, width, height)

      // Update position for next panel
      if ((i + 1) % columns === 0) {
        // New row
        currentRow += height + gap
        currentCol = 1 + gap
      } else {
        // Next column
        currentCol += width + gap
      }
    }

    // Render status bar if enabled
    this.renderStatusBar()
  }

  private drawDashboardPanel(
    panel: DashboardPanel,
    row: number,
    col: number,
    width: number,
    height: number,
  ): void {
    // Trim content to fit panel height
    const contentHeight = height - 2 // Account for top/bottom borders
    const visibleContent = panel.content.slice(0, contentHeight)

    // Draw panel box
    drawPanel(visibleContent, row, col, width, { title: panel.title })
  }

  // ── Preset Layouts ────────────────────────────────────────

  /**
   * Create a morning briefing dashboard layout.
   */
  createMorningBriefingLayout(data: {
    tasks: string[]
    followUps: string[]
    calendar: string[]
    news: string[]
    projectSummary?: string[]
  }): DashboardLayout {
    const panels: DashboardPanel[] = [
      {
        id: 'tasks',
        title: 'Tarefas do Dia',
        content: data.tasks.length > 0 ? data.tasks : ['Nenhuma tarefa para hoje'],
      },
      {
        id: 'followups',
        title: 'Follow-ups',
        content: data.followUps.length > 0 ? data.followUps : ['Nenhum follow-up pendente'],
      },
      {
        id: 'calendar',
        title: 'Agenda',
        content: data.calendar.length > 0 ? data.calendar : ['Sem eventos hoje'],
      },
      {
        id: 'news',
        title: 'Noticias',
        content: data.news.length > 0 ? data.news : ['Sem noticias recentes'],
      },
    ]

    if (data.projectSummary) {
      panels.push({
        id: 'project',
        title: 'Projetos',
        content: data.projectSummary,
      })
    }

    return { panels, columns: 2, gap: 1 }
  }

  /**
   * Create a system monitoring dashboard layout.
   */
  createMonitoringLayout(telemetry: TelemetryData): DashboardLayout {
    const telemetryLines = renderTelemetryPanel(telemetry, 35)

    return {
      panels: [
        {
          id: 'telemetry',
          title: 'Sistema',
          content: telemetryLines,
        },
      ],
      columns: 1,
      gap: 1,
    }
  }
}

// ─── Split View Utilities ─────────────────────────────────────

/**
 * Render two content areas side by side.
 */
export function renderSplitView(
  left: { title: string; content: string[] },
  right: { title: string; content: string[] },
  width: number,
  height: number,
): string[] {
  const gap = 2
  const panelWidth = Math.floor((width - gap) / 2)

  const leftBox = renderBox(left.content, panelWidth, { title: left.title })
  const rightBox = renderBox(right.content, panelWidth, { title: right.title })

  // Merge lines side by side
  const maxLines = Math.max(leftBox.length, rightBox.length)
  const lines: string[] = []

  for (let i = 0; i < maxLines; i++) {
    const leftLine = leftBox[i] || ' '.repeat(panelWidth)
    const rightLine = rightBox[i] || ''

    // Pad left line to fixed width
    const leftPlain = stripAnsi(leftLine)
    const leftPad = panelWidth - visibleLength(leftLine)
    const paddedLeft = leftLine + ' '.repeat(Math.max(0, leftPad))

    lines.push(`${paddedLeft}${' '.repeat(gap)}${rightLine}`)
  }

  return lines
}

/**
 * Render content in three columns.
 */
export function renderTripleView(
  panels: Array<{ title: string; content: string[] }>,
  width: number,
): string[] {
  if (panels.length !== 3) {
    throw new Error('renderTripleView requires exactly 3 panels')
  }

  const gap = 1
  const panelWidth = Math.floor((width - gap * 2) / 3)

  const boxes = panels.map((p) => renderBox(p.content, panelWidth, { title: p.title }))
  const maxLines = Math.max(...boxes.map((b) => b.length))

  const lines: string[] = []

  for (let i = 0; i < maxLines; i++) {
    const parts = boxes.map((box, idx) => {
      const line = box[i] || ''
      const plainLen = visibleLength(line)
      const pad = panelWidth - plainLen
      return line + ' '.repeat(Math.max(0, pad))
    })

    lines.push(parts.join(' '.repeat(gap)))
  }

  return lines
}

// ─── Transition Effects ───────────────────────────────────────

/**
 * Clear screen with a fade effect (progressive dim).
 */
export function fadeOutScreen(width: number, height: number): void {
  // Quick fade - just clear with a brief dim
  w(A.dim)
  for (let row = 1; row <= height; row++) {
    w(A.to(row, 1))
    w(' '.repeat(width))
  }
  w(A.reset)
  w(A.clear)
}

/**
 * Slide transition between views (left-to-right wipe).
 */
export function wipeTransition(width: number, height: number, durationMs: number = 100): Promise<void> {
  return new Promise((resolve) => {
    const steps = 10
    const stepWidth = Math.ceil(width / steps)
    const delay = durationMs / steps

    let step = 0
    const interval = setInterval(() => {
      const startCol = step * stepWidth + 1
      const endCol = Math.min((step + 1) * stepWidth, width)

      for (let row = 1; row <= height; row++) {
        w(A.to(row, startCol))
        w(' '.repeat(endCol - startCol + 1))
      }

      step++
      if (step >= steps) {
        clearInterval(interval)
        resolve()
      }
    }, delay)
  })
}

// ─── Layout Helpers ───────────────────────────────────────────

/**
 * Calculate optimal panel sizes for a given number of panels.
 */
export function calculatePanelLayout(
  panelCount: number,
  width: number,
  height: number,
  options: { maxColumns?: number; gap?: number } = {},
): Array<{ row: number; col: number; width: number; height: number }> {
  const { maxColumns = 2, gap = 1 } = options

  const columns = Math.min(maxColumns, panelCount)
  const rows = Math.ceil(panelCount / columns)

  const panelWidth = Math.floor((width - gap * (columns + 1)) / columns)
  const panelHeight = Math.floor((height - gap * (rows + 1)) / rows)

  const layout: Array<{ row: number; col: number; width: number; height: number }> = []

  for (let i = 0; i < panelCount; i++) {
    const panelRow = Math.floor(i / columns)
    const panelCol = i % columns

    layout.push({
      row: gap + panelRow * (panelHeight + gap) + 1,
      col: gap + panelCol * (panelWidth + gap) + 1,
      width: panelWidth,
      height: panelHeight,
    })
  }

  return layout
}

/**
 * Create a centered content area within the terminal.
 */
export function centerContent(
  content: string[],
  width: number,
  height: number,
): { row: number; col: number; lines: string[] } {
  const contentWidth = Math.max(...content.map((l) => visibleLength(l)))
  const contentHeight = content.length

  const startRow = Math.max(1, Math.floor((height - contentHeight) / 2))
  const startCol = Math.max(1, Math.floor((width - contentWidth) / 2))

  return {
    row: startRow,
    col: startCol,
    lines: content,
  }
}

// ─── Scroll Region Management ─────────────────────────────────

/**
 * Set the scrolling region (for keeping header/footer fixed).
 * Uses ANSI escape sequence: CSI top ; bottom r
 */
export function setScrollRegion(top: number, bottom: number): void {
  w(`\x1b[${top};${bottom}r`)
}

/**
 * Reset scroll region to full screen.
 */
export function resetScrollRegion(): void {
  w('\x1b[r')
}

/**
 * Save cursor position.
 */
export function saveCursor(): void {
  w('\x1b[s')
}

/**
 * Restore cursor position.
 */
export function restoreCursor(): void {
  w('\x1b[u')
}

// ─── Export singleton for convenience ─────────────────────────

export const viewManager = new ViewManager()
