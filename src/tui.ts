import { A, C, CSI, w, stripAnsi, wrapText, visibleLength, displayWidth } from './ansi'
import { renderMarkdown } from './markdown'
import { InputHistory } from './history'
import { join } from 'node:path'

// ─── TUI ─────────────────────────────────────────────────────

interface Line {
  text: string
}

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
  private commands = [
    '/help', '/clear', '/commit', '/persona', '/copy', '/fork',
    '/new', '/load', '/sessions', '/delete', '/model', '/export',
    '/cost', '/retry', '/undo', '/search', '/lang', '/config', '/exit',
  ]

  private onSubmit: ((s: string) => void) | null = null
  private onCancel: (() => void) | null = null
  private onExit: (() => void) | null = null

  constructor(
    private model: string,
    private sessionName: string,
    private authInfo: string = '',
    private dataDir?: string,
  ) {}

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

    w(A.altOn)
    process.stdin.setRawMode?.(true)
    process.stdin.resume()
    process.stdin.on('data', (d: Buffer) => this.onKey(d))
    process.stdout.on('resize', () => this.onResize())

    this.render()
  }

  stop(): void {
    this.stopSpinner()
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

  // ── Rendering ───────────────────────────────────────────

  private render(): void {
    w(A.hide)
    w(A.clear)
    this.renderHeader()
    this.renderMessages()
    this.renderInput()
    w(A.show)
  }

  private renderAll(): void {
    this.renderMessages()
    this.renderInput()
  }

  private renderHeader(): void {
    w(A.to(1, 1))
    w(A.inv)
    const left = ' tinyclaw'
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
    const footerH = 2
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
      const display = this.inputBuf.length > this.width - 3
        ? this.inputBuf.slice(this.inputBuf.length - this.width + 3)
        : this.inputBuf
      w(`${C.prompt}❯${A.reset} ${display}`)
      // Unicode-aware cursor: compute display width of chars before cursor
      const cursorCol = displayWidth(this.inputBuf, this.inputPos) + 3
      w(A.to(inputRow, Math.min(cursorCol, this.width)))
      w(A.show)
    }
  }

  // ── Input Handling ──────────────────────────────────────

  private onKey(data: Buffer): void {
    const key = data.toString()

    // Ctrl+C
    if (key === '\x03') {
      if (this.isStreaming) {
        this.onCancel?.()
      } else {
        this.onExit?.()
      }
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

    // Tab — command completion
    if (key === '\t') {
      if (this.inputBuf.startsWith('/')) {
        const matches = this.commands.filter((c) => c.startsWith(this.inputBuf))
        if (matches.length === 1) {
          this.inputBuf = matches[0] + ' '
          this.inputPos = this.inputBuf.length
          this.renderInput()
        } else if (matches.length > 1) {
          // Find common prefix
          let prefix = matches[0]
          for (const m of matches) {
            while (!m.startsWith(prefix)) prefix = prefix.slice(0, -1)
          }
          if (prefix.length > this.inputBuf.length) {
            this.inputBuf = prefix
            this.inputPos = this.inputBuf.length
          }
          this.showSystem(matches.join('  '))
        }
      }
      return
    }

    // Paste detection: multi-char input with newlines → insert as single line
    if (key.length > 1 && !key.startsWith('\x1b') && key.includes('\n')) {
      const cleaned = key.replace(/\r?\n/g, ' ').trim()
      this.inputBuf =
        this.inputBuf.slice(0, this.inputPos) +
        cleaned +
        this.inputBuf.slice(this.inputPos)
      this.inputPos += cleaned.length
      this.renderInput()
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
        this.inputBuf =
          this.inputBuf.slice(0, this.inputPos - 1) +
          this.inputBuf.slice(this.inputPos)
        this.inputPos--
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
            this.inputPos--
            this.renderInput()
          }
          break
        case 'C': // Right
          if (this.inputPos < this.inputBuf.length) {
            this.inputPos++
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
        case '3~': // Delete
          if (this.inputPos < this.inputBuf.length) {
            this.inputBuf =
              this.inputBuf.slice(0, this.inputPos) +
              this.inputBuf.slice(this.inputPos + 1)
            this.renderInput()
          }
          break
      }
      return
    }

    // Regular printable characters
    if (key.length === 1 && key >= ' ') {
      this.inputBuf =
        this.inputBuf.slice(0, this.inputPos) +
        key +
        this.inputBuf.slice(this.inputPos)
      this.inputPos++
      this.renderInput()
    }
  }

  private onResize(): void {
    this.width = process.stdout.columns || 80
    this.height = process.stdout.rows || 24
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
