import { A, C, CSI, w, stripAnsi, wrapText, visibleLength, displayWidth } from './ansi'
import { renderMarkdown } from './markdown'
import { InputHistory } from './history'
import { join } from 'node:path'
import {
  ViewManager,
  renderStatusBar,
  renderBox,
  renderSplitView,
  renderTable,
  setScrollRegion,
  resetScrollRegion,
  type ViewMode,
  type DashboardLayout,
  type DashboardPanel,
  type StatusBarConfig,
} from './tui/index'
import { eventBus } from './core/event-bus'
import type {
  ContextChangedEvent,
  TelemetryAlertEvent,
  TaskCompletedEvent,
  StatusUpdateEvent,
  SessionChangedEvent,
} from './types'

// ─── TUI ─────────────────────────────────────────────────────

interface Line {
  text: string
}

export type { ViewMode, DashboardLayout, DashboardPanel }

export class TUI {
  private width = 80
  private height = 24
  private lines: Line[] = []
  private streamBuf = ''
  private streamLines: Line[] = []
  private inputBuf = ''
  private inputPos = 0
  private isStreaming = false
  private scrollOffset = 0
  private history: InputHistory | null = null
  private renderTimer: ReturnType<typeof setTimeout> | null = null
  private spinnerFrame = 0
  private spinnerTimer: ReturnType<typeof setInterval> | null = null
  private streamStartTime = 0
  private sessionCost = ''

  // View mode state
  private viewMode: ViewMode = 'chat'
  private viewManager: ViewManager
  private dashboardContent: DashboardPanel[] = []
  private statusBarEnabled = true
  private inputTokens = 0
  private outputTokens = 0
  private activeProject = ''
  private vaultStatus: 'ok' | 'warn' | 'error' = 'ok'
  private stickyStatusRow = 0
  private commands = [
    // English
    '/help', '/clear', '/commit', '/persona', '/copy', '/fork',
    '/new', '/load', '/sessions', '/delete', '/model', '/export',
    '/cost', '/retry', '/undo', '/search', '/lang', '/config', '/exit',
    '/briefing', '/news', '/open', '/openfile', '/openurl', '/apps',
    '/sysinfo', '/calendar', '/ask', '/budget', '/plugins',
    '/task', '/tasks', '/done', '/rmtask',
    '/people', '/team', '/family', '/person', '/addperson',
    '/delegate', '/delegations', '/followups', '/dashboard', '/contacts',
    '/investigar', '/investigate', '/investigacoes',
    '/monitor', '/vigiar',
    '/workflow', '/fluxo',
    '/pomodoro', '/foco',
    '/entrada', '/saida', '/income', '/expense', '/finance', '/financas', '/balanco',
    '/decisions', '/decisoes',
    '/email', '/rascunho',
    '/memo', '/memos', '/note', '/notas', '/tags', '/memotags', '/rmmemo', '/rmnota',
    '/index', '/indexar', '/reindex', '/memory', '/memoria',
    '/clipboard', '/area', '/tela', '/screen', '/ps1',
    '/refresh', '/renovar', '/vault', '/backup',
    '/feeds', '/fontes', '/addfeed', '/novafonte', '/rmfeed', '/rmfonte',
    '/disablefeed', '/desativarfonte', '/enablefeed', '/ativarfonte',
    '/projeto', '/project', '/projetos', '/projects', '/sessao', '/session',
    '/relatorio', '/report', '/oportunidades', '/opportunities',
    // Portugues
    '/anotar', '/ajuda', '/limpar', '/commitar', '/modo', '/copiar',
    '/novo', '/carregar', '/sessoes', '/deletar', '/modelo', '/exportar',
    '/custo', '/repetir', '/desfazer', '/buscar', '/idioma', '/sair',
    '/resumo', '/noticias', '/abrir', '/programas', '/sistema',
    '/agenda', '/calendario', '/perguntar', '/orcamento',
    '/tarefa', '/tarefas', '/feito', '/concluido', '/rmtarefa',
    '/pessoas', '/equipe', '/familia', '/pessoa', '/novapessoa', '/addpessoa',
    '/delegar', '/delegacoes', '/delegados', '/painel', '/contatos',
  ]

  /** Subcommand/argument completions per command */
  private subcommands: Record<string, string[]> = {
    // Model selection
    '/model': ['haiku', 'sonnet', 'sonnet-4.6', 'opus', 'opus-4.6'],
    '/modelo': ['haiku', 'sonnet', 'sonnet-4.6', 'opus', 'opus-4.6'],
    // News categories
    '/news': ['business', 'tech', 'finance', 'brazil', 'world', 'security'],
    '/noticias': ['business', 'tech', 'finance', 'brazil', 'world', 'security'],
    // App launcher
    '/open': ['excel', 'word', 'powerpoint', 'outlook', 'onenote', 'teams', 'edge', 'chrome', 'firefox', 'calculator', 'notepad', 'terminal', 'explorer', 'vscode', 'cursor', 'paint', 'snip', 'settings', 'taskmanager'],
    '/abrir': ['excel', 'word', 'powerpoint', 'outlook', 'onenote', 'teams', 'edge', 'chrome', 'firefox', 'calculator', 'notepad', 'terminal', 'explorer', 'vscode', 'cursor', 'paint', 'snip', 'settings', 'taskmanager'],
    // Work sessions
    '/sessao': ['start', 'stop', 'status'],
    '/session': ['start', 'stop', 'status'],
    // Reports
    '/relatorio': ['today', 'week', 'month'],
    '/report': ['today', 'week', 'month'],
    // Project
    '/projeto': ['auto'],
    '/project': ['auto'],
    // Opportunities filter
    '/oportunidades': ['nova', 'em_analise', 'aceita', 'recusada', 'concluida'],
    '/opportunities': ['nova', 'em_analise', 'aceita', 'recusada', 'concluida'],
    // Persona
    '/persona': ['default', 'business'],
    '/modo': ['default', 'business'],
    // People groups
    '/people': ['equipe', 'familia', 'contato'],
    '/pessoas': ['equipe', 'familia', 'contato'],
    // Investigation types
    '/investigar': ['bug', 'feature', 'test', 'audit', 'incident'],
    '/investigate': ['bug', 'feature', 'test', 'audit', 'incident'],
    // Finance
    '/entrada': [],
    '/saida': [],
    // Language
    '/lang': ['pt', 'en', 'auto'],
    '/idioma': ['pt', 'en', 'auto'],
    // Pomodoro
    '/pomodoro': ['start', 'stop', 'status'],
    '/foco': ['start', 'stop', 'status'],
    // Monitor
    '/monitor': ['start', 'stop', 'list'],
    '/vigiar': ['start', 'stop', 'list'],
    // Workflow
    '/vault': ['status', 'backup', 'sync', 'init'],
    '/workflow': ['list', 'run', 'info', 'create', 'delete', 'enable', 'disable'],
    '/fluxo': ['list', 'run', 'info', 'create', 'delete', 'ativar', 'desativar'],
  }

  private onSubmit: ((s: string) => void) | null = null
  private onCancel: (() => void) | null = null
  private onExit: (() => void) | null = null
  private pickerActive = false
  private lastCtrlCTime = 0
  private eventUnsubscribers: Array<() => void> = []
  private statusBarContext = '' // Context info for status bar

  constructor(
    private model: string,
    private sessionName: string,
    private authInfo: string = '',
    private dataDir?: string,
  ) {
    this.viewManager = new ViewManager()
  }

  start(handlers: {
    onSubmit: (s: string) => void
    onCancel: () => void
    onExit: () => void
  }): void {
    this.onSubmit = handlers.onSubmit
    this.onCancel = handlers.onCancel
    this.onExit = handlers.onExit

    this.width = process.stdout.columns || 80
    this.height = process.stdout.rows || 24

    // Load input history
    if (this.dataDir) {
      this.history = new InputHistory(join(this.dataDir, 'history'))
    }

    // Subscribe to global events for reactive UI updates
    this.setupEventListeners()

    w(A.altOn)
    process.stdin.setRawMode?.(true)
    process.stdin.resume()
    process.stdin.on('data', (d: Buffer) => this.onKey(d))
    process.stdout.on('resize', () => this.onResize())

    this.render()
  }

  /**
   * Set up event bus listeners for reactive UI updates.
   * All listeners are synchronous to ensure immediate UI feedback.
   */
  private setupEventListeners(): void {
    // Context changed — update status bar with current directory
    this.eventUnsubscribers.push(
      eventBus.on('context:changed', (event: ContextChangedEvent) => {
        this.statusBarContext = event.foregroundWindow || ''
        this.renderHeader()
      }),
    )

    // Status updates — show system messages for important updates
    this.eventUnsubscribers.push(
      eventBus.on('status:update', (event: StatusUpdateEvent) => {
        const prefix = event.level === 'error' ? C.err
          : event.level === 'warning' ? C.prompt
          : event.level === 'success' ? C.sys
          : A.dim
        this.lines.push({
          text: `  ${prefix}[${event.source}]${A.reset} ${event.message}`,
        })
        // Only render if not streaming to avoid disrupting output
        if (!this.isStreaming) {
          this.renderMessages()
        }
      }),
    )

    // Telemetry alerts — show warnings for cost/token limits
    this.eventUnsubscribers.push(
      eventBus.on('telemetry:alert', (event: TelemetryAlertEvent) => {
        if (event.alertType === 'cost_warning') {
          this.lines.push({
            text: `  ${C.prompt}⚠ ${event.message}${A.reset}`,
          })
        } else if (event.alertType === 'rate_limit') {
          this.lines.push({
            text: `  ${C.err}⚠ Rate limit: ${event.message}${A.reset}`,
          })
        } else {
          this.lines.push({
            text: `  ${A.dim}[telemetry] ${event.message}${A.reset}`,
          })
        }
        if (!this.isStreaming) {
          this.renderMessages()
        }
      }),
    )

    // Task completed — show completion messages for background tasks
    this.eventUnsubscribers.push(
      eventBus.on('task:completed', (event: TaskCompletedEvent) => {
        // Only show notifications for certain task types
        if (event.taskType === 'backup' && event.success) {
          this.lines.push({
            text: `  ${A.dim}[backup] ${event.message || 'Backup concluido'}${A.reset}`,
          })
        } else if (event.taskType === 'pomodoro') {
          this.lines.push({
            text: `  ${C.sys}[pomodoro] ${event.message}${A.reset}`,
          })
        } else if (!event.success && event.message) {
          this.lines.push({
            text: `  ${C.err}[${event.taskType}] ${event.message}${A.reset}`,
          })
        }
        if (!this.isStreaming) {
          this.renderMessages()
        }
      }),
    )

    // Session changed — update session name in header
    this.eventUnsubscribers.push(
      eventBus.on('session:changed', (event: SessionChangedEvent) => {
        this.sessionName = event.currentSession
        this.renderHeader()
      }),
    )
  }

  /**
   * Clean up event listeners.
   */
  private cleanupEventListeners(): void {
    for (const unsub of this.eventUnsubscribers) {
      unsub()
    }
    this.eventUnsubscribers = []
  }

  stop(): void {
    this.stopSpinner()
    this.cleanupEventListeners()
    if (this.renderTimer) clearTimeout(this.renderTimer)
    process.stdin.setRawMode?.(false)
    process.stdin.pause()
    w(A.show)
    w(A.altOff)
  }

  // ── Public API ──────────────────────────────────────────

  addUserMessage(content: string): void {
    this.addLabel('user')
    this.addWrapped(content)
    this.lines.push({ text: '' })
  }

  addAssistantMessage(content: string): void {
    this.addLabel('assistant')
    this.addMarkdown(content)
    this.lines.push({ text: '' })
  }

  startStream(): void {
    this.isStreaming = true
    this.streamBuf = ''
    this.streamLines = []
    this.streamStartTime = Date.now()
    this.addLabel('assistant')
    this.startSpinner()
    this.renderAll()
  }

  appendStream(text: string): void {
    this.streamBuf += text
    // Debounce markdown re-render to 50ms to avoid lag
    if (!this.renderTimer) {
      this.renderTimer = setTimeout(() => {
        this.renderTimer = null
        this.streamLines = renderMarkdown(this.streamBuf).map((t) => ({ text: t }))
        this.renderMessages()
        this.renderInput()
      }, 50)
    }
  }

  flushStream(): void {
    if (this.streamLines.length > 0) {
      this.lines.push(...this.streamLines)
      this.streamLines = []
      this.streamBuf = ''
    }
  }

  resetStreamBuffer(): void {
    this.streamBuf = ''
    this.streamLines = []
  }

  endStream(): void {
    this.stopSpinner()
    // Flush any pending debounced render
    if (this.renderTimer) {
      clearTimeout(this.renderTimer)
      this.renderTimer = null
      this.streamLines = renderMarkdown(this.streamBuf).map((t) => ({ text: t }))
    }
    this.lines.push(...this.streamLines)
    this.lines.push({ text: '' })
    this.streamBuf = ''
    this.streamLines = []
    this.isStreaming = false
    this.scrollOffset = 0
    this.renderAll()
  }

  showToolCall(name: string, input: unknown): void {
    const inp = input as Record<string, unknown>
    let summary: string
    switch (name) {
      case 'read_file':
        summary = String(inp.path || '')
        if (inp.offset) summary += `:${inp.offset}`
        break
      case 'write_file':
      case 'edit_file':
        summary = String(inp.path || '')
        break
      case 'search_files':
        summary = `/${inp.pattern || ''}/`
        if (inp.include) summary += ` (${inp.include})`
        break
      case 'find_files':
        summary = String(inp.pattern || '')
        break
      case 'list_directory':
        summary = String(inp.path || '.')
        break
      case 'run_command':
        summary = String(inp.command || '')
        if (summary.length > 80) summary = summary.slice(0, 77) + '...'
        break
      default: {
        const s = JSON.stringify(inp)
        summary = s.length > 80 ? s.slice(0, 77) + '...' : s
      }
    }
    this.lines.push({
      text: `  ${C.tool}⚙ ${name}${A.reset} ${A.dim}${summary}${A.reset}`,
    })
    this.renderMessages()
  }

  showToolResult(name: string, result: string): void {
    const lines = result.split('\n')
    const maxLines = 8
    const shown = lines.slice(0, maxLines)

    for (const line of shown) {
      const trimmed = line.length > this.width - 6
        ? line.slice(0, this.width - 9) + '...'
        : line
      this.lines.push({
        text: `  ${A.dim}${trimmed}${A.reset}`,
      })
    }
    if (lines.length > maxLines) {
      this.lines.push({
        text: `  ${A.dim}... (${lines.length - maxLines} more lines)${A.reset}`,
      })
    }
    this.renderMessages()
  }

  /**
   * Prompt user for tool approval. Returns a promise resolved when user presses y/n/a.
   * Shows the operation and waits for single keypress.
   */
  promptApproval(description: string): Promise<boolean> {
    this.lines.push({
      text: `  ${C.prompt}? ${description}${A.reset}  ${A.dim}[y]es / [n]o / [a]ll${A.reset}`,
    })
    this.renderAll()

    return new Promise<boolean>((resolve) => {
      const handler = (data: Buffer) => {
        const key = data.toString().toLowerCase()
        if (key === 'y' || key === '\r' || key === '\n') {
          process.stdin.removeListener('data', handler)
          this.lines.push({ text: `  ${C.sys}approved${A.reset}` })
          this.renderAll()
          resolve(true)
        } else if (key === 'n' || key === '\x1b') {
          process.stdin.removeListener('data', handler)
          this.lines.push({ text: `  ${C.err}rejected${A.reset}` })
          this.renderAll()
          resolve(false)
        } else if (key === 'a') {
          process.stdin.removeListener('data', handler)
          this.lines.push({ text: `  ${C.sys}approved all for this session${A.reset}` })
          this.renderAll()
          // Signal to caller that "approve all" was selected
          this._approveAllRequested = true
          resolve(true)
        }
      }
      process.stdin.on('data', handler)

      // Timeout after 30s — auto-reject
      setTimeout(() => {
        process.stdin.removeListener('data', handler)
        this.lines.push({ text: `  ${A.dim}timeout — auto-rejected${A.reset}` })
        this.renderAll()
        resolve(false)
      }, 30_000)
    })
  }

  /** Flag set when user presses 'a' for approve-all */
  _approveAllRequested = false

  // ── Session Picker ──────────────────────────────────────

  /**
   * Interactive session picker. Renders a navigable list over the message area.
   * Returns the selected action or null if cancelled.
   */
  promptSessionPicker(
    entries: SessionPickerEntry[],
  ): Promise<SessionPickerResult | null> {
    if (entries.length === 0) {
      this.showSystem('No sessions found.')
      return Promise.resolve(null)
    }

    return new Promise<SessionPickerResult | null>((resolve) => {
      this.pickerActive = true
      let cursor = entries.findIndex((e) => e.isCurrent)
      if (cursor < 0) cursor = 0
      let filter = ''
      let filterMode = false

      const filtered = (): SessionPickerEntry[] => {
        if (!filter) return entries
        const q = filter.toLowerCase()
        return entries.filter((e) => e.name.toLowerCase().includes(q))
      }

      const renderPicker = (): void => {
        const headerH = 2
        const footerH = 2
        const avail = this.height - headerH - footerH

        const items = filtered()
        if (cursor >= items.length) cursor = Math.max(0, items.length - 1)

        // Calculate visible window (scroll if list exceeds available space)
        const titleLines = 2 // title + blank
        const hintLines = 2  // blank + hints
        const listAvail = avail - titleLines - hintLines
        const maxVisible = Math.max(1, listAvail)

        let scrollStart = 0
        if (items.length > maxVisible) {
          scrollStart = Math.max(0, cursor - Math.floor(maxVisible / 2))
          scrollStart = Math.min(scrollStart, items.length - maxVisible)
        }
        const visibleItems = items.slice(scrollStart, scrollStart + maxVisible)

        w(A.hide)
        // Title
        w(A.to(headerH + 1, 1))
        w(A.clearLine)
        if (filterMode) {
          w(`  ${C.heading}${A.bold}Sessions${A.reset}  ${A.dim}filter: ${filter}█${A.reset}`)
        } else {
          w(`  ${C.heading}${A.bold}Sessions${A.reset}  ${A.dim}(${items.length})${A.reset}`)
        }
        w(A.to(headerH + 2, 1))
        w(A.clearLine)

        // List
        for (let i = 0; i < maxVisible; i++) {
          const row = headerH + titleLines + i + 1
          w(A.to(row, 1))
          w(A.clearLine)
          if (i >= visibleItems.length) continue

          const entry = visibleItems[i]
          const idx = scrollStart + i
          const isSelected = idx === cursor
          const marker = entry.isCurrent ? '*' : ' '
          const archLabel = entry.isArchived ? `${A.dim}[arch] ${A.reset}` : '       '
          const msgs = `${entry.messageCount} msgs`.padEnd(10)
          const age = formatPickerAge(entry.updated)

          if (isSelected) {
            w(`  ${C.prompt}${A.bold}› ${marker} ${archLabel}${C.prompt}${A.bold}${entry.name.padEnd(20)}${A.reset} ${A.dim}${msgs} ${age}${A.reset}`)
          } else {
            const nameColor = entry.isArchived ? A.dim : C.sys
            w(`    ${marker} ${archLabel}${nameColor}${entry.name.padEnd(20)}${A.reset} ${A.dim}${msgs} ${age}${A.reset}`)
          }
        }

        // Clear remaining rows
        for (let i = visibleItems.length; i < maxVisible; i++) {
          const row = headerH + titleLines + i + 1
          w(A.to(row, 1))
          w(A.clearLine)
        }

        // Scroll indicator
        const indicatorRow = headerH + titleLines + maxVisible + 1
        w(A.to(indicatorRow, 1))
        w(A.clearLine)
        if (items.length > maxVisible) {
          const pct = Math.round(((cursor + 1) / items.length) * 100)
          w(`  ${A.dim}${scrollStart > 0 ? '↑' : ' '} ${pct}% ${scrollStart + maxVisible < items.length ? '↓' : ' '}${A.reset}`)
        }

        // Hints
        const hintRow = this.height - footerH
        w(A.to(hintRow, 1))
        w(A.clearLine)
        w(`  ${A.dim}W/S or ↑↓ navigate  Enter select  Esc cancel  / filter  d delete  a archive${A.reset}`)
      }

      const cleanup = (result: SessionPickerResult | null): void => {
        this.pickerActive = false
        process.stdin.removeListener('data', handler)
        // Restore message area
        this.renderAll()
        resolve(result)
      }

      const handler = (data: Buffer): void => {
        const key = data.toString('utf-8')
        const items = filtered()

        // Esc — exit filter mode or cancel picker
        if (key === '\x1b' && data.length === 1) {
          if (filterMode) {
            filterMode = false
            filter = ''
            renderPicker()
          } else {
            cleanup(null)
          }
          return
        }

        // Ctrl+C — cancel
        if (key === '\x03') {
          cleanup(null)
          return
        }

        // Enter — select
        if (key === '\r' || key === '\n') {
          if (items.length > 0 && cursor < items.length) {
            cleanup({ action: 'load', name: items[cursor].name })
          }
          return
        }

        // Arrow keys + W/S navigation
        if (key === '\x1b[A' || (key === 'w' && !filterMode)) { // Up
          if (cursor > 0) { cursor--; renderPicker() }
          return
        }
        if (key === '\x1b[B' || (key === 's' && !filterMode)) { // Down
          if (cursor < items.length - 1) { cursor++; renderPicker() }
          return
        }

        // 'd' — delete (only outside filter mode)
        if (key === 'd' && filterMode === false) {
          if (items.length > 0 && cursor < items.length) {
            const entry = items[cursor]
            if (!entry.isCurrent) {
              cleanup({ action: 'delete', name: entry.name, isArchived: entry.isArchived })
            }
          }
          return
        }

        // 'a' — archive/unarchive (only outside filter mode)
        if (key === 'a' && filterMode === false) {
          if (items.length > 0 && cursor < items.length) {
            const entry = items[cursor]
            if (!entry.isCurrent) {
              const action = entry.isArchived ? 'unarchive' : 'archive'
              cleanup({ action, name: entry.name })
            }
          }
          return
        }

        // '/' — toggle filter mode
        if (key === '/' && filterMode === false) {
          filterMode = true
          filter = ''
          renderPicker()
          return
        }

        // In filter mode, handle typing
        if (filterMode) {
          // Backspace in filter
          if (key === '\x7f' || key === '\b') {
            if (filter.length > 0) {
              filter = filter.slice(0, -1)
              cursor = 0
              renderPicker()
            } else {
              // Exit filter mode on backspace with empty filter
              filterMode = false
              renderPicker()
            }
            return
          }
          // Printable char in filter
          if (key.length === 1 && key >= ' ') {
            filter += key
            cursor = 0
            renderPicker()
            return
          }
        }
      }

      process.stdin.on('data', handler)
      renderPicker()
    })
  }

  // ── News Picker ────────────────────────────────────────────

  /**
   * Interactive news picker. Navigate with W/S or arrows, Enter to open in browser.
   * Returns the selected item's link or null if cancelled.
   */
  promptNewsPicker(
    items: NewsPickerEntry[],
  ): Promise<string | null> {
    if (items.length === 0) {
      this.showSystem('Nenhuma noticia encontrada.')
      return Promise.resolve(null)
    }

    return new Promise<string | null>((resolve) => {
      this.pickerActive = true
      let cursor = 0
      let filter = ''
      let filterMode = false
      let categoryFilter = ''

      const categories = [...new Set(items.map((i) => i.category))].sort()

      const filtered = (): NewsPickerEntry[] => {
        let result = categoryFilter
          ? items.filter((i) => i.category === categoryFilter)
          : items
        if (filter) {
          const q = filter.toLowerCase()
          result = result.filter((i) =>
            i.title.toLowerCase().includes(q) || i.source.toLowerCase().includes(q),
          )
        }
        return result
      }

      const categoryLabel = (cat: string): string => {
        const labels: Record<string, string> = {
          business: 'Negocios', tech: 'Tecnologia', finance: 'Financas',
          brazil: 'Brasil', world: 'Mundo', security: 'Ciberseguranca',
        }
        return labels[cat] || cat
      }

      const renderPicker = (): void => {
        const headerH = 2
        const footerH = 2
        const avail = this.height - headerH - footerH

        const list = filtered()
        if (cursor >= list.length) cursor = Math.max(0, list.length - 1)

        const titleLines = 2
        const hintLines = 2
        const listAvail = avail - titleLines - hintLines
        const maxVisible = Math.max(1, listAvail)

        let scrollStart = 0
        if (list.length > maxVisible) {
          scrollStart = Math.max(0, cursor - Math.floor(maxVisible / 2))
          scrollStart = Math.min(scrollStart, list.length - maxVisible)
        }
        const visibleItems = list.slice(scrollStart, scrollStart + maxVisible)

        w(A.hide)
        // Title
        w(A.to(headerH + 1, 1))
        w(A.clearLine)
        if (filterMode) {
          w(`  ${C.heading}${A.bold}Noticias${A.reset}  ${A.dim}filtro: ${filter}█${A.reset}`)
        } else {
          const catLabel = categoryFilter ? categoryLabel(categoryFilter) : 'Todas'
          w(`  ${C.heading}${A.bold}Noticias${A.reset}  ${A.dim}(${list.length}) ${catLabel}${A.reset}`)
        }
        w(A.to(headerH + 2, 1))
        w(A.clearLine)

        // List
        for (let i = 0; i < maxVisible; i++) {
          const row = headerH + titleLines + i + 1
          w(A.to(row, 1))
          w(A.clearLine)
          if (i >= visibleItems.length) continue

          const entry = visibleItems[i]
          const isSelected = (scrollStart + i) === cursor
          const time = entry.time ? `[${entry.time}]` : '       '
          const maxTitleW = this.width - 30
          const title = entry.title.length > maxTitleW
            ? entry.title.slice(0, maxTitleW - 1) + '\u2026'
            : entry.title

          if (isSelected) {
            w(`  ${C.prompt}${A.bold}› ${time} ${title}${A.reset} ${A.dim}(${entry.source})${A.reset}`)
          } else {
            w(`    ${A.dim}${time}${A.reset} ${C.sys}${title}${A.reset} ${A.dim}(${entry.source})${A.reset}`)
          }
        }

        // Clear remaining
        for (let i = visibleItems.length; i < maxVisible; i++) {
          const row = headerH + titleLines + i + 1
          w(A.to(row, 1))
          w(A.clearLine)
        }

        // Scroll indicator
        const indicatorRow = headerH + titleLines + maxVisible + 1
        w(A.to(indicatorRow, 1))
        w(A.clearLine)
        if (list.length > maxVisible) {
          const pct = Math.round(((cursor + 1) / list.length) * 100)
          w(`  ${A.dim}${scrollStart > 0 ? '\u2191' : ' '} ${pct}% ${scrollStart + maxVisible < list.length ? '\u2193' : ' '}${A.reset}`)
        }

        // Hints
        const hintRow = this.height - footerH
        w(A.to(hintRow, 1))
        w(A.clearLine)
        w(`  ${A.dim}W/S or \u2191\u2193 navigate  Enter open  Esc cancel  / filter  Tab category${A.reset}`)
      }

      const cleanup = (result: string | null): void => {
        this.pickerActive = false
        process.stdin.removeListener('data', handler)
        this.renderAll()
        resolve(result)
      }

      const handler = (data: Buffer): void => {
        const key = data.toString('utf-8')
        const list = filtered()

        // Esc
        if (key === '\x1b' && data.length === 1) {
          if (filterMode) {
            filterMode = false
            filter = ''
            renderPicker()
          } else {
            cleanup(null)
          }
          return
        }

        // Ctrl+C
        if (key === '\x03') {
          cleanup(null)
          return
        }

        // Enter — open link
        if (key === '\r' || key === '\n') {
          if (list.length > 0 && cursor < list.length) {
            cleanup(list[cursor].link)
          }
          return
        }

        // Arrow keys + W/S navigation
        if (key === '\x1b[A' || (key === 'w' && !filterMode)) {
          if (cursor > 0) { cursor--; renderPicker() }
          return
        }
        if (key === '\x1b[B' || (key === 's' && !filterMode)) {
          if (cursor < list.length - 1) { cursor++; renderPicker() }
          return
        }

        // Tab — cycle category filter
        if (key === '\t') {
          if (!categoryFilter) {
            categoryFilter = categories[0] || ''
          } else {
            const idx = categories.indexOf(categoryFilter)
            categoryFilter = idx < categories.length - 1 ? categories[idx + 1] : ''
          }
          cursor = 0
          renderPicker()
          return
        }

        // '/' — toggle filter mode
        if (key === '/' && !filterMode) {
          filterMode = true
          filter = ''
          renderPicker()
          return
        }

        // Filter mode typing
        if (filterMode) {
          if (key === '\x7f' || key === '\b') {
            if (filter.length > 0) {
              filter = filter.slice(0, -1)
              cursor = 0
              renderPicker()
            } else {
              filterMode = false
              renderPicker()
            }
            return
          }
          if (key.length === 1 && key >= ' ') {
            filter += key
            cursor = 0
            renderPicker()
            return
          }
        }
      }

      process.stdin.on('data', handler)
      renderPicker()
    })
  }

  showUsage(msg: string): void {
    this.lines.push({ text: `  ${A.dim}tokens: ${msg}${A.reset}` })
    this.renderAll()
  }

  updateSessionCost(cost: string): void {
    this.sessionCost = cost
    this.renderHeader()
  }

  showError(msg: string): void {
    this.lines.push({ text: `  ${C.err}✗ ${msg}${A.reset}` })
    this.lines.push({ text: '' })
    this.renderAll()
  }

  showSystem(msg: string): void {
    for (const line of msg.split('\n')) {
      this.lines.push({ text: `  ${C.sys}${line}${A.reset}` })
    }
    this.lines.push({ text: '' })
    this.renderAll()
  }

  clearMessages(): void {
    this.lines = []
    this.renderAll()
  }

  updateModel(m: string): void {
    this.model = m
    this.renderHeader()
  }

  updateSession(s: string): void {
    this.sessionName = s
    this.renderHeader()
  }

  enableInput(): void {
    this.inputBuf = ''
    this.inputPos = 0
    this.isStreaming = false
    this.history?.reset()
    this.renderInput()
  }

  disableInput(): void {
    w(A.hide)
  }

  // ── View Mode API ─────────────────────────────────────────

  /**
   * Get current view mode.
   */
  getViewMode(): ViewMode {
    return this.viewMode
  }

  /**
   * Switch to chat mode (normal conversation view).
   */
  enterChatMode(): void {
    if (this.viewMode === 'chat') return

    this.viewMode = 'chat'
    this.viewManager.enterChatMode()
    resetScrollRegion()
    this.render()
  }

  /**
   * Switch to dashboard mode with custom panels.
   */
  enterDashboardMode(layout: DashboardLayout): void {
    this.viewMode = 'dashboard'
    this.dashboardContent = layout.panels
    this.viewManager.enterDashboardMode(layout)

    // Set scroll region to protect header and footer
    setScrollRegion(3, this.height - 2)

    this.renderDashboard()
  }

  /**
   * Update dashboard content without full re-render.
   */
  updateDashboardPanel(panelId: string, content: string[]): void {
    const panel = this.dashboardContent.find((p) => p.id === panelId)
    if (panel) {
      panel.content = content
      if (this.viewMode === 'dashboard') {
        this.renderDashboard()
      }
    }
  }

  /**
   * Update the sticky status bar info.
   */
  updateStatusBar(info: {
    project?: string
    inputTokens?: number
    outputTokens?: number
    vaultStatus?: 'ok' | 'warn' | 'error'
  }): void {
    if (info.project !== undefined) this.activeProject = info.project
    if (info.inputTokens !== undefined) this.inputTokens = info.inputTokens
    if (info.outputTokens !== undefined) this.outputTokens = info.outputTokens
    if (info.vaultStatus !== undefined) this.vaultStatus = info.vaultStatus

    this.renderStickyStatusBar()
  }

  /**
   * Enable or disable the sticky status bar.
   */
  setStatusBarEnabled(enabled: boolean): void {
    this.statusBarEnabled = enabled
    this.render()
  }

  // ── Dashboard Rendering ───────────────────────────────────

  private renderDashboard(): void {
    w(A.hide)
    w(A.clear)

    // Header
    this.renderHeader()

    // Calculate panel layout
    const headerH = 2
    const footerH = 2 + (this.statusBarEnabled ? 1 : 0)
    const contentHeight = this.height - headerH - footerH

    const panels = this.dashboardContent
    const columns = Math.min(2, panels.length)
    const rows = Math.ceil(panels.length / columns)
    const gap = 1

    const panelWidth = Math.floor((this.width - gap * (columns + 1)) / columns)
    const panelHeight = Math.floor((contentHeight - gap * (rows + 1)) / rows)

    let panelIdx = 0
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < columns && panelIdx < panels.length; col++) {
        const panel = panels[panelIdx]
        const startRow = headerH + gap + row * (panelHeight + gap) + 1
        const startCol = gap + col * (panelWidth + gap) + 1

        this.drawDashboardPanel(panel, startRow, startCol, panelWidth, panelHeight)
        panelIdx++
      }
    }

    // Sticky status bar
    if (this.statusBarEnabled) {
      this.renderStickyStatusBar()
    }

    // Input line
    this.renderInput()
    w(A.show)
  }

  private drawDashboardPanel(
    panel: DashboardPanel,
    row: number,
    col: number,
    width: number,
    height: number,
  ): void {
    // Draw panel border
    const boxLines = renderBox(
      panel.content.slice(0, height - 2),
      width,
      { title: panel.title, borderColor: A.dim, titleColor: C.heading },
    )

    for (let i = 0; i < boxLines.length && i < height; i++) {
      w(A.to(row + i, col))
      w(boxLines[i])
    }
  }

  private renderStickyStatusBar(): void {
    if (!this.statusBarEnabled) return

    const statusRow = this.height - 2
    this.stickyStatusRow = statusRow

    const config: StatusBarConfig = {
      model: this.model,
      project: this.activeProject || undefined,
      tokens: { input: this.inputTokens, output: this.outputTokens },
      sessionCost: this.sessionCost || undefined,
      vaultStatus: this.vaultStatus,
    }

    w(A.to(statusRow, 1))
    w(renderStatusBar(config, this.width))
  }

  // ── Rendering ───────────────────────────────────────────

  private render(): void {
    // Route to appropriate render based on view mode
    if (this.viewMode === 'dashboard') {
      this.renderDashboard()
      return
    }

    w(A.hide)
    w(A.clear)
    this.renderHeader()
    this.renderMessages()

    // Render sticky status bar in chat mode if enabled
    if (this.statusBarEnabled) {
      this.renderStickyStatusBar()
    }

    this.renderInput()
    w(A.show)
  }

  private renderAll(): void {
    if (this.viewMode === 'dashboard') {
      this.renderDashboard()
      return
    }

    this.renderMessages()

    if (this.statusBarEnabled) {
      this.renderStickyStatusBar()
    }

    this.renderInput()
  }

  private renderHeader(): void {
    w(A.to(1, 1))
    w(A.inv)
    const left = ' smolerclaw'
    const parts = [this.model, this.sessionName]
    if (this.sessionCost) parts.push(this.sessionCost)
    if (this.authInfo) parts.push(this.authInfo)
    const right = parts.join(' | ') + ' '
    const pad = Math.max(1, this.width - left.length - right.length)
    w(left + ' '.repeat(pad) + right)
    w(A.reset)

    w(A.to(2, 1))
    w(`${A.dim}${'─'.repeat(this.width)}${A.reset}`)
  }

  private renderMessages(): void {
    const headerH = 2
    // Account for status bar when enabled
    const statusBarH = this.statusBarEnabled ? 1 : 0
    const footerH = 2 + statusBarH
    const avail = this.height - headerH - footerH

    const allLines = [...this.lines, ...this.streamLines]
    const total = allLines.length
    const start = Math.max(0, total - avail - this.scrollOffset)
    const end = Math.min(total, start + avail)
    const visible = allLines.slice(start, end)

    w(A.hide)
    for (let i = 0; i < avail; i++) {
      w(A.to(headerH + i + 1, 1))
      w(A.clearLine)
      if (i < visible.length) {
        const plain = stripAnsi(visible[i].text)
        if (plain.length > this.width) {
          // Truncate but try to preserve ANSI reset at end
          w(visible[i].text.slice(0, this.width + (visible[i].text.length - plain.length)))
          w(A.reset)
        } else {
          w(visible[i].text)
        }
      }
    }
  }

  /**
   * Complete a partial input. Handles both command and subcommand completion.
   * Returns the completed value and optional list of matches to display.
   */
  private completeInput(input: string): { value: string; options?: string } | null {
    const parts = input.split(' ')
    const cmd = parts[0]

    // Phase 1: completing the command itself (no space yet)
    if (parts.length === 1) {
      const matches = this.commands.filter((c) => c.startsWith(cmd))
      if (matches.length === 1) {
        // Check if this command has subcommands
        const sub = this.subcommands[matches[0]]
        if (sub && sub.length > 0) {
          return { value: matches[0] + ' ', options: `Opcoes: ${sub.join('  ')}` }
        }
        return { value: matches[0] + ' ' }
      }
      if (matches.length > 1) {
        let prefix = matches[0]
        for (const m of matches) {
          while (!m.startsWith(prefix)) prefix = prefix.slice(0, -1)
        }
        return {
          value: prefix.length > input.length ? prefix : input,
          options: matches.join('  '),
        }
      }
      return null
    }

    // Phase 2: completing a subcommand/argument
    const sub = this.subcommands[cmd]
    if (!sub || sub.length === 0) return null

    const partial = parts[parts.length - 1].toLowerCase()
    const matches = sub.filter((s) => s.toLowerCase().startsWith(partial))

    if (matches.length === 1) {
      parts[parts.length - 1] = matches[0]
      return { value: parts.join(' ') + ' ' }
    }
    if (matches.length > 1) {
      // Find common prefix among matches
      let prefix = matches[0]
      for (const m of matches) {
        while (!m.toLowerCase().startsWith(prefix.toLowerCase())) prefix = prefix.slice(0, -1)
      }
      if (prefix.length > partial.length) {
        parts[parts.length - 1] = prefix
        return { value: parts.join(' '), options: matches.join('  ') }
      }
      return { value: input, options: matches.join('  ') }
    }

    // No matches — show all options if partial is empty
    if (!partial && sub.length > 0) {
      return { value: input, options: sub.join('  ') }
    }

    return null
  }

  private renderInput(): void {
    const sepRow = this.height - 1
    const inputRow = this.height

    w(A.to(sepRow, 1))
    w(A.clearLine)
    w(`${A.dim}${'─'.repeat(this.width)}${A.reset}`)

    w(A.to(inputRow, 1))
    w(A.clearLine)

    if (this.isStreaming) {
      const elapsed = ((Date.now() - this.streamStartTime) / 1000).toFixed(1)
      w(`  ${C.ai}${this.getSpinnerChar()}${A.reset} ${A.dim}streaming... ${elapsed}s${A.reset}`)
      w(A.hide)
    } else {
      const display = visibleLength(this.inputBuf) > this.width - 3
        ? this.inputBuf.slice(this.inputBuf.length - this.width + 3)
        : this.inputBuf
      w(`${C.prompt}❯${A.reset} ${display}`)
      // Unicode-aware cursor: compute display width of chars before cursor
      const beforeCursor = this.inputBuf.slice(0, this.inputPos)
      const cursorCol = visibleLength(beforeCursor) + 3
      w(A.to(inputRow, Math.min(cursorCol, this.width)))
      w(A.show)
    }
  }

  // ── Input Handling ──────────────────────────────────────

  private onKey(data: Buffer): void {
    // Suppress main input while a picker (sessions/news) is active
    if (this.pickerActive) return

    const key = data.toString('utf-8')

    // Ctrl+C — clear input first, double-tap to exit
    if (key === '\x03') {
      if (this.isStreaming) {
        this.onCancel?.()
        return
      }

      const now = Date.now()
      const DOUBLE_TAP_MS = 1500

      if (this.inputBuf.length > 0) {
        // First: clear the input field
        this.inputBuf = ''
        this.inputPos = 0
        this.lastCtrlCTime = now
        this.renderInput()
        return
      }

      // Input already empty — check for double-tap
      if (now - this.lastCtrlCTime < DOUBLE_TAP_MS) {
        this.onExit?.()
        return
      }

      // First tap with empty input — show hint and record time
      this.lastCtrlCTime = now
      this.showSystem('Pressione Ctrl+C novamente para sair.')
      return
    }

    // Ctrl+D
    if (key === '\x04') {
      this.onExit?.()
      return
    }

    // Ctrl+L — redraw
    if (key === '\x0c') {
      this.render()
      return
    }

    // Ignore input during streaming
    if (this.isStreaming) return

    // Tab — command + subcommand completion
    if (key === '\t') {
      if (this.inputBuf.startsWith('/')) {
        const completed = this.completeInput(this.inputBuf)
        if (completed) {
          this.inputBuf = completed.value
          this.inputPos = this.inputBuf.length
          this.renderInput()
          if (completed.options) {
            this.showSystem(completed.options)
          }
        }
      }
      return
    }

    // Paste detection: multi-char input that isn't an escape sequence
    // Covers both newline-containing pastes and plain text pastes
    if (key.length > 1 && !key.startsWith('\x1b') && !isSingleUnicodeChar(key)) {
      const cleaned = key.replace(/\r?\n/g, ' ').trim()
      if (cleaned.length > 0) {
        this.inputBuf =
          this.inputBuf.slice(0, this.inputPos) +
          cleaned +
          this.inputBuf.slice(this.inputPos)
        this.inputPos += cleaned.length
        this.renderInput()
      }
      return
    }

    // Enter
    if (key === '\r' || key === '\n') {
      // Backslash continuation for multi-line
      if (this.inputBuf.endsWith('\\')) {
        this.inputBuf = this.inputBuf.slice(0, -1) + '\n'
        this.inputPos = this.inputBuf.length
        this.renderInput()
        return
      }

      const input = this.inputBuf.trim()
      if (input) {
        this.history?.add(input)
        this.inputBuf = ''
        this.inputPos = 0
        this.scrollOffset = 0
        this.onSubmit?.(input)
      }
      return
    }

    // Backspace
    if (key === '\x7f' || key === '\b') {
      if (this.inputPos > 0) {
        const charLen = prevCharLength(this.inputBuf, this.inputPos)
        this.inputBuf =
          this.inputBuf.slice(0, this.inputPos - charLen) +
          this.inputBuf.slice(this.inputPos)
        this.inputPos -= charLen
        this.renderInput()
      }
      return
    }

    // Escape sequences
    if (key.startsWith('\x1b[')) {
      const code = key.slice(2)
      switch (code) {
        case 'D': // Left
          if (this.inputPos > 0) {
            this.inputPos -= prevCharLength(this.inputBuf, this.inputPos)
            this.renderInput()
          }
          break
        case 'C': // Right
          if (this.inputPos < this.inputBuf.length) {
            this.inputPos += nextCharLength(this.inputBuf, this.inputPos)
            this.renderInput()
          }
          break
        case 'A': { // Up — input history
          const prev = this.history?.prev(this.inputBuf)
          if (prev !== null && prev !== undefined) {
            this.inputBuf = prev
            this.inputPos = this.inputBuf.length
            this.renderInput()
          }
          break
        }
        case 'B': { // Down — input history
          const next = this.history?.next()
          if (next !== undefined) {
            this.inputBuf = next
            this.inputPos = this.inputBuf.length
            this.renderInput()
          }
          break
        }
        case '5~': // PageUp — scroll messages up
          if (this.scrollOffset < this.lines.length) {
            this.scrollOffset = Math.min(this.scrollOffset + 5, this.lines.length)
            this.renderMessages()
          }
          break
        case '6~': // PageDown — scroll messages down
          if (this.scrollOffset > 0) {
            this.scrollOffset = Math.max(0, this.scrollOffset - 5)
            this.renderMessages()
          }
          break
        case 'H': // Home
          this.inputPos = 0
          this.renderInput()
          break
        case 'F': // End
          this.inputPos = this.inputBuf.length
          this.renderInput()
          break
        case '3~': { // Delete
          if (this.inputPos < this.inputBuf.length) {
            const charLen = nextCharLength(this.inputBuf, this.inputPos)
            this.inputBuf =
              this.inputBuf.slice(0, this.inputPos) +
              this.inputBuf.slice(this.inputPos + charLen)
            this.renderInput()
          }
          break
        }
      }
      return
    }

    // Regular printable characters (including multi-byte Unicode like ç, ã, é)
    if (isPrintable(key)) {
      this.inputBuf =
        this.inputBuf.slice(0, this.inputPos) +
        key +
        this.inputBuf.slice(this.inputPos)
      this.inputPos += key.length
      this.renderInput()
    }
  }

  private onResize(): void {
    this.width = process.stdout.columns || 80
    this.height = process.stdout.rows || 24

    // Update view manager dimensions
    this.viewManager.updateDimensions(this.width, this.height)

    // Reset scroll region when dimensions change
    if (this.viewMode === 'dashboard') {
      setScrollRegion(3, this.height - 2)
    } else {
      resetScrollRegion()
    }

    this.render()
  }

  // ── Helpers ─────────────────────────────────────────────

  private addLabel(role: 'user' | 'assistant'): void {
    const ts = new Date().toLocaleTimeString('en', {
      hour: '2-digit',
      minute: '2-digit',
    })
    if (role === 'user') {
      this.lines.push({
        text: `${C.user}${A.bold}  You${A.reset}  ${A.dim}${ts}${A.reset}`,
      })
    } else {
      this.lines.push({
        text: `${C.ai}${A.bold}  Claude${A.reset}  ${A.dim}${ts}${A.reset}`,
      })
    }
  }

  private startSpinner(): void {
    const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
    this.spinnerFrame = 0
    this.spinnerTimer = setInterval(() => {
      this.spinnerFrame = (this.spinnerFrame + 1) % frames.length
      this.renderInput()
    }, 80)
  }

  private stopSpinner(): void {
    if (this.spinnerTimer) {
      clearInterval(this.spinnerTimer)
      this.spinnerTimer = null
    }
  }

  private getSpinnerChar(): string {
    const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
    return frames[this.spinnerFrame % frames.length]
  }

  private addWrapped(text: string): void {
    const wrapped = wrapText('  ' + text, this.width - 2)
    for (const line of wrapped) {
      this.lines.push({ text: line })
    }
  }

  private addMarkdown(text: string): void {
    const rendered = renderMarkdown(text)
    for (const line of rendered) {
      this.lines.push({ text: line })
    }
  }
}

// ─── Unicode helpers for input handling ───────────────────

/** Check if a string is a single Unicode codepoint (may be 1 or 2 JS chars for surrogates) */
function isSingleUnicodeChar(s: string): boolean {
  const chars = [...s]
  return chars.length === 1
}

/** Check if a key input is a printable character (single codepoint, not control) */
function isPrintable(key: string): boolean {
  if (!isSingleUnicodeChar(key)) return false
  const code = key.codePointAt(0) || 0
  return code >= 0x20 && code !== 0x7f
}

/** Get the JS string length of the previous codepoint before position */
function prevCharLength(s: string, pos: number): number {
  if (pos <= 0) return 0
  // Check for surrogate pair (emoji, etc): low surrogate at pos-1 + high surrogate at pos-2
  if (pos >= 2) {
    const low = s.charCodeAt(pos - 1)
    const high = s.charCodeAt(pos - 2)
    if (low >= 0xdc00 && low <= 0xdfff && high >= 0xd800 && high <= 0xdbff) {
      return 2
    }
  }
  return 1
}

/** Get the JS string length of the codepoint at position */
function nextCharLength(s: string, pos: number): number {
  if (pos >= s.length) return 0
  const high = s.charCodeAt(pos)
  if (high >= 0xd800 && high <= 0xdbff && pos + 1 < s.length) {
    return 2
  }
  return 1
}

// ─── Session Picker Types ─────────────────────────────────

export interface SessionPickerEntry {
  name: string
  messageCount: number
  updated: number
  isCurrent: boolean
  isArchived: boolean
}

export type SessionPickerResult =
  | { action: 'load'; name: string }
  | { action: 'delete'; name: string; isArchived?: boolean }
  | { action: 'archive'; name: string }
  | { action: 'unarchive'; name: string }

// ─── News Picker Types ───────────────────────────────────

export interface NewsPickerEntry {
  title: string
  link: string
  source: string
  category: string
  time: string    // formatted time string e.g. "21:30"
}

function formatPickerAge(timestamp: number): string {
  const diff = Date.now() - timestamp
  const secs = Math.floor(diff / 1000)
  if (secs < 60) return 'just now'
  const mins = Math.floor(secs / 60)
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days}d ago`
  const months = Math.floor(days / 30)
  return `${months}mo ago`
}
