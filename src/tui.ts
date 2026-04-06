import { A, C, CSI, w, stripAnsi, wrapText, visibleLength, displayWidth, getPalette, type PersonaPalette } from './ansi'
import { renderMarkdown } from './markdown'
import { InputHistory } from './history'
import { fuzzyFilter, highlightMatches, type FuzzyMatch } from './input/fuzzy'
import { join } from 'node:path'
import {
  ViewManager,
  renderStatusBar,
  renderBox,
  renderSplitView,
  renderTable,
  setScrollRegion,
  resetScrollRegion,
  renderInsightSnippet,
  getInsightSnippetHeight,
  clearInsightSnippet,
  renderMetaLearningPanel,
  createMetaLearningDashboardPanel,
  type ViewMode,
  type DashboardLayout,
  type DashboardPanel,
  type StatusBarConfig,
  type MetaLearningEntry,
} from './tui/index'
import { eventBus } from './core/event-bus'
import type {
  ContextChangedEvent,
  TelemetryAlertEvent,
  TaskCompletedEvent,
  StatusUpdateEvent,
  SessionChangedEvent,
  Insight,
  InsightAcceptedEvent,
  InsightAvailableEvent,
} from './types'
import type { PersonaMode, TimeContext } from './briefing'

// ─── TUI ─────────────────────────────────────────────────────

interface Line {
  text: string
}

export type { ViewMode, DashboardLayout, DashboardPanel, MetaLearningEntry }

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

  // Time & Load Balancer state
  private personaMode: PersonaMode = 'productivity'
  private palette: PersonaPalette = getPalette('productivity')
  private timeContext: TimeContext | null = null
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
    '/macro', '/macros', '/atalho', '/atalhos',
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
    // Macros
    '/macro': ['list', 'all', 'info', 'create', 'delete', 'enable', 'disable'],
    '/macros': ['list', 'all', 'info', 'create', 'delete', 'enable', 'disable'],
    '/atalho': ['list', 'all', 'info', 'criar', 'deletar', 'ativar', 'desativar'],
    '/atalhos': ['list', 'all', 'info', 'criar', 'deletar', 'ativar', 'desativar'],
  }

  /** Brief descriptions for commands (shown in completions) */
  private commandDescriptions: Record<string, string> = {
    '/help': 'Mostrar todos os comandos', '/ajuda': 'Mostrar todos os comandos',
    '/clear': 'Limpar tela', '/limpar': 'Limpar tela',
    '/commit': 'Git commit com mensagem IA', '/commitar': 'Git commit com mensagem IA',
    '/persona': 'Trocar modo de persona', '/modo': 'Trocar modo de persona',
    '/copy': 'Copiar ultima resposta', '/copiar': 'Copiar ultima resposta',
    '/fork': 'Bifurcar sessao atual',
    '/new': 'Nova sessao', '/novo': 'Nova sessao',
    '/load': 'Carregar sessao', '/carregar': 'Carregar sessao',
    '/sessions': 'Listar sessoes', '/sessoes': 'Listar sessoes',
    '/delete': 'Deletar sessao', '/deletar': 'Deletar sessao',
    '/model': 'Trocar modelo IA', '/modelo': 'Trocar modelo IA',
    '/export': 'Exportar conversa', '/exportar': 'Exportar conversa',
    '/cost': 'Ver custo da sessao', '/custo': 'Ver custo da sessao',
    '/retry': 'Repetir ultima mensagem', '/repetir': 'Repetir ultima mensagem',
    '/undo': 'Desfazer ultima acao', '/desfazer': 'Desfazer ultima acao',
    '/search': 'Buscar na conversa', '/buscar': 'Buscar na conversa',
    '/lang': 'Trocar idioma', '/idioma': 'Trocar idioma',
    '/config': 'Configuracoes',
    '/exit': 'Sair do aplicativo', '/sair': 'Sair do aplicativo',
    '/briefing': 'Resumo diario', '/resumo': 'Resumo diario',
    '/news': 'Feed de noticias', '/noticias': 'Feed de noticias',
    '/open': 'Abrir aplicativo', '/abrir': 'Abrir aplicativo',
    '/openfile': 'Abrir arquivo',
    '/openurl': 'Abrir URL',
    '/apps': 'Listar aplicativos', '/programas': 'Listar aplicativos',
    '/sysinfo': 'Info do sistema', '/sistema': 'Info do sistema',
    '/calendar': 'Ver calendario', '/calendario': 'Ver calendario', '/agenda': 'Ver calendario',
    '/ask': 'Perguntar ao modelo', '/perguntar': 'Perguntar ao modelo',
    '/budget': 'Ver orcamento', '/orcamento': 'Ver orcamento',
    '/plugins': 'Gerenciar plugins',
    '/task': 'Criar tarefa', '/tarefa': 'Criar tarefa',
    '/tasks': 'Listar tarefas', '/tarefas': 'Listar tarefas',
    '/done': 'Concluir tarefa', '/feito': 'Concluir tarefa', '/concluido': 'Concluir tarefa',
    '/rmtask': 'Remover tarefa', '/rmtarefa': 'Remover tarefa',
    '/people': 'Gerenciar pessoas', '/pessoas': 'Gerenciar pessoas',
    '/team': 'Ver equipe', '/equipe': 'Ver equipe',
    '/family': 'Ver familia', '/familia': 'Ver familia',
    '/person': 'Ver pessoa', '/pessoa': 'Ver pessoa',
    '/addperson': 'Adicionar pessoa', '/novapessoa': 'Adicionar pessoa', '/addpessoa': 'Adicionar pessoa',
    '/delegate': 'Delegar tarefa', '/delegar': 'Delegar tarefa',
    '/delegations': 'Ver delegacoes', '/delegacoes': 'Ver delegacoes', '/delegados': 'Ver delegacoes',
    '/followups': 'Ver follow-ups',
    '/dashboard': 'Painel visual', '/painel': 'Painel visual',
    '/contacts': 'Ver contatos', '/contatos': 'Ver contatos',
    '/investigar': 'Iniciar investigacao', '/investigate': 'Start investigation',
    '/investigacoes': 'Ver investigacoes',
    '/monitor': 'Monitorar recurso', '/vigiar': 'Monitorar recurso',
    '/workflow': 'Gerenciar workflows', '/fluxo': 'Gerenciar workflows',
    '/macro': 'Gerenciar macros', '/macros': 'Listar macros',
    '/atalho': 'Gerenciar atalhos', '/atalhos': 'Listar atalhos',
    '/pomodoro': 'Timer Pomodoro', '/foco': 'Timer Pomodoro',
    '/entrada': 'Registrar receita', '/income': 'Registrar receita',
    '/saida': 'Registrar despesa', '/expense': 'Registrar despesa',
    '/finance': 'Ver financas', '/financas': 'Ver financas', '/balanco': 'Ver balanco',
    '/decisions': 'Registro de decisoes', '/decisoes': 'Registro de decisoes',
    '/email': 'Gerenciar email', '/rascunho': 'Rascunho de email',
    '/memo': 'Criar memo', '/memos': 'Listar memos',
    '/note': 'Criar nota', '/notas': 'Listar notas', '/anotar': 'Criar nota',
    '/tags': 'Ver tags', '/memotags': 'Tags de memos',
    '/rmmemo': 'Remover memo', '/rmnota': 'Remover nota',
    '/index': 'Indexar conteudo', '/indexar': 'Indexar conteudo',
    '/reindex': 'Reindexar tudo',
    '/memory': 'Ver memoria', '/memoria': 'Ver memoria',
    '/clipboard': 'Ver clipboard', '/area': 'Ver area de transferencia',
    '/tela': 'Capturar tela', '/screen': 'Capturar tela',
    '/ps1': 'Customizar prompt',
    '/refresh': 'Atualizar dados', '/renovar': 'Atualizar dados',
    '/vault': 'Gerenciar vault', '/backup': 'Fazer backup',
    '/feeds': 'Ver feeds RSS', '/fontes': 'Ver fontes RSS',
    '/addfeed': 'Adicionar feed', '/novafonte': 'Adicionar fonte',
    '/rmfeed': 'Remover feed', '/rmfonte': 'Remover fonte',
    '/disablefeed': 'Desativar feed', '/desativarfonte': 'Desativar fonte',
    '/enablefeed': 'Ativar feed', '/ativarfonte': 'Ativar fonte',
    '/projeto': 'Ver projeto', '/project': 'Ver projeto',
    '/projetos': 'Listar projetos', '/projects': 'Listar projetos',
    '/sessao': 'Sessao de trabalho', '/session': 'Work session',
    '/relatorio': 'Gerar relatorio', '/report': 'Gerar relatorio',
    '/oportunidades': 'Ver oportunidades', '/opportunities': 'Ver oportunidades',
    '/schedule': 'Ver agenda',
  }

  // ── Autocomplete state ──────────────────────────────────────
  private ghostText = ''                    // Dimmed suggestion after cursor
  private tabCycleMatches: string[] = []    // Matches for Tab cycling
  private tabCycleIndex = -1               // Current position in Tab cycle (-1 = not cycling)
  private tabCycleBase = ''                 // Original input before Tab cycling started

  private onSubmit: ((s: string) => void) | null = null
  private onCancel: (() => void) | null = null
  private onExit: (() => void) | null = null
  private pickerActive = false
  private lastCtrlCTime = 0
  private eventUnsubscribers: Array<() => void> = []
  private statusBarContext = '' // Context info for status bar

  // Insight state
  private activeInsight: Insight | null = null
  private insightSnippetLines = 0
  private insightDisplayed = false
  private metaLearningEntries: MetaLearningEntry[] = []

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

    // Insight available — display proactive insight snippet
    this.eventUnsubscribers.push(
      eventBus.on('insight:available', (event: InsightAvailableEvent) => {
        // Don't interrupt streaming or active pickers
        if (this.isStreaming || this.pickerActive) return

        this.showInsight(event.insight)
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
        this.streamLines = renderMarkdown(this.streamBuf, this.width).map((t) => ({ text: t }))
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
      this.streamLines = renderMarkdown(this.streamBuf, this.width).map((t) => ({ text: t }))
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
   * Interactive news picker. Navigate with W/S or arrows.
   * - Enter: open in browser
   * - Ctrl+Enter: fetch and read content in assistant
   * Returns NewsPickerResult or null if cancelled.
   */
  promptNewsPicker(
    items: NewsPickerEntry[],
  ): Promise<NewsPickerResult | null> {
    if (items.length === 0) {
      this.showSystem('Nenhuma noticia encontrada.')
      return Promise.resolve(null)
    }

    return new Promise<NewsPickerResult | null>((resolve) => {
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
        w(`  ${A.dim}↑↓ navegar  Enter abrir  Ctrl+Enter ler aqui  Esc cancelar  / filtrar  Tab categoria${A.reset}`)
      }

      const cleanup = (result: NewsPickerResult | null): void => {
        this.pickerActive = false
        process.stdin.removeListener('data', handler)
        this.renderAll()
        resolve(result)
      }

      const handler = (data: Buffer): void => {
        const key = data.toString('utf-8')
        const list = filtered()

        // Esc (bare escape, not part of sequence)
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

        // Ctrl+Enter (Ctrl+J = \x0a or some terminals send \x1b\r or similar)
        // Common Ctrl+Enter sequences: \x0a (Ctrl+J), \x1b\r, \x1bOM
        if (key === '\x0a' || key === '\x1b\r' || key === '\x1bOM') {
          if (list.length > 0 && cursor < list.length) {
            cleanup({ action: 'read', link: list[cursor].link })
          }
          return
        }

        // Regular Enter — open in browser
        if (key === '\r' || key === '\n') {
          if (list.length > 0 && cursor < list.length) {
            cleanup({ action: 'open', link: list[cursor].link })
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
   * Automatically includes Meta-Aprendizado panel if entries exist.
   */
  enterDashboardMode(layout: DashboardLayout): void {
    this.viewMode = 'dashboard'

    // Create a copy of panels to avoid mutation
    let panels = [...layout.panels]

    // Add Meta-Aprendizado panel if we have entries and it's not already present
    const hasMetaPanel = panels.some((p) => p.id === 'meta-learning')
    if (!hasMetaPanel && this.metaLearningEntries.length > 0) {
      const panelWidth = Math.floor(this.width / 2) - 4
      const metaPanel = createMetaLearningDashboardPanel(
        this.metaLearningEntries,
        panelWidth,
      )
      panels = [...panels, metaPanel]
    }

    this.dashboardContent = panels
    this.viewManager.enterDashboardMode({ ...layout, panels })

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

// ── Insight Management ──────────────────────────────────────

  /**
   * Display a proactive insight snippet.
   * The snippet appears above the input line and awaits Y/N response.
   */
  showInsight(insight: Insight): void {
    // Clear any existing insight first
    if (this.activeInsight) {
      this.dismissInsight()
    }

    this.activeInsight = insight
    const snippetLines = renderInsightSnippet(insight, {
      width: this.width - 4,
      showActions: true,
    })
    this.insightSnippetLines = snippetLines.length

    // Render the insight above the input area
    this.renderInsightDisplay(snippetLines)
    this.insightDisplayed = true
  }

  /**
   * Render the insight snippet above the input line.
   */
  private renderInsightDisplay(snippetLines: string[]): void {
    // Position: above the separator line (height - 1 - lineCount)
    const startRow = this.height - 1 - this.insightSnippetLines - 1
    w(A.hide)

    for (let i = 0; i < snippetLines.length; i++) {
      w(A.to(startRow + i, 1))
      w(A.clearLine)
      w(snippetLines[i])
    }

    w(A.show)
  }

  /**
   * Dismiss the current insight without accepting it.
   * Clears the snippet from the terminal using ANSI escape sequences.
   */
  dismissInsight(): void {
    if (!this.activeInsight || !this.insightDisplayed) return

    // Clear the insight lines from screen
    const startRow = this.height - 1 - this.insightSnippetLines - 1
    w(A.hide)

    for (let i = 0; i < this.insightSnippetLines; i++) {
      w(A.to(startRow + i, 1))
      w(A.clearLine)
    }

    w(A.show)

    // Reset state
    this.activeInsight = null
    this.insightSnippetLines = 0
    this.insightDisplayed = false

    // Re-render messages to fill the cleared space
    this.renderMessages()
  }

  /**
   * Accept the current insight and emit the acceptance event.
   */
  private acceptInsight(): void {
    if (!this.activeInsight) return

    const insight = this.activeInsight
    const acceptedEvent: InsightAcceptedEvent = {
      insightId: insight.id,
      insight,
      timestamp: Date.now(),
    }

    // Emit acceptance event
    eventBus.emit('insight:accepted', acceptedEvent)

    // Show confirmation
    this.lines.push({
      text: `  ${C.sys}✓ Dica aceita: ${insight.title}${A.reset}`,
    })

    // Execute suggested action if present
    if (insight.suggestedAction) {
      this.lines.push({
        text: `  ${A.dim}Executando: ${insight.suggestedAction.command}${A.reset}`,
      })
      // The actual execution should be handled by the event subscriber
    }

    // Clear the display
    this.dismissInsight()
  }

  /**
   * Check if there's an active insight awaiting response.
   */
  hasActiveInsight(): boolean {
    return this.activeInsight !== null && this.insightDisplayed
  }

  /**
   * Update meta-learning entries for dashboard display.
   */
  updateMetaLearningEntries(entries: MetaLearningEntry[]): void {
    this.metaLearningEntries = entries

    // If in dashboard mode, update the panel
    if (this.viewMode === 'dashboard') {
      const metaPanel = createMetaLearningDashboardPanel(
        entries,
        Math.floor(this.width / 2) - 4,
      )
      this.updateDashboardPanel('meta-learning', metaPanel.content)
    }
  }

  // ── Time & Load Balancer API ───────────────────────────────

  /**
   * Update the persona mode and refresh the color palette.
   * Call this when the time context changes (e.g., at startup or day transition).
   */
  setPersonaMode(mode: PersonaMode): void {
    this.personaMode = mode
    this.palette = getPalette(mode)
    this.renderHeader()
    if (this.statusBarEnabled) {
      this.renderStickyStatusBar()
    }
  }

  /**
   * Set the full time context for advanced UI features.
   */
  setTimeContext(context: TimeContext): void {
    this.timeContext = context
    this.setPersonaMode(context.persona)
  }

  /**
   * Get the current persona mode.
   */
  getPersonaMode(): PersonaMode {
    return this.personaMode
  }

  /**
   * Get the current color palette based on persona.
   */
  getPalette(): PersonaPalette {
    return this.palette
  }

  /**
   * Get a persona-aware label for the status bar.
   */
  private getPersonaLabel(): string {
    switch (this.personaMode) {
      case 'productivity':
        return 'PROD'
      case 'spillover_alert':
        return 'SPILL'
      case 'sharpen_or_relax':
        return 'RELAX'
    }
  }

  /**
   * Add a meta-learning entry or update frequency if exists.
   */
  addMetaLearningEntry(entry: Omit<MetaLearningEntry, 'frequency' | 'lastSeen'>): void {
    const existing = this.metaLearningEntries.find(
      (e) => e.title === entry.title,
    )

    if (existing) {
      // Update frequency and timestamp (immutable update)
      this.metaLearningEntries = this.metaLearningEntries.map((e) =>
        e.title === entry.title
          ? { ...e, frequency: e.frequency + 1, lastSeen: Date.now() }
          : e,
      )
    } else {
      // Add new entry (immutable)
      this.metaLearningEntries = [
        ...this.metaLearningEntries,
        {
          ...entry,
          frequency: 1,
          lastSeen: Date.now(),
        },
      ]
    }
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
    // Use persona-aware colors for panel styling
    const borderColor = this.personaMode === 'sharpen_or_relax'
      ? this.palette.muted
      : A.dim
    const titleColor = this.palette.primary

    // Draw panel border
    const boxLines = renderBox(
      panel.content.slice(0, height - 2),
      width,
      { title: panel.title, borderColor, titleColor },
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

    // Build custom items with persona indicator
    const customItems: Array<{ label: string; value: string; color?: string }> = []

    // Add persona mode indicator with dynamic color
    if (this.personaMode !== 'productivity') {
      const personaColor = this.personaMode === 'spillover_alert'
        ? this.palette.accent
        : this.palette.primary
      customItems.push({
        label: 'MODE',
        value: this.getPersonaLabel(),
        color: personaColor,
      })
    }

    // Add spillover count if in spillover mode
    if (this.timeContext && this.personaMode === 'spillover_alert') {
      const spilloverCount = this.timeContext.urgentTasks.length +
        this.timeContext.overdueTasks.length +
        this.timeContext.pendingCommits.length
      if (spilloverCount > 0) {
        customItems.push({
          label: 'PEND',
          value: String(spilloverCount),
          color: this.palette.accent,
        })
      }
    }

    const config: StatusBarConfig = {
      model: this.model,
      project: this.activeProject || undefined,
      tokens: { input: this.inputTokens, output: this.outputTokens },
      sessionCost: this.sessionCost || undefined,
      vaultStatus: this.vaultStatus,
      customItems: customItems.length > 0 ? customItems : undefined,
    }

    w(A.to(statusRow, 1))
    w(this.renderPersonaAwareStatusBar(config))
  }

  /**
   * Render status bar with persona-aware styling.
   */
  private renderPersonaAwareStatusBar(config: StatusBarConfig): string {
    // Use renderStatusBar but apply persona colors
    const baseBar = renderStatusBar(config, this.width)

    // For weekend modes, apply a subtle tint to the status bar
    if (this.personaMode === 'sharpen_or_relax') {
      // Return with muted styling
      return `${this.palette.muted}${stripAnsi(baseBar)}${A.reset}`
    }

    return baseBar
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

    // Use persona-aware colors for header
    const headerColor = this.palette.header
    const bgColor = this.getHeaderBgColor()

    w(bgColor)
    w(A.inv)

    // Add persona indicator for weekend modes
    const personaIndicator = this.personaMode !== 'productivity'
      ? ` [${this.getPersonaLabel()}]`
      : ''
    const left = ` smolerclaw${personaIndicator}`

    const parts = [this.model, this.sessionName]
    if (this.sessionCost) parts.push(this.sessionCost)
    if (this.authInfo) parts.push(this.authInfo)
    const right = parts.join(' | ') + ' '
    const pad = Math.max(1, this.width - visibleLength(left) - right.length)
    w(left + ' '.repeat(pad) + right)
    w(A.reset)

    // Persona-aware divider color
    w(A.to(2, 1))
    const dividerColor = this.personaMode === 'sharpen_or_relax' ? this.palette.muted : A.dim
    w(`${dividerColor}${'─'.repeat(this.width)}${A.reset}`)
  }

  /**
   * Get background color hint for header based on persona.
   */
  private getHeaderBgColor(): string {
    switch (this.personaMode) {
      case 'productivity':
        return '' // Default inverse
      case 'spillover_alert':
        return A.bg(52) // Dark red hint
      case 'sharpen_or_relax':
        return A.bg(53) // Dark magenta hint
    }
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
        w(visible[i].text)
      }
    }
  }

  /**
   * Reset Tab cycling state (called on any non-Tab keystroke).
   */
  private resetTabCycle(): void {
    this.tabCycleMatches = []
    this.tabCycleIndex = -1
    this.tabCycleBase = ''
  }

  /**
   * Compute ghost text suggestion for current input.
   * Shows dimmed text after cursor for quick acceptance with Right arrow.
   */
  private updateGhostText(): void {
    const input = this.inputBuf
    this.ghostText = ''

    // Only show ghost when cursor is at end of input
    if (this.inputPos !== input.length) return
    if (input.length === 0) return

    // Phase 1: Command ghost text
    if (input.startsWith('/')) {
      const parts = input.split(' ')

      if (parts.length === 1) {
        // Ghost for command name — find best fuzzy match
        const results = fuzzyFilter(input, this.commands)
        if (results.length > 0) {
          const best = results[0].item as string
          if (best !== input && best.startsWith(input)) {
            // Show remaining part of the command
            const remainder = best.slice(input.length)
            const desc = this.commandDescriptions[best]
            this.ghostText = desc ? `${remainder}  ${desc}` : remainder
            return
          }
          // Fuzzy match (not prefix) — show full suggestion
          if (best !== input) {
            const desc = this.commandDescriptions[best]
            this.ghostText = desc ? `  → ${best}  ${desc}` : `  → ${best}`
            return
          }
        }
      } else {
        // Ghost for subcommand
        const cmd = parts[0]
        const sub = this.subcommands[cmd]
        if (sub && sub.length > 0) {
          const partial = parts[parts.length - 1].toLowerCase()
          if (partial) {
            const matches = sub.filter(s => s.toLowerCase().startsWith(partial))
            if (matches.length > 0) {
              this.ghostText = matches[0].slice(partial.length)
              return
            }
          } else {
            // Show first option as ghost
            this.ghostText = sub[0]
            return
          }
        }
      }
    }

    // Phase 2: History-based ghost text for non-command input
    if (!input.startsWith('/') && input.length >= 2 && this.history) {
      const entries = this.history.getEntries()
      // Search from most recent backward, find prefix match first
      for (let i = entries.length - 1; i >= 0; i--) {
        if (entries[i].startsWith(input) && entries[i] !== input) {
          this.ghostText = entries[i].slice(input.length)
          return
        }
      }
      // If no prefix match, try fuzzy for hint
      const results = fuzzyFilter(input, [...entries].reverse().slice(0, 100))
      if (results.length > 0 && results[0].match.score > 50) {
        const best = results[0].item as string
        if (best !== input) {
          this.ghostText = `  → ${best}`
        }
      }
    }
  }

  /**
   * Complete a partial input. Handles both command and subcommand completion.
   * Uses fuzzy matching for better discovery and Tab cycling for multiple matches.
   * Returns the completed value and optional list of matches to display.
   */
  private completeInput(input: string): { value: string; options?: string } | null {
    const parts = input.split(' ')
    const cmd = parts[0]

    // ── Tab cycling: if already cycling, advance to next match ──
    if (this.tabCycleMatches.length > 1 && this.tabCycleBase) {
      this.tabCycleIndex = (this.tabCycleIndex + 1) % this.tabCycleMatches.length
      const match = this.tabCycleMatches[this.tabCycleIndex]
      const counter = `[${this.tabCycleIndex + 1}/${this.tabCycleMatches.length}]`
      const desc = this.commandDescriptions[match]
      const hint = desc ? `${counter} ${desc}` : counter
      // Is this a command or subcommand cycle?
      if (parts.length === 1 || this.tabCycleBase.split(' ').length === 1) {
        const hasSub = this.subcommands[match]
        return { value: match + (hasSub?.length ? ' ' : ' '), options: hint }
      } else {
        const baseParts = this.tabCycleBase.split(' ')
        baseParts[baseParts.length - 1] = match
        return { value: baseParts.join(' ') + ' ', options: hint }
      }
    }

    // ── Phase 1: completing the command itself (no space yet) ──
    if (parts.length === 1) {
      // Prefix matches first (fast path)
      const prefixMatches = this.commands.filter(c => c.startsWith(cmd))
      // Fuzzy matches (broader discovery)
      const fuzzyResults = cmd.length >= 2
        ? fuzzyFilter(cmd, this.commands).map(r => r.item as string)
        : []
      // Merge: prefix matches first, then fuzzy-only matches
      const prefixSet = new Set(prefixMatches)
      const allMatches = [...prefixMatches, ...fuzzyResults.filter(m => !prefixSet.has(m))]

      if (allMatches.length === 0) return null

      if (allMatches.length === 1) {
        const match = allMatches[0]
        const sub = this.subcommands[match]
        const desc = this.commandDescriptions[match]
        const opts = sub?.length ? `Opcoes: ${sub.join('  ')}` : undefined
        const hint = desc ? (opts ? `${desc}\n${opts}` : desc) : opts
        return { value: match + ' ', options: hint }
      }

      // Multiple matches — start Tab cycling
      this.tabCycleMatches = allMatches
      this.tabCycleIndex = 0
      this.tabCycleBase = input

      const match = allMatches[0]
      const desc = this.commandDescriptions[match]
      // Format options with descriptions
      const optLines = allMatches.slice(0, 12).map(m => {
        const d = this.commandDescriptions[m]
        return d ? `${m} ${A.dim}${d}${A.reset}` : m
      })
      const more = allMatches.length > 12 ? `  ${A.dim}+${allMatches.length - 12} mais${A.reset}` : ''
      const counter = `[1/${allMatches.length}]`

      // If there's a common prefix among prefix matches, expand to it
      if (prefixMatches.length > 1) {
        let prefix = prefixMatches[0]
        for (const m of prefixMatches) {
          while (!m.startsWith(prefix)) prefix = prefix.slice(0, -1)
        }
        if (prefix.length > input.length) {
          return { value: prefix, options: `${counter}\n${optLines.join('\n')}${more}` }
        }
      }

      const hasSub = this.subcommands[match]
      return {
        value: match + (hasSub?.length ? ' ' : ' '),
        options: `${counter}${desc ? ' ' + desc : ''}\n${optLines.join('\n')}${more}`,
      }
    }

    // ── Phase 2: completing a subcommand/argument ──
    const sub = this.subcommands[cmd]
    if (!sub || sub.length === 0) return null

    const partial = parts[parts.length - 1].toLowerCase()
    const matches = partial
      ? sub.filter(s => s.toLowerCase().startsWith(partial))
      : [...sub]

    // If no prefix matches but partial is non-empty, try fuzzy
    if (matches.length === 0 && partial) {
      const fuzzyResults = fuzzyFilter(partial, sub)
      if (fuzzyResults.length > 0) {
        const fuzzyMatches = fuzzyResults.map(r => r.item as string)
        if (fuzzyMatches.length === 1) {
          parts[parts.length - 1] = fuzzyMatches[0]
          return { value: parts.join(' ') + ' ' }
        }
        // Start cycling fuzzy subcommand matches
        this.tabCycleMatches = fuzzyMatches
        this.tabCycleIndex = 0
        this.tabCycleBase = input
        parts[parts.length - 1] = fuzzyMatches[0]
        return {
          value: parts.join(' ') + ' ',
          options: `[1/${fuzzyMatches.length}] ${fuzzyMatches.join('  ')}`,
        }
      }
      return null
    }

    if (matches.length === 1) {
      parts[parts.length - 1] = matches[0]
      return { value: parts.join(' ') + ' ' }
    }

    if (matches.length > 1) {
      // Start cycling through subcommand matches
      this.tabCycleMatches = matches
      this.tabCycleIndex = 0
      this.tabCycleBase = input

      parts[parts.length - 1] = matches[0]
      return {
        value: parts.join(' ') + ' ',
        options: `[1/${matches.length}] ${matches.join('  ')}`,
      }
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
      const promptPrefix = `${C.prompt}❯${A.reset} `
      const inputWidth = this.width - 3 // 2 for "❯ " + 1 margin

      const display = visibleLength(this.inputBuf) > inputWidth
        ? this.inputBuf.slice(this.inputBuf.length - inputWidth)
        : this.inputBuf

      w(promptPrefix + display)

      // Show ghost text after input (dimmed) when cursor is at end
      if (this.ghostText && this.inputPos === this.inputBuf.length) {
        const availableSpace = inputWidth - visibleLength(this.inputBuf)
        if (availableSpace > 2) {
          const ghostDisplay = this.ghostText.length > availableSpace
            ? this.ghostText.slice(0, availableSpace - 1) + '…'
            : this.ghostText
          w(`${A.dim}${A.italic}${ghostDisplay}${A.reset}`)
        }
      }

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

    // ── Insight Quick Action Interception ──────────────────
    // When an insight is displayed, intercept Y/N before normal input
    if (this.hasActiveInsight()) {
      const lowerKey = key.toLowerCase()

      if (lowerKey === 'y') {
        // Accept the insight
        this.acceptInsight()
        return
      }

      if (lowerKey === 'n' || key === '\x1b') {
        // Explicitly reject the insight
        this.dismissInsight()
        return
      }

      // Any other key (including printable chars) dismisses and proceeds
      // This allows the user to start typing without being blocked
      this.dismissInsight()
      // Fall through to process the key normally
    }

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
        this.ghostText = ''
        this.resetTabCycle()
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

    // Tab — command + subcommand completion with cycling
    if (key === '\t') {
      if (this.inputBuf.startsWith('/')) {
        const completed = this.completeInput(this.inputBuf)
        if (completed) {
          this.inputBuf = completed.value
          this.inputPos = this.inputBuf.length
          this.ghostText = ''
          this.renderInput()
          if (completed.options) {
            this.showSystem(completed.options)
          }
        }
      } else if (this.ghostText) {
        // Accept ghost text for non-command input (history suggestion)
        const ghost = this.ghostText.startsWith('  →') ? '' : this.ghostText
        if (ghost) {
          this.inputBuf += ghost
          this.inputPos = this.inputBuf.length
          this.ghostText = ''
          this.renderInput()
        }
      }
      return
    }

    // Paste detection: multi-char input that isn't an escape sequence
    // Covers both newline-containing pastes and plain text pastes
    if (key.length > 1 && !key.startsWith('\x1b') && !isSingleUnicodeChar(key)) {
      this.resetTabCycle()
      const cleaned = key.replace(/\r?\n/g, ' ').trim()
      if (cleaned.length > 0) {
        this.inputBuf =
          this.inputBuf.slice(0, this.inputPos) +
          cleaned +
          this.inputBuf.slice(this.inputPos)
        this.inputPos += cleaned.length
        this.updateGhostText()
        this.renderInput()
      }
      return
    }

    // Enter
    if (key === '\r' || key === '\n') {
      this.resetTabCycle()
      this.ghostText = ''

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
      this.resetTabCycle()
      if (this.inputPos > 0) {
        const charLen = prevCharLength(this.inputBuf, this.inputPos)
        this.inputBuf =
          this.inputBuf.slice(0, this.inputPos - charLen) +
          this.inputBuf.slice(this.inputPos)
        this.inputPos -= charLen
        this.updateGhostText()
        this.renderInput()
      }
      return
    }

    // Escape sequences
    if (key.startsWith('\x1b[')) {
      this.resetTabCycle()
      const code = key.slice(2)
      switch (code) {
        case 'D': // Left
          if (this.inputPos > 0) {
            this.inputPos -= prevCharLength(this.inputBuf, this.inputPos)
            this.ghostText = ''
            this.renderInput()
          }
          break
        case 'C': // Right — accept ghost text or move cursor
          if (this.ghostText && this.inputPos === this.inputBuf.length) {
            // Accept ghost text (only the direct completion part, not "→" hints)
            const ghost = this.ghostText.startsWith('  →') ? '' : this.ghostText
            if (ghost) {
              // Accept only up to first double-space (strip description)
              const descIdx = ghost.indexOf('  ')
              const accepted = descIdx >= 0 ? ghost.slice(0, descIdx) : ghost
              this.inputBuf += accepted
              this.inputPos = this.inputBuf.length
              this.ghostText = ''
              this.updateGhostText()
              this.renderInput()
              break
            }
          }
          if (this.inputPos < this.inputBuf.length) {
            this.inputPos += nextCharLength(this.inputBuf, this.inputPos)
            this.updateGhostText()
            this.renderInput()
          }
          break
        case 'A': { // Up — input history
          const prev = this.history?.prev(this.inputBuf)
          if (prev !== null && prev !== undefined) {
            this.inputBuf = prev
            this.inputPos = this.inputBuf.length
            this.updateGhostText()
            this.renderInput()
          }
          break
        }
        case 'B': { // Down — input history
          const next = this.history?.next()
          if (next !== undefined) {
            this.inputBuf = next
            this.inputPos = this.inputBuf.length
            this.updateGhostText()
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
          this.ghostText = ''
          this.renderInput()
          break
        case 'F': // End
          this.inputPos = this.inputBuf.length
          this.updateGhostText()
          this.renderInput()
          break
        case '3~': { // Delete
          if (this.inputPos < this.inputBuf.length) {
            const charLen = nextCharLength(this.inputBuf, this.inputPos)
            this.inputBuf =
              this.inputBuf.slice(0, this.inputPos) +
              this.inputBuf.slice(this.inputPos + charLen)
            this.updateGhostText()
            this.renderInput()
          }
          break
        }
      }
      return
    }

    // Regular printable characters (including multi-byte Unicode like ç, ã, é)
    if (isPrintable(key)) {
      this.resetTabCycle()
      this.inputBuf =
        this.inputBuf.slice(0, this.inputPos) +
        key +
        this.inputBuf.slice(this.inputPos)
      this.inputPos += key.length
      this.updateGhostText()
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
    const rendered = renderMarkdown(text, this.width)
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

export type NewsPickerResult =
  | { action: 'open'; link: string }    // Enter: open in browser
  | { action: 'read'; link: string }    // Ctrl+Enter: fetch and read content

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
