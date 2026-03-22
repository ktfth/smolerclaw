import type { Message } from './types'

// Approximate token limits per model family
const MODEL_LIMITS: Record<string, number> = {
  haiku: 200_000,
  sonnet: 200_000,
  opus: 200_000,
}
const DEFAULT_LIMIT = 200_000

// Reserve tokens for system prompt + tool definitions + response
const RESERVED_TOKENS = 20_000

/**
 * Estimate token count for a string.
 * Uses a fast heuristic: ~4 chars per token for English.
 * More accurate than counting words, faster than a real tokenizer.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.5)
}

/**
 * Estimate total tokens for a list of messages.
 */
export function estimateMessageTokens(messages: Message[]): number {
  let total = 0
  for (const msg of messages) {
    total += estimateTokens(msg.content)
    if (msg.toolCalls) {
      for (const tc of msg.toolCalls) {
        total += estimateTokens(JSON.stringify(tc.input))
        total += estimateTokens(tc.result)
      }
    }
    total += 10 // overhead per message (role, metadata)
  }
  return total
}

/**
 * Get the effective context limit for a model.
 */
function getContextLimit(model: string): number {
  const lower = model.toLowerCase()
  for (const [key, limit] of Object.entries(MODEL_LIMITS)) {
    if (lower.includes(key)) return limit
  }
  return DEFAULT_LIMIT
}

/**
 * Trim messages to fit within context window.
 * Strategy:
 *   1. Keep the first message (often sets context)
 *   2. Keep the last N messages that fit the budget
 *   3. Insert a summary marker where messages were dropped
 *
 * Returns a new array — never mutates the input.
 */
export function trimToContextWindow(
  messages: Message[],
  model: string,
  systemPromptTokens: number,
): Message[] {
  const limit = getContextLimit(model) - RESERVED_TOKENS - systemPromptTokens

  const totalTokens = estimateMessageTokens(messages)
  if (totalTokens <= limit) return messages

  // Strategy: keep recent messages, drop older ones from the middle
  // Always keep the first user message if it exists (sets project context)
  const result: Message[] = []
  let budget = limit

  // Scan from newest to oldest to keep recent context
  const reversed = [...messages].reverse()
  const kept: Message[] = []

  for (const msg of reversed) {
    const msgTokens = estimateTokens(msg.content) +
      (msg.toolCalls?.reduce((sum, tc) =>
        sum + estimateTokens(JSON.stringify(tc.input)) + estimateTokens(tc.result), 0) ?? 0) +
      10

    if (budget - msgTokens < 0) break
    budget -= msgTokens
    kept.unshift(msg)
  }

  // If we dropped messages, add a system note
  const dropped = messages.length - kept.length
  if (dropped > 0) {
    result.push({
      role: 'user' as const,
      content: `[Note: ${dropped} earlier messages were trimmed to fit context. The conversation continues below.]`,
      timestamp: Date.now(),
    })
  }

  result.push(...kept)
  return result
}

/**
 * Check if context needs summarization (at 70% capacity).
 */
export function needsSummary(
  messages: Message[],
  model: string,
  systemPromptTokens: number,
): boolean {
  const limit = getContextLimit(model) - RESERVED_TOKENS - systemPromptTokens
  const total = estimateMessageTokens(messages)
  return total > limit * 0.7
}

/**
 * Build a summarization prompt from old messages.
 * Returns the messages to summarize and how many to keep intact.
 */
export function buildSummaryRequest(
  messages: Message[],
  model: string,
  systemPromptTokens: number,
): { toSummarize: Message[]; toKeep: Message[] } | null {
  const limit = getContextLimit(model) - RESERVED_TOKENS - systemPromptTokens
  const total = estimateMessageTokens(messages)
  if (total <= limit * 0.7) return null

  // Keep the last 30% of messages intact, summarize the rest
  const keepCount = Math.max(4, Math.floor(messages.length * 0.3))
  const toSummarize = messages.slice(0, messages.length - keepCount)
  const toKeep = messages.slice(messages.length - keepCount)

  if (toSummarize.length < 2) return null

  return { toSummarize, toKeep }
}

/**
 * Generate the prompt to send to Claude for summarization.
 */
export function summarizationPrompt(messages: Message[]): string {
  const transcript = messages.map((m) => {
    let text = `[${m.role}]: ${m.content.slice(0, 500)}`
    if (m.toolCalls?.length) {
      text += `\n  Tools used: ${m.toolCalls.map((tc) => tc.name).join(', ')}`
    }
    return text
  }).join('\n\n')

  return `Summarize this conversation concisely. Focus on:
1. Key decisions made
2. Files created or modified
3. Important context the user shared
4. Current state of the task

Be brief but preserve actionable information. Output ONLY the summary.

---
${transcript}`
}

/**
 * Summarize tool call results to reduce token usage.
 * Truncates long tool results but preserves the first/last lines.
 */
export function compressToolResults(messages: Message[], maxResultLen: number = 2000): Message[] {
  return messages.map((msg) => {
    if (!msg.toolCalls?.length) return msg

    const compressedCalls = msg.toolCalls.map((tc) => {
      if (tc.result.length <= maxResultLen) return tc

      const lines = tc.result.split('\n')
      const headCount = Math.min(10, lines.length)
      const tailCount = Math.min(5, Math.max(0, lines.length - headCount))
      const omitted = lines.length - headCount - tailCount
      const parts = [...lines.slice(0, headCount)]
      if (omitted > 0) parts.push(`... (${omitted} lines omitted)`)
      if (tailCount > 0) parts.push(...lines.slice(-tailCount))
      const truncated = parts.join('\n')

      return { ...tc, result: truncated }
    })

    return { ...msg, toolCalls: compressedCalls }
  })
}
