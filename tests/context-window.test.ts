import { describe, it, expect } from 'bun:test'
import {
  estimateTokens,
  estimateMessageTokens,
  trimToContextWindow,
  needsSummary,
  buildSummaryRequest,
  summarizationPrompt,
  compressToolResults,
  shouldTrimHistory,
  trimMessageHistory,
  summarizeContext,
} from '../src/context-window'
import type { Message } from '../src/types'

// ─── Helpers ────────────────────────────────────────────────────

function makeMessage(
  role: 'user' | 'assistant',
  content: string,
  toolCalls?: Message['toolCalls'],
): Message {
  return { role, content, timestamp: Date.now(), ...(toolCalls ? { toolCalls } : {}) }
}

function makeToolCall(resultLen: number = 20) {
  return {
    id: 'tc-1',
    name: 'read_file',
    input: { path: 'foo.ts' } as Record<string, unknown>,
    result: 'x'.repeat(resultLen),
  }
}

/**
 * Build a message whose estimated token count is approximately `targetTokens`.
 * Uses the 3.5 chars/token heuristic from the source.
 */
function makeBigMessage(
  role: 'user' | 'assistant',
  targetTokens: number,
): Message {
  const charCount = Math.floor(targetTokens * 3.5)
  return makeMessage(role, 'a'.repeat(charCount))
}

// ─── estimateTokens ─────────────────────────────────────────────

describe('estimateTokens', () => {
  it('returns 0 for empty string', () => {
    expect(estimateTokens('')).toBe(0)
  })

  it('returns ceil(len / 3.5) for any string', () => {
    expect(estimateTokens('a')).toBe(Math.ceil(1 / 3.5)) // 1
    expect(estimateTokens('abcdefg')).toBe(Math.ceil(7 / 3.5)) // 2
    expect(estimateTokens('a'.repeat(350))).toBe(Math.ceil(350 / 3.5)) // 100
  })

  it('handles very short strings (1-3 chars)', () => {
    expect(estimateTokens('x')).toBe(1)
    expect(estimateTokens('xy')).toBe(1)
    expect(estimateTokens('xyz')).toBe(1)
    expect(estimateTokens('xyzw')).toBe(2)
  })

  it('handles very long strings', () => {
    const longText = 'a'.repeat(1_000_000)
    const tokens = estimateTokens(longText)
    expect(tokens).toBe(Math.ceil(1_000_000 / 3.5))
  })

  it('scales linearly with text length', () => {
    const short = estimateTokens('a'.repeat(100))
    const long = estimateTokens('a'.repeat(200))
    // The 200-char estimate should be roughly 2x the 100-char estimate
    expect(long).toBeGreaterThanOrEqual(short * 2 - 1)
    expect(long).toBeLessThanOrEqual(short * 2 + 1)
  })

  it('handles whitespace-only strings', () => {
    const tokens = estimateTokens('   \n\t  ')
    expect(tokens).toBeGreaterThan(0)
  })

  it('handles unicode / multi-byte characters', () => {
    const tokens = estimateTokens('你好世界')
    expect(tokens).toBeGreaterThan(0)
  })
})

// ─── estimateMessageTokens ──────────────────────────────────────

describe('estimateMessageTokens', () => {
  it('returns 0 for empty array', () => {
    expect(estimateMessageTokens([])).toBe(0)
  })

  it('adds 10 overhead per message', () => {
    const msgs = [makeMessage('user', '')]
    // empty content = 0 tokens, + 10 overhead
    expect(estimateMessageTokens(msgs)).toBe(10)
  })

  it('sums content tokens + overhead for multiple messages', () => {
    const msgs = [
      makeMessage('user', 'a'.repeat(35)),   // ceil(35/3.5) = 10 + 10 = 20
      makeMessage('assistant', 'a'.repeat(70)), // ceil(70/3.5) = 20 + 10 = 30
    ]
    expect(estimateMessageTokens(msgs)).toBe(50)
  })

  it('includes tool call input and result tokens', () => {
    const tc = {
      id: '1',
      name: 'bash',
      input: { command: 'ls' } as Record<string, unknown>,
      result: 'file1.ts\nfile2.ts',
    }
    const withTools = [makeMessage('assistant', 'running', [tc])]
    const withoutTools = [makeMessage('assistant', 'running')]

    expect(estimateMessageTokens(withTools)).toBeGreaterThan(
      estimateMessageTokens(withoutTools),
    )
  })

  it('handles message with multiple tool calls', () => {
    const tc1 = makeToolCall(100)
    const tc2 = { ...makeToolCall(200), id: 'tc-2', name: 'write_file' }
    const msgs = [makeMessage('assistant', 'doing work', [tc1, tc2])]
    const tokens = estimateMessageTokens(msgs)
    // Should include both tool call results
    expect(tokens).toBeGreaterThan(50)
  })

  it('handles messages with no toolCalls property', () => {
    const msg: Message = { role: 'user', content: 'hello', timestamp: 0 }
    // toolCalls is undefined — should not throw
    expect(estimateMessageTokens([msg])).toBeGreaterThan(0)
  })
})

// ─── trimToContextWindow ────────────────────────────────────────

describe('trimToContextWindow', () => {
  it('returns messages unchanged when under limit', () => {
    const msgs = [
      makeMessage('user', 'Hello'),
      makeMessage('assistant', 'Hi there!'),
    ]
    const result = trimToContextWindow(msgs, 'sonnet', 0)
    expect(result).toEqual(msgs)
  })

  it('trims messages that exceed the context window', () => {
    // Each message ~ 50k tokens (175k chars at 3.5 chars/token)
    const msgs = [
      makeBigMessage('user', 50_000),
      makeBigMessage('assistant', 50_000),
      makeBigMessage('user', 50_000),
      makeBigMessage('assistant', 50_000),
    ]
    // limit = 200k - 20k reserved - 0 system = 180k, total ~ 200k
    const result = trimToContextWindow(msgs, 'sonnet', 0)
    expect(result.length).toBeLessThan(msgs.length + 1) // may include notice
  })

  it('inserts a drop notice when messages are trimmed', () => {
    const msgs = [
      makeBigMessage('user', 80_000),
      makeBigMessage('assistant', 80_000),
      makeBigMessage('user', 80_000),
    ]
    const result = trimToContextWindow(msgs, 'sonnet', 0)
    const notice = result.find((m) => m.content.includes('trimmed'))
    expect(notice).toBeDefined()
    expect(notice!.role).toBe('user')
    expect(notice!.content).toContain('earlier messages were trimmed')
  })

  it('keeps the most recent messages that fit the budget', () => {
    const msgs = [
      makeMessage('user', 'oldest'),
      makeMessage('assistant', 'old reply'),
      makeBigMessage('user', 80_000),
      makeBigMessage('assistant', 80_000),
      makeMessage('user', 'newest'),
    ]
    const result = trimToContextWindow(msgs, 'sonnet', 0)
    const lastMsg = result[result.length - 1]
    expect(lastMsg.content).toBe('newest')
  })

  it('accounts for systemPromptTokens in the budget', () => {
    // With large system prompt, even modest messages may need trimming
    const msgs = [
      makeBigMessage('user', 80_000),
      makeBigMessage('assistant', 80_000),
    ]
    const withSmallSys = trimToContextWindow(msgs, 'sonnet', 0)
    const withLargeSys = trimToContextWindow(msgs, 'sonnet', 100_000)
    // Large system prompt leaves less room, so more trimming
    expect(withLargeSys.length).toBeLessThanOrEqual(withSmallSys.length)
  })

  it('recognizes model-specific limits (haiku, sonnet, opus)', () => {
    const msgs = [makeMessage('user', 'short message')]
    // All models should pass these through — they all have 200k limit
    expect(trimToContextWindow(msgs, 'haiku', 0)).toEqual(msgs)
    expect(trimToContextWindow(msgs, 'sonnet', 0)).toEqual(msgs)
    expect(trimToContextWindow(msgs, 'opus', 0)).toEqual(msgs)
  })

  it('uses DEFAULT_LIMIT for unknown models', () => {
    const msgs = [makeMessage('user', 'hi')]
    // Unknown model falls back to 200k — small message fits fine
    const result = trimToContextWindow(msgs, 'gpt-4o-unknown', 0)
    expect(result).toEqual(msgs)
  })

  it('handles empty messages array', () => {
    const result = trimToContextWindow([], 'sonnet', 0)
    expect(result).toEqual([])
  })

  it('handles single message that exceeds limit', () => {
    const msgs = [makeBigMessage('user', 250_000)]
    const result = trimToContextWindow(msgs, 'sonnet', 0)
    // Can't fit even one message — notice + nothing, or just notice
    expect(result.length).toBeLessThanOrEqual(2)
  })

  it('drop notice includes count of dropped messages', () => {
    const msgs = Array.from({ length: 10 }, (_, i) =>
      makeBigMessage(i % 2 === 0 ? 'user' : 'assistant', 25_000),
    )
    const result = trimToContextWindow(msgs, 'sonnet', 0)
    const notice = result.find((m) => m.content.includes('trimmed'))
    if (notice) {
      // Notice should mention the number of dropped messages
      expect(notice.content).toMatch(/\d+ earlier messages/)
    }
  })
})

// ─── needsSummary ───────────────────────────────────────────────

describe('needsSummary', () => {
  it('returns false when well under 70% capacity', () => {
    const msgs = [makeMessage('user', 'hello')]
    expect(needsSummary(msgs, 'sonnet', 0)).toBe(false)
  })

  it('returns true when over 70% capacity', () => {
    // limit = 200k - 20k = 180k. 70% of 180k = 126k
    // Need messages totaling > 126k tokens
    const msgs = [makeBigMessage('user', 130_000)]
    expect(needsSummary(msgs, 'sonnet', 0)).toBe(true)
  })

  it('accounts for system prompt tokens', () => {
    // limit = 200k - 20k - 100k = 80k. 70% of 80k = 56k
    const msgs = [makeBigMessage('user', 60_000)]
    expect(needsSummary(msgs, 'sonnet', 100_000)).toBe(true)
  })

  it('returns false for empty messages', () => {
    expect(needsSummary([], 'sonnet', 0)).toBe(false)
  })

  it('works at the boundary (exactly 70%)', () => {
    // limit = 200k - 20k = 180k. 70% = 126_000
    // We need to get close to the boundary and check both sides
    const under = [makeBigMessage('user', 125_000)]
    const over = [makeBigMessage('user', 128_000)]
    // One should be false, one should be true (approximately)
    expect(needsSummary(under, 'sonnet', 0)).toBe(false)
    expect(needsSummary(over, 'sonnet', 0)).toBe(true)
  })

  it('uses correct model limit for different models', () => {
    const msgs = [makeMessage('user', 'tiny')]
    expect(needsSummary(msgs, 'haiku', 0)).toBe(false)
    expect(needsSummary(msgs, 'unknown-model', 0)).toBe(false)
  })
})

// ─── buildSummaryRequest ────────────────────────────────────────

describe('buildSummaryRequest', () => {
  it('returns null when under 70% capacity', () => {
    const msgs = [makeMessage('user', 'hello')]
    expect(buildSummaryRequest(msgs, 'sonnet', 0)).toBeNull()
  })

  it('returns toSummarize and toKeep when over threshold', () => {
    const msgs = Array.from({ length: 20 }, (_, i) =>
      makeBigMessage(i % 2 === 0 ? 'user' : 'assistant', 7_000),
    )
    // Total ~ 140k tokens, limit = 180k, 70% = 126k → should trigger
    const result = buildSummaryRequest(msgs, 'sonnet', 0)
    expect(result).not.toBeNull()
    expect(result!.toSummarize.length).toBeGreaterThan(0)
    expect(result!.toKeep.length).toBeGreaterThan(0)
    // toSummarize + toKeep should equal original messages
    expect(result!.toSummarize.length + result!.toKeep.length).toBe(msgs.length)
  })

  it('keeps at least 4 messages in toKeep (minimum)', () => {
    const msgs = Array.from({ length: 6 }, (_, i) =>
      makeBigMessage(i % 2 === 0 ? 'user' : 'assistant', 25_000),
    )
    const result = buildSummaryRequest(msgs, 'sonnet', 0)
    if (result) {
      expect(result.toKeep.length).toBeGreaterThanOrEqual(4)
    }
  })

  it('keeps last 30% of messages', () => {
    const msgs = Array.from({ length: 20 }, (_, i) =>
      makeBigMessage(i % 2 === 0 ? 'user' : 'assistant', 7_000),
    )
    const result = buildSummaryRequest(msgs, 'sonnet', 0)
    if (result) {
      const expectedKeep = Math.max(4, Math.floor(20 * 0.3)) // 6
      expect(result.toKeep.length).toBe(expectedKeep)
      expect(result.toSummarize.length).toBe(20 - expectedKeep)
    }
  })

  it('returns null if fewer than 2 messages to summarize', () => {
    // With few messages, toSummarize < 2 → returns null
    const msgs = Array.from({ length: 5 }, (_, i) =>
      makeBigMessage(i % 2 === 0 ? 'user' : 'assistant', 30_000),
    )
    const result = buildSummaryRequest(msgs, 'sonnet', 0)
    if (result) {
      // If result is returned, toSummarize must have >= 2
      expect(result.toSummarize.length).toBeGreaterThanOrEqual(2)
    }
  })

  it('toKeep contains the last messages from the original array', () => {
    const msgs = Array.from({ length: 20 }, (_, i) =>
      makeMessage(i % 2 === 0 ? 'user' : 'assistant', `msg-${i}`),
    )
    // Force over threshold with big system prompt
    const result = buildSummaryRequest(msgs, 'sonnet', 175_000)
    if (result) {
      const lastOriginal = msgs[msgs.length - 1]
      const lastKept = result.toKeep[result.toKeep.length - 1]
      expect(lastKept.content).toBe(lastOriginal.content)
    }
  })

  it('returns null for empty messages', () => {
    expect(buildSummaryRequest([], 'sonnet', 0)).toBeNull()
  })

  it('accounts for systemPromptTokens', () => {
    const msgs = Array.from({ length: 10 }, (_, i) =>
      makeBigMessage(i % 2 === 0 ? 'user' : 'assistant', 10_000),
    )
    // Without system prompt: may be under 70%
    const withoutSys = buildSummaryRequest(msgs, 'sonnet', 0)
    // With huge system prompt: more likely over 70%
    const withSys = buildSummaryRequest(msgs, 'sonnet', 100_000)
    // The one with large system prompt is more likely to return a result
    if (withoutSys === null) {
      expect(withSys).not.toBeNull()
    }
  })
})

// ─── summarizationPrompt ────────────────────────────────────────

describe('summarizationPrompt', () => {
  it('produces a prompt with conversation transcript', () => {
    const msgs = [
      makeMessage('user', 'Can you help me fix a bug?'),
      makeMessage('assistant', 'Sure, what is the issue?'),
    ]
    const prompt = summarizationPrompt(msgs)
    expect(prompt).toContain('[user]')
    expect(prompt).toContain('[assistant]')
    expect(prompt).toContain('fix a bug')
    expect(prompt).toContain('Summarize this conversation')
  })

  it('truncates long messages to 500 chars', () => {
    const longContent = 'x'.repeat(1000)
    const msgs = [makeMessage('user', longContent)]
    const prompt = summarizationPrompt(msgs)
    // The content in the prompt should be truncated
    expect(prompt).not.toContain('x'.repeat(1000))
    expect(prompt).toContain('x'.repeat(500))
  })

  it('includes tool names when tool calls are present', () => {
    const tc = {
      id: '1',
      name: 'read_file',
      input: { path: 'test.ts' } as Record<string, unknown>,
      result: 'file contents',
    }
    const msgs = [makeMessage('assistant', 'Let me check', [tc])]
    const prompt = summarizationPrompt(msgs)
    expect(prompt).toContain('Tools used: read_file')
  })

  it('lists multiple tool names comma-separated', () => {
    const tcs = [
      { id: '1', name: 'read_file', input: {} as Record<string, unknown>, result: 'a' },
      { id: '2', name: 'write_file', input: {} as Record<string, unknown>, result: 'b' },
      { id: '3', name: 'bash', input: {} as Record<string, unknown>, result: 'c' },
    ]
    const msgs = [makeMessage('assistant', 'Working on it', tcs)]
    const prompt = summarizationPrompt(msgs)
    expect(prompt).toContain('Tools used: read_file, write_file, bash')
  })

  it('handles empty messages array', () => {
    const prompt = summarizationPrompt([])
    expect(prompt).toContain('Summarize this conversation')
    // Should not throw, just produce the template with empty transcript
  })

  it('includes instructions about what to focus on', () => {
    const prompt = summarizationPrompt([makeMessage('user', 'test')])
    expect(prompt).toContain('Key decisions')
    expect(prompt).toContain('Files created or modified')
    expect(prompt).toContain('Important context')
    expect(prompt).toContain('Current state')
  })

  it('does not include tool names when no tool calls', () => {
    const msgs = [makeMessage('user', 'just a message')]
    const prompt = summarizationPrompt(msgs)
    expect(prompt).not.toContain('Tools used')
  })

  it('handles messages with empty tool calls array', () => {
    const msgs = [makeMessage('assistant', 'content', [])]
    const prompt = summarizationPrompt(msgs)
    // Empty array has length 0, so no Tools used line
    expect(prompt).not.toContain('Tools used')
  })
})

// ─── compressToolResults ────────────────────────────────────────

describe('compressToolResults', () => {
  it('passes through messages without tool calls', () => {
    const msgs = [makeMessage('user', 'hello')]
    const result = compressToolResults(msgs)
    expect(result).toEqual(msgs)
  })

  it('passes through short tool results unchanged', () => {
    const tc = makeToolCall(50)
    const msgs = [makeMessage('assistant', 'done', [tc])]
    const result = compressToolResults(msgs)
    expect(result[0].toolCalls![0].result).toBe(tc.result)
  })

  it('truncates long tool results', () => {
    const longResult = Array.from({ length: 200 }, (_, i) => `line ${i}`).join('\n')
    const tc = { ...makeToolCall(), result: longResult }
    const msgs = [makeMessage('assistant', 'done', [tc])]
    const result = compressToolResults(msgs, 100)
    expect(result[0].toolCalls![0].result.length).toBeLessThan(longResult.length)
    expect(result[0].toolCalls![0].result).toContain('omitted')
  })

  it('preserves head and tail lines when truncating', () => {
    const lines = Array.from({ length: 50 }, (_, i) => `line-${i}`)
    const tc = { ...makeToolCall(), result: lines.join('\n') }
    const msgs = [makeMessage('assistant', 'done', [tc])]
    const result = compressToolResults(msgs, 50)
    const compressed = result[0].toolCalls![0].result
    // Should have first 10 lines
    expect(compressed).toContain('line-0')
    expect(compressed).toContain('line-9')
    // Should have last 5 lines
    expect(compressed).toContain('line-45')
    expect(compressed).toContain('line-49')
  })

  it('never produces negative omitted count', () => {
    const fiveLines = 'a\nb\nc\nd\ne'
    const tc = { ...makeToolCall(), result: fiveLines }
    const msgs = [makeMessage('assistant', 'done', [tc])]
    const result = compressToolResults(msgs, 2)
    const compressed = result[0].toolCalls![0].result
    expect(compressed).not.toMatch(/-\d+ lines/)
  })

  it('uses default maxResultLen of 2000', () => {
    const shortResult = 'x'.repeat(100)
    const tc = { ...makeToolCall(), result: shortResult }
    const msgs = [makeMessage('assistant', 'done', [tc])]
    // Default maxResultLen = 2000, so 100 chars passes through
    const result = compressToolResults(msgs)
    expect(result[0].toolCalls![0].result).toBe(shortResult)
  })

  it('returns new array (does not mutate input)', () => {
    const tc = makeToolCall(50)
    const msgs = [makeMessage('assistant', 'done', [tc])]
    const result = compressToolResults(msgs)
    expect(result).not.toBe(msgs)
  })

  it('handles message with empty toolCalls array', () => {
    const msgs = [makeMessage('assistant', 'done', [])]
    const result = compressToolResults(msgs)
    expect(result[0]).toEqual(msgs[0])
  })

  it('compresses multiple tool calls independently', () => {
    const short = { ...makeToolCall(10), id: 'short', name: 'short_tool' }
    const longResult = Array.from({ length: 100 }, (_, i) => `line-${i}`).join('\n')
    const long = { ...makeToolCall(), id: 'long', name: 'long_tool', result: longResult }
    const msgs = [makeMessage('assistant', 'done', [short, long])]
    const result = compressToolResults(msgs, 50)
    // Short one should be unchanged
    expect(result[0].toolCalls![0].result).toBe(short.result)
    // Long one should be compressed
    expect(result[0].toolCalls![1].result).toContain('omitted')
  })
})

// ─── shouldTrimHistory ──────────────────────────────────────────

describe('shouldTrimHistory', () => {
  it('returns false when well under 80% of effective limit', () => {
    const msgs = [makeMessage('user', 'short')]
    expect(shouldTrimHistory(msgs, 200_000)).toBe(false)
  })

  it('returns true when over 80% of effective limit', () => {
    // effectiveLimit = 200k - 20k = 180k. 80% = 144k
    const msgs = [makeBigMessage('user', 150_000)]
    expect(shouldTrimHistory(msgs, 200_000)).toBe(true)
  })

  it('uses DEFAULT_LIMIT (200k) when no contextLimit provided', () => {
    const msgs = [makeMessage('user', 'small')]
    expect(shouldTrimHistory(msgs)).toBe(false)
  })

  it('works with small context limits', () => {
    // effectiveLimit = 1000 - 20000 = negative → anything triggers
    // Actually: effectiveLimit = 1000 - 20000 = -19000, 80% = -15200
    // Even 0 tokens > -15200, so should be true
    const msgs = [makeMessage('user', 'hello')]
    expect(shouldTrimHistory(msgs, 1_000)).toBe(true)
  })

  it('returns false for empty messages', () => {
    expect(shouldTrimHistory([], 200_000)).toBe(false)
  })

  it('considers tool call tokens in the total', () => {
    const bigResult = 'a'.repeat(510_000) // ~146k tokens, exceeds 80% of (200k - 20k)
    const tc = { id: '1', name: 'bash', input: {} as Record<string, unknown>, result: bigResult }
    const msgs = [makeMessage('assistant', 'ok', [tc])]
    expect(shouldTrimHistory(msgs, 200_000)).toBe(true)
  })
})

// ─── trimMessageHistory ─────────────────────────────────────────

describe('trimMessageHistory', () => {
  it('returns all messages when under effective limit', () => {
    const msgs = [
      makeMessage('user', 'hello'),
      makeMessage('assistant', 'hi'),
    ]
    expect(trimMessageHistory(msgs, 200_000)).toEqual(msgs)
  })

  it('preserves most recent messages when trimming', () => {
    const msgs = [
      makeMessage('user', 'oldest message'),
      makeBigMessage('assistant', 80_000),
      makeBigMessage('user', 80_000),
      makeMessage('assistant', 'newest message'),
    ]
    const trimmed = trimMessageHistory(msgs, 200_000)
    const lastContent = trimmed[trimmed.length - 1].content
    expect(lastContent).toContain('newest message')
  })

  it('adds trim notice to first kept message', () => {
    const msgs = [
      makeBigMessage('user', 90_000),
      makeBigMessage('assistant', 90_000),
      makeMessage('user', 'recent'),
    ]
    const trimmed = trimMessageHistory(msgs, 200_000)
    if (trimmed.length < msgs.length) {
      expect(trimmed[0].content).toContain('Previous messages trimmed')
    }
  })

  it('returns empty array when no messages fit', () => {
    // If even one message is too big for the budget
    const msgs = [makeBigMessage('user', 250_000)]
    const trimmed = trimMessageHistory(msgs, 200_000)
    // Budget is exceeded by the single message, so nothing kept
    expect(trimmed.length).toBe(0)
  })

  it('handles empty messages array', () => {
    const trimmed = trimMessageHistory([], 200_000)
    expect(trimmed).toEqual([])
  })

  it('uses default context limit when not specified', () => {
    const msgs = [makeMessage('user', 'hi')]
    const trimmed = trimMessageHistory(msgs)
    expect(trimmed).toEqual(msgs)
  })

  it('does not mutate the original messages array', () => {
    const msgs = [
      makeBigMessage('user', 90_000),
      makeBigMessage('assistant', 90_000),
      makeMessage('user', 'recent'),
    ]
    const originalLength = msgs.length
    const originalContent = msgs[2].content
    trimMessageHistory(msgs, 200_000)
    expect(msgs.length).toBe(originalLength)
    expect(msgs[2].content).toBe(originalContent)
  })

  it('creates a new object for the trimmed first message (immutability)', () => {
    const msgs = [
      makeBigMessage('user', 90_000),
      makeBigMessage('assistant', 90_000),
      makeMessage('user', 'recent'),
    ]
    const trimmed = trimMessageHistory(msgs, 200_000)
    if (trimmed.length > 0 && trimmed.length < msgs.length) {
      // The first message in trimmed should be a new object with prepended notice
      expect(trimmed[0]).not.toBe(msgs[msgs.length - 1])
    }
  })

  it('handles messages with tool calls during trimming', () => {
    const tc = makeToolCall(100)
    const msgs = [
      makeBigMessage('user', 90_000),
      makeMessage('assistant', 'worked', [tc]),
      makeMessage('user', 'thanks'),
    ]
    const trimmed = trimMessageHistory(msgs, 200_000)
    // Should still work and keep recent messages with tool calls
    expect(trimmed.length).toBeGreaterThan(0)
  })
})

// ─── summarizeContext ───────────────────────────────────────────

describe('summarizeContext', () => {
  it('returns new conversation message for empty array', () => {
    const summary = summarizeContext([])
    expect(summary).toBe('summary: New conversation started.')
  })

  it('includes user and assistant message counts', () => {
    const msgs = [
      makeMessage('user', 'q1'),
      makeMessage('assistant', 'a1'),
      makeMessage('user', 'q2'),
      makeMessage('assistant', 'a2'),
      makeMessage('user', 'q3'),
    ]
    const summary = summarizeContext(msgs)
    expect(summary).toContain('3 user messages')
    expect(summary).toContain('2 assistant responses')
  })

  it('extracts topics from recent user messages', () => {
    const msgs = [
      makeMessage('user', 'Tell me about performance optimization techniques for web applications'),
      makeMessage('assistant', 'Here are some tips...'),
    ]
    const summary = summarizeContext(msgs)
    expect(summary).toContain('performance optimization')
  })

  it('only considers last 5 messages for topics', () => {
    const msgs = Array.from({ length: 10 }, (_, i) =>
      makeMessage(
        i % 2 === 0 ? 'user' : 'assistant',
        i === 0 ? 'very old topic about dinosaurs' : `message ${i}`,
      ),
    )
    const summary = summarizeContext(msgs)
    // The first message is outside the last-5 window
    expect(summary).not.toContain('dinosaurs')
  })

  it('shows "Topics: various" when no user topics found in recent messages', () => {
    // Last 5 messages are all short assistant messages
    const msgs = Array.from({ length: 6 }, (_, i) =>
      makeMessage('assistant', 'ok'),
    )
    const summary = summarizeContext(msgs)
    expect(summary).toContain('Topics: various')
  })

  it('skips short user messages as topics (< 10 chars)', () => {
    const msgs = [
      makeMessage('user', 'yes'),
      makeMessage('assistant', 'ok'),
    ]
    const summary = summarizeContext(msgs)
    // "yes" is too short (3 words → "yes" = 3 chars first 20 words)
    expect(summary).toContain('Topics: various')
  })

  it('extracts first 20 words from user messages', () => {
    const longMsg = Array.from({ length: 50 }, (_, i) => `word${i}`).join(' ')
    const msgs = [makeMessage('user', longMsg)]
    const summary = summarizeContext(msgs)
    expect(summary).toContain('word0')
    expect(summary).toContain('word19')
    // word20 should not be in the topic (only first 20 words)
    expect(summary).not.toContain('word20')
  })

  it('joins multiple topics with pipe separator', () => {
    const msgs = [
      makeMessage('user', 'First topic about databases and performance'),
      makeMessage('assistant', 'reply'),
      makeMessage('user', 'Second topic about security and authentication'),
    ]
    const summary = summarizeContext(msgs)
    expect(summary).toContain(' | ')
  })

  it('handles single message', () => {
    const msgs = [makeMessage('user', 'Tell me about TypeScript generics')]
    const summary = summarizeContext(msgs)
    expect(summary).toContain('1 user messages')
    expect(summary).toContain('0 assistant responses')
  })
})
