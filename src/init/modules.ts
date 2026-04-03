import { initVault, initShadowBackup, startAutoBackup } from '../vault'
import { initPeople } from '../people'
import { initMemos } from '../memos'
import { initMaterials } from '../materials'
import { initNews } from '../news'
import { initFinance } from '../finance'
import { initFinanceGuard } from '../finance-guard'
import { initDecisions } from '../decisions'
import { initPomodoro } from '../pomodoro'
import { initWorkflows } from '../workflows'
import { initMacros } from '../macros'
import { initInvestigations } from '../investigate'
import { initMemory } from '../memory'
import { initProjects } from '../projects'
import { initPitwall } from '../pitwall'
import { initDecisionEngine } from '../services/decision-engine'
import { initDocsEngine } from '../services/docs-engine'
import { initMonitor } from '../monitor'
import { initScheduler } from '../scheduler'
import { initTasks, type Task } from '../tasks'
import { registerSessionManager } from '../tools'
import { getConfigPath } from '../config'
import type { SessionManager } from '../session'
import type { TUI } from '../tui'

let _coreInitialized = false

/**
 * Initialize core data modules that do NOT depend on TUI.
 * Safe to call from any mode (TUI, web, desktop).
 * Idempotent — only runs once.
 */
export function initCoreModules(
  dataDir: string,
  sessions: SessionManager,
): void {
  if (_coreInitialized) return
  _coreInitialized = true

  initVault(dataDir, getConfigPath().replace(/[/\\]config\.json$/, ''))
  initPeople(dataDir)
  initMemos(dataDir)
  initMaterials(dataDir)
  initNews(dataDir)
  registerSessionManager(sessions)
  initFinance(dataDir)
  initFinanceGuard()
  initDecisions(dataDir)
  initWorkflows(dataDir)
  initMacros(dataDir)
  initInvestigations(dataDir)
  initMemory(dataDir)
  initProjects(dataDir)
  initPitwall(dataDir)
  initDecisionEngine(dataDir)
  initTasks(dataDir, () => {}) // no-op notifier for headless modes; TUI overrides later
}

/**
 * Initialize ALL feature modules including those that depend on TUI.
 * Only call from interactive TUI mode.
 * Vault must init first — other modules use atomicWriteFile.
 */
export function initAllModules(
  dataDir: string,
  tui: TUI,
  sessions: SessionManager,
): void {
  // Core modules (idempotent — safe to call again)
  initCoreModules(dataDir, sessions)

  // TUI-dependent modules
  initPomodoro((msg) => tui.showSystem(`\n*** ${msg} ***\n`))
  initDocsEngine(dataDir, (insight) => {
    // Non-blocking notification when an immediate insight is generated
    tui.showSystem(`\n*** Meta-Insight: ${insight.title} ***\n${insight.recommendation}\n`)
  })
  initMonitor((msg) => tui.showSystem(`\n*** ${msg} ***\n`))
  initScheduler(dataDir, (msg) => tui.showSystem(`\n*** ${msg} ***\n`))
  initTasks(dataDir, (task: Task) => {
    tui.showSystem(`\n*** LEMBRETE: ${task.title} ***\n`)
  })
}
