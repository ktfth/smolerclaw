import type { AnyProvider } from '../init/providers'
import type { SessionManager } from '../session'
import type { Message } from '../types'

export async function runPrintMode(
  provider: AnyProvider,
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
  for await (const event of provider.chat(sessions.messages, systemPrompt, enableTools)) {
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
