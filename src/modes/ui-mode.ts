/**
 * UI Mode - Launches web interface
 */

import { exec } from 'node:child_process'
import type { Message, ChatEvent } from '../types'
import type { SessionManager } from '../session'
import { createWebServer } from '../ui/web'
import { t } from '../i18n'

/**
 * Generic provider interface matching both ClaudeProvider and OpenAICompatProvider
 */
interface ChatProvider {
  chat(messages: Message[], systemPrompt: string, enableTools?: boolean): AsyncGenerator<ChatEvent>
  setApprovalCallback?(cb: (name: string, input: Record<string, unknown>, riskLevel: string) => Promise<boolean>): void
}

export interface UIModeConfig {
  provider: ChatProvider
  systemPrompt: string
  enableTools: boolean
  sessionManager: SessionManager
  port?: number
}

/**
 * Open URL in the default browser (cross-platform)
 */
function openBrowser(url: string): void {
  const cmd = process.platform === 'win32'
    ? `start "" "${url}"`
    : process.platform === 'darwin'
      ? `open "${url}"`
      : `xdg-open "${url}"`

  exec(cmd, (err) => {
    if (err) console.error(`Failed to open browser: ${url}`, err.message)
  })
}

/**
 * Run web UI mode (Hono server + opens browser)
 */
export async function runWebUI(config: UIModeConfig): Promise<void> {
  const port = config.port || 3847

  console.log(`\n  ${t('ui.starting_web')}\n`)

  const server = createWebServer({
    port,
    provider: config.provider,
    systemPrompt: config.systemPrompt,
    enableTools: config.enableTools,
    sessionManager: config.sessionManager,
  })

  server.start()

  const url = `http://localhost:${port}`
  openBrowser(url)

  // Keep the process running
  await new Promise(() => {})
}
