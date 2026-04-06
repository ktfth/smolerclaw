import { loadConfig, saveConfig, getConfigPath } from '../config'
import { refreshAuth, authLabel, type AuthResult } from '../auth'
import { formatAutoRefreshStatus, updateAutoRefreshAuth } from '../auto-refresh'
import { loadSkills, buildSystemPrompt, formatSkillList } from '../skills'
import type { SessionPickerEntry, NewsPickerEntry, DashboardLayout, DashboardPanel } from '../tui'
import { TUI } from '../tui'
import { TokenTracker } from '../tokens'
import { exportToMarkdown } from '../export'
import { resolveModel, formatModelList, modelDisplayName } from '../models'
import { parseModelString, formatProviderList } from '../providers'
import { gitDiff, gitStatus, gitStageAll, gitCommit, isGitRepo } from '../git'
import { getPersona, formatPersonaList } from '../personas'
import { copyToClipboard } from '../clipboard'
import { undoStack } from '../tools'
import { formatPluginList } from '../plugins'
import { formatPluginRegistry, disablePlugin, enablePlugin, getPlugin, installPlugin, uninstallPlugin, listInstalledPlugins } from '../plugin-system'
import { formatApprovalPrompt, formatEditDiff } from '../approval'
import { fetchNews, fetchNewsItems, fetchNewsContent, getNewsCategories, addNewsFeed, removeNewsFeed, disableNewsFeed, enableNewsFeed, listNewsFeeds, type NewsCategory, type NewsItem } from '../news'
import { generateBriefing, getTimeContext, type TimeContext } from '../briefing'
import { stopTasks, addTask, completeTask, removeTask, listTasks, formatTaskList, parseTime, type Task } from '../tasks'
import { addPerson, findPerson, listPeople, logInteraction, delegateTask, getDelegations, getPendingFollowUps, markFollowUpDone, formatPeopleList, formatPersonDetail, formatDelegationList, formatFollowUps, generatePeopleDashboard, type PersonGroup } from '../people'
import { saveMemo, searchMemos, listMemos, deleteMemo, formatMemoList, formatMemoDetail, formatMemoTags } from '../memos'
import { saveMaterial, searchMaterials, listMaterials, deleteMaterial, updateMaterial, getMaterial, formatMaterialList, formatMaterialDetail, formatMaterialCategories } from '../materials'
import { isFirstRunToday, markMorningDone, generateMorningBriefing } from '../morning'
import { openEmailDraft, formatDraftPreview } from '../email'
import { startPomodoro, stopPomodoro, pomodoroStatus, stopPomodoroTimer } from '../pomodoro'
import {
  stopScheduler, scheduleJob, removeJob, enableJob, disableJob,
  listJobs, getJob, runJobNow, clearAllJobs,
  formatJobList, formatJobDetail,
  parseScheduleTime, parseScheduleDate, parseWeekDay,
  type ScheduleType,
} from '../scheduler'
import { addTransaction, getMonthSummary, getRecentTransactions } from '../finance'
import { verifyTransaction, recordVerifiedTransaction, formatVerification, getTodaySpendingSummary } from '../finance-guard'
import { searchDecisions, listDecisions, formatDecisionList } from '../decisions'
import { runWorkflow, listWorkflows, getWorkflow, deleteWorkflow, updateWorkflow, formatWorkflowList, formatWorkflowDetail } from '../workflows'
import { runMacro, listMacros, listAllMacros, getMacro, createMacro, deleteMacro, updateMacro, formatMacroList, formatMacroDetail, getMacroNames, type MacroAction } from '../macros'
import { startMonitor, stopMonitor, listMonitors, stopAllMonitors } from '../monitor'
import { buildIndex, queryMemory, getIndexStats, formatQueryResults } from '../memory'
import { getVaultStatus, formatVaultStatus, initShadowBackup, performBackup, syncBackupToRemote, startAutoBackup, stopAutoBackup } from '../vault'
import { executePowerShellScript, analyzeScreenContext, readClipboardContent } from '../windows-agent'
import { openApp, openFile, openUrl, getRunningApps, getSystemInfo, getDateTimeInfo, getOutlookEvents, getKnownApps } from '../windows'
import { runSelfReflection } from '../services/docs-engine'
import { getEnergyState, formatEnergyState, getProfile, type EnergyLevel } from '../energy'
import { getAttentionStats, formatAttentionStatus, getFocusMode } from '../attention'
import { listNeighborhoods } from '../neighborhoods'
import {
  setActiveProject, getActiveProject, autoDetectProject,
  listProjects, getProject, startSession, endSession, getOpenSession,
  listOpportunities, generateWorkReport, getProjectBriefingSummary,
  formatProjectList, formatProjectDetail, formatOpportunityList,
} from '../projects'
import { handleM365Command } from '../m365'
import { handleGwsCommand } from '../gws'
import { writeFileSync } from 'node:fs'
import { logger } from '../core/logger'
import type { SessionManager } from '../session'
import type { AnyProvider } from '../init/providers'
import type { loadPlugins } from '../plugins'

export interface CommandContext {
  tui: TUI
  sessions: SessionManager
  claude: AnyProvider
  config: ReturnType<typeof loadConfig>
  auth: { auth: AuthResult }
  skills: ReturnType<typeof loadSkills>
  tracker: TokenTracker
  plugins: ReturnType<typeof loadPlugins>
  systemPrompt: string
  activeSystemPrompt: string
  setActiveSystemPrompt: (prompt: string) => void
  currentPersona: string
  setCurrentPersona: (name: string) => void
  timeContext: TimeContext | null
  setTimeContext: (ctx: TimeContext | null) => void
  handleSubmit: (input: string) => Promise<void>
  cleanup: () => void
}

export async function handleCommand(input: string, ctx: CommandContext): Promise<void> {
  const parts = input.slice(1).split(' ')
  const cmd = parts[0].toLowerCase()
  const args = parts.slice(1)

  switch (cmd) {
    case 'exit':
    case 'quit':
    case 'sair':
    case 'q':
      ctx.cleanup()
      break

    case 'clear':
    case 'limpar':
      ctx.sessions.clear()
      ctx.tui.clearMessages()
      ctx.tui.showSystem('Conversation cleared.')
      break

    case 'new':
    case 'novo':
    case 'nova': {
      const name = args[0] || `s-${Date.now()}`
      ctx.sessions.switchTo(name)
      ctx.tui.clearMessages()
      ctx.tui.updateSession(name)
      ctx.tui.showSystem(`New session: ${name}`)
      break
    }

    case 'load':
    case 'carregar': {
      const name = args[0]
      if (!name) {
        ctx.tui.showError('Usage: /load <name>')
        break
      }
      ctx.sessions.switchTo(name)
      ctx.tui.clearMessages()
      for (const msg of ctx.sessions.messages) {
        if (msg.role === 'user') ctx.tui.addUserMessage(msg.content)
        else ctx.tui.addAssistantMessage(msg.content)
      }
      ctx.tui.updateSession(name)
      ctx.tui.showSystem(`Loaded: ${name}`)
      break
    }

    case 'sessions':
    case 'sessoes':
    case 'ls': {
      const active: SessionPickerEntry[] = ctx.sessions.list().map((name) => {
        const info = ctx.sessions.getInfo(name)
        return {
          name,
          messageCount: info?.messageCount ?? 0,
          updated: info?.updated ?? 0,
          isCurrent: name === ctx.sessions.session.name,
          isArchived: false,
        }
      })
      const archived: SessionPickerEntry[] = ctx.sessions.listArchived().map((name) => {
        const info = ctx.sessions.getArchivedInfo(name)
        return {
          name,
          messageCount: info?.messageCount ?? 0,
          updated: info?.updated ?? 0,
          isCurrent: false,
          isArchived: true,
        }
      })
      const pickerResult = await ctx.tui.promptSessionPicker([...active, ...archived])
      if (pickerResult) {
        switch (pickerResult.action) {
          case 'load': {
            const target = pickerResult.name
            const wasArchived = archived.some((e) => e.name === target)
            if (wasArchived) ctx.sessions.unarchive(target)
            ctx.sessions.switchTo(target)
            ctx.tui.clearMessages()
            for (const msg of ctx.sessions.messages) {
              if (msg.role === 'user') ctx.tui.addUserMessage(msg.content)
              else ctx.tui.addAssistantMessage(msg.content)
            }
            ctx.tui.updateSession(target)
            ctx.tui.showSystem(`Loaded: ${target}`)
            break
          }
          case 'delete': {
            const target = pickerResult.name
            const deleted = pickerResult.isArchived
              ? ctx.sessions.deleteArchived(target)
              : ctx.sessions.delete(target)
            if (deleted) ctx.tui.showSystem(`Deleted: ${target}`)
            else ctx.tui.showError(`Not found: ${target}`)
            break
          }
          case 'archive':
            if (ctx.sessions.archive(pickerResult.name)) {
              ctx.tui.showSystem(`Archived: ${pickerResult.name}`)
            } else {
              ctx.tui.showError(`Failed to archive: ${pickerResult.name}`)
            }
            break
          case 'unarchive':
            if (ctx.sessions.unarchive(pickerResult.name)) {
              ctx.tui.showSystem(`Restored: ${pickerResult.name}`)
            } else {
              ctx.tui.showError(`Not found in archive: ${pickerResult.name}`)
            }
            break
        }
      }
      break
    }

    case 'delete':
    case 'deletar':
    case 'rm': {
      const name = args[0]
      if (!name) {
        ctx.tui.showError('Usage: /delete <name>')
        break
      }
      if (ctx.sessions.delete(name)) {
        ctx.tui.showSystem(`Deleted: ${name}`)
      } else {
        ctx.tui.showError(`Session not found: ${name}`)
      }
      break
    }

    case 'archive':
    case 'arquivar': {
      const name = args[0]
      if (!name) {
        ctx.tui.showError('Uso: /archive <nome> ou /archive all')
        break
      }
      if (name === 'all' || name === 'todas') {
        const archived = ctx.sessions.archiveAll()
        if (archived.length > 0) {
          ctx.tui.showSystem(`Arquivadas ${archived.length} sessoes: ${archived.join(', ')}`)
        } else {
          ctx.tui.showSystem('Nenhuma sessao para arquivar (apenas a sessao atual esta ativa).')
        }
      } else {
        if (ctx.sessions.archive(name)) {
          ctx.tui.showSystem(`Sessao arquivada: "${name}"`)
        } else {
          ctx.tui.showError(`Falha ao arquivar "${name}" (nao encontrada ou e a sessao atual).`)
        }
      }
      break
    }

    case 'unarchive':
    case 'desarquivar':
    case 'restore':
    case 'restaurar': {
      const name = args[0]
      if (!name) {
        ctx.tui.showError('Uso: /unarchive <nome>')
        break
      }
      if (ctx.sessions.unarchive(name)) {
        ctx.tui.showSystem(`Sessao restaurada: "${name}"`)
      } else {
        ctx.tui.showError(`Sessao arquivada nao encontrada: "${name}"`)
      }
      break
    }

    case 'archived':
    case 'arquivadas': {
      const list = ctx.sessions.listArchived()
      if (list.length === 0) {
        ctx.tui.showSystem('Nenhuma sessao arquivada.')
        break
      }
      const details = list.map((name) => {
        const info = ctx.sessions.getArchivedInfo(name)
        const age = info ? formatAge(info.updated) : ''
        const msgs = info ? `${info.messageCount} msgs` : ''
        return `  ${name.padEnd(20)} ${msgs.padEnd(10)} ${age}`
      })
      ctx.tui.showSystem(`Sessoes arquivadas (${list.length}):\n${details.join('\n')}`)
      break
    }

    case 'model':
    case 'modelo': {
      const m = args[0]
      if (!m) {
        ctx.tui.showSystem(formatModelList(ctx.config.model) + '\n\n' + formatProviderList())
        break
      }
      const { provider, model: modelName } = parseModelString(m)
      const resolved = provider === 'anthropic' ? resolveModel(modelName) : modelName
      ctx.config.model = provider === 'anthropic' ? resolved : `${provider}:${resolved}`
      saveConfig(ctx.config)
      if (provider === 'anthropic') {
        ctx.claude.setModel(resolved)
      } else {
        // For non-anthropic providers, show info but keep using claude for now
        // Full provider switch requires restarting the provider instance
        ctx.tui.showSystem(`Note: ${provider} provider selected. Restart smolerclaw for full provider switch.`)
      }
      ctx.tracker.setModel(resolved)
      ctx.tui.updateModel(ctx.config.model)
      ctx.tui.showSystem(`Model -> ${ctx.config.model}`)
      break
    }

    case 'skills':
    case 'habilidades': {
      ctx.tui.showSystem(formatSkillList(ctx.skills))
      break
    }

    case 'auth':
      ctx.tui.showSystem(
        `Auth: subscription (${ctx.auth.auth.subscriptionType})` +
        `\nExpires: ${new Date(ctx.auth.auth.expiresAt).toLocaleString()}`,
      )
      break

    case 'refresh':
    case 'renovar': {
      ctx.tui.showSystem('Renovando sessao Claude...')
      try {
        const proc = Bun.spawn(['claude', '-p', 'Fresh!'], { stdout: 'pipe', stderr: 'pipe' })
        const timer = setTimeout(() => proc.kill(), 15_000)
        await proc.exited
        clearTimeout(timer)
        // Re-read credentials
        const freshAuth = refreshAuth()
        if (freshAuth) {
          ctx.auth.auth = freshAuth
          if ('updateToken' in ctx.claude) {
            (ctx.claude as any).updateToken(freshAuth.token)
          }
          updateAutoRefreshAuth(freshAuth)
          ctx.tui.showSystem(`Sessao renovada. Expira: ${new Date(freshAuth.expiresAt).toLocaleString()}`)
        } else {
          ctx.tui.showSystem('claude executado, mas credenciais nao atualizaram. Tente novamente.')
        }
      } catch (err) {
        ctx.tui.showError(`Falha ao renovar: ${err instanceof Error ? err.message : String(err)}`)
      }
      break
    }

    case 'auto-refresh':
    case 'autorefresh': {
      ctx.tui.showSystem(formatAutoRefreshStatus())
      break
    }

    case 'config':
      ctx.tui.showSystem(`Config: ${getConfigPath()}`)
      break

    case 'export':
    case 'exportar': {
      const datePart = new Date().toISOString().split('T')[0]
      const exportPath = args[0] || `smolerclaw-${ctx.sessions.session.name}-${datePart}.md`
      try {
        const md = exportToMarkdown(ctx.sessions.session)
        writeFileSync(exportPath, md)
        ctx.tui.showSystem(`Exported to: ${exportPath}`)
      } catch (err) {
        ctx.tui.showError(`Export failed: ${err instanceof Error ? err.message : err}`)
      }
      break
    }

    case 'cost':
    case 'custo':
      ctx.tui.showSystem(`Session: ${ctx.tracker.formatSession()}`)
      break

    case 'retry':
    case 'repetir': {
      const lastUserMsg = [...ctx.sessions.messages].reverse().find((m) => m.role === 'user')
      if (!lastUserMsg) {
        ctx.tui.showError('No previous message to retry.')
        break
      }
      // Remove last exchange (assistant + user) via safe method that persists
      const msgs = ctx.sessions.messages
      let toPop = 0
      if (msgs.length > 0 && msgs[msgs.length - 1].role === 'assistant') toPop++
      if (msgs.length > toPop && msgs[msgs.length - 1 - toPop].role === 'user') toPop++
      if (toPop > 0) ctx.sessions.popMessages(toPop)

      ctx.tui.showSystem('Retrying...')
      // Reconstruct input with image references if present
      const retryInput = lastUserMsg.images?.length
        ? lastUserMsg.content  // images are stored in session, will be picked up again
        : lastUserMsg.content
      await ctx.handleSubmit(retryInput)
      break
    }

    case 'help':
    case 'ajuda':
    case '?':
      ctx.tui.showSystem(
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
          '  /verificar /status      Energia, foco e Lokaliza',
          '',
          'Monitor:',
          '  /monitor /vigiar     Monitorar processo (ex: /monitor nginx)',
          '  /monitor stop <nome> Parar monitoramento',
          '',
          'Workflows:',
          '  /workflow /fluxo     Listar workflows',
          '  /workflow run <nome> Executar (ex: /workflow iniciar-dia)',
          '',
          'Macros / Atalhos:',
          '  /macro /atalho       Listar macros (atalhos rapidos)',
          '  /macro <nome>        Executar macro (ex: /macro vscode)',
          '  /macro info <nome>   Ver detalhes do macro',
          '  /macro create        Criar novo macro',
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
          'Auth:',
          '  /refresh /renovar    Renovar sessao manualmente',
          '  /auto-refresh        Status do auto-refresh de token',
          '',
          'Plugins:',
          '  /plugins /plugin         Listar plugins',
          '  /plugin install owner/r  Instalar do GitHub',
          '  /plugin uninstall <n>    Desinstalar plugin',
          '  /plugin installed        Listar instalados',
          '  /plugin info <nome>      Detalhes do plugin',
          '  /plugin enable <n>       Habilitar plugin',
          '  /plugin disable <n>      Desabilitar plugin',
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
          'Materiais / Materials:',
          '  /material /mat       Salvar material (ex: /mat titulo | conteudo)',
          '  /materials /materiais Listar/buscar materiais',
          '  /matcats /categorias Listar categorias',
          '  /rmmat /rmmaterial   Remover material',
          '',
          'Arquivo / Archive:',
          '  /archive /arquivar   Arquivar sessao (ex: /archive minha-sessao)',
          '  /archive all         Arquivar todas exceto a atual',
          '  /archived /arquivadas Listar sessoes arquivadas',
          '  /unarchive /restaurar Restaurar sessao arquivada',
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
          'Meta-Learning:',
          '  /reflect /reflexao      Analisa uso e gera insights',
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
        ctx.tui.showError('Not a git repository.')
        break
      }
      const status = await gitStatus()
      if (status === '(clean)') {
        ctx.tui.showSystem('Nothing to commit — working tree clean.')
        break
      }
      ctx.tui.showSystem('Changes:\n' + status)
      ctx.tui.disableInput()

      try {
        // Get diff and generate commit message via AI
        const diff = await gitDiff()
        const commitPrompt = `Generate a concise git commit message for these changes. Use conventional commits format (feat:, fix:, refactor:, docs:, chore:, etc.). One line, max 72 chars. No quotes. Just the message.\n\nDiff:\n${diff.slice(0, 8000)}`

        ctx.tui.startStream()
        let commitMsg = ''
        for await (const event of ctx.claude.chat(
          [{ role: 'user', content: commitPrompt, timestamp: Date.now() }],
          'You generate git commit messages. Output ONLY the commit message, nothing else.',
          false,
        )) {
          if (event.type === 'text') {
            commitMsg += event.text
            ctx.tui.appendStream(event.text)
          } else if (event.type === 'error') {
            ctx.tui.showError(event.error)
          }
        }
        ctx.tui.endStream()

        commitMsg = commitMsg.trim().replace(/^["']|["']$/g, '')

        // Guard: don't stage/commit with empty message
        if (!commitMsg) {
          ctx.tui.showError('Failed to generate commit message. Aborting.')
          break
        }

        // Stage and commit
        await gitStageAll()
        const result = await gitCommit(commitMsg)
        if (result.ok) {
          ctx.tui.showSystem(`Committed: ${commitMsg}`)
        } else {
          ctx.tui.showError(`Commit failed: ${result.output}`)
        }
      } catch (err) {
        ctx.tui.showError(`Commit error: ${err instanceof Error ? err.message : String(err)}`)
      }
      ctx.tui.enableInput()
      break
    }

    case 'persona':
    case 'modo': {
      const name = args[0]
      if (!name) {
        ctx.tui.showSystem(formatPersonaList(ctx.currentPersona))
        break
      }
      const persona = getPersona(name)
      if (!persona) {
        ctx.tui.showError(`Unknown persona: ${name}. Try /persona to see options.`)
        break
      }
      ctx.setCurrentPersona(persona.name)
      if (persona.systemPrompt) {
        ctx.setActiveSystemPrompt(buildSystemPrompt(persona.systemPrompt, ctx.skills, ctx.config.language))
      } else {
        ctx.setActiveSystemPrompt(ctx.systemPrompt)
      }
      ctx.tui.showSystem(`Persona -> ${persona.name}: ${persona.description}`)
      break
    }

    case 'copy':
    case 'copiar': {
      // Copy last assistant message to clipboard
      const lastAssistant = [...ctx.sessions.messages].reverse().find((m) => m.role === 'assistant')
      if (!lastAssistant) {
        ctx.tui.showError('No assistant message to copy.')
        break
      }
      const ok = await copyToClipboard(lastAssistant.content)
      if (ok) {
        ctx.tui.showSystem('Copied last response to clipboard.')
      } else {
        ctx.tui.showError('Failed to copy. Is xclip/pbcopy available?')
      }
      break
    }

    case 'ask':
    case 'perguntar': {
      const question = args.join(' ')
      if (!question) {
        ctx.tui.showError('Usage: /ask <question>')
        break
      }
      ctx.tui.addUserMessage(`(ephemeral) ${question}`)
      ctx.tui.disableInput()
      ctx.tui.startStream()
      let askText = ''
      // Send as isolated message — not saved to session, no tools
      for await (const event of ctx.claude.chat(
        [{ role: 'user', content: question, timestamp: Date.now() }],
        ctx.activeSystemPrompt,
        false,
      )) {
        if (event.type === 'text') {
          askText += event.text
          ctx.tui.appendStream(event.text)
        } else if (event.type === 'error') {
          ctx.tui.showError(event.error)
        } else if (event.type === 'usage') {
          // Show usage inline but don't track in session
          ctx.tui.showUsage(`${event.inputTokens} in / ${event.outputTokens} out (ephemeral)`)
        }
      }
      ctx.tui.endStream()
      ctx.tui.enableInput()
      break
    }

    case 'fork': {
      const forkName = args[0] || `fork-${Date.now()}`
      ctx.sessions.fork(forkName)
      ctx.tui.updateSession(forkName)
      ctx.tui.showSystem(`Forked session -> ${forkName} (${ctx.sessions.messages.length} messages copied)`)
      break
    }

    case 'plugins':
    case 'plugin': {
      const sub = args[0]
      if (sub === 'disable' || sub === 'desabilitar') {
        const name = args[1]
        if (!name) { ctx.tui.showSystem('Uso: /plugin disable <nome>'); break }
        if (disablePlugin(name)) {
          ctx.tui.showSystem(`Plugin "${name}" desabilitado.`)
        } else {
          ctx.tui.showError(`Plugin "${name}" nao encontrado.`)
        }
      } else if (sub === 'enable' || sub === 'habilitar') {
        const name = args[1]
        if (!name) { ctx.tui.showSystem('Uso: /plugin enable <nome>'); break }
        if (await enablePlugin(name)) {
          ctx.tui.showSystem(`Plugin "${name}" habilitado.`)
        } else {
          ctx.tui.showError(`Plugin "${name}" nao encontrado ou ja habilitado.`)
        }
      } else if (sub === 'install' || sub === 'instalar') {
        const source = args[1]
        if (!source) { ctx.tui.showSystem('Uso: /plugin install owner/repo'); break }
        ctx.tui.showSystem(`Instalando plugin de ${source}...`)
        const result = await installPlugin(source)
        if (result.success) {
          ctx.tui.showSystem(result.message)
        } else {
          ctx.tui.showError(result.message)
        }
      } else if (sub === 'uninstall' || sub === 'desinstalar') {
        const name = args[1]
        if (!name) { ctx.tui.showSystem('Uso: /plugin uninstall <nome>'); break }
        const result = uninstallPlugin(name)
        if (result.success) {
          ctx.tui.showSystem(result.message)
        } else {
          ctx.tui.showError(result.message)
        }
      } else if (sub === 'installed' || sub === 'instalados') {
        const installed = listInstalledPlugins()
        if (installed.length === 0) {
          ctx.tui.showSystem('Nenhum plugin instalado do GitHub.')
        } else {
          const lines = ['Plugins instalados do GitHub:']
          for (const p of installed) {
            const date = new Date(p.installedAt).toLocaleDateString('pt-BR')
            lines.push(`  ${p.name} — github.com/${p.source} (${date})`)
          }
          ctx.tui.showSystem(lines.join('\n'))
        }
      } else if (sub === 'info') {
        const name = args[1]
        if (!name) { ctx.tui.showSystem('Uso: /plugin info <nome>'); break }
        const p = getPlugin(name)
        if (p) {
          ctx.tui.showSystem(
            `${p.name} v${p.version} (${p.type})\n` +
            `  ${p.description}\n` +
            `  Status: ${p.enabled ? 'ativo' : 'desabilitado'}\n` +
            `  Source: ${p.source}\n` +
            `  Tools: ${p.tools.map((t) => t.name).join(', ') || 'nenhuma'}`,
          )
        } else {
          ctx.tui.showError(`Plugin "${name}" nao encontrado.`)
        }
      } else {
        ctx.tui.showSystem(formatPluginRegistry())
      }
      break
    }

    case 'budget':
    case 'orcamento': {
      const val = args[0]
      if (!val) {
        const max = ctx.config.maxSessionCost
        const spent = ctx.tracker.totals.costCents
        if (max === 0) {
          ctx.tui.showSystem(`Budget: unlimited (spent ~$${(spent / 100).toFixed(4)})`)
        } else {
          const pct = Math.round((spent / max) * 100)
          ctx.tui.showSystem(`Budget: ~$${(spent / 100).toFixed(4)} / $${(max / 100).toFixed(4)} (${pct}%)`)
        }
        break
      }
      const cents = Number(val)
      if (isNaN(cents) || cents < 0) {
        ctx.tui.showError('Usage: /budget <cents> (e.g., /budget 50 for $0.50)')
        break
      }
      ctx.config.maxSessionCost = cents
      saveConfig(ctx.config)
      ctx.tui.showSystem(cents === 0 ? 'Budget: unlimited' : `Budget set: $${(cents / 100).toFixed(2)}`)
      break
    }

    case 'undo':
    case 'desfazer': {
      const peek = undoStack.peek()
      if (!peek) {
        ctx.tui.showError('Nothing to undo.')
        break
      }
      const result = undoStack.undo()
      if (result) {
        ctx.tui.showSystem(result)
      }
      break
    }

    case 'search':
    case 'buscar': {
      const query = args.join(' ').toLowerCase()
      if (!query) {
        ctx.tui.showError('Usage: /search <text>')
        break
      }
      const matches: string[] = []
      for (const msg of ctx.sessions.messages) {
        if (msg.content.toLowerCase().includes(query)) {
          const preview = msg.content.slice(0, 100).replace(/\n/g, ' ')
          const ts = new Date(msg.timestamp).toLocaleTimeString('en', { hour: '2-digit', minute: '2-digit' })
          matches.push(`  [${msg.role} ${ts}] ${preview}${msg.content.length > 100 ? '...' : ''}`)
        }
      }
      ctx.tui.showSystem(
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
        ctx.tui.showSystem(`Language: ${ctx.config.language} (auto = match user's language)`)
        break
      }
      ctx.config.language = lang
      saveConfig(ctx.config)
      ctx.tui.showSystem(`Language -> ${lang}`)
      break
    }

    // ── Business assistant commands ──────────────────────

    case 'briefing':
    case 'resumo': {
      ctx.tui.showSystem('Carregando briefing...')
      ctx.tui.disableInput()
      try {
        // Pass dataDir for Time & Load Balancer context
        const briefing = await generateBriefing(ctx.config.dataDir)
        ctx.tui.showSystem(briefing)

        // Refresh time context and persona after briefing
        const newContext = await getTimeContext(ctx.config.dataDir)
        ctx.tui.setTimeContext(newContext)
        ctx.setTimeContext(newContext)
      } catch (err) {
        ctx.tui.showError(`Briefing falhou: ${err instanceof Error ? err.message : String(err)}`)
      }
      ctx.tui.enableInput()
      break
    }

    case 'news':
    case 'noticias': {
      const category = args[0] as NewsCategory | undefined
      if (category) {
        ctx.tui.showSystem(`Buscando noticias (${category})...`)
      } else {
        ctx.tui.showSystem('Buscando noticias...')
      }
      ctx.tui.disableInput()
      try {
        const { items, errors } = await fetchNewsItems(category ? [category] : undefined)
        if (items.length === 0) {
          ctx.tui.showSystem(errors.length > 0
            ? `Nenhuma noticia encontrada.\nFalhas: ${errors.join(', ')}`
            : 'Nenhuma noticia encontrada.')
          ctx.tui.enableInput()
          break
        }

        const pickerEntries: NewsPickerEntry[] = items.map((item: NewsItem) => ({
          title: item.title,
          link: item.link,
          source: item.source,
          category: item.category,
          time: item.pubDate
            ? item.pubDate.toLocaleTimeString('pt-BR', {
                hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo',
              })
            : '',
        }))

        const result = await ctx.tui.promptNewsPicker(pickerEntries)
        if (result) {
          if (result.action === 'open') {
            // Open in browser
            const { openUrl } = await import('../windows')
            openUrl(result.link)
            ctx.tui.showSystem(`Abrindo: ${result.link}`)
          } else if (result.action === 'read') {
            // Fetch and display content
            ctx.tui.showSystem(`Buscando conteudo...`)
            const content = await fetchNewsContent(result.link)
            if (typeof content === 'string') {
              ctx.tui.showError(content)
            } else {
              // Send content to assistant for summarization
              const newsContext = `Noticia: ${content.title}\nFonte: ${result.link}\n\n${content.content}`
              const prompt = `Por favor, resuma esta noticia de forma objetiva e destaque os pontos principais:\n\n${newsContext}`
              ctx.tui.enableInput()
              ctx.handleSubmit(prompt)
              return
            }
          }
        }
      } catch (err) {
        ctx.tui.showError(`Falha ao buscar noticias: ${err instanceof Error ? err.message : String(err)}`)
      }
      ctx.tui.enableInput()
      break
    }

    case 'feeds':
    case 'fontes': {
      ctx.tui.showSystem(listNewsFeeds())
      break
    }

    case 'addfeed':
    case 'novafonte': {
      // Usage: /addfeed <name> <url> <category>
      if (args.length < 3) {
        ctx.tui.showError('Uso: /addfeed <nome> <url> <categoria>\nEx: /addfeed "Ars Technica" https://feeds.arstechnica.com/arstechnica/index tech')
        break
      }
      const feedName = args[0]
      const feedUrl = args[1]
      const feedCat = args[2]
      const result = addNewsFeed(feedName, feedUrl, feedCat)
      if (typeof result === 'string') {
        ctx.tui.showError(result)
      } else {
        ctx.tui.showSystem(`Fonte adicionada: ${result.name} (${result.category}) — ${result.url}`)
      }
      break
    }

    case 'rmfeed':
    case 'rmfonte': {
      const ref = args.join(' ')
      if (!ref) {
        ctx.tui.showError('Uso: /rmfeed <nome ou url>')
        break
      }
      if (removeNewsFeed(ref)) {
        ctx.tui.showSystem(`Fonte removida: ${ref}`)
      } else {
        ctx.tui.showError(`Fonte custom nao encontrada: "${ref}". Para desativar uma built-in, use /disablefeed.`)
      }
      break
    }

    case 'disablefeed':
    case 'desativarfonte': {
      const ref = args.join(' ')
      if (!ref) {
        ctx.tui.showError('Uso: /disablefeed <nome ou url>')
        break
      }
      if (disableNewsFeed(ref)) {
        ctx.tui.showSystem(`Fonte desativada: ${ref}`)
      } else {
        ctx.tui.showError(`Fonte built-in nao encontrada ou ja desativada: "${ref}"`)
      }
      break
    }

    case 'enablefeed':
    case 'ativarfonte': {
      const ref = args.join(' ')
      if (!ref) {
        ctx.tui.showError('Uso: /enablefeed <nome ou url>')
        break
      }
      if (enableNewsFeed(ref)) {
        ctx.tui.showSystem(`Fonte reativada: ${ref}`)
      } else {
        ctx.tui.showError(`Fonte built-in nao encontrada ou nao esta desativada: "${ref}"`)
      }
      break
    }

    case 'open':
    case 'abrir': {
      const appName = args.join(' ')
      if (!appName) {
        ctx.tui.showSystem(`Apps disponiveis: ${getKnownApps().join(', ')}\nUso: /open <app> ou /open <app> <arquivo>`)
        break
      }
      // Check if second arg looks like a file path
      const appArg = args.length > 1 ? args.slice(1).join(' ') : undefined
      const result = await openApp(args[0], appArg)
      ctx.tui.showSystem(result)
      break
    }

    case 'openfile':
    case 'abrirarquivo': {
      const filePath = args.join(' ')
      if (!filePath) {
        ctx.tui.showError('Uso: /openfile <caminho>')
        break
      }
      const result = await openFile(filePath)
      ctx.tui.showSystem(result)
      break
    }

    case 'openurl': {
      const url = args[0]
      if (!url) {
        ctx.tui.showError('Uso: /openurl <url>')
        break
      }
      const result = await openUrl(url)
      ctx.tui.showSystem(result)
      break
    }

    case 'apps':
    case 'programas': {
      ctx.tui.disableInput()
      try {
        const result = await getRunningApps()
        ctx.tui.showSystem(result)
      } catch (err) {
        ctx.tui.showError(`Apps: ${err instanceof Error ? err.message : String(err)}`)
      }
      ctx.tui.enableInput()
      break
    }

    case 'sysinfo':
    case 'sistema': {
      ctx.tui.disableInput()
      try {
        const result = await getSystemInfo()
        ctx.tui.showSystem(result)
      } catch (err) {
        ctx.tui.showError(`Sysinfo: ${err instanceof Error ? err.message : String(err)}`)
      }
      ctx.tui.enableInput()
      break
    }

    case 'calendar':
    case 'calendario':
    case 'agenda':
    case 'cal': {
      ctx.tui.disableInput()
      try {
        const dateInfo = await getDateTimeInfo()
        const events = await getOutlookEvents()
        ctx.tui.showSystem(`${dateInfo}\n\n--- Agenda ---\n${events}`)
      } catch (err) {
        ctx.tui.showError(`Calendar: ${err instanceof Error ? err.message : String(err)}`)
      }
      ctx.tui.enableInput()
      break
    }

    // ── Monitor commands ───────────────────────────────────

    case 'monitor':
    case 'vigiar': {
      const sub = args[0]?.toLowerCase()
      if (!sub || sub === 'list' || sub === 'listar') {
        ctx.tui.showSystem(listMonitors())
      } else if (sub === 'stop' || sub === 'parar') {
        const name = args[1]
        if (!name) { ctx.tui.showError('Uso: /monitor stop <processo>'); break }
        ctx.tui.showSystem(stopMonitor(name))
      } else {
        // Start monitoring
        const intervalSec = parseInt(args[1]) || 60
        ctx.tui.showSystem(startMonitor(sub, intervalSec))
      }
      break
    }

    // ── Workflow commands ──────────────────────────────────

    case 'workflow':
    case 'fluxo': {
      const sub = args[0]?.toLowerCase()
      if (!sub || sub === 'list' || sub === 'listar') {
        const tag = args[1]
        ctx.tui.showSystem(formatWorkflowList(listWorkflows(tag)))
      } else if (sub === 'run' || sub === 'rodar') {
        const name = args[1]
        if (!name) { ctx.tui.showError('Uso: /workflow run <nome>'); break }
        ctx.tui.disableInput()
        try {
          const result = await runWorkflow(name, (msg) => ctx.tui.showSystem(msg))
          ctx.tui.showSystem(result)
        } catch (err) {
          ctx.tui.showError(`Workflow: ${err instanceof Error ? err.message : String(err)}`)
        }
        ctx.tui.enableInput()
      } else if (sub === 'info' || sub === 'detalhe') {
        const name = args[1]
        if (!name) { ctx.tui.showError('Uso: /workflow info <nome>'); break }
        const wf = getWorkflow(name)
        if (wf) { ctx.tui.showSystem(formatWorkflowDetail(wf)) }
        else { ctx.tui.showError(`Workflow nao encontrado: ${name}`) }
      } else if (sub === 'delete' || sub === 'deletar') {
        const name = args[1]
        if (!name) { ctx.tui.showError('Uso: /workflow delete <nome>'); break }
        if (deleteWorkflow(name)) { ctx.tui.showSystem(`Workflow removido: ${name}`) }
        else { ctx.tui.showError(`Workflow nao encontrado: ${name}`) }
      } else if (sub === 'enable' || sub === 'ativar') {
        const name = args[1]
        if (!name) { ctx.tui.showError('Uso: /workflow enable <nome>'); break }
        const updated = updateWorkflow(name, { enabled: true })
        if (updated) { ctx.tui.showSystem(`Workflow ativado: ${updated.name}`) }
        else { ctx.tui.showError(`Workflow nao encontrado: ${name}`) }
      } else if (sub === 'disable' || sub === 'desativar') {
        const name = args[1]
        if (!name) { ctx.tui.showError('Uso: /workflow disable <nome>'); break }
        const updated = updateWorkflow(name, { enabled: false })
        if (updated) { ctx.tui.showSystem(`Workflow desativado: ${updated.name}`) }
        else { ctx.tui.showError(`Workflow nao encontrado: ${name}`) }
      } else {
        // Treat as "run <name>"
        ctx.tui.disableInput()
        try {
          const result = await runWorkflow(sub, (msg) => ctx.tui.showSystem(msg))
          ctx.tui.showSystem(result)
        } catch (err) {
          ctx.tui.showError(`Workflow: ${err instanceof Error ? err.message : String(err)}`)
        }
        ctx.tui.enableInput()
      }
      break
    }

    // ── Macro commands ────────────────────────────────────

    case 'macro':
    case 'macros':
    case 'atalho':
    case 'atalhos': {
      const sub = args[0]?.toLowerCase()
      if (!sub || sub === 'list' || sub === 'listar') {
        const tag = args[1]
        ctx.tui.showSystem(formatMacroList(listMacros(tag)))
      } else if (sub === 'all' || sub === 'todos') {
        ctx.tui.showSystem(formatMacroList(listAllMacros()))
      } else if (sub === 'info' || sub === 'detalhe') {
        const name = args[1]
        if (!name) { ctx.tui.showError('Uso: /macro info <nome>'); break }
        const m = getMacro(name)
        if (m) { ctx.tui.showSystem(formatMacroDetail(m)) }
        else { ctx.tui.showError(`Macro nao encontrado: ${name}`) }
      } else if (sub === 'create' || sub === 'criar' || sub === 'new' || sub === 'novo') {
        // Usage: /macro create <name> <action> <target> [description]
        // Example: /macro create mysite open_url https://example.com "Meu site favorito"
        const name = args[1]
        const action = args[2] as MacroAction
        const target = args[3]
        if (!name || !action || !target) {
          ctx.tui.showSystem(
            'Uso: /macro create <nome> <acao> <target> [descricao]\n' +
            'Acoes: open_app, open_url, open_file, run_command\n' +
            'Exemplos:\n' +
            '  /macro create mysite open_url https://example.com "Meu site"\n' +
            '  /macro create docs open_file C:\\Users\\Docs "Pasta de documentos"\n' +
            '  /macro create cleanup run_command "Remove-Item $env:TEMP\\* -Force"',
          )
          break
        }
        const validActions: MacroAction[] = ['open_app', 'open_url', 'open_file', 'run_command']
        if (!validActions.includes(action)) {
          ctx.tui.showError(`Acao invalida: ${action}. Use: ${validActions.join(', ')}`)
          break
        }
        const description = args.slice(4).join(' ') || `Macro: ${name}`
        const macro = createMacro(name, description, action, target)
        ctx.tui.showSystem(`Macro criado: "${macro.name}" (${macro.action}: ${macro.target})`)
      } else if (sub === 'delete' || sub === 'deletar' || sub === 'rm') {
        const name = args[1]
        if (!name) { ctx.tui.showError('Uso: /macro delete <nome>'); break }
        if (deleteMacro(name)) { ctx.tui.showSystem(`Macro removido: ${name}`) }
        else { ctx.tui.showError(`Macro nao encontrado: ${name}`) }
      } else if (sub === 'enable' || sub === 'ativar') {
        const name = args[1]
        if (!name) { ctx.tui.showError('Uso: /macro enable <nome>'); break }
        const updated = updateMacro(name, { enabled: true })
        if (updated) { ctx.tui.showSystem(`Macro ativado: ${updated.name}`) }
        else { ctx.tui.showError(`Macro nao encontrado: ${name}`) }
      } else if (sub === 'disable' || sub === 'desativar') {
        const name = args[1]
        if (!name) { ctx.tui.showError('Uso: /macro disable <nome>'); break }
        const updated = updateMacro(name, { enabled: false })
        if (updated) { ctx.tui.showSystem(`Macro desativado: ${updated.name}`) }
        else { ctx.tui.showError(`Macro nao encontrado: ${name}`) }
      } else {
        // Treat as macro name to run: /macro vscode -> run vscode macro
        ctx.tui.disableInput()
        try {
          const result = await runMacro(sub)
          if (result.success) {
            ctx.tui.showSystem(`${result.message} (${result.duration}ms)`)
          } else {
            ctx.tui.showError(result.message)
          }
        } catch (err) {
          ctx.tui.showError(`Macro: ${err instanceof Error ? err.message : String(err)}`)
        }
        ctx.tui.enableInput()
      }
      break
    }

    // ── Pomodoro commands ─────────────────────────────────

    case 'pomodoro':
    case 'foco': {
      const sub = args[0]?.toLowerCase()
      if (sub === 'stop' || sub === 'parar') {
        ctx.tui.showSystem(stopPomodoro())
      } else if (sub === 'status') {
        ctx.tui.showSystem(pomodoroStatus())
      } else if (!sub) {
        ctx.tui.showSystem(pomodoroStatus())
      } else {
        // Start with label
        const label = args.join(' ')
        const workMin = 25
        const breakMin = 5
        ctx.tui.showSystem(startPomodoro(label, workMin, breakMin))
      }
      break
    }

    // ── Scheduler commands ──────────────────────────────────

    case 'agendar':
    case 'schedule': {
      // /agendar "mensagem" "14:00" [data] [tipo]
      // /agendar "comando" "14:00" daily command
      const sub = args[0]?.toLowerCase()

      if (!sub || sub === 'list' || sub === 'listar') {
        const jobs = listJobs(args[1] === 'all' || args[1] === 'todos')
        ctx.tui.showSystem(formatJobList(jobs))
        break
      }

      if (sub === 'remove' || sub === 'remover' || sub === 'delete') {
        if (!args[1]) {
          ctx.tui.showSystem('Uso: /agendar remove <id ou nome>')
          break
        }
        const removed = await removeJob(args[1])
        ctx.tui.showSystem(removed ? 'Agendamento removido.' : 'Agendamento nao encontrado.')
        break
      }

      if (sub === 'enable' || sub === 'ativar') {
        if (!args[1]) {
          ctx.tui.showSystem('Uso: /agendar ativar <id ou nome>')
          break
        }
        const job = await enableJob(args[1])
        ctx.tui.showSystem(job ? `Agendamento "${job.name}" ativado.` : 'Agendamento nao encontrado.')
        break
      }

      if (sub === 'disable' || sub === 'desativar') {
        if (!args[1]) {
          ctx.tui.showSystem('Uso: /agendar desativar <id ou nome>')
          break
        }
        const job = await disableJob(args[1])
        ctx.tui.showSystem(job ? `Agendamento "${job.name}" desativado.` : 'Agendamento nao encontrado.')
        break
      }

      if (sub === 'run' || sub === 'executar') {
        if (!args[1]) {
          ctx.tui.showSystem('Uso: /agendar executar <id ou nome>')
          break
        }
        ctx.tui.showSystem(await runJobNow(args[1]))
        break
      }

      if (sub === 'clear' || sub === 'limpar') {
        ctx.tui.showSystem(await clearAllJobs())
        break
      }

      if (sub === 'detail' || sub === 'detalhe' || sub === 'info') {
        if (!args[1]) {
          ctx.tui.showSystem('Uso: /agendar info <id ou nome>')
          break
        }
        const job = getJob(args[1])
        ctx.tui.showSystem(job ? formatJobDetail(job) : 'Agendamento nao encontrado.')
        break
      }

      // Create new schedule: /agendar "mensagem" "14:00" [once|daily|weekly] [data/dia]
      // Parse quoted strings
      const fullText = args.join(' ')
      const quotedParts = fullText.match(/"([^"]+)"/g)

      if (!quotedParts || quotedParts.length < 2) {
        ctx.tui.showSystem(
          'Uso: /agendar "<mensagem>" "<horario>" [once|daily|weekly] [data/dia]\n' +
          'Exemplos:\n' +
          '  /agendar "Reuniao" "14:00"\n' +
          '  /agendar "Standup" "09:00" daily\n' +
          '  /agendar "Review" "15:00" weekly sexta\n' +
          '  /agendar "Dentista" "10:00" once 15/04/2026',
        )
        break
      }

      const message = quotedParts[0].slice(1, -1) // Remove quotes
      const timeStr = quotedParts[1].slice(1, -1)
      const parsedTime = parseScheduleTime(timeStr)

      if (!parsedTime) {
        ctx.tui.showSystem(`Horario invalido: "${timeStr}". Use formato HH:MM ou HHh.`)
        break
      }

      // Parse remaining args after quoted strings
      const afterQuotes = fullText.replace(/"[^"]+"/g, '').trim().split(/\s+/).filter(Boolean)
      let scheduleType: ScheduleType = 'once'
      let dateOrDay: string | undefined

      for (const arg of afterQuotes) {
        const lower = arg.toLowerCase()
        if (lower === 'daily' || lower === 'diario') {
          scheduleType = 'daily'
        } else if (lower === 'weekly' || lower === 'semanal') {
          scheduleType = 'weekly'
        } else if (lower === 'once' || lower === 'uma-vez') {
          scheduleType = 'once'
        } else if (scheduleType === 'weekly') {
          const day = parseWeekDay(arg)
          if (day) dateOrDay = day
        } else if (scheduleType === 'once') {
          const date = parseScheduleDate(arg)
          if (date) dateOrDay = date
        }
      }

      // Default date for 'once' if not specified
      if (scheduleType === 'once' && !dateOrDay) {
        const now = new Date()
        const [h, m] = parsedTime.split(':').map(Number)
        const scheduleTime = new Date(now)
        scheduleTime.setHours(h, m, 0, 0)

        // If time already passed today, schedule for tomorrow
        if (scheduleTime <= now) {
          scheduleTime.setDate(scheduleTime.getDate() + 1)
        }
        dateOrDay = [
          String(scheduleTime.getMonth() + 1).padStart(2, '0'),
          String(scheduleTime.getDate()).padStart(2, '0'),
          String(scheduleTime.getFullYear()),
        ].join('/')
      }

      try {
        const job = await scheduleJob(message, scheduleType, parsedTime, 'toast', message, dateOrDay)
        ctx.tui.showSystem(`Tarefa "${job.name}" agendada para ${formatJobDetail(job).split('\n').slice(2, 5).join(', ').replace(/\n/g, '')}`)
      } catch (err) {
        ctx.tui.showError(`Erro ao agendar: ${err instanceof Error ? err.message : String(err)}`)
      }
      break
    }

    case 'agendamentos':
    case 'schedules': {
      const jobs = listJobs(args[0] === 'all' || args[0] === 'todos')
      ctx.tui.showSystem(formatJobList(jobs))
      break
    }

    // ── Finance commands ──────────────────────────────��─────

    case 'entrada':
    case 'income': {
      // /entrada 500 salario descricao
      const amount = parseFloat(args[0])
      if (isNaN(amount) || args.length < 3) {
        ctx.tui.showSystem('Uso: /entrada <valor> <categoria> <descricao>')
        break
      }
      const cat = args[1]
      const desc = args.slice(2).join(' ')
      const check = verifyTransaction('entrada', amount, cat, desc)
      if (!check.allowed) {
        ctx.tui.showError(check.blocked!)
        break
      }
      const tx = addTransaction('entrada', amount, cat, desc)
      recordVerifiedTransaction('entrada', amount, cat)
      const warn = formatVerification(check)
      ctx.tui.showSystem(`+ R$ ${tx.amount.toFixed(2)} (${tx.category}) — ${tx.description}`)
      if (warn) ctx.tui.showSystem(warn)
      break
    }

    case 'saida':
    case 'expense': {
      const amount = parseFloat(args[0])
      if (isNaN(amount) || args.length < 3) {
        ctx.tui.showSystem('Uso: /saida <valor> <categoria> <descricao>')
        break
      }
      const cat = args[1]
      const desc = args.slice(2).join(' ')
      const check = verifyTransaction('saida', amount, cat, desc)
      if (!check.allowed) {
        ctx.tui.showError(check.blocked!)
        break
      }
      const tx = addTransaction('saida', amount, cat, desc)
      recordVerifiedTransaction('saida', amount, cat)
      const warn = formatVerification(check)
      ctx.tui.showSystem(`- R$ ${tx.amount.toFixed(2)} (${tx.category}) — ${tx.description}`)
      if (warn) ctx.tui.showSystem(warn)
      break
    }

    case 'finance':
    case 'financas':
    case 'balanco': {
      const sub = args[0]
      if (sub === 'recent' || sub === 'recentes') {
        ctx.tui.showSystem(getRecentTransactions())
      } else {
        ctx.tui.showSystem(getMonthSummary() + '\n\n' + getRecentTransactions(5))
      }
      break
    }

    // ── Decision commands ────────────────────────────────���──

    case 'decisions':
    case 'decisoes': {
      const query = args.join(' ')
      if (query) {
        const results = searchDecisions(query)
        ctx.tui.showSystem(formatDecisionList(results))
      } else {
        ctx.tui.showSystem(formatDecisionList(listDecisions()))
      }
      break
    }

    // ── Investigation commands ─────────────────────────────

    case 'investigar':
    case 'investigate':
    case 'investigacoes': {
      const query = args.join(' ')
      if (query) {
        const { searchInvestigations, formatInvestigationList } = await import('../investigate')
        ctx.tui.showSystem(formatInvestigationList(searchInvestigations(query)))
      } else {
        const { listInvestigations, formatInvestigationList } = await import('../investigate')
        ctx.tui.showSystem(formatInvestigationList(listInvestigations()))
      }
      break
    }

    // ── Email command ──────────────────────────────────────

    case 'email':
    case 'rascunho': {
      // Quick email: /email to@addr.com assunto | corpo
      const text = args.join(' ')
      if (!text) {
        ctx.tui.showSystem('Uso: /email <destinatario> <assunto> | <corpo>\nOu peca a IA: "escreve um email para joao@email.com cobrando o relatorio"')
        break
      }
      // Parse: first word is email, rest before | is subject, after | is body
      const emailAddr = args[0]
      const restText = args.slice(1).join(' ')
      const pipeIdx = restText.indexOf('|')
      if (pipeIdx === -1) {
        ctx.tui.showSystem('Formato: /email <destinatario> <assunto> | <corpo>\nUse | para separar assunto do corpo.')
        break
      }
      const subject = restText.slice(0, pipeIdx).trim()
      const body = restText.slice(pipeIdx + 1).trim()
      if (!subject || !body) {
        ctx.tui.showError('Assunto e corpo sao obrigatorios.')
        break
      }
      const draft = { to: emailAddr, subject, body }
      ctx.tui.showSystem(formatDraftPreview(draft))
      ctx.tui.disableInput()
      try {
        const result = await openEmailDraft(draft)
        ctx.tui.showSystem(result)
      } catch (err) {
        ctx.tui.showError(`Email: ${err instanceof Error ? err.message : String(err)}`)
      }
      ctx.tui.enableInput()
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
        ctx.tui.showSystem(formatMemoList(memos))
        break
      }
      const memo = saveMemo(text)
      const tagStr = memo.tags.length > 0 ? ` [${memo.tags.map((t: string) => '#' + t).join(' ')}]` : ''
      ctx.tui.showSystem(`Memo salvo${tagStr}  {${memo.id}}`)
      break
    }

    case 'memos':
    case 'notas': {
      const query = args.join(' ')
      if (query) {
        const results = searchMemos(query)
        ctx.tui.showSystem(formatMemoList(results))
      } else {
        const memos = listMemos()
        ctx.tui.showSystem(formatMemoList(memos))
      }
      break
    }

    case 'memotags':
    case 'tags': {
      ctx.tui.showSystem(formatMemoTags())
      break
    }

    case 'rmmemo':
    case 'rmnota': {
      const id = args[0]
      if (!id) {
        ctx.tui.showError('Uso: /rmmemo <id>')
        break
      }
      if (deleteMemo(id)) {
        ctx.tui.showSystem('Memo removido.')
      } else {
        ctx.tui.showError(`Memo nao encontrado: ${id}`)
      }
      break
    }

    // ── Material commands ───────────────────────────────��───

    case 'material':
    case 'mat': {
      const text = args.join(' ')
      if (!text) {
        const mats = listMaterials(10)
        ctx.tui.showSystem(formatMaterialList(mats))
        break
      }
      // Check if it's a detail view (ID-like: 6 alphanumeric chars)
      if (/^[a-z0-9]{6}$/.test(text)) {
        const mat = getMaterial(text)
        if (mat) {
          ctx.tui.showSystem(formatMaterialDetail(mat))
        } else {
          ctx.tui.showError(`Material nao encontrado: ${text}`)
        }
        break
      }
      // Otherwise treat as a quick save: /material title | content
      const pipeIdx = text.indexOf('|')
      if (pipeIdx === -1) {
        ctx.tui.showSystem('Uso: /material <titulo> | <conteudo>\nOu peca a IA: "salva esse material sobre..."')
        break
      }
      const title = text.slice(0, pipeIdx).trim()
      const content = text.slice(pipeIdx + 1).trim()
      if (!title || !content) {
        ctx.tui.showError('Titulo e conteudo sao obrigatorios.')
        break
      }
      const mat = saveMaterial(title, content)
      const tagStr = mat.tags.length > 0 ? ` [${mat.tags.map((t: string) => '#' + t).join(' ')}]` : ''
      ctx.tui.showSystem(`Material salvo: "${mat.title}" (${mat.category})${tagStr}  {${mat.id}}`)
      break
    }

    case 'materials':
    case 'materiais': {
      const query = args.join(' ')
      if (query) {
        const results = searchMaterials(query)
        ctx.tui.showSystem(formatMaterialList(results))
      } else {
        const mats = listMaterials()
        ctx.tui.showSystem(formatMaterialList(mats))
      }
      break
    }

    case 'matcats':
    case 'categorias': {
      ctx.tui.showSystem(formatMaterialCategories())
      break
    }

    case 'rmmat':
    case 'rmmaterial': {
      const id = args[0]
      if (!id) {
        ctx.tui.showError('Uso: /rmmat <id>')
        break
      }
      if (deleteMaterial(id)) {
        ctx.tui.showSystem('Material removido.')
      } else {
        ctx.tui.showError(`Material nao encontrado: ${id}`)
      }
      break
    }

    // ── Meta-Learning commands ──────────────────────────────

    case 'reflect':
    case 'reflexao':
    case 'aprender': {
      ctx.tui.showSystem('Executando reflexao de uso...')
      ctx.tui.disableInput()
      try {
        const result = await runSelfReflection()
        ctx.tui.showSystem(result.summary)
      } catch (err) {
        ctx.tui.showError(`Reflexao falhou: ${err instanceof Error ? err.message : String(err)}`)
      }
      ctx.tui.enableInput()
      break
    }

    // ── Memory/RAG commands ────────────────────────────────

    case 'indexar':
    case 'index':
    case 'reindex': {
      ctx.tui.showSystem('Indexando memoria local...')
      const stats = buildIndex()
      ctx.tui.showSystem(
        `Indexacao concluida: ${stats.indexed} fonte(s) indexada(s), ${stats.skipped} sem alteracao. Total: ${stats.total} chunks.`,
      )
      break
    }

    case 'memoria':
    case 'memory': {
      const query = args.join(' ')
      if (query) {
        const results = queryMemory(query)
        ctx.tui.showSystem(formatQueryResults(results))
      } else {
        const stats = getIndexStats()
        const builtStr = stats.builtAt
          ? new Date(stats.builtAt).toLocaleString('pt-BR')
          : 'nunca'
        ctx.tui.showSystem(
          `Memory RAG Index:\n  Chunks: ${stats.chunks}\n  Fontes: ${stats.sources}\n  Ultima indexacao: ${builtStr}`,
        )
      }
      break
    }

    // ── Vault commands ────────────────────────────────────

    case 'vault': {
      const sub = args[0]?.toLowerCase()
      if (!sub || sub === 'status') {
        ctx.tui.showSystem(formatVaultStatus(getVaultStatus()))
      } else if (sub === 'backup') {
        ctx.tui.showSystem('Realizando backup...')
        const msg = args.slice(1).join(' ') || undefined
        const result = await performBackup(msg)
        ctx.tui.showSystem(result)
      } else if (sub === 'sync' || sub === 'push') {
        ctx.tui.showSystem('Sincronizando com remote...')
        const result = await syncBackupToRemote()
        ctx.tui.showSystem(result)
      } else if (sub === 'init') {
        const result = await initShadowBackup()
        ctx.tui.showSystem(result)
        startAutoBackup(30)
        ctx.tui.showSystem('Auto-backup ativado (a cada 30 minutos).')
      } else {
        ctx.tui.showError('Uso: /vault [status|backup|sync|init]')
      }
      break
    }

    case 'backup': {
      ctx.tui.showSystem('Realizando backup...')
      const result = await performBackup()
      ctx.tui.showSystem(result)
      break
    }

    // ── Windows Agent commands ─────────────────────────────

    case 'clipboard':
    case 'area': {
      ctx.tui.showSystem('Lendo clipboard...')
      const clip = await readClipboardContent()
      switch (clip.type) {
        case 'text':
          ctx.tui.showSystem(`Clipboard (texto):\n${clip.text}`)
          break
        case 'image':
          ctx.tui.showSystem(clip.text)
          break
        case 'empty':
          ctx.tui.showSystem('Clipboard vazio.')
          break
        case 'error':
          ctx.tui.showError(clip.text)
          break
      }
      break
    }

    case 'tela':
    case 'screen': {
      ctx.tui.showSystem('Analisando tela...')
      const ctx2 = await analyzeScreenContext()
      ctx.tui.showSystem(ctx2)
      break
    }

    case 'ps1': {
      const script = args.join(' ')
      if (!script.trim()) {
        ctx.tui.showError('Uso: /ps1 <script powershell>')
        break
      }
      ctx.tui.showSystem('Executando script...')
      const result = await executePowerShellScript(script)
      const scriptParts: string[] = []
      if (result.stdout.trim()) scriptParts.push(result.stdout.trim())
      if (result.stderr.trim()) scriptParts.push(`stderr: ${result.stderr.trim()}`)
      scriptParts.push(`(exit: ${result.exitCode}, ${result.duration}ms)`)
      ctx.tui.showSystem(scriptParts.join('\n'))
      break
    }

    // ── Project management commands ──────────────────────

    case 'projeto':
    case 'project': {
      const ref = args.join(' ')
      if (ref) {
        // Set active project or show details
        const project = getProject(ref)
        if (project) {
          setActiveProject(project.id)
          ctx.tui.showSystem(formatProjectDetail(project))
        } else {
          // Try auto-detect if "auto"
          if (ref === 'auto') {
            const detected = autoDetectProject(process.cwd())
            if (detected) {
              setActiveProject(detected.id)
              ctx.tui.showSystem(`Projeto detectado: ${formatProjectDetail(detected)}`)
            } else {
              ctx.tui.showError('Nenhum projeto detectado no diretorio atual.')
            }
          } else {
            ctx.tui.showError(`Projeto nao encontrado: "${ref}"`)
          }
        }
      } else {
        const active = getActiveProject()
        if (active) {
          ctx.tui.showSystem(formatProjectDetail(active))
        } else {
          ctx.tui.showSystem('Nenhum projeto ativo. Use /projeto <nome> ou /projeto auto')
        }
      }
      break
    }

    case 'projetos':
    case 'projects': {
      ctx.tui.showSystem(formatProjectList(listProjects()))
      break
    }

    case 'sessao':
    case 'session': {
      const action = args[0]
      const active = getActiveProject()
      if (!active) {
        ctx.tui.showError('Nenhum projeto ativo. Use /projeto primeiro.')
        break
      }
      if (action === 'start' || action === 'iniciar') {
        const notes = args.slice(1).join(' ')
        const session = startSession(active.id, notes)
        if (session) {
          ctx.tui.showSystem(`Sessao iniciada para "${active.name}" [${session.id}]`)
        }
      } else if (action === 'stop' || action === 'parar') {
        const open = getOpenSession(active.id)
        if (open) {
          const ended = endSession(open.id, args.slice(1).join(' '))
          if (ended) {
            ctx.tui.showSystem(`Sessao encerrada: ${ended.durationMinutes} minutos em "${active.name}"`)
          }
        } else {
          ctx.tui.showSystem('Nenhuma sessao aberta.')
        }
      } else {
        const open = getOpenSession(active.id)
        if (open) {
          const elapsed = Math.round((Date.now() - new Date(open.startedAt).getTime()) / 60_000)
          ctx.tui.showSystem(`Sessao aberta: ${elapsed} minutos em "${active.name}"`)
        } else {
          ctx.tui.showSystem('Nenhuma sessao aberta. Use /sessao start')
        }
      }
      break
    }

    case 'relatorio':
    case 'report': {
      const active = getActiveProject()
      if (!active) {
        ctx.tui.showError('Nenhum projeto ativo. Use /projeto primeiro.')
        break
      }
      const period = (args[0] as 'today' | 'week' | 'month') || 'today'
      ctx.tui.showSystem('Gerando relatorio...')
      const report = await generateWorkReport(active.id, period, 'pt')
      if (report) {
        ctx.tui.showSystem(report.markdown)
      } else {
        ctx.tui.showError('Falha ao gerar relatorio.')
      }
      break
    }

    case 'oportunidades':
    case 'opportunities': {
      const status = args[0] || undefined
      const opps = listOpportunities(status as any)
      ctx.tui.showSystem(formatOpportunityList(opps))
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
      ctx.tui.showSystem(formatPeopleList(people))
      break
    }

    case 'person':
    case 'pessoa': {
      const ref = args.join(' ')
      if (!ref) {
        ctx.tui.showError('Uso: /person <nome>')
        break
      }
      const person = findPerson(ref)
      if (!person) {
        ctx.tui.showError(`Pessoa nao encontrada: "${ref}"`)
        break
      }
      ctx.tui.showSystem(formatPersonDetail(person))
      break
    }

    case 'addperson':
    case 'addpessoa':
    case 'novapessoa': {
      // /addperson <group> <name> [role]
      const group = args[0] as PersonGroup
      const validGroups: PersonGroup[] = ['equipe', 'familia', 'contato']
      if (!group || !validGroups.includes(group)) {
        ctx.tui.showSystem('Uso: /addperson <equipe|familia|contato> <nome> [papel]\nEx: /addperson equipe Joao dev frontend')
        break
      }
      const nameAndRole = args.slice(1).join(' ')
      if (!nameAndRole) {
        ctx.tui.showError('Nome obrigatorio. Ex: /addperson equipe Joao dev frontend')
        break
      }
      // Split name from role at first comma if present
      const [pName, ...roleParts] = nameAndRole.split(',')
      const pRole = roleParts.join(',').trim() || undefined
      const newPerson = addPerson(pName.trim(), group, pRole)
      ctx.tui.showSystem(`Adicionado: ${newPerson.name} (${group}) [${newPerson.id}]`)
      break
    }

    case 'delegate':
    case 'delegar': {
      // /delegate <person> <task>
      const personName = args[0]
      if (!personName || args.length < 2) {
        ctx.tui.showSystem('Uso: /delegate <pessoa> <tarefa>\nEx: /delegate Joao revisar relatorio')
        break
      }
      const taskText = args.slice(1).join(' ')
      const delegation = delegateTask(personName, taskText)
      if (!delegation) {
        ctx.tui.showError(`Pessoa nao encontrada: "${personName}"`)
        break
      }
      ctx.tui.showSystem(`Delegado para ${personName}: "${taskText}" [${delegation.id}]`)
      break
    }

    case 'delegations':
    case 'delegacoes':
    case 'delegados': {
      const personRef = args[0]
      const delegations = getDelegations(personRef)
      ctx.tui.showSystem(formatDelegationList(delegations))
      break
    }

    case 'followups': {
      const followUps = getPendingFollowUps()
      ctx.tui.showSystem(formatFollowUps(followUps))
      break
    }

    case 'verificar':
    case 'status': {
      const statusPanels: DashboardPanel[] = []

      // Energy panel
      const energy = getEnergyState()
      const levelIcons: Record<EnergyLevel, string> = { alto: '🟢', medio: '🟡', baixo: '🟠', critico: '🔴' }
      const phaseLabels: Record<string, string> = {
        aquecimento: 'Aquecimento', pico: 'Pico', sustentado: 'Sustentado',
        declinio: 'Declinio', esgotado: 'Esgotado',
      }
      statusPanels.push({
        id: 'energy',
        title: `${levelIcons[energy.level]} Energia: ${energy.score}/100`,
        content: [
          `Fase: ${phaseLabels[energy.phase] ?? energy.phase}`,
          `Sessao: ${energy.sessionDurationMin} min`,
          `Streak: ${energy.currentStreak} min sem pausa`,
          `Pausas: ${energy.breaksTaken}`,
          `Interacoes: ${energy.interactionCount}`,
          '',
          energy.suggestion,
        ],
      })

      // Focus / Attention panel
      const attention = getAttentionStats()
      const focusLabels: Record<string, string> = {
        desligado: 'Desligado', leve: 'Leve', profundo: 'Profundo', nao_perturbe: 'Nao Perturbe',
      }
      statusPanels.push({
        id: 'attention',
        title: `Foco: ${focusLabels[attention.focusMode] ?? attention.focusMode}`,
        content: [
          `Pendentes: ${attention.pending}`,
          `Bloqueadas hoje: ${attention.blockedToday}`,
          `Total hoje: ${attention.totalToday}`,
        ],
      })

      // Optimal hours panel
      const profile = getProfile()
      if (profile.totalSessions >= 3) {
        statusPanels.push({
          id: 'profile',
          title: 'Perfil de Energia',
          content: [
            `Melhores horarios: ${profile.bestHours.map((h) => `${h}h`).join(', ')}`,
            `Sessao media: ${profile.avgSessionMin} min`,
            `Intervalo entre pausas: ${profile.avgBreakInterval} min`,
            `Total sessoes: ${profile.totalSessions}`,
          ],
        })
      }

      // Lokaliza panel
      const hoods = listNeighborhoods()
      if (hoods.length > 0) {
        const totalPois = hoods.reduce((acc, h) => acc + h.pois.length, 0)
        const totalLayers = hoods.reduce((acc, h) => acc + h.layers.length, 0)
        statusPanels.push({
          id: 'lokaliza',
          title: `Lokaliza (${hoods.length} bairros)`,
          content: [
            `POIs: ${totalPois} | Camadas: ${totalLayers}`,
            ...hoods.slice(0, 5).map((h) => `• ${h.name} — ${h.city}/${h.state}`),
            ...(hoods.length > 5 ? [`... +${hoods.length - 5} mais`] : []),
          ],
        })
      }

      // Tasks summary panel
      const statusTasks = listTasks()
      const doneTasks = listTasks(true).filter((t) => t.done)
      statusPanels.push({
        id: 'tasks-summary',
        title: `Tarefas`,
        content: [
          `Pendentes: ${statusTasks.length}`,
          `Concluidas hoje: ${doneTasks.filter((t) => {
            const d = new Date(t.createdAt)
            return d.toDateString() === new Date().toDateString()
          }).length}`,
        ],
      })

      const statusLayout: DashboardLayout = {
        panels: statusPanels,
        columns: 2,
        gap: 1,
      }
      ctx.tui.enterDashboardMode(statusLayout)

      process.stdin.once('data', () => {
        if (ctx.tui.getViewMode() === 'dashboard') {
          ctx.tui.enterChatMode()
        }
      })
      break
    }

    case 'dashboard':
    case 'painel': {
      const dashboardLayout = await generateDashboardBriefing(ctx.config.dataDir)
      ctx.tui.enterDashboardMode(dashboardLayout)

      // Exit on any key press
      process.stdin.once('data', () => {
        if (ctx.tui.getViewMode() === 'dashboard') {
          ctx.tui.enterChatMode()
        }
      })
      break
    }

    case 'chat': {
      ctx.tui.enterChatMode()
      break
    }

    // ── Task/reminder commands ────────────────────────────

    case 'task':
    case 'tarefa': {
      const text = args.join(' ')
      if (!text) {
        // Show pending tasks
        const tasks = listTasks()
        ctx.tui.showSystem(formatTaskList(tasks))
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
      ctx.tui.showSystem(`Tarefa criada: "${task.title}"${dueStr}  [${task.id}]`)
      break
    }

    case 'tasks':
    case 'tarefas': {
      const showAll = args[0] === 'all' || args[0] === 'todas'
      const tasks = listTasks(showAll)
      ctx.tui.showSystem(formatTaskList(tasks))
      break
    }

    case 'done':
    case 'feito':
    case 'concluido': {
      const ref = args.join(' ')
      if (!ref) {
        ctx.tui.showError('Uso: /done <id ou parte do titulo>')
        break
      }
      const task = completeTask(ref)
      if (task) {
        ctx.tui.showSystem(`Concluida: "${task.title}"`)
      } else {
        ctx.tui.showError(`Tarefa nao encontrada: "${ref}"`)
      }
      break
    }

    case 'rmtask':
    case 'rmtarefa': {
      const ref = args.join(' ')
      if (!ref) {
        ctx.tui.showError('Uso: /rmtask <id ou parte do titulo>')
        break
      }
      const removed = removeTask(ref)
      if (removed) {
        ctx.tui.showSystem('Tarefa removida.')
      } else {
        ctx.tui.showError(`Tarefa nao encontrada: "${ref}"`)
      }
      break
    }

    case 'm365': {
      await handleM365Command(args, {
        showSystem: (msg) => ctx.tui.showSystem(msg),
        showError: (msg) => ctx.tui.showError(msg),
      })
      break
    }

    case 'gws': {
      await handleGwsCommand(args, {
        showSystem: (msg) => ctx.tui.showSystem(msg),
        showError: (msg) => ctx.tui.showError(msg),
        enterDashboard: (panels) => {
          const layout = {
            panels: panels.map((p, i) => ({
              ...p,
              col: i,
              row: 0,
            })),
            columns: 3,
            gap: 1,
          }
          ctx.tui.enterDashboardMode(layout)
        },
      })
      break
    }

    default:
      ctx.tui.showError(`Unknown command: /${cmd}. Try /help`)
  }
}

/**
 * Generate dashboard layout data for morning briefing.
 * Returns panels for tasks, follow-ups, calendar, and news.
 */
export async function generateDashboardBriefing(dataDir?: string): Promise<DashboardLayout> {
  const panels: DashboardPanel[] = []

  // Greeting based on time of day
  const hour = new Date().getHours()
  const greeting = hour < 12 ? 'BOM DIA' : hour < 18 ? 'BOA TARDE' : 'BOA NOITE'
  const dateStr = new Date().toLocaleDateString('pt-BR', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  })

  // Tasks panel
  const tasks = listTasks()
  const todayTasks = tasks.filter((t) => {
    if (!t.dueAt) return true // Include tasks without due date
    const due = new Date(t.dueAt)
    const today = new Date()
    return due.toDateString() === today.toDateString()
  })

  if (todayTasks.length > 0 || tasks.length > 0) {
    const taskLines = todayTasks.slice(0, 8).map((t) => {
      const time = t.dueAt
        ? new Date(t.dueAt).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
        : ''
      return `${time ? `[${time}] ` : ''}${t.title}`
    })

    if (tasks.length > todayTasks.length) {
      taskLines.push(`... +${tasks.length - todayTasks.length} outras`)
    }

    panels.push({
      id: 'tasks',
      title: `${greeting}! Tarefas (${todayTasks.length})`,
      content: taskLines.length > 0 ? taskLines : ['Nenhuma tarefa para hoje'],
    })
  }

  // Follow-ups panel
  const followUps = getPendingFollowUps()
  if (followUps.length > 0) {
    const followUpLines = followUps.slice(0, 6).map((f) => {
      const personName = f.person.name || 'Alguem'
      const summary = f.interaction.summary || 'Follow-up pendente'
      return `${personName}: ${summary.slice(0, 30)}...`
    })

    panels.push({
      id: 'followups',
      title: `Follow-ups (${followUps.length})`,
      content: followUpLines,
    })
  }

  // Delegations panel (overdue)
  const delegations = getDelegations()
  const overdue = delegations.filter((d) => d.status === 'atrasado')
  if (overdue.length > 0) {
    const overdueLines = overdue.slice(0, 5).map((d) => {
      // Look up person name by ID
      const person = findPerson(d.personId)
      const personName = person?.name || 'Alguem'
      return `${personName}: ${d.task.slice(0, 25)}...`
    })

    panels.push({
      id: 'delegations',
      title: `Atrasados (${overdue.length})`,
      content: overdueLines,
    })
  }

  // Calendar panel (Windows only)
  try {
    const events = await getOutlookEvents()
    const eventLines = events.split('\n').filter((l) => l.trim()).slice(0, 6)

    // Check if the response is a real event list or a fallback/error message
    const isError = eventLines.length === 1 && (
      eventLines[0].startsWith('Outlook nao disponivel') ||
      eventLines[0].startsWith('Outlook timeout') ||
      eventLines[0].startsWith('Outlook integration only')
    )

    if (isError) {
      // Show the error so the user knows what happened
      panels.push({
        id: 'calendar',
        title: 'Agenda',
        content: [eventLines[0]],
      })
      logger.debug('Calendar fallback in dashboard', { message: eventLines[0] })
    } else if (eventLines.length > 0) {
      panels.push({
        id: 'calendar',
        title: `Agenda (${eventLines.length > 1 || eventLines[0] !== 'Nenhum evento hoje.' ? eventLines.length : 0})`,
        content: eventLines,
      })
    }
  } catch (err) {
    logger.debug('Calendar unavailable for dashboard', { error: err })
    panels.push({
      id: 'calendar',
      title: 'Agenda',
      content: ['Erro ao acessar Outlook'],
    })
  }

  // Project summary
  const projectSummary = getProjectBriefingSummary()
  if (projectSummary) {
    const projectLines = projectSummary.split('\n').filter((l) => l.trim()).slice(0, 5)
    panels.push({
      id: 'project',
      title: 'Projetos',
      content: projectLines,
    })
  }

  // News panel (limited)
  try {
    const news = await fetchNews(['finance', 'business', 'tech'], 2)
    const newsLines = news.split('\n').filter((l) => l.trim()).slice(0, 6)

    if (newsLines.length > 0) {
      panels.push({
        id: 'news',
        title: 'Noticias',
        content: newsLines,
      })
    }
  } catch (err) {
    logger.debug('News fetch failed for dashboard', { error: err })
  }

  // If no panels, add a simple greeting panel
  if (panels.length === 0) {
    panels.push({
      id: 'greeting',
      title: greeting,
      content: [
        dateStr,
        '',
        'Nenhuma tarefa ou evento pendente.',
        'Use /ajuda para ver comandos disponíveis.',
      ],
    })
  }

  return {
    panels,
    columns: Math.min(2, panels.length),
    gap: 1,
  }
}

export function formatAge(timestamp: number): string {
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
