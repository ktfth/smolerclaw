import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ApprovalCallback } from './approval'
import type { ChatEvent, Message, ToolApprovalMode } from './types'
import type { LLMProvider } from './providers'

interface CodexSessionState {
  threadId: string
  lastCallMessagesLen: number
  systemPrompt: string
}

interface CodexUsage {
  input_tokens?: number
  output_tokens?: number
}

interface CodexJsonEvent {
  type: string
  thread_id?: string
  usage?: CodexUsage
  item?: {
    id: string
    type: string
    text?: string
    command?: string
    aggregated_output?: string
    exit_code?: number | null
    changes?: Array<{ path: string; kind: string }>
    status?: string
  }
}

/**
 * Codex CLI-backed provider.
 * Uses `codex exec --json` so ChatGPT/Codex login can be reused without an API key.
 */
export class CodexProvider implements LLMProvider {
  readonly name = 'codex'
  private approvalMode: ToolApprovalMode = 'auto'
  private approvalCallback: ApprovalCallback | null = null
  private autoApproveAll = false
  private conversationKey = 'default'
  private readonly sessions = new Map<string, CodexSessionState>()

  constructor(
    private model: string,
    private maxTokens: number,
    approvalMode: ToolApprovalMode = 'auto',
  ) {
    this.approvalMode = approvalMode
  }

  setModel(model: string): void {
    this.model = model
  }

  setApprovalMode(mode: ToolApprovalMode): void {
    this.approvalMode = mode
  }

  setApprovalCallback(cb: ApprovalCallback): void {
    this.approvalCallback = cb
  }

  setAutoApproveAll(value: boolean): void {
    this.autoApproveAll = value
  }

  setConversationKey(key: string): void {
    this.conversationKey = key
  }

  async *chat(
    messages: Message[],
    systemPrompt: string,
    enableTools = true,
  ): AsyncGenerator<ChatEvent> {
    const latestUser = [...messages].reverse().find((msg) => msg.role === 'user')
    if (!latestUser) {
      yield { type: 'error', error: 'No user message found for Codex request.' }
      return
    }

    const state = this.sessions.get(this.conversationKey)
    const shouldResume =
      !!state &&
      state.systemPrompt === systemPrompt &&
      state.lastCallMessagesLen + 2 === messages.length

    const prompt = shouldResume
      ? latestUser.content
      : buildBootstrapPrompt(messages, systemPrompt, enableTools)

    const tempDir = latestUser.images?.length
      ? mkdtempSync(join(tmpdir(), 'smolerclaw-codex-'))
      : null

    try {
      const imageArgs = tempDir ? writeImageArgs(tempDir, latestUser.images || []) : []
      const args = buildCodexArgs({
        enableTools,
        model: this.model,
        maxTokens: this.maxTokens,
        approvalMode: this.approvalMode,
        autoApproveAll: this.autoApproveAll,
        resumeThreadId: shouldResume ? state?.threadId : null,
        imageArgs,
      })

      const proc = Bun.spawn(args, {
        cwd: process.cwd(),
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'pipe',
      })

      proc.stdin?.write(prompt)
      proc.stdin?.end()

      const stderrPromise = collectLines(proc.stderr)
      let threadId = shouldResume ? state?.threadId ?? null : null
      let sawUsage = false
      let sawAgentMessage = false

      for await (const line of iterateLines(proc.stdout)) {
        const event = parseEvent(line)
        if (!event) continue

        if (event.type === 'thread.started' && event.thread_id) {
          threadId = event.thread_id
          continue
        }

        if (event.type === 'item.started' && event.item?.type === 'command_execution') {
          yield {
            type: 'tool_call',
            id: event.item.id,
            name: 'command_execution',
            input: { command: event.item.command || '' },
          }
          continue
        }

        if (event.type === 'item.completed' && event.item?.type === 'command_execution') {
          yield {
            type: 'tool_result',
            id: event.item.id,
            name: 'command_execution',
            result: formatCommandResult(event.item.command || '', event.item.aggregated_output || '', event.item.exit_code),
          }
          continue
        }

        if (event.type === 'item.started' && event.item?.type === 'file_change') {
          yield {
            type: 'tool_call',
            id: event.item.id,
            name: 'file_change',
            input: { changes: event.item.changes || [] },
          }
          continue
        }

        if (event.type === 'item.completed' && event.item?.type === 'file_change') {
          yield {
            type: 'tool_result',
            id: event.item.id,
            name: 'file_change',
            result: formatFileChanges(event.item.changes || []),
          }
          continue
        }

        if (event.type === 'item.completed' && event.item?.type === 'agent_message' && event.item.text) {
          sawAgentMessage = true
          yield { type: 'text', text: event.item.text }
          continue
        }

        if (event.type === 'turn.completed' && event.usage) {
          sawUsage = true
          yield {
            type: 'usage',
            inputTokens: event.usage.input_tokens || 0,
            outputTokens: event.usage.output_tokens || 0,
          }
        }
      }

      const exitCode = await proc.exited
      const stderrLines = await stderrPromise

      if (exitCode !== 0) {
        yield { type: 'error', error: humanizeCodexError(stderrLines.join('\n') || 'Codex CLI execution failed.') }
        return
      }

      if (!sawUsage) {
        yield { type: 'usage', inputTokens: 0, outputTokens: 0 }
      }

      if (!sawAgentMessage && stderrLines.length > 0) {
        yield { type: 'error', error: humanizeCodexError(stderrLines.join('\n')) }
        return
      }

      if (threadId) {
        this.sessions.set(this.conversationKey, {
          threadId,
          lastCallMessagesLen: messages.length,
          systemPrompt,
        })
      }

      yield { type: 'done' }
    } catch (err) {
      yield { type: 'error', error: humanizeCodexError(err instanceof Error ? err.message : String(err)) }
    } finally {
      if (tempDir) {
        try {
          rmSync(tempDir, { recursive: true, force: true })
        } catch {
          // Best effort temp cleanup.
        }
      }
    }
  }
}

function buildCodexArgs(opts: {
  enableTools: boolean
  model: string
  maxTokens: number
  approvalMode: ToolApprovalMode
  autoApproveAll: boolean
  resumeThreadId: string | null
  imageArgs: string[]
}): string[] {
  const sandbox = opts.enableTools ? 'workspace-write' : 'read-only'
  const approval = 'never'
  const args = ['codex', '-s', sandbox, '-a', approval]

  if (opts.resumeThreadId) {
    args.push('exec', 'resume', opts.resumeThreadId)
  } else {
    args.push('exec')
  }

  args.push('--skip-git-repo-check', '--json', '--ignore-user-config', '-m', opts.model)
  args.push(...opts.imageArgs)
  args.push('-')
  return args
}

function buildBootstrapPrompt(
  messages: Message[],
  systemPrompt: string,
  enableTools: boolean,
): string {
  const transcript = messages.map(formatTranscriptMessage).join('\n\n')
  const toolGuidance = enableTools
    ? 'You may use Codex CLI tools when they materially help complete the current request.'
    : 'Do not modify files or run commands unless the user explicitly asks. Prefer a direct answer.'

  return [
    'You are the active model backend for smolerclaw.',
    'Follow the system instructions exactly and continue the conversation from the latest user message.',
    toolGuidance,
    '<system_prompt>',
    systemPrompt,
    '</system_prompt>',
    '<conversation>',
    transcript,
    '</conversation>',
  ].join('\n\n')
}

function formatTranscriptMessage(message: Message): string {
  const lines = [`[${message.role.toUpperCase()}]`, message.content]

  if (message.toolCalls?.length) {
    for (const toolCall of message.toolCalls) {
      lines.push(`[TOOL ${toolCall.name}] ${JSON.stringify(toolCall.input)}`)
      lines.push(`[TOOL RESULT ${toolCall.name}] ${toolCall.result}`)
    }
  }

  return lines.join('\n')
}

function writeImageArgs(tempDir: string, images: NonNullable<Message['images']>): string[] {
  const args: string[] = []
  images.forEach((image, index) => {
    const ext = mediaTypeToExtension(image.mediaType)
    const filePath = join(tempDir, `image-${index}.${ext}`)
    writeFileSync(filePath, Buffer.from(image.base64, 'base64'))
    args.push('-i', filePath)
  })
  return args
}

function mediaTypeToExtension(mediaType: string): string {
  switch (mediaType) {
    case 'image/jpeg':
      return 'jpg'
    case 'image/gif':
      return 'gif'
    case 'image/webp':
      return 'webp'
    default:
      return 'png'
  }
}

async function collectLines(stream: ReadableStream<Uint8Array> | null | undefined): Promise<string[]> {
  const lines: string[] = []
  for await (const line of iterateLines(stream)) {
    lines.push(line)
  }
  return lines
}

async function* iterateLines(
  stream: ReadableStream<Uint8Array> | null | undefined,
): AsyncGenerator<string> {
  if (!stream) return

  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) break

    buffer += decoder.decode(value, { stream: true })
    let newline = buffer.indexOf('\n')
    while (newline >= 0) {
      const line = buffer.slice(0, newline).replace(/\r$/, '').trim()
      buffer = buffer.slice(newline + 1)
      if (line) yield line
      newline = buffer.indexOf('\n')
    }
  }

  const tail = buffer.trim()
  if (tail) yield tail
}

function parseEvent(line: string): CodexJsonEvent | null {
  if (!line.startsWith('{')) return null

  try {
    return JSON.parse(line) as CodexJsonEvent
  } catch {
    return null
  }
}

function formatCommandResult(command: string, output: string, exitCode: number | null | undefined): string {
  const parts = [command]
  if (output.trim()) parts.push(output.trim())
  if (exitCode !== null && exitCode !== undefined) parts.push(`(exit: ${exitCode})`)
  return parts.join('\n')
}

function formatFileChanges(changes: Array<{ path: string; kind: string }>): string {
  if (changes.length === 0) return 'No file changes reported.'
  return changes.map((change) => `${change.kind}: ${change.path}`).join('\n')
}

function humanizeCodexError(input: string): string {
  const msg = input.trim()
  if (!msg) return 'Codex CLI execution failed.'

  const lower = msg.toLowerCase()
  if (lower.includes('not logged in') || lower.includes('login')) {
    return 'Codex CLI authentication failed. Run `codex --login` and try again.'
  }
  if (lower.includes('unauthorized') || lower.includes('forbidden')) {
    return 'Codex CLI access was denied. Re-run `codex --login` and confirm your ChatGPT/OpenAI access.'
  }
  return msg
}
