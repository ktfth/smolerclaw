#!/usr/bin/env bun
import { parseArgs, printHelp, getVersion } from './cli'
import { loadConfig, saveConfig, getConfigPath } from './config'
import { resolveAuth, refreshAuth, authLabel, type AuthResult } from './auth'
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
import { undoStack, registerPlugins, registerWindowsTools, TOOLS } from './tools'
import { loadPlugins, pluginsToTools, formatPluginList, getPluginDir } from './plugins'
import { formatApprovalPrompt, formatEditDiff } from './approval'
import { extractImages } from './images'
import { openApp, openFile, openUrl, getRunningApps, getSystemInfo, getDateTimeInfo, getOutlookEvents, getKnownApps } from './windows'
import { fetchNews, getNewsCategories, type NewsCategory } from './news'
import { generateBriefing } from './briefing'
import { initTasks, stopTasks, addTask, completeTask, removeTask, listTasks, formatTaskList, parseTime, type Task } from './tasks'
import { initPeople, addPerson, findPerson, listPeople, logInteraction, delegateTask, getDelegations, getPendingFollowUps, markFollowUpDone, formatPeopleList, formatPersonDetail, formatDelegationList, formatFollowUps, generatePeopleDashboard, type PersonGroup, type InteractionType } from './people'
import { initMemos, saveMemo, searchMemos, listMemos, deleteMemo, formatMemoList, formatMemoDetail, formatMemoTags } from './memos'
import { isFirstRunToday, markMorningDone, generateMorningBriefing } from './morning'
import { openEmailDraft, formatDraftPreview } from './email'
import { initPomodoro, startPomodoro, stopPomodoro, pomodoroStatus, stopPomodoroTimer } from './pomodoro'
import { initFinance, addTransaction, getMonthSummary, getRecentTransactions, removeTransaction } from './finance'
import { initDecisions, logDecision, searchDecisions, listDecisions, formatDecisionList, formatDecisionDetail } from './decisions'
import { initWorkflows, runWorkflow, listWorkflows, createWorkflow, deleteWorkflow, formatWorkflowList, type WorkflowStep } from './workflows'
import { initMonitor, startMonitor, stopMonitor, listMonitors, stopAllMonitors } from './monitor'
import { initInvestigations } from './investigate'
import { writeFileSync } from 'node:fs'
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
    console.log(`smolerclaw v${getVersion()}`)
    process.exit(0)
  }

  // ── Load config and auth ─────────────────────────────────
  const config = loadConfig()
  if (cliArgs.model) config.model = resolveModel(cliArgs.model)
  if (cliArgs.maxTokens) config.maxTokens = cliArgs.maxTokens

  let auth: AuthResult
  try {
    auth = resolveAuth()
  } catch (err) {
    console.error('smolerclaw:', err instanceof Error ? err.message : err)
    process.exit(1)
  }

  // Initialize provider based on model string
  const { provider: providerType, model: providerModel } = parseModelString(config.model)
  let claude: ClaudeProvider | OpenAICompatProvider

  if (providerType === 'openai' || providerType === 'ollama') {
    claude = new OpenAICompatProvider(providerType, providerModel, config.maxTokens)
  } else {
    const claudeProvider = new ClaudeProvider(auth.token, config.model, config.maxTokens, config.toolApproval)

    // Auto-refresh credentials on 401 so the session survives token expiration
    claudeProvider.setAuthRefresh(() => {
      const freshAuth = refreshAuth()
      if (freshAuth && freshAuth.token !== auth.token) {
        auth = freshAuth
        claudeProvider.updateApiKey(freshAuth.token)
        return true
      }
      return false
    })

    claude = claudeProvider
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
    console.error('smolerclaw: no input provided')
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
      console.error(`\nsmolerclaw error: ${event.error}`)
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

  // Initialize people, task, and memo systems
  initPeople(config.dataDir)
  initMemos(config.dataDir)
  initFinance(config.dataDir)
  initDecisions(config.dataDir)
  initPomodoro((msg) => tui.showSystem(`\n*** ${msg} ***\n`))
  initWorkflows(config.dataDir)
  initInvestigations(config.dataDir)
  initMonitor((msg) => tui.showSystem(`\n*** ${msg} ***\n`))
  initTasks(config.dataDir, (task: Task) => {
    tui.showSystem(`\n*** LEMBRETE: ${task.title} ***\n`)
  })

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
      case 'sair':
      case 'q':
        cleanup()
        break

      case 'clear':
      case 'limpar':
        sessions.clear()
        tui.clearMessages()
        tui.showSystem('Conversation cleared.')
        break

      case 'new':
      case 'novo':
      case 'nova': {
        const name = args[0] || `s-${Date.now()}`
        sessions.switchTo(name)
        tui.clearMessages()
        tui.updateSession(name)
        tui.showSystem(`New session: ${name}`)
        break
      }

      case 'load':
      case 'carregar': {
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
      case 'sessoes':
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
      case 'deletar':
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

      case 'model':
      case 'modelo': {
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
          tui.showSystem(`Note: ${provider} provider selected. Restart smolerclaw for full provider switch.`)
        }
        tracker.setModel(resolved)
        tui.updateModel(config.model)
        tui.showSystem(`Model -> ${config.model}`)
        break
      }

      case 'skills':
      case 'habilidades': {
        tui.showSystem(formatSkillList(skills))
        break
      }

      case 'auth':
        tui.showSystem(
          `Auth: subscription (${auth.subscriptionType})` +
          `\nExpires: ${new Date(auth.expiresAt).toLocaleString()}`,
        )
        break

      case 'config':
        tui.showSystem(`Config: ${getConfigPath()}`)
        break

      case 'export':
      case 'exportar': {
        const datePart = new Date().toISOString().split('T')[0]
        const exportPath = args[0] || `smolerclaw-${sessions.session.name}-${datePart}.md`
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
      case 'custo':
        tui.showSystem(`Session: ${tracker.formatSession()}`)
        break

      case 'retry':
      case 'repetir': {
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
        // Reconstruct input with image references if present
        const retryInput = lastUserMsg.images?.length
          ? lastUserMsg.content  // images are stored in session, will be picked up again
          : lastUserMsg.content
        await handleSubmit(retryInput)
        break
      }

      case 'help':
      case 'ajuda':
      case '?':
        tui.showSystem(
          [
            'Comandos / Commands (en | pt):',
            '  /help /ajuda           Mostrar ajuda',
            '  /clear /limpar         Limpar conversa',
            '  /new /novo             Nova sessao',
            '  /load /carregar        Carregar sessao',
            '  /sessions /sessoes     Listar sessoes',
            '  /delete /deletar       Deletar sessao',
            '  /model /modelo         Ver/trocar modelo',
            '  /persona /modo         Trocar modo (business, coder...)',
            '  /export /exportar      Exportar para markdown',
            '  /copy /copiar          Copiar ultima resposta',
            '  /cost /custo           Ver uso de tokens',
            '  /retry /repetir        Repetir ultima msg',
            '  /undo /desfazer        Desfazer alteracao',
            '  /search /buscar        Buscar na conversa',
            '  /lang /idioma          Definir idioma',
            '  /commit /commitar      Git commit com IA',
            '  /exit /sair            Sair',
            '',
            'Negocios / Business:',
            '  /briefing /resumo      Briefing diario',
            '  /news /noticias        Radar de noticias',
            '  /open /abrir           Abrir app Windows',
            '  /apps /programas       Apps em execucao',
            '  /sysinfo /sistema      Recursos do sistema',
            '  /calendar /agenda      Calendario Outlook',
            '',
            'Pessoas / People:',
            '  /addperson /novapessoa  Cadastrar pessoa',
            '  /people /pessoas        Listar todas',
            '  /team /equipe           Listar equipe',
            '  /family /familia        Listar familia',
            '  /person /pessoa         Detalhes de alguem',
            '  /delegate /delegar      Delegar tarefa',
            '  /delegations /delegacoes Listar delegacoes',
            '  /followups              Follow-ups pendentes',
            '  /dashboard /painel      Painel geral',
            '',
            'Monitor:',
            '  /monitor /vigiar     Monitorar processo (ex: /monitor nginx)',
            '  /monitor stop <nome> Parar monitoramento',
            '',
            'Workflows:',
            '  /workflow /fluxo     Listar workflows',
            '  /workflow run <nome> Executar (ex: /workflow iniciar-dia)',
            '',
            'Pomodoro:',
            '  /pomodoro /foco      Iniciar (ex: /foco revisar codigo)',
            '  /pomodoro status     Ver tempo restante',
            '  /pomodoro stop       Parar',
            '',
            'Financas / Finance:',
            '  /entrada <$> <cat>   Registrar entrada',
            '  /saida <$> <cat>     Registrar saida',
            '  /finance /balanco    Resumo mensal',
            '',
            'Decisoes / Decisions:',
            '  /decisoes [busca]    Listar/buscar decisoes',
            '',
            'Email:',
            '  /email /rascunho     Rascunho (ex: /email joao@x.com oi | texto)',
            '',
            'Memos / Notes:',
            '  /memo /anotar        Salvar memo (ex: /memo senha wifi #casa)',
            '  /memos /notas        Buscar memos (ex: /memos docker)',
            '  /tags /memotags      Listar tags',
            '  /rmmemo /rmnota      Remover memo',
            '',
            'Investigacao / Investigation:',
            '  /investigar /investigate  Listar investigacoes',
            '  /investigar <busca>       Buscar por palavra-chave',
            '',
            'Tarefas / Tasks:',
            '  /task /tarefa           Criar tarefa (ex: /tarefa 18h buscar pao)',
            '  /tasks /tarefas         Listar pendentes',
            '  /done /feito            Marcar como concluida',
            '  /rmtask /rmtarefa       Remover tarefa',
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

      case 'commit':
      case 'commitar': {
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

        try {
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
            } else if (event.type === 'error') {
              tui.showError(event.error)
            }
          }
          tui.endStream()

          commitMsg = commitMsg.trim().replace(/^["']|["']$/g, '')

          // Guard: don't stage/commit with empty message
          if (!commitMsg) {
            tui.showError('Failed to generate commit message. Aborting.')
            break
          }

          // Stage and commit
          await gitStageAll()
          const result = await gitCommit(commitMsg)
          if (result.ok) {
            tui.showSystem(`Committed: ${commitMsg}`)
          } else {
            tui.showError(`Commit failed: ${result.output}`)
          }
        } catch (err) {
          tui.showError(`Commit error: ${err instanceof Error ? err.message : String(err)}`)
        }
        tui.enableInput()
        break
      }

      case 'persona':
      case 'modo': {
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

      case 'copy':
      case 'copiar': {
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

      case 'ask':
      case 'perguntar': {
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
          } else if (event.type === 'error') {
            tui.showError(event.error)
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

      case 'budget':
      case 'orcamento': {
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

      case 'undo':
      case 'desfazer': {
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

      case 'search':
      case 'buscar': {
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
      case 'language':
      case 'idioma': {
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

      case 'briefing':
      case 'resumo': {
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

      case 'news':
      case 'noticias': {
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

      case 'open':
      case 'abrir': {
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

      case 'openfile':
      case 'abrirarquivo': {
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

      case 'apps':
      case 'programas': {
        tui.disableInput()
        try {
          const result = await getRunningApps()
          tui.showSystem(result)
        } catch (err) {
          tui.showError(`Apps: ${err instanceof Error ? err.message : String(err)}`)
        }
        tui.enableInput()
        break
      }

      case 'sysinfo':
      case 'sistema': {
        tui.disableInput()
        try {
          const result = await getSystemInfo()
          tui.showSystem(result)
        } catch (err) {
          tui.showError(`Sysinfo: ${err instanceof Error ? err.message : String(err)}`)
        }
        tui.enableInput()
        break
      }

      case 'calendar':
      case 'calendario':
      case 'agenda':
      case 'cal': {
        tui.disableInput()
        try {
          const dateInfo = await getDateTimeInfo()
          const events = await getOutlookEvents()
          tui.showSystem(`${dateInfo}\n\n--- Agenda ---\n${events}`)
        } catch (err) {
          tui.showError(`Calendar: ${err instanceof Error ? err.message : String(err)}`)
        }
        tui.enableInput()
        break
      }

      // ── Monitor commands ───────────────────────────────────

      case 'monitor':
      case 'vigiar': {
        const sub = args[0]?.toLowerCase()
        if (!sub || sub === 'list' || sub === 'listar') {
          tui.showSystem(listMonitors())
        } else if (sub === 'stop' || sub === 'parar') {
          const name = args[1]
          if (!name) { tui.showError('Uso: /monitor stop <processo>'); break }
          tui.showSystem(stopMonitor(name))
        } else {
          // Start monitoring
          const intervalSec = parseInt(args[1]) || 60
          tui.showSystem(startMonitor(sub, intervalSec))
        }
        break
      }

      // ── Workflow commands ──────────────────────────────────

      case 'workflow':
      case 'fluxo': {
        const sub = args[0]?.toLowerCase()
        if (!sub || sub === 'list' || sub === 'listar') {
          tui.showSystem(formatWorkflowList())
        } else if (sub === 'run' || sub === 'rodar') {
          const name = args[1]
          if (!name) {
            tui.showError('Uso: /workflow run <nome>')
            break
          }
          tui.disableInput()
          try {
            const result = await runWorkflow(name, (msg) => tui.showSystem(msg))
            tui.showSystem(result)
          } catch (err) {
            tui.showError(`Workflow: ${err instanceof Error ? err.message : String(err)}`)
          }
          tui.enableInput()
        } else if (sub === 'delete' || sub === 'deletar') {
          const name = args[1]
          if (!name) { tui.showError('Uso: /workflow delete <nome>'); break }
          if (deleteWorkflow(name)) {
            tui.showSystem(`Workflow removido: ${name}`)
          } else {
            tui.showError(`Workflow nao encontrado: ${name}`)
          }
        } else {
          // Treat as "run <name>"
          tui.disableInput()
          try {
            const result = await runWorkflow(sub, (msg) => tui.showSystem(msg))
            tui.showSystem(result)
          } catch (err) {
            tui.showError(`Workflow: ${err instanceof Error ? err.message : String(err)}`)
          }
          tui.enableInput()
        }
        break
      }

      // ── Pomodoro commands ─────────────────────────────────

      case 'pomodoro':
      case 'foco': {
        const sub = args[0]?.toLowerCase()
        if (sub === 'stop' || sub === 'parar') {
          tui.showSystem(stopPomodoro())
        } else if (sub === 'status') {
          tui.showSystem(pomodoroStatus())
        } else if (!sub) {
          tui.showSystem(pomodoroStatus())
        } else {
          // Start with label
          const label = args.join(' ')
          const workMin = 25
          const breakMin = 5
          tui.showSystem(startPomodoro(label, workMin, breakMin))
        }
        break
      }

      // ── Finance commands ────────────────────────────────────

      case 'entrada':
      case 'income': {
        // /entrada 500 salario descricao
        const amount = parseFloat(args[0])
        if (isNaN(amount) || args.length < 3) {
          tui.showSystem('Uso: /entrada <valor> <categoria> <descricao>')
          break
        }
        const tx = addTransaction('entrada', amount, args[1], args.slice(2).join(' '))
        tui.showSystem(`+ R$ ${tx.amount.toFixed(2)} (${tx.category}) — ${tx.description}`)
        break
      }

      case 'saida':
      case 'expense': {
        const amount = parseFloat(args[0])
        if (isNaN(amount) || args.length < 3) {
          tui.showSystem('Uso: /saida <valor> <categoria> <descricao>')
          break
        }
        const tx = addTransaction('saida', amount, args[1], args.slice(2).join(' '))
        tui.showSystem(`- R$ ${tx.amount.toFixed(2)} (${tx.category}) — ${tx.description}`)
        break
      }

      case 'finance':
      case 'financas':
      case 'balanco': {
        const sub = args[0]
        if (sub === 'recent' || sub === 'recentes') {
          tui.showSystem(getRecentTransactions())
        } else {
          tui.showSystem(getMonthSummary() + '\n\n' + getRecentTransactions(5))
        }
        break
      }

      // ── Decision commands ───────────────────────────────────

      case 'decisions':
      case 'decisoes': {
        const query = args.join(' ')
        if (query) {
          const results = searchDecisions(query)
          tui.showSystem(formatDecisionList(results))
        } else {
          tui.showSystem(formatDecisionList(listDecisions()))
        }
        break
      }

      // ── Investigation commands ─────────────────────────────

      case 'investigar':
      case 'investigate':
      case 'investigacoes': {
        const query = args.join(' ')
        if (query) {
          const { searchInvestigations, formatInvestigationList } = await import('./investigate')
          tui.showSystem(formatInvestigationList(searchInvestigations(query)))
        } else {
          const { listInvestigations, formatInvestigationList } = await import('./investigate')
          tui.showSystem(formatInvestigationList(listInvestigations()))
        }
        break
      }

      // ── Email command ──────────────────────────────────────

      case 'email':
      case 'rascunho': {
        // Quick email: /email to@addr.com assunto | corpo
        const text = args.join(' ')
        if (!text) {
          tui.showSystem('Uso: /email <destinatario> <assunto> | <corpo>\nOu peca a IA: "escreve um email para joao@email.com cobrando o relatorio"')
          break
        }
        // Parse: first word is email, rest before | is subject, after | is body
        const emailAddr = args[0]
        const restText = args.slice(1).join(' ')
        const pipeIdx = restText.indexOf('|')
        if (pipeIdx === -1) {
          tui.showSystem('Formato: /email <destinatario> <assunto> | <corpo>\nUse | para separar assunto do corpo.')
          break
        }
        const subject = restText.slice(0, pipeIdx).trim()
        const body = restText.slice(pipeIdx + 1).trim()
        if (!subject || !body) {
          tui.showError('Assunto e corpo sao obrigatorios.')
          break
        }
        const draft = { to: emailAddr, subject, body }
        tui.showSystem(formatDraftPreview(draft))
        tui.disableInput()
        try {
          const result = await openEmailDraft(draft)
          tui.showSystem(result)
        } catch (err) {
          tui.showError(`Email: ${err instanceof Error ? err.message : String(err)}`)
        }
        tui.enableInput()
        break
      }

      // ── Memo commands ─────────────────────────────────────

      case 'memo':
      case 'anotar':
      case 'note': {
        const text = args.join(' ')
        if (!text) {
          // Show recent memos
          const memos = listMemos()
          tui.showSystem(formatMemoList(memos))
          break
        }
        const memo = saveMemo(text)
        const tagStr = memo.tags.length > 0 ? ` [${memo.tags.map((t: string) => '#' + t).join(' ')}]` : ''
        tui.showSystem(`Memo salvo${tagStr}  {${memo.id}}`)
        break
      }

      case 'memos':
      case 'notas': {
        const query = args.join(' ')
        if (query) {
          const results = searchMemos(query)
          tui.showSystem(formatMemoList(results))
        } else {
          const memos = listMemos()
          tui.showSystem(formatMemoList(memos))
        }
        break
      }

      case 'memotags':
      case 'tags': {
        tui.showSystem(formatMemoTags())
        break
      }

      case 'rmmemo':
      case 'rmnota': {
        const id = args[0]
        if (!id) {
          tui.showError('Uso: /rmmemo <id>')
          break
        }
        if (deleteMemo(id)) {
          tui.showSystem('Memo removido.')
        } else {
          tui.showError(`Memo nao encontrado: ${id}`)
        }
        break
      }

      // ── People management commands ────────────────────────

      case 'people':
      case 'pessoas':
      case 'equipe':
      case 'team':
      case 'familia':
      case 'family':
      case 'contato':
      case 'contatos':
      case 'contacts': {
        const groupMap: Record<string, PersonGroup> = {
          equipe: 'equipe', team: 'equipe',
          familia: 'familia', family: 'familia',
          contato: 'contato', contatos: 'contato', contacts: 'contato',
        }
        const groupFilter = groupMap[cmd] || args[0] as PersonGroup | undefined
        const people = listPeople(groupFilter)
        tui.showSystem(formatPeopleList(people))
        break
      }

      case 'person':
      case 'pessoa': {
        const ref = args.join(' ')
        if (!ref) {
          tui.showError('Uso: /person <nome>')
          break
        }
        const person = findPerson(ref)
        if (!person) {
          tui.showError(`Pessoa nao encontrada: "${ref}"`)
          break
        }
        tui.showSystem(formatPersonDetail(person))
        break
      }

      case 'addperson':
      case 'addpessoa':
      case 'novapessoa': {
        // /addperson <group> <name> [role]
        const group = args[0] as PersonGroup
        const validGroups: PersonGroup[] = ['equipe', 'familia', 'contato']
        if (!group || !validGroups.includes(group)) {
          tui.showSystem('Uso: /addperson <equipe|familia|contato> <nome> [papel]\nEx: /addperson equipe Joao dev frontend')
          break
        }
        const nameAndRole = args.slice(1).join(' ')
        if (!nameAndRole) {
          tui.showError('Nome obrigatorio. Ex: /addperson equipe Joao dev frontend')
          break
        }
        // Split name from role at first comma if present
        const [pName, ...roleParts] = nameAndRole.split(',')
        const pRole = roleParts.join(',').trim() || undefined
        const newPerson = addPerson(pName.trim(), group, pRole)
        tui.showSystem(`Adicionado: ${newPerson.name} (${group}) [${newPerson.id}]`)
        break
      }

      case 'delegate':
      case 'delegar': {
        // /delegate <person> <task>
        const personName = args[0]
        if (!personName || args.length < 2) {
          tui.showSystem('Uso: /delegate <pessoa> <tarefa>\nEx: /delegate Joao revisar relatorio')
          break
        }
        const taskText = args.slice(1).join(' ')
        const delegation = delegateTask(personName, taskText)
        if (!delegation) {
          tui.showError(`Pessoa nao encontrada: "${personName}"`)
          break
        }
        tui.showSystem(`Delegado para ${personName}: "${taskText}" [${delegation.id}]`)
        break
      }

      case 'delegations':
      case 'delegacoes':
      case 'delegados': {
        const personRef = args[0]
        const delegations = getDelegations(personRef)
        tui.showSystem(formatDelegationList(delegations))
        break
      }

      case 'followups': {
        const followUps = getPendingFollowUps()
        tui.showSystem(formatFollowUps(followUps))
        break
      }

      case 'dashboard':
      case 'painel': {
        tui.showSystem(generatePeopleDashboard())
        break
      }

      // ── Task/reminder commands ────────────────────────────

      case 'task':
      case 'tarefa': {
        const text = args.join(' ')
        if (!text) {
          // Show pending tasks
          const tasks = listTasks()
          tui.showSystem(formatTaskList(tasks))
          break
        }

        // Parse time from the text (look for time patterns)
        const dueTime = parseTime(text)

        // Remove time-related parts from the title
        let title = text
          .replace(/\b(para\s+(as\s+)?)?\d{1,2}\s*[h:]\s*\d{0,2}\b/gi, '')
          .replace(/\b(em\s+\d+\s*(min|minutos?|h|horas?))\b/gi, '')
          .replace(/\b(amanha|amanhã)\b/gi, '')
          .replace(/\s{2,}/g, ' ')
          .trim()

        // If title became empty, use the original text
        if (!title) title = text

        const task = addTask(title, dueTime || undefined)
        const dueStr = dueTime
          ? ` — lembrete: ${dueTime.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`
          : ''
        tui.showSystem(`Tarefa criada: "${task.title}"${dueStr}  [${task.id}]`)
        break
      }

      case 'tasks':
      case 'tarefas': {
        const showAll = args[0] === 'all' || args[0] === 'todas'
        const tasks = listTasks(showAll)
        tui.showSystem(formatTaskList(tasks))
        break
      }

      case 'done':
      case 'feito':
      case 'concluido': {
        const ref = args.join(' ')
        if (!ref) {
          tui.showError('Uso: /done <id ou parte do titulo>')
          break
        }
        const task = completeTask(ref)
        if (task) {
          tui.showSystem(`Concluida: "${task.title}"`)
        } else {
          tui.showError(`Tarefa nao encontrada: "${ref}"`)
        }
        break
      }

      case 'rmtask':
      case 'rmtarefa': {
        const ref = args.join(' ')
        if (!ref) {
          tui.showError('Uso: /rmtask <id ou parte do titulo>')
          break
        }
        const removed = removeTask(ref)
        if (removed) {
          tui.showSystem('Tarefa removida.')
        } else {
          tui.showError(`Tarefa nao encontrada: "${ref}"`)
        }
        break
      }

      default:
        tui.showError(`Unknown command: /${cmd}. Try /help`)
    }
  }

  function cleanup(): void {
    stopTasks()
    stopPomodoroTimer()
    stopAllMonitors()
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

  const authInfo = `Authenticated via Claude ${auth.subscriptionType} subscription.`
  tui.showSystem(`smolerclaw v${getVersion()} — the micro AI assistant.\n${authInfo}\nType /ajuda for commands.`)

  // Morning briefing — first run of the day
  if (isFirstRunToday(config.dataDir)) {
    try {
      const briefing = await generateMorningBriefing()
      tui.showSystem(briefing)
      markMorningDone()
    } catch {
      // Don't block startup if briefing fails
    }
  }

  // Auto-submit initial prompt if provided
  if (initialPrompt) {
    await handleSubmit(initialPrompt)
  }
}

function formatAge(timestamp: number): string {
  if (!timestamp || timestamp <= 0) return ''
  const diff = Date.now() - timestamp
  if (diff < 0) return ''
  const mins = Math.floor(diff / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days > 365) return `${Math.floor(days / 365)}y ago`
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
