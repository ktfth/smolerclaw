import {
  Agent,
  OpenAIProvider,
  Runner,
  isOpenAIResponsesRawModelStreamEvent,
  tool as openAITool,
  type AgentInputItem,
  type RunStreamEvent,
  type Tool as OpenAITool,
} from '@openai/agents'
import type Anthropic from '@anthropic-ai/sdk'
import type { Message, ChatEvent, ToolApprovalMode } from './types'
import type { ApprovalCallback } from './approval'
import type { LLMProvider } from './providers'
import { TOOLS, executeTool } from './tools'
import { assessToolRisk } from './tool-safety'
import { humanizeError } from './errors'
import { needsApproval } from './approval'

const OPENAI_BASE = 'https://api.openai.com/v1'

type ToolExecutionMeta =
  | { status: 'ok'; result: string }
  | { status: 'blocked'; reason: string }

export class OpenAIAgentsProvider implements LLMProvider {
  readonly name = 'openai'
  private approvalMode: ToolApprovalMode = 'auto'
  private approvalCallback: ApprovalCallback | null = null
  private autoApproveAll = false
  private conversationKey = 'default'
  private readonly runner: Runner
  private readonly modelProvider: OpenAIProvider
  private readonly toolExecutionMeta = new Map<string, ToolExecutionMeta>()

  constructor(
    private apiKey: string,
    private model: string,
    private maxTokens: number,
    approvalMode: ToolApprovalMode = 'auto',
    baseUrl = process.env.OPENAI_BASE_URL || OPENAI_BASE,
  ) {
    this.approvalMode = approvalMode
    this.modelProvider = new OpenAIProvider({
      apiKey,
      baseURL: baseUrl,
      useResponses: true,
    })
    this.runner = new Runner({
      modelProvider: this.modelProvider,
      tracingDisabled: true,
      workflowName: 'smolerclaw-chat',
    })
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
    const agent = new Agent({
      name: 'smolerclaw',
      instructions: systemPrompt,
      model: this.model,
      modelSettings: {
        maxTokens: this.maxTokens,
        parallelToolCalls: false,
        store: false,
      },
      tools: enableTools ? this.buildTools() : [],
    })

    try {
      this.toolExecutionMeta.clear()
      const result = await this.runner.run(agent, toAgentInput(messages), {
        stream: true,
      })

      for await (const event of result) {
        const textDelta = extractTextDelta(event)
        if (textDelta) {
          yield { type: 'text', text: textDelta }
          continue
        }

        if (event.type !== 'run_item_stream_event') continue

        if (event.name === 'tool_called' && event.item.type === 'tool_call_item') {
          const callId = getToolCallId(event)
          const toolName = getToolName(event)
          const input = getToolInput(event)
          if (callId && toolName) {
            yield { type: 'tool_call', id: callId, name: toolName, input }
          }
          continue
        }

        if (event.name === 'tool_output' && event.item.type === 'tool_call_output_item') {
          const callId = getToolOutputCallId(event)
          const toolName = getToolOutputName(event)
          if (!callId || !toolName) continue

          const meta = this.toolExecutionMeta.get(callId)
          if (meta?.status === 'blocked') {
            yield { type: 'tool_blocked', id: callId, name: toolName, reason: meta.reason }
            continue
          }

          const resultText = meta?.status === 'ok'
            ? meta.result
            : stringifyToolOutput(event.item.output)
          yield { type: 'tool_result', id: callId, name: toolName, result: resultText }
        }
      }

      await result.completed
      if (result.error) {
        throw result.error
      }

      const usage = result.rawResponses.at(-1)?.usage
      if (usage) {
        yield {
          type: 'usage',
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
        }
      }
      yield { type: 'done' }
    } catch (err) {
      yield { type: 'error', error: humanizeError(err) }
    }
  }

  private buildTools(): OpenAITool[] {
    return TOOLS.map((toolDef) => this.toOpenAITool(toolDef))
  }

  private toOpenAITool(toolDef: Anthropic.Tool): OpenAITool {
    const schema = normalizeToolSchema(toolDef.input_schema)

    return openAITool({
      name: toolDef.name,
      description: toolDef.description || `Execute ${toolDef.name}.`,
      parameters: schema as any,
      strict: false,
      execute: async (rawInput, _context, details) => {
        const input = toRecordInput(rawInput)
        const callId = details?.toolCall?.callId || `${toolDef.name}-${Date.now()}`
        const risk = assessToolRisk(toolDef.name, input)

        if (risk.level === 'dangerous') {
          const reason = `Blocked dangerous operation: ${risk.reason}`
          this.toolExecutionMeta.set(callId, { status: 'blocked', reason })
          return `Error: ${reason}.`
        }

        if (
          !this.autoApproveAll &&
          needsApproval(this.approvalMode, toolDef.name, risk.level) &&
          this.approvalCallback
        ) {
          const approved = await this.approvalCallback(toolDef.name, input, risk.level)
          if (!approved) {
            const reason = 'Rejected by user'
            this.toolExecutionMeta.set(callId, { status: 'blocked', reason })
            return 'Error: User rejected this operation.'
          }
        }

        const result = await executeTool(toolDef.name, input)
        this.toolExecutionMeta.set(callId, { status: 'ok', result })
        return result
      },
    })
  }
}

function normalizeToolSchema(schema: unknown): Record<string, unknown> {
  if (schema && typeof schema === 'object' && !Array.isArray(schema)) {
    return schema as Record<string, unknown>
  }

  return {
    type: 'object',
    properties: {},
    required: [],
  }
}

function toRecordInput(input: unknown): Record<string, unknown> {
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    return input as Record<string, unknown>
  }
  return {}
}

function extractTextDelta(event: RunStreamEvent): string | null {
  if (isOpenAIResponsesRawModelStreamEvent(event)) {
    const type = event.data.event.type
    if (type === 'response.output_text.delta') {
      return event.data.event.delta
    }
    return null
  }

  if (event.type !== 'raw_model_stream_event') return null
  const raw = event.data as { type?: string; delta?: unknown }
  return raw.type === 'output_text_delta' && typeof raw.delta === 'string'
    ? raw.delta
    : null
}

function getToolCallId(event: Extract<RunStreamEvent, { type: 'run_item_stream_event' }>): string | null {
  const rawItem = event.item.rawItem as { callId?: unknown }
  return typeof rawItem?.callId === 'string' ? rawItem.callId : null
}

function getToolName(event: Extract<RunStreamEvent, { type: 'run_item_stream_event' }>): string | null {
  const rawItem = event.item.rawItem as { name?: unknown }
  return typeof rawItem?.name === 'string' ? rawItem.name : null
}

function getToolInput(event: Extract<RunStreamEvent, { type: 'run_item_stream_event' }>): Record<string, unknown> {
  const rawItem = event.item.rawItem as { arguments?: unknown }
  if (typeof rawItem?.arguments !== 'string' || !rawItem.arguments.trim()) {
    return {}
  }

  try {
    const parsed = JSON.parse(rawItem.arguments)
    return toRecordInput(parsed)
  } catch {
    return {}
  }
}

function getToolOutputCallId(event: Extract<RunStreamEvent, { type: 'run_item_stream_event' }>): string | null {
  const rawItem = event.item.rawItem as { callId?: unknown }
  return typeof rawItem?.callId === 'string' ? rawItem.callId : null
}

function getToolOutputName(event: Extract<RunStreamEvent, { type: 'run_item_stream_event' }>): string | null {
  const rawItem = event.item.rawItem as { name?: unknown }
  return typeof rawItem?.name === 'string' ? rawItem.name : null
}

function stringifyToolOutput(output: unknown): string {
  if (typeof output === 'string') return output
  if (output === undefined) return ''
  try {
    return JSON.stringify(output, null, 2)
  } catch {
    return String(output)
  }
}

function toAgentInput(messages: Message[]): AgentInputItem[] {
  const result: AgentInputItem[] = []

  for (const msg of messages) {
    if (msg.role === 'user') {
      const content: Array<
        | { type: 'input_text'; text: string }
        | { type: 'input_image'; image: string }
      > = []

      for (const image of msg.images || []) {
        content.push({
          type: 'input_image',
          image: `data:${image.mediaType};base64,${image.base64}`,
        })
      }

      if (msg.content) {
        content.push({ type: 'input_text', text: msg.content })
      }

      result.push({
        role: 'user',
        content: content.length > 0 ? content : msg.content,
      } as AgentInputItem)
      continue
    }

    if (msg.content) {
      result.push({
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: msg.content }],
      } as AgentInputItem)
    }

    for (const toolCall of msg.toolCalls || []) {
      result.push({
        type: 'function_call',
        callId: toolCall.id,
        name: toolCall.name,
        arguments: JSON.stringify(toolCall.input),
        status: 'completed',
      } as AgentInputItem)
      result.push({
        type: 'function_call_result',
        callId: toolCall.id,
        name: toolCall.name,
        status: 'completed',
        output: toolCall.result,
      } as AgentInputItem)
    }
  }

  return result
}
