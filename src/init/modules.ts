import { initVault, initShadowBackup, startAutoBackup } from '../vault'
import { initPeople } from '../people'
import { initNotes } from '../notes'
import { initFinance } from '../finance'
import { initFinanceGuard } from '../finance-guard'
import { initBrCompany } from '../br-company'
import { initDecisions } from '../decisions'
import { initPomodoro } from '../pomodoro'
import { initWorkflows } from '../workflows'
import { initMacros } from '../macros'
import { initProjects } from '../projects'
import { initMonitor } from '../monitor'
import { initScheduler } from '../scheduler'
import { initTasks, type Task } from '../tasks'
import { getConfigPath } from '../config'
import { initObsidian } from '../obsidian'
import type { TUI } from '../tui'

let _initializedDataDir: string | null = null

/**
 * Initialize core data modules that do NOT depend on TUI.
 * Safe to call from any mode (TUI, web, engine).
 * Idempotent per dataDir — reinitializes if switched to a different sandbox dir.
 */
export function initCoreModules(dataDir: string, obsidianVault = ''): void {
  if (_initializedDataDir === dataDir) return
  _initializedDataDir = dataDir

  initVault(dataDir, getConfigPath().replace(/[/\\]config\.json$/, ''))
  initPeople(dataDir)
  initNotes(dataDir)
  initFinance(dataDir)
  initFinanceGuard()
  initBrCompany(dataDir)
  initDecisions(dataDir)
  initWorkflows(dataDir)
  initMacros(dataDir)
  initProjects(dataDir)
  // Headless modes need scheduler storage too; Windows task sync stays TUI-only.
  initScheduler(dataDir, undefined, { sync: false })
  initTasks(dataDir, () => {}) // no-op notifier for headless modes; TUI overrides later
  // Last: the mirror projects notes and tasks, so their stores must be open.
  initObsidian(obsidianVault)
}

/**
 * Initialize ALL feature modules including those that depend on TUI.
 * Only call from interactive TUI mode.
 * Vault must init first — other modules use atomicWriteFile.
 */
export function initAllModules(dataDir: string, tui: TUI): void {
  // Core modules (idempotent — safe to call again)
  initCoreModules(dataDir)

  // TUI-dependent modules
  initPomodoro((msg) => tui.showSystem(`\n*** ${msg} ***\n`))
  initMonitor((msg) => tui.showSystem(`\n*** ${msg} ***\n`))
  initScheduler(dataDir, (msg) => tui.showSystem(`\n*** ${msg} ***\n`))
  initTasks(dataDir, (task: Task) => {
    tui.showSystem(`\n*** LEMBRETE: ${task.title} ***\n`)
  })
}
