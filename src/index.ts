#!/usr/bin/env bun
import { parseArgs, printHelp, getVersion } from './cli'
import { loadConfig } from './config'
import { resolveAuth } from './auth'
import { resolveModel } from './models'
import { initProvider, type AuthHolder } from './init/providers'
import { initSession } from './init/session'
import { runPrintMode } from './modes/print-mode'
import { runInteractive } from './modes/interactive'
import { runWebUI, runDesktopUI } from './modes/ui-mode'
import { initI18n } from './i18n'
import { initCoreModules } from './init/modules'

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

  // ── Load config, init i18n, resolve auth ─────────────────
  const config = loadConfig()
  initI18n(config.language)
  if (cliArgs.model) config.model = resolveModel(cliArgs.model)
  if (cliArgs.maxTokens) config.maxTokens = cliArgs.maxTokens

  let authResult
  try {
    authResult = resolveAuth()
  } catch (err) {
    console.error('smolerclaw:', err instanceof Error ? err.message : err)
    process.exit(1)
  }

  // Mutable auth holder shared between provider and interactive mode
  const authHolder: AuthHolder = { auth: authResult }

  // Initialize provider based on model string
  const claude = initProvider(authHolder, config.model, config.maxTokens, config.toolApproval)

  // Initialize session, skills, plugins
  const {
    sessions,
    skills,
    systemPrompt,
    activeSystemPrompt,
    enableTools,
    plugins,
  } = await initSession(config, cliArgs.session, cliArgs.noTools)

  // Initialize core data modules (vault, tasks, memory, etc.)
  // This makes all tools functional in every mode (TUI, web, desktop, print).
  // TUI-specific modules (pomodoro notifications, etc.) init later in interactive mode.
  initCoreModules(config.dataDir, sessions)

  // ── Web UI mode ─────────────────────────────────────────
  if (cliArgs.uiMode === 'web') {
    await runWebUI({
      provider: claude,
      systemPrompt,
      enableTools,
      sessionManager: sessions,
      port: cliArgs.port,
    })
    return
  }

  // ── Desktop UI mode ────────────────────────────────────
  if (cliArgs.uiMode === 'desktop') {
    await runDesktopUI({
      provider: claude,
      systemPrompt,
      enableTools,
      sessionManager: sessions,
      port: cliArgs.port,
    })
    return
  }

  // ── Pipe mode: stdin is not a TTY ────────────────────────
  const isPiped = !process.stdin.isTTY

  if (cliArgs.print || isPiped) {
    await runPrintMode(claude, sessions, systemPrompt, enableTools, cliArgs.prompt, isPiped)
    process.exit(0)
  }

  // ── Interactive TUI mode ─────────────────────────────────
  await runInteractive(claude, sessions, config, authHolder, skills, systemPrompt, activeSystemPrompt, enableTools, plugins, cliArgs.prompt)
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
