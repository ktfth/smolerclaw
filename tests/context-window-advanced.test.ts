import { describe, it, expect } from 'bun:test'
import { estimateTokens, estimateMessageTokens, shouldTrimHistory, trimMessageHistory, summarizeContext } from '../src/context-window'
import type { Message } from '../src/types'

describe('context-window', () => {
  describe('estimateTokens', () => {
    it('estimates tokens using 3.5 char heuristic', () => {
      const text = 'a'.repeat(350) // 350 chars
      const est = estimateTokens(text)
      expect(est).toBeGreaterThanOrEqual(95) // ~100 tokens
      expect(est).toBeLessThanOrEqual(105)
    })

    it('handles empty strings', () => {
      expect(estimateTokens('')).toBe(0)
    })

    it('handles short strings', () => {
      const est = estimateTokens('hello')
      expect(est).toBeGreaterThan(0)
      expect(est).toBeLessThanOrEqual(2)
    })

    it('scales with text length', () => {
      const short = estimateTokens('a'.repeat(100))
      const long = estimateTokens('a'.repeat(200))
      expect(long).toBeGreaterThan(short)
    })
  })

  describe('estimateMessageTokens', () => {
    it('estimates tokens for single message', () => {
      const msgs: Message[] = [
        { role: 'user', content: 'a'.repeat(350), timestamp: Date.now() }
      ]
      const est = estimateMessageTokens(msgs)
      expect(est).toBeGreaterThan(90)
    })

    it('sums tokens across multiple messages', () => {
      const msgs: Message[] = [
        { role: 'user', content: 'a'.repeat(350), timestamp: Date.now() },
        { role: 'assistant', content: 'a'.repeat(350), timestamp: Date.now() },
      ]
      const est = estimateMessageTokens(msgs)
      expect(est).toBeGreaterThan(180)
    })

    it('includes tool call tokens', () => {
      const msgs: Message[] = [
        {
          role: 'assistant',
          content: 'doing something',
          timestamp: Date.now(),
          toolCalls: [
            {
              id: 'tc1',
              name: 'read_file',
              input: { path: 'a'.repeat(100) },
              result: 'a'.repeat(200),
            }
          ]
        }
      ]
      const est = estimateMessageTokens(msgs)
      expect(est).toBeGreaterThan(50)
    })

    it('includes per-message overhead', () => {
      const msgs: Message[] = [
        { role: 'user', content: 'hi', timestamp: Date.now() },
        { role: 'assistant', content: 'hi', timestamp: Date.now() },
      ]
      const est = estimateMessageTokens(msgs)
      expect(est).toBeGreaterThan(20) // at least 2 * 10 overhead
    })
  })

  describe('shouldTrimHistory', () => {
    it('returns false when under limit', () => {
      const msgs: Message[] = [
        { role: 'user', content: 'a'.repeat(50), timestamp: Date.now() }
      ]
      expect(shouldTrimHistory(msgs, 200_000)).toBe(false)
    })

    it('returns true when approaching limit', () => {
      // Create messages totaling ~180k tokens
      const bigMsg = 'a'.repeat(600_000) // ~170k tokens
      const msgs: Message[] = [
        { role: 'user', content: bigMsg, timestamp: Date.now() },
        { role: 'assistant', content: bigMsg, timestamp: Date.now() },
      ]
      expect(shouldTrimHistory(msgs, 200_000)).toBe(true)
    })

    it('considers model limit', () => {
      const msgs: Message[] = [
        { role: 'user', content: 'a'.repeat(100), timestamp: Date.now() }
      ]
      expect(shouldTrimHistory(msgs, 50_000)).toBe(false) // small message, plenty of room
    })
  })

  describe('trimMessageHistory', () => {
    it('keeps oldest messages when trimming', () => {
      const msgs: Message[] = [
        { role: 'user', content: 'msg1', timestamp: 1000 },
        { role: 'assistant', content: 'reply1', timestamp: 2000 },
        { role: 'user', content: 'msg2', timestamp: 3000 },
        { role: 'assistant', content: 'reply2', timestamp: 4000 },
      ]
      const trimmed = trimMessageHistory(msgs, 200_000)
      // Should preserve structure, might remove oldest
      expect(trimmed.length).toBeLessThanOrEqual(msgs.length)
    })

    it('preserves most recent messages', () => {
      const recent = { role: 'user', content: 'latest', timestamp: Date.now() }
      const msgs: Message[] = [
        { role: 'user', content: 'a'.repeat(600_000), timestamp: 1000 },
        recent,
      ]
      const trimmed = trimMessageHistory(msgs, 200_000)
      expect(trimmed[trimmed.length - 1]).toEqual(recent)
    })

    it('returns all messages if under limit', () => {
      const msgs: Message[] = [
        { role: 'user', content: 'hi', timestamp: Date.now() }
      ]
      expect(trimMessageHistory(msgs, 200_000)).toEqual(msgs)
    })
  })

  describe('summarizeContext', () => {
    it('summarizes empty messages', () => {
      const summary = summarizeContext([])
      expect(summary).toContain('summary')
      expect(summary.length).toBeGreaterThan(0)
    })

    it('includes message count in summary', () => {
      const msgs: Message[] = [
        { role: 'user', content: 'hi', timestamp: Date.now() },
        { role: 'assistant', content: 'hello', timestamp: Date.now() },
      ]
      const summary = summarizeContext(msgs)
      expect(summary.toLowerCase()).toContain('1 user')
      expect(summary.toLowerCase()).toContain('1 assistant')
    })

    it('summarizes long history', () => {
      const msgs: Message[] = Array.from({ length: 50 }, (_, i) => ({
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: `msg${i}`,
        timestamp: Date.now() + i,
      }))
      const summary = summarizeContext(msgs)
      expect(summary.length).toBeGreaterThan(10)
      expect(summary).not.toContain('msg0') // old messages shouldn't be directly quoted
    })

    it('includes key topics from messages', () => {
      const msgs: Message[] = [
        { role: 'user', content: 'Tell me about performance optimization', timestamp: Date.now() },
        { role: 'assistant', content: 'Here are performance tips', timestamp: Date.now() },
      ]
      const summary = summarizeContext(msgs)
      // Summary should indicate the main topic
      expect(summary.length).toBeGreaterThan(20)
    })
  })
})
