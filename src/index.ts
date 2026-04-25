#!/usr/bin/env bun
import { parseArgs, printHelp, getVersion } from './cli'
import { loadConfig } from './config'
import { resolveAuthForModel } from './auth'
import { resolveModel } from './models'
import { initProvider, type AuthHolder } from './init/providers'
import { initSession } from './init/session'
import { runPrintMode } from './modes/print-mode'
import { runInteractive } from './modes/interactive'
import { runWebUI } from './modes/ui-mode'
import { initI18n } from './i18n'
import { initCoreModules } from './init/modules'
import { promptStartupProviderSelection } from './login'

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

  const isInteractiveTui =
    !cliArgs.print &&
    cliArgs.uiMode === 'tui' &&
    process.stdin.isTTY &&
    process.stdout.isTTY &&
    !cliArgs.model &&
    !cliArgs.prompt

  if (isInteractiveTui) {
    config.model = resolveModel(await promptStartupProviderSelection(config.model) || config.model)
  }

  let authResult
  try {
    authResult = resolveAuthForModel(config.model)
  } catch (err) {
    console.error('smolerclaw:', err instanceof Error ? err.message : err)
    process.exit(1)
  }

  // Mutable auth holder shared between provider and interactive mode
  const authHolder: AuthHolder = { auth: authResult }

  // Initialize provider based on model string
  const provider = initProvider(authHolder, config.model, config.maxTokens, config.toolApproval)

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
  // This makes all tools functional in every mode (TUI, web, print).
  // TUI-specific modules (pomodoro notifications, etc.) init later in interactive mode.
  initCoreModules(config.dataDir, sessions)

  // ── Web UI mode ─────────────────────────────────────────
  if (cliArgs.uiMode === 'web') {
    await runWebUI({
      provider,
      model: config.model,
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
    await runPrintMode(provider, sessions, systemPrompt, enableTools, cliArgs.prompt, isPiped)
    process.exit(0)
  }

  // ── Interactive TUI mode ─────────────────────────────────
  await runInteractive(provider, sessions, config, authHolder, skills, systemPrompt, activeSystemPrompt, enableTools, plugins, cliArgs.prompt)
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
