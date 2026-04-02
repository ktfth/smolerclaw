/**
 * UI Mode - Launches web or desktop interface
 */

import type { Message, ChatEvent } from '../types'
import { createWebServer } from '../ui/web'
import { launchDesktopApp } from '../ui/desktop'

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
  port?: number
}

/**
 * Run web UI mode (Hono server)
 */
export async function runWebUI(config: UIModeConfig): Promise<void> {
  const port = config.port || 3847

  console.log('\n  Starting smolerclaw web UI...\n')

  const server = createWebServer({
    port,
    provider: config.provider,
    systemPrompt: config.systemPrompt,
    enableTools: config.enableTools,
  })

  server.start()

  // Keep the process running
  await new Promise(() => {})
}

/**
 * Run desktop UI mode (Electrobun)
 */
export async function runDesktopUI(config: UIModeConfig): Promise<void> {
  console.log('\n  Starting smolerclaw desktop app...\n')

  const { url } = await launchDesktopApp({
    provider: config.provider,
    systemPrompt: config.systemPrompt,
    enableTools: config.enableTools,
    devMode: process.env.NODE_ENV === 'development',
  })

  console.log(`  App running at: ${url}\n`)

  // Keep the process running
  await new Promise(() => {})
}
