#!/usr/bin/env bun
import { parseArgs, printHelp, getVersion } from './cli'
import { loadConfig, saveConfig, getConfigPath } from './config'
import { resolveAuth, authLabel, type AuthResult } from './auth'
import { ClaudeProvider } from './claude'
import { SessionManager } from './session'
import { loadSkills, buildSystemPrompt, formatSkillList } from './skills'
import { TUI } from './tui'
import { TokenTracker } from './tokens'
import { exportToMarkdown } from './export'
import { resolveModel, formatModelList, modelDisplayName } from './models'
import { parseModelString, formatProviderList } from './providers'
import { OpenAICompatProvider } from './openai-provider'
import { gitDiff, gitStatus, gitStageAll, gitCommit, isGitRepo } from './git'
import { getPersona, formatPersonaList, type Persona } from './personas'
import { copyToClipboard } from './clipboard'
import { undoStack, registerPlugins, registerWindowsTools } from './tools'
import { loadPlugins, pluginsToTools, formatPluginList, getPluginDir } from './plugins'
import { formatApprovalPrompt, formatEditDiff } from './approval'
import { extractImages } from './images'
import { openApp, openFile, openUrl, getRunningApps, getSystemInfo, getDateTimeInfo, getOutlookEvents, getKnownApps } from './windows'
import { fetchNews, getNewsCategories, type NewsCategory } from './news'
import { generateBriefing } from './briefing'
import { writeFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { Message, ToolCall } from './types'

async function main(): Promise<void> {
  const cliArgs = parseArgs(process.argv.slice(2))

  // ── Help / Version ───────────────────────────────────────
  if (cliArgs.help) {
    printHelp()
    process.exit(0)
  }
  if (cliArgs.version) {
    console.log(`tinyclaw v${getVersion()}`)
    process.exit(0)
  }

  // ── Load config and auth ─────────────────────────────────
  const config = loadConfig()
  if (cliArgs.model) config.model = resolveModel(cliArgs.model)
  if (cliArgs.maxTokens) config.maxTokens = cliArgs.maxTokens

  let auth: AuthResult
  try {
    auth = resolveAuth(config.apiKey, config.authMode)
  } catch (err) {
    console.error('tinyclaw:', err instanceof Error ? err.message : err)
    process.exit(1)
  }

  // Initialize provider based on model string
  const { provider: providerType, model: providerModel } = parseModelString(config.model)
  let claude: ClaudeProvider | OpenAICompatProvider

  if (providerType === 'openai' || providerType === 'ollama') {
    claude = new OpenAICompatProvider(providerType, providerModel, config.maxTokens)
  } else {
    claude = new ClaudeProvider(auth.apiKey, config.model, config.maxTokens, config.toolApproval)
  }
  const sessionName = cliArgs.session || 'default'
  const sessions = new SessionManager(config.dataDir)
  if (cliArgs.session) sessions.switchTo(cliArgs.session)
  const skills = loadSkills(config.skillsDir)
  const systemPrompt = buildSystemPrompt(config.systemPrompt, skills, config.language)
  const enableTools = !cliArgs.noTools

  // Register Windows/business tools
  registerWindowsTools()

  // Load plugins
  const pluginDir = getPluginDir(join(config.dataDir, '..'))
  const plugins = loadPlugins(pluginDir)
  if (plugins.length > 0) {
    registerPlugins(plugins)
    // Add plugin tools to the TOOLS array
    const { TOOLS } = await import('./tools')
    TOOLS.push(...pluginsToTools(plugins))
  }

  // ── Pipe mode: stdin is not a TTY ────────────────────────
  const isPiped = !process.stdin.isTTY

  if (cliArgs.print || isPiped) {
    await runPrintMode(claude, sessions, systemPrompt, enableTools, cliArgs.prompt, isPiped)
    process.exit(0)
  }

  // ── Interactive TUI mode ─────────────────────────────────
  await runInteractive(claude, sessions, config, auth, skills, systemPrompt, enableTools, plugins, cliArgs.prompt)
}

// ─── Print Mode ───────────────────────────────────────────────

// Common provider interface for both Claude and OpenAI-compatible
type AnyProvider = { chat: ClaudeProvider['chat']; setModel: (m: string) => void; setApprovalCallback?: ClaudeProvider['setApprovalCallback']; setAutoApproveAll?: ClaudeProvider['setAutoApproveAll'] }

async function runPrintMode(
  claude: AnyProvider,
  sessions: SessionManager,
  systemPrompt: string,
  enableTools: boolean,
  prompt?: string,
  isPiped?: boolean,
): Promise<void> {
  let input = prompt || ''

  // Read stdin if piped
  if (isPiped) {
    const stdinText = await readStdin()
    input = input ? `${input}\n\n${stdinText}` : stdinText
  }

  if (!input.trim()) {
    console.error('tinyclaw: no input provided')
    process.exit(1)
  }

  const userMsg: Message = { role: 'user', content: input.trim(), timestamp: Date.now() }
  sessions.addMessage(userMsg)

  let fullText = ''
  for await (const event of claude.chat(sessions.messages, systemPrompt, enableTools)) {
    if (event.type === 'text') {
      process.stdout.write(event.text)
      fullText += event.text
    } else if (event.type === 'error') {
      console.error(`\ntinyclaw error: ${event.error}`)
    }
  }

  // Ensure trailing newline
  if (fullText && !fullText.endsWith('\n')) {
    process.stdout.write('\n')
  }

  const assistantMsg: Message = { role: 'assistant', content: fullText, timestamp: Date.now() }
  sessions.addMessage(assistantMsg)
}

async function readStdin(): Promise<string> {
  const chunks: Uint8Array[] = []
  for await (const chunk of process.stdin) {
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('utf-8')
}

// ─── Interactive Mode ─────────────────────────────────────────

async function runInteractive(
  claude: AnyProvider,
  sessions: SessionManager,
  config: ReturnType<typeof loadConfig>,
  auth: AuthResult,
  skills: ReturnType<typeof loadSkills>,
  systemPrompt: string,
  enableTools: boolean,
  plugins: ReturnType<typeof loadPlugins>,
  initialPrompt?: string,
): Promise<void> {
  const tracker = new TokenTracker(config.model)
  const tui = new TUI(config.model, sessions.session.name, authLabel(auth), config.dataDir)
  let currentPersona = 'default'
  let activeSystemPrompt = systemPrompt

  // Wire tool approval callback
  if (config.toolApproval !== 'auto' && claude.setApprovalCallback) {
    claude.setApprovalCallback(async (toolName, input, riskLevel) => {
      // Show diff preview for edit_file
      if (toolName === 'edit_file' && input.old_text && input.new_text) {
        const diffLines = formatEditDiff(String(input.old_text), String(input.new_text))
        for (const line of diffLines) {
          tui.showSystem(line)
        }
      }
      const desc = formatApprovalPrompt(toolName, input)
      const approved = await tui.promptApproval(desc)
      if (tui._approveAllRequested) {
        claude.setAutoApproveAll?.(true)
        tui._approveAllRequested = false
      }
      return approved
    })
  }

  // Restore existing messages
  for (const msg of sessions.messages) {
    if (msg.role === 'user') tui.addUserMessage(msg.content)
    else tui.addAssistantMessage(msg.content)
  }

  let activeAbort: AbortController | null = null

  async function handleSubmit(input: string): Promise<void> {
    if (input.startsWith('/')) {
      await handleCommand(input)
      return
    }

    // Cost budget check
    if (config.maxSessionCost > 0) {
      const spent = tracker.totals.costCents
      if (spent >= config.maxSessionCost) {
        tui.showError(`Budget exceeded (~$${(spent / 100).toFixed(4)} / $${(config.maxSessionCost / 100).toFixed(4)}). Use /budget <cents> to increase or /clear to reset.`)
        return
      }
      if (spent >= config.maxSessionCost * 0.8) {
        tui.showSystem(`Budget: ${Math.round((spent / config.maxSessionCost) * 100)}% used`)
      }
    }

    // Extract image attachments from input
    const { text: cleanedInput, images } = extractImages(input)
    const userMsg: Message = {
      role: 'user',
      content: cleanedInput,
      images: images.length > 0 ? images.map((i) => ({ mediaType: i.mediaType, base64: i.base64 })) : undefined,
      timestamp: Date.now(),
    }
    sessions.addMessage(userMsg)
    tui.addUserMessage(images.length > 0 ? `${cleanedInput} (${images.length} image${images.length > 1 ? 's' : ''})` : cleanedInput)
    tui.disableInput()

    tui.startStream()
    let fullText = ''
    const toolCalls: ToolCall[] = []
    let pendingToolInput: Record<string, unknown> = {}
    let totalInput = 0
    let totalOutput = 0
    activeAbort = new AbortController()

    try {
      for await (const event of claude.chat(sessions.messages, activeSystemPrompt, enableTools)) {
        if (activeAbort.signal.aborted) break

        switch (event.type) {
          case 'text':
            tui.appendStream(event.text)
            fullText += event.text
            break

          case 'tool_call':
            tui.flushStream()
            tui.showToolCall(event.name, event.input)
            pendingToolInput = event.input as Record<string, unknown>
            break

          case 'tool_result':
            tui.showToolResult(event.name, event.result)
            toolCalls.push({
              id: event.id,
              name: event.name,
              input: pendingToolInput,
              result: event.result,
            })
            pendingToolInput = {}
            tui.resetStreamBuffer()
            break

          case 'tool_blocked':
            tui.showError(event.reason)
            break

          case 'usage':
            totalInput += event.inputTokens
            totalOutput += event.outputTokens
            break

          case 'error':
            tui.showError(event.error)
            break

          case 'done':
            break
        }
      }
    } catch (err) {
      if (!activeAbort.signal.aborted) {
        tui.showError(err instanceof Error ? err.message : String(err))
      }
    }

    activeAbort = null
    tui.endStream()

    // Track and display token usage
    const usage = { inputTokens: totalInput, outputTokens: totalOutput }
    const cost = tracker.add(usage)

    if (totalInput > 0 || totalOutput > 0) {
      tui.showUsage(tracker.formatUsage(usage))
      tui.updateSessionCost(`~$${(tracker.totals.costCents / 100).toFixed(4)}`)
    }

    const assistantMsg: Message = {
      role: 'assistant',
      content: fullText,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      usage: totalInput > 0 ? { inputTokens: totalInput, outputTokens: totalOutput, costCents: cost.totalCostCents } : undefined,
      timestamp: Date.now(),
    }
    sessions.addMessage(assistantMsg)
    sessions.trimHistory(config.maxHistory)
    tui.enableInput()
  }

  async function handleCommand(input: string): Promise<void> {
    const parts = input.slice(1).split(' ')
    const cmd = parts[0].toLowerCase()
    const args = parts.slice(1)

    switch (cmd) {
      case 'exit':
      case 'quit':
      case 'q':
        cleanup()
        break

      case 'clear':
        sessions.clear()
        tui.clearMessages()
        tui.showSystem('Conversation cleared.')
        break

      case 'new': {
        const name = args[0] || `s-${Date.now()}`
        sessions.switchTo(name)
        tui.clearMessages()
        tui.updateSession(name)
        tui.showSystem(`New session: ${name}`)
        break
      }

      case 'load': {
        const name = args[0]
        if (!name) {
          tui.showError('Usage: /load <name>')
          break
        }
        sessions.switchTo(name)
        tui.clearMessages()
        for (const msg of sessions.messages) {
          if (msg.role === 'user') tui.addUserMessage(msg.content)
          else tui.addAssistantMessage(msg.content)
        }
        tui.updateSession(name)
        tui.showSystem(`Loaded: ${name}`)
        break
      }

      case 'sessions':
      case 'ls': {
        const list = sessions.list()
        if (list.length === 0) {
          tui.showSystem('No saved sessions.')
          break
        }
        const details = list.map((name) => {
          const info = sessions.getInfo(name)
          const marker = name === sessions.session.name ? ' *' : '  '
          const age = info ? formatAge(info.updated) : ''
          const msgs = info ? `${info.messageCount} msgs` : ''
          return `${marker} ${name.padEnd(20)} ${msgs.padEnd(10)} ${age}`
        })
        tui.showSystem('Sessions:\n' + details.join('\n'))
        break
      }

      case 'delete':
      case 'rm': {
        const name = args[0]
        if (!name) {
          tui.showError('Usage: /delete <name>')
          break
        }
        if (sessions.delete(name)) {
          tui.showSystem(`Deleted: ${name}`)
        } else {
          tui.showError(`Session not found: ${name}`)
        }
        break
      }

      case 'model': {
        const m = args[0]
        if (!m) {
          tui.showSystem(formatModelList(config.model) + '\n\n' + formatProviderList())
          break
        }
        const { provider, model: modelName } = parseModelString(m)
        const resolved = provider === 'anthropic' ? resolveModel(modelName) : modelName
        config.model = provider === 'anthropic' ? resolved : `${provider}:${resolved}`
        saveConfig(config)
        if (provider === 'anthropic') {
          claude.setModel(resolved)
        } else {
          // For non-anthropic providers, show info but keep using claude for now
          // Full provider switch requires restarting the provider instance
          tui.showSystem(`Note: ${provider} provider selected. Restart tinyclaw for full provider switch.`)
        }
        tracker.setModel(resolved)
        tui.updateModel(config.model)
        tui.showSystem(`Model -> ${config.model}`)
        break
      }

      case 'skills': {
        tui.showSystem(formatSkillList(skills))
        break
      }

      case 'auth':
        tui.showSystem(
          `Auth: ${auth.source}` +
          (auth.subscriptionType ? ` (${auth.subscriptionType})` : '') +
          (auth.expiresAt
            ? `\nExpires: ${new Date(auth.expiresAt).toLocaleString()}`
            : ''),
        )
        break

      case 'config':
        tui.showSystem(`Config: ${getConfigPath()}`)
        break

      case 'export': {
        const datePart = new Date().toISOString().split('T')[0]
        const exportPath = args[0] || `tinyclaw-${sessions.session.name}-${datePart}.md`
        try {
          const md = exportToMarkdown(sessions.session)
          writeFileSync(exportPath, md)
          tui.showSystem(`Exported to: ${exportPath}`)
        } catch (err) {
          tui.showError(`Export failed: ${err instanceof Error ? err.message : err}`)
        }
        break
      }

      case 'cost':
        tui.showSystem(`Session: ${tracker.formatSession()}`)
        break

      case 'retry': {
        const lastUserMsg = [...sessions.messages].reverse().find((m) => m.role === 'user')
        if (!lastUserMsg) {
          tui.showError('No previous message to retry.')
          break
        }
        // Remove last exchange (assistant + user) via safe method that persists
        const msgs = sessions.messages
        let toPop = 0
        if (msgs.length > 0 && msgs[msgs.length - 1].role === 'assistant') toPop++
        if (msgs.length > toPop && msgs[msgs.length - 1 - toPop].role === 'user') toPop++
        if (toPop > 0) sessions.popMessages(toPop)

        tui.showSystem('Retrying...')
        await handleSubmit(lastUserMsg.content)
        break
      }

      case 'help':
      case '?':
        tui.showSystem(
          [
            'Commands:',
            '  /help          Show this help',
            '  /clear         Clear conversation',
            '  /commit        AI-generated git commit',
            '  /persona [name] Switch assistant mode',
            '  /copy          Copy last response to clipboard',
            '  /fork [name]   Fork current session',
            '  /new [name]    Start new session',
            '  /load <name>   Load session',
            '  /sessions      List sessions',
            '  /delete <name> Delete session',
            '  /model [name]  Show/set model',
            '  /export [path] Export to markdown',
            '  /cost          Show token usage',
            '  /retry         Retry last message',
            '  /undo          Undo last file change',
            '  /search <text> Search conversation',
            '  /lang [code]   Set language (auto, pt, en...)',
            '  /config        Show config path',
            '  /exit          Quit',
            '',
            'Business:',
            '  /briefing      Daily briefing (agenda + news + system)',
            '  /news [cat]    News radar (business/tech/finance/brazil/world)',
            '  /open <app>    Open Windows app (excel, word, outlook...)',
            '  /openfile <p>  Open file with default app',
            '  /apps          Show running applications',
            '  /sysinfo       System resources (CPU, RAM, disk)',
            '  /calendar      Today\'s Outlook calendar',
            '',
            'Tab completes commands. Use \\ at end of line for multi-line.',
            '',
            'Keys:',
            '  Ctrl+C      Cancel stream / exit',
            '  Ctrl+D      Exit',
            '  Ctrl+L      Redraw screen',
            '  Up/Down     Input history',
            '  PgUp/PgDown Scroll messages',
          ].join('\n'),
        )
        break

      case 'commit': {
        if (!await isGitRepo()) {
          tui.showError('Not a git repository.')
          break
        }
        const status = await gitStatus()
        if (status === '(clean)') {
          tui.showSystem('Nothing to commit — working tree clean.')
          break
        }
        tui.showSystem('Changes:\n' + status)
        tui.disableInput()

        // Get diff and generate commit message via AI
        const diff = await gitDiff()
        const commitPrompt = `Generate a concise git commit message for these changes. Use conventional commits format (feat:, fix:, refactor:, docs:, chore:, etc.). One line, max 72 chars. No quotes. Just the message.\n\nDiff:\n${diff.slice(0, 8000)}`

        tui.startStream()
        let commitMsg = ''
        for await (const event of claude.chat(
          [{ role: 'user', content: commitPrompt, timestamp: Date.now() }],
          'You generate git commit messages. Output ONLY the commit message, nothing else.',
          false,
        )) {
          if (event.type === 'text') {
            commitMsg += event.text
            tui.appendStream(event.text)
          }
        }
        tui.endStream()

        commitMsg = commitMsg.trim().replace(/^["']|["']$/g, '')

        // Stage and commit
        await gitStageAll()
        const result = await gitCommit(commitMsg)
        if (result.ok) {
          tui.showSystem(`Committed: ${commitMsg}`)
        } else {
          tui.showError(`Commit failed: ${result.output}`)
        }
        tui.enableInput()
        break
      }

      case 'persona': {
        const name = args[0]
        if (!name) {
          tui.showSystem(formatPersonaList(currentPersona))
          break
        }
        const persona = getPersona(name)
        if (!persona) {
          tui.showError(`Unknown persona: ${name}. Try /persona to see options.`)
          break
        }
        currentPersona = persona.name
        if (persona.systemPrompt) {
          activeSystemPrompt = buildSystemPrompt(persona.systemPrompt, skills, config.language)
        } else {
          activeSystemPrompt = systemPrompt
        }
        tui.showSystem(`Persona -> ${persona.name}: ${persona.description}`)
        break
      }

      case 'copy': {
        // Copy last assistant message to clipboard
        const lastAssistant = [...sessions.messages].reverse().find((m) => m.role === 'assistant')
        if (!lastAssistant) {
          tui.showError('No assistant message to copy.')
          break
        }
        const ok = await copyToClipboard(lastAssistant.content)
        if (ok) {
          tui.showSystem('Copied last response to clipboard.')
        } else {
          tui.showError('Failed to copy. Is xclip/pbcopy available?')
        }
        break
      }

      case 'ask': {
        const question = args.join(' ')
        if (!question) {
          tui.showError('Usage: /ask <question>')
          break
        }
        tui.addUserMessage(`(ephemeral) ${question}`)
        tui.disableInput()
        tui.startStream()
        let askText = ''
        // Send as isolated message — not saved to session, no tools
        for await (const event of claude.chat(
          [{ role: 'user', content: question, timestamp: Date.now() }],
          activeSystemPrompt,
          false,
        )) {
          if (event.type === 'text') {
            askText += event.text
            tui.appendStream(event.text)
          } else if (event.type === 'usage') {
            // Show usage inline but don't track in session
            tui.showUsage(`${event.inputTokens} in / ${event.outputTokens} out (ephemeral)`)
          }
        }
        tui.endStream()
        tui.enableInput()
        break
      }

      case 'fork': {
        const forkName = args[0] || `fork-${Date.now()}`
        sessions.fork(forkName)
        tui.updateSession(forkName)
        tui.showSystem(`Forked session -> ${forkName} (${sessions.messages.length} messages copied)`)
        break
      }

      case 'plugins': {
        tui.showSystem(formatPluginList(plugins))
        break
      }

      case 'budget': {
        const val = args[0]
        if (!val) {
          const max = config.maxSessionCost
          const spent = tracker.totals.costCents
          if (max === 0) {
            tui.showSystem(`Budget: unlimited (spent ~$${(spent / 100).toFixed(4)})`)
          } else {
            const pct = Math.round((spent / max) * 100)
            tui.showSystem(`Budget: ~$${(spent / 100).toFixed(4)} / $${(max / 100).toFixed(4)} (${pct}%)`)
          }
          break
        }
        const cents = Number(val)
        if (isNaN(cents) || cents < 0) {
          tui.showError('Usage: /budget <cents> (e.g., /budget 50 for $0.50)')
          break
        }
        config.maxSessionCost = cents
        saveConfig(config)
        tui.showSystem(cents === 0 ? 'Budget: unlimited' : `Budget set: $${(cents / 100).toFixed(2)}`)
        break
      }

      case 'undo': {
        const peek = undoStack.peek()
        if (!peek) {
          tui.showError('Nothing to undo.')
          break
        }
        const result = undoStack.undo()
        if (result) {
          tui.showSystem(result)
        }
        break
      }

      case 'search': {
        const query = args.join(' ').toLowerCase()
        if (!query) {
          tui.showError('Usage: /search <text>')
          break
        }
        const matches: string[] = []
        for (const msg of sessions.messages) {
          if (msg.content.toLowerCase().includes(query)) {
            const preview = msg.content.slice(0, 100).replace(/\n/g, ' ')
            const ts = new Date(msg.timestamp).toLocaleTimeString('en', { hour: '2-digit', minute: '2-digit' })
            matches.push(`  [${msg.role} ${ts}] ${preview}${msg.content.length > 100 ? '...' : ''}`)
          }
        }
        tui.showSystem(
          matches.length > 0
            ? `Found ${matches.length} match${matches.length > 1 ? 'es' : ''}:\n${matches.join('\n')}`
            : `No matches for "${query}".`,
        )
        break
      }

      case 'lang':
      case 'language': {
        const lang = args[0]
        if (!lang) {
          tui.showSystem(`Language: ${config.language} (auto = match user's language)`)
          break
        }
        config.language = lang
        saveConfig(config)
        tui.showSystem(`Language -> ${lang}`)
        break
      }

      // ── Business assistant commands ──────────────────────

      case 'briefing': {
        tui.showSystem('Carregando briefing...')
        tui.disableInput()
        try {
          const briefing = await generateBriefing()
          tui.showSystem(briefing)
        } catch (err) {
          tui.showError(`Briefing falhou: ${err instanceof Error ? err.message : String(err)}`)
        }
        tui.enableInput()
        break
      }

      case 'news': {
        const category = args[0] as NewsCategory | undefined
        const validCats: NewsCategory[] = ['business', 'tech', 'finance', 'brazil', 'world']
        if (category && !validCats.includes(category)) {
          tui.showSystem(getNewsCategories())
          break
        }
        tui.showSystem('Buscando noticias...')
        tui.disableInput()
        try {
          const news = await fetchNews(category ? [category] : undefined)
          tui.showSystem(news)
        } catch (err) {
          tui.showError(`Falha ao buscar noticias: ${err instanceof Error ? err.message : String(err)}`)
        }
        tui.enableInput()
        break
      }

      case 'open': {
        const appName = args.join(' ')
        if (!appName) {
          tui.showSystem(`Apps disponiveis: ${getKnownApps().join(', ')}\nUso: /open <app> ou /open <app> <arquivo>`)
          break
        }
        // Check if second arg looks like a file path
        const appArg = args.length > 1 ? args.slice(1).join(' ') : undefined
        const result = await openApp(args[0], appArg)
        tui.showSystem(result)
        break
      }

      case 'openfile': {
        const filePath = args.join(' ')
        if (!filePath) {
          tui.showError('Uso: /openfile <caminho>')
          break
        }
        const result = await openFile(filePath)
        tui.showSystem(result)
        break
      }

      case 'openurl': {
        const url = args[0]
        if (!url) {
          tui.showError('Uso: /openurl <url>')
          break
        }
        const result = await openUrl(url)
        tui.showSystem(result)
        break
      }

      case 'apps': {
        tui.disableInput()
        const result = await getRunningApps()
        tui.showSystem(result)
        tui.enableInput()
        break
      }

      case 'sysinfo': {
        tui.disableInput()
        const result = await getSystemInfo()
        tui.showSystem(result)
        tui.enableInput()
        break
      }

      case 'calendar':
      case 'cal': {
        tui.disableInput()
        const dateInfo = await getDateTimeInfo()
        const events = await getOutlookEvents()
        tui.showSystem(`${dateInfo}\n\n--- Agenda ---\n${events}`)
        tui.enableInput()
        break
      }

      default:
        tui.showError(`Unknown command: /${cmd}. Try /help`)
    }
  }

  function cleanup(): void {
    tui.stop()
    process.exit(0)
  }

  process.on('SIGINT', cleanup)
  process.on('SIGTERM', cleanup)

  tui.start({
    onSubmit: handleSubmit,
    onCancel: () => {
      activeAbort?.abort()
      tui.endStream()
      tui.showSystem('Cancelled.')
      tui.enableInput()
    },
    onExit: cleanup,
  })

  const authInfo = auth.source === 'subscription'
    ? `Authenticated via Claude ${auth.subscriptionType} subscription.`
    : 'Authenticated via API key.'
  tui.showSystem(`tinyclaw v${getVersion()} — the micro AI assistant.\n${authInfo}\nType /help for commands.`)

  // Auto-submit initial prompt if provided
  if (initialPrompt) {
    handleSubmit(initialPrompt)
  }
}

function formatAge(timestamp: number): string {
  const diff = Date.now() - timestamp
  const mins = Math.floor(diff / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

main().catch((err) => {
  // Ensure terminal is restored on crash
  try {
    process.stdin.setRawMode?.(false)
    process.stdout.write('\x1b[?1049l') // exit alt screen
    process.stdout.write('\x1b[?25h')   // show cursor
  } catch { /* best effort */ }
  console.error('Fatal:', err)
  process.exit(1)
})
