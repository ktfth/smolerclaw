import { loadConfig } from '../config'
import { logger } from '../core/logger'
import { type AuthResult, authLabel } from '../auth'
import { loadSkills, buildSystemPrompt } from '../skills'
import { TUI } from '../tui'
import { TokenTracker } from '../tokens'
import { extractImages, extractFiles } from '../images'
import { formatApprovalPrompt, formatEditDiff } from '../approval'
import { getTimeContext, type TimeContext } from '../briefing'
import { stopTasks } from '../tasks'
import { stopPomodoroTimer } from '../pomodoro'
import { stopAllMonitors } from '../monitor'
import { stopScheduler } from '../scheduler'
import { stopAutoBackup } from '../vault'
import { isFirstRunToday, markMorningDone, generateMorningBriefing } from '../morning'
import { runSelfReflection } from '../services/docs-engine'
import { getVersion } from '../cli'
import { initAllModules } from '../init/modules'
import { handleCommand, generateDashboardBriefing } from '../commands/handlers'
import type { CommandContext } from '../commands/handlers'
import type { AnyProvider, AuthHolder } from '../init/providers'
import type { SessionManager } from '../session'
import type { loadPlugins } from '../plugins'
import type { Message, ToolCall } from '../types'

export async function runInteractive(
  claude: AnyProvider,
  sessions: SessionManager,
  config: ReturnType<typeof loadConfig>,
  authHolder: AuthHolder,
  skills: ReturnType<typeof loadSkills>,
  systemPrompt: string,
  activeSystemPromptInit: string,
  enableTools: boolean,
  plugins: ReturnType<typeof loadPlugins>,
  initialPrompt?: string,
): Promise<void> {
  const tracker = new TokenTracker(config.model)
  const tui = new TUI(config.model, sessions.session.name, authLabel(authHolder.auth), config.dataDir)
  let currentPersona = 'default'
  let activeSystemPrompt = activeSystemPromptInit

  // Initialize people, task, memo, and material systems
  initAllModules(config.dataDir, tui, sessions)

  // Initialize Time & Load Balancer — detect persona based on day/workload
  let timeContext: TimeContext | null = null
  try {
    timeContext = await getTimeContext(config.dataDir)
    tui.setTimeContext(timeContext)
  } catch (err) {
    logger.debug('Time context init failed, using productivity mode', { error: err })
    tui.setPersonaMode('productivity')
  }

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
      await handleCommand(input, commandCtx)
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

    // Extract image and file attachments from input
    const { text: textAfterImages, images } = extractImages(input)
    const { text: cleanedInput, files } = extractFiles(textAfterImages)

    // Build content with file contexts prepended
    let messageContent = cleanedInput
    if (files.length > 0) {
      const fileContexts = files.map((f) =>
        `<file name="${f.name}" path="${f.path}" size="${f.size}">\n${f.content}\n</file>`
      ).join('\n\n')
      messageContent = `${fileContexts}\n\n${cleanedInput}`
    }

    const userMsg: Message = {
      role: 'user',
      content: messageContent,
      images: images.length > 0 ? images.map((i) => ({ mediaType: i.mediaType, base64: i.base64 })) : undefined,
      files: files.length > 0 ? files : undefined,
      timestamp: Date.now(),
    }
    sessions.addMessage(userMsg)

    // Build display label
    const attachLabels: string[] = []
    if (images.length > 0) attachLabels.push(`${images.length} image${images.length > 1 ? 's' : ''}`)
    if (files.length > 0) attachLabels.push(`${files.length} file${files.length > 1 ? 's' : ''}`)
    const displayText = attachLabels.length > 0 ? `${cleanedInput} (${attachLabels.join(', ')})` : cleanedInput
    tui.addUserMessage(displayText)
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

  function cleanup(): void {
    sessions.saveLastSession()
    stopTasks()
    stopPomodoroTimer()
    stopAllMonitors()
    stopScheduler()
    stopAutoBackup()

    // Run self-reflection asynchronously before exit (non-blocking)
    runSelfReflection().catch(() => {
      // Best effort - don't block exit if reflection fails
    })

    tui.stop()
    process.exit(0)
  }

  // Build command context object for the handler
  const commandCtx: CommandContext = {
    tui,
    sessions,
    claude,
    config,
    auth: authHolder,
    skills,
    tracker,
    plugins,
    systemPrompt,
    activeSystemPrompt,
    setActiveSystemPrompt: (prompt: string) => {
      activeSystemPrompt = prompt
      commandCtx.activeSystemPrompt = prompt
    },
    currentPersona,
    setCurrentPersona: (name: string) => {
      currentPersona = name
      commandCtx.currentPersona = name
    },
    timeContext,
    setTimeContext: (ctx: TimeContext | null) => {
      timeContext = ctx
      commandCtx.timeContext = ctx
    },
    handleSubmit,
    cleanup,
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

  const authInfo = `Authenticated via Claude ${authHolder.auth.subscriptionType} subscription.`
  tui.showSystem(`smolerclaw v${getVersion()} — the micro AI assistant.\nCriado por Aldeia Viva - Impactando Vida (aldeia-viva.com.br)\n${authInfo}\nType /ajuda for commands.`)

  // Morning briefing — first run of the day
  if (isFirstRunToday(config.dataDir)) {
    try {
      // Generate dashboard layout for morning briefing
      const dashboardData = await generateDashboardBriefing(config.dataDir)

      if (dashboardData.panels.length > 0) {
        // Enter Dashboard Mode for the morning briefing
        tui.enterDashboardMode(dashboardData)

        // After 30 seconds or user input, return to chat mode
        const exitDashboardHandler = (): void => {
          tui.enterChatMode()
          tui.showSystem('Briefing exibido. Pressione qualquer tecla para continuar.')
          process.stdin.removeListener('data', exitDashboardHandler)
        }

        // Auto-exit dashboard after 30 seconds
        setTimeout(() => {
          if (tui.getViewMode() === 'dashboard') {
            tui.enterChatMode()
          }
        }, 30_000)

        // Exit on any key press
        process.stdin.once('data', () => {
          if (tui.getViewMode() === 'dashboard') {
            tui.enterChatMode()
          }
        })
      } else {
        // Fallback to text briefing if dashboard data is empty
        const briefing = await generateMorningBriefing()
        tui.showSystem(briefing)
      }

      markMorningDone()
    } catch (err) {
      logger.debug('Morning briefing failed at startup', { error: err })
    }
  }

  // Auto-submit initial prompt if provided
  if (initialPrompt) {
    await handleSubmit(initialPrompt)
  }
}
