import { describe, test, expect } from 'bun:test'
import { estimateTokens, estimateMessageTokens, compressToolResults } from '../src/context-window'
import type { Message } from '../src/types'

describe('estimateTokens', () => {
  test('estimates roughly 1 token per 3.5 chars', () => {
    const tokens = estimateTokens('Hello, world!')
    expect(tokens).toBeGreaterThan(2)
    expect(tokens).toBeLessThan(10)
  })

  test('empty string is 0 tokens', () => {
    expect(estimateTokens('')).toBe(0)
  })
})

describe('estimateMessageTokens', () => {
  test('counts tokens across messages', () => {
    const msgs: Message[] = [
      { role: 'user', content: 'Hello', timestamp: 0 },
      { role: 'assistant', content: 'Hi there, how can I help?', timestamp: 0 },
    ]
    const tokens = estimateMessageTokens(msgs)
    expect(tokens).toBeGreaterThan(10)
  })

  test('includes tool call tokens', () => {
    const withTools: Message[] = [{
      role: 'assistant',
      content: 'Let me check.',
      toolCalls: [{ id: '1', name: 'read_file', input: { path: 'foo.ts' }, result: 'file contents here' }],
      timestamp: 0,
    }]
    const withoutTools: Message[] = [{
      role: 'assistant',
      content: 'Let me check.',
      timestamp: 0,
    }]
    expect(estimateMessageTokens(withTools)).toBeGreaterThan(estimateMessageTokens(withoutTools))
  })
})

describe('compressToolResults', () => {
  test('short results pass through unchanged', () => {
    const msgs: Message[] = [{
      role: 'assistant',
      content: 'done',
      toolCalls: [{ id: '1', name: 'read_file', input: { path: 'x' }, result: 'short' }],
      timestamp: 0,
    }]
    const compressed = compressToolResults(msgs)
    expect(compressed[0].toolCalls![0].result).toBe('short')
  })

  test('long results are truncated without negative count', () => {
    const longResult = Array.from({ length: 100 }, (_, i) => `line ${i}`).join('\n')
    const msgs: Message[] = [{
      role: 'assistant',
      content: 'done',
      toolCalls: [{ id: '1', name: 'read_file', input: { path: 'x' }, result: longResult }],
      timestamp: 0,
    }]
    const compressed = compressToolResults(msgs, 50)
    const result = compressed[0].toolCalls![0].result
    expect(result).toContain('omitted')
    // Should never contain negative count
    expect(result).not.toMatch(/\(-\d+ lines omitted\)/)
  })

  test('results with few lines do not produce negative omitted count', () => {
    const fiveLines = 'a\nb\nc\nd\ne'
    const msgs: Message[] = [{
      role: 'assistant',
      content: 'done',
      toolCalls: [{ id: '1', name: 'read_file', input: { path: 'x' }, result: fiveLines }],
      timestamp: 0,
    }]
    // Force compression with very low maxResultLen
    const compressed = compressToolResults(msgs, 2)
    const result = compressed[0].toolCalls![0].result
    expect(result).not.toMatch(/-\d+ lines/)
  })
})
