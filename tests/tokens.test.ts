import { describe, test, expect } from 'bun:test'
import { estimateCost, TokenTracker } from '../src/tokens'

describe('estimateCost', () => {
  test('haiku pricing', () => {
    const cost = estimateCost({ inputTokens: 1_000_000, outputTokens: 1_000_000 }, 'claude-haiku-4-5-20251001')
    expect(cost.inputCostCents).toBeCloseTo(100, 0) // $1.00
    expect(cost.outputCostCents).toBeCloseTo(500, 0) // $5.00
  })

  test('sonnet pricing', () => {
    const cost = estimateCost({ inputTokens: 1_000_000, outputTokens: 1_000_000 }, 'claude-sonnet-4-20250514')
    expect(cost.inputCostCents).toBeCloseTo(300, 0) // $3.00
    expect(cost.outputCostCents).toBeCloseTo(1500, 0) // $15.00
  })

  test('pattern matching for unknown model IDs', () => {
    const cost = estimateCost({ inputTokens: 1_000_000, outputTokens: 0 }, 'claude-haiku-future-version')
    expect(cost.inputCostCents).toBeCloseTo(100, 0) // matches haiku pattern
  })

  test('fallback pricing for completely unknown model', () => {
    const cost = estimateCost({ inputTokens: 1_000_000, outputTokens: 0 }, 'gpt-5-ultra')
    expect(cost.inputCostCents).toBeCloseTo(300, 0) // defaults to sonnet-level
  })
})

describe('TokenTracker', () => {
  test('accumulates usage across calls', () => {
    const tracker = new TokenTracker('claude-haiku-4-5-20251001')
    tracker.add({ inputTokens: 100, outputTokens: 50 })
    tracker.add({ inputTokens: 200, outputTokens: 100 })
    expect(tracker.totals.inputTokens).toBe(300)
    expect(tracker.totals.outputTokens).toBe(150)
  })

  test('formatUsage returns readable string', () => {
    const tracker = new TokenTracker('claude-haiku-4-5-20251001')
    const result = tracker.formatUsage({ inputTokens: 1000, outputTokens: 500 })
    expect(result).toContain('1,000')
    expect(result).toContain('500')
    expect(result).toContain('$')
  })
})
