import Anthropic from '@anthropic-ai/sdk'
import type { Message, ChatEvent, ToolApprovalMode } from './types'
import { TOOLS, executeTool } from './tools'
import { withRetry } from './retry'
import { trimToContextWindow, compressToolResults, estimateTokens, needsSummary, buildSummaryRequest, summarizationPrompt } from './context-window'
import { assessToolRisk } from './tool-safety'
import { humanizeError } from './errors'
import { needsApproval, type ApprovalCallback } from './approval'

export class ClaudeProvider {
  private client: Anthropic
  private approvalMode: ToolApprovalMode
  private approvalCallback: ApprovalCallback | null = null
  private autoApproveAll = false
  private onAuthExpired: (() => boolean) | null = null

  constructor(
    apiKey: string,
    private model: string,
    private maxTokens: number,
    approvalMode: ToolApprovalMode = 'auto',
  ) {
    this.client = new Anthropic({ apiKey })
    this.approvalMode = approvalMode
  }

  /** Replace the API key and recreate the client (used after auth refresh) */
  updateApiKey(newKey: string): void {
    this.client = new Anthropic({ apiKey: newKey })
  }

  /** Register a callback that fires on 401 to attempt credential refresh */
  setAuthRefresh(cb: () => boolean): void {
    this.onAuthExpired = cb
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

  async *chat(
    messages: Message[],
    systemPrompt: string,
    enableTools = true,
  ): AsyncGenerator<ChatEvent> {
    let processed = compressToolResults(messages)
    const systemTokens = estimateTokens(systemPrompt)

    // Auto-summary when context is getting large
    if (needsSummary(processed, this.model, systemTokens)) {
      const req = buildSummaryRequest(processed, this.model, systemTokens)
      if (req) {
        try {
          const summaryText = await this.generateSummary(req.toSummarize)
          const summaryMsg: Message = {
            role: 'assistant',
            content: `[Conversation summary]\n${summaryText}`,
            timestamp: Date.now(),
          }
          processed = [
            { role: 'user', content: 'Continue from this summary of our earlier conversation.', timestamp: Date.now() },
            summaryMsg,
            ...req.toKeep,
          ]
        } catch {
          // Fallback to simple trim if summary fails
        }
      }
    }

    const trimmed = trimToContextWindow(processed, this.model, systemTokens)
    const apiMessages = toApiMessages(trimmed)
    const tools = enableTools ? TOOLS : undefined

    try {
      yield* this.streamLoop(apiMessages, systemPrompt, tools)
    } catch (err) {
      yield { type: 'error', error: humanizeError(err) }
    }
  }

  private async generateSummary(messages: Message[]): Promise<string> {
    const prompt = summarizationPrompt(messages)
    const resp = await this.client.messages.create({
      model: this.model,
      max_tokens: 1024,
      messages: [{ role: 'user', content: prompt }],
    })
    const textBlock = resp.content.find((b) => b.type === 'text')
    return textBlock?.type === 'text' ? textBlock.text : 'Summary unavailable.'
  }

  private async *streamLoop(
    messages: Anthropic.MessageParam[],
    system: string,
    tools?: Anthropic.Tool[],
  ): AsyncGenerator<ChatEvent> {
    const MAX_TOOL_ROUNDS = 25
    const convo = [...messages]
    let round = 0

    while (round++ < MAX_TOOL_ROUNDS) {
      let stream: ReturnType<typeof this.client.messages.stream>

      try {
        stream = await withRetry(
          async () => {
            return this.client.messages.stream({
              model: this.model,
              max_tokens: this.maxTokens,
              system,
              messages: convo,
              ...(tools?.length ? { tools } : {}),
            })
          },
          {
            onAuthExpired: this.onAuthExpired ?? undefined,
          },
        )
      } catch (err) {
        yield { type: 'error', error: humanizeError(err) }
        return
      }

      for await (const event of stream) {
        if (
          event.type === 'content_block_delta' &&
          event.delta.type === 'text_delta'
        ) {
          yield { type: 'text', text: event.delta.text }
        }
      }

      const final = await stream.finalMessage()

      if (final.usage) {
        yield {
          type: 'usage',
          inputTokens: final.usage.input_tokens,
          outputTokens: final.usage.output_tokens,
        }
      }

      if (final.stop_reason !== 'tool_use') {
        yield { type: 'done' }
        return
      }

      const toolBlocks = final.content.filter(
        (b: Anthropic.ContentBlock): b is Anthropic.ToolUseBlock => b.type === 'tool_use',
      )

      convo.push({ role: 'assistant', content: final.content })

      const toolResults: Anthropic.ToolResultBlockParam[] = []
      for (const tc of toolBlocks) {
        const input = tc.input as Record<string, unknown>
        const risk = assessToolRisk(tc.name, input)

        // Block dangerous operations always
        if (risk.level === 'dangerous') {
          yield { type: 'tool_blocked', id: tc.id, name: tc.name, reason: `Blocked dangerous operation: ${risk.reason}` }
          toolResults.push({
            type: 'tool_result',
            tool_use_id: tc.id,
            content: `Error: Operation blocked for safety. Reason: ${risk.reason}. This command appears dangerous and was not executed.`,
          })
          continue
        }

        // Check if approval is needed
        if (!this.autoApproveAll && needsApproval(this.approvalMode, tc.name, risk.level) && this.approvalCallback) {
          yield { type: 'tool_call', id: tc.id, name: tc.name, input: tc.input }
          const approved = await this.approvalCallback(tc.name, input, risk.level)
          if (!approved) {
            yield { type: 'tool_blocked', id: tc.id, name: tc.name, reason: 'Rejected by user' }
            toolResults.push({
              type: 'tool_result',
              tool_use_id: tc.id,
              content: 'Error: User rejected this operation.',
            })
            continue
          }
          // Approved — execute (tool_call already yielded above)
          const result = await executeTool(tc.name, input)
          yield { type: 'tool_result', id: tc.id, name: tc.name, result }
          toolResults.push({ type: 'tool_result', tool_use_id: tc.id, content: result })
          continue
        }

        // Auto-approved — execute normally
        yield { type: 'tool_call', id: tc.id, name: tc.name, input: tc.input }
        const result = await executeTool(tc.name, input)
        yield { type: 'tool_result', id: tc.id, name: tc.name, result }
        toolResults.push({ type: 'tool_result', tool_use_id: tc.id, content: result })
      }

      convo.push({ role: 'user', content: toolResults })
    }

    yield { type: 'error', error: `Stopped after ${MAX_TOOL_ROUNDS} tool rounds to prevent runaway execution.` }
  }
}

function toApiMessages(messages: Message[]): Anthropic.MessageParam[] {
  const result: Anthropic.MessageParam[] = []

  for (const msg of messages) {
    if (msg.role === 'user') {
      if (msg.images?.length) {
        // Build multi-modal content with images + text
        const content: Anthropic.ContentBlockParam[] = msg.images.map((img) => ({
          type: 'image' as const,
          source: {
            type: 'base64' as const,
            media_type: img.mediaType,
            data: img.base64,
          },
        }))
        content.push({ type: 'text', text: msg.content })
        result.push({ role: 'user', content })
      } else {
        result.push({ role: 'user', content: msg.content })
      }
    } else if (msg.role === 'assistant') {
      if (msg.toolCalls?.length) {
        const content: Anthropic.ContentBlockParam[] = []
        if (msg.content) {
          content.push({ type: 'text', text: msg.content })
        }
        for (const tc of msg.toolCalls) {
          content.push({
            type: 'tool_use',
            id: tc.id,
            name: tc.name,
            input: tc.input,
          })
        }
        result.push({ role: 'assistant', content })
        result.push({
          role: 'user',
          content: msg.toolCalls.map((tc) => ({
            type: 'tool_result' as const,
            tool_use_id: tc.id,
            content: tc.result,
          })),
        })
      } else {
        result.push({ role: 'assistant', content: msg.content })
      }
    }
  }

  return result
}
