export interface TokenUsage {
  inputTokens: number
  outputTokens: number
}

export interface CostEstimate {
  inputCostCents: number
  outputCostCents: number
  totalCostCents: number
}

// Pricing per 1M tokens in USD (as of 2025)
const PRICING: Record<string, { input: number; output: number }> = {
  'claude-haiku-4-5-20251001': { input: 1.00, output: 5.00 },
  'claude-sonnet-4-20250514':  { input: 3.00, output: 15.00 },
  'claude-sonnet-4-6-20250627': { input: 3.00, output: 15.00 },
  'claude-opus-4-20250514':    { input: 15.00, output: 75.00 },
  'claude-opus-4-6-20250318':  { input: 15.00, output: 75.00 },
  'codex:codex-mini-latest':   { input: 1.50, output: 6.00 },
}

// Fallback for unknown models (conservative estimate)
const DEFAULT_PRICING = { input: 3.00, output: 15.00 }

/**
 * Estimate cost for a given token usage and model.
 */
export function estimateCost(usage: TokenUsage, model: string): CostEstimate {
  const pricing = findPricing(model)
  const inputCostCents = (usage.inputTokens / 1_000_000) * pricing.input * 100
  const outputCostCents = (usage.outputTokens / 1_000_000) * pricing.output * 100
  return {
    inputCostCents,
    outputCostCents,
    totalCostCents: inputCostCents + outputCostCents,
  }
}

function findPricing(model: string): { input: number; output: number } {
  // Exact match
  if (PRICING[model]) return PRICING[model]

  // Pattern match (e.g., "claude-haiku" matches "claude-haiku-4-5-*")
  const lower = model.toLowerCase()
  if (lower.includes('haiku')) return PRICING['claude-haiku-4-5-20251001']
  if (lower.includes('opus')) return PRICING['claude-opus-4-20250514']
  if (lower.includes('sonnet')) return PRICING['claude-sonnet-4-20250514']
  if (lower.includes('codex-mini')) return PRICING['codex:codex-mini-latest']

  return DEFAULT_PRICING
}

/**
 * Tracks cumulative token usage across a session.
 */
export class TokenTracker {
  private totalInput = 0
  private totalOutput = 0
  private totalCostCents = 0
  private model: string

  constructor(model: string) {
    this.model = model
  }

  setModel(model: string): void {
    this.model = model
  }

  add(usage: TokenUsage): CostEstimate {
    this.totalInput += usage.inputTokens
    this.totalOutput += usage.outputTokens
    const cost = estimateCost(usage, this.model)
    this.totalCostCents += cost.totalCostCents
    return cost
  }

  get totals(): { inputTokens: number; outputTokens: number; costCents: number } {
    return {
      inputTokens: this.totalInput,
      outputTokens: this.totalOutput,
      costCents: this.totalCostCents,
    }
  }

  /**
   * Format a single response's usage for display.
   */
  formatUsage(usage: TokenUsage): string {
    const cost = estimateCost(usage, this.model)
    return `${fmt(usage.inputTokens)} in / ${fmt(usage.outputTokens)} out (~$${(cost.totalCostCents / 100).toFixed(4)})`
  }

  /**
   * Format cumulative session usage.
   */
  formatSession(): string {
    return `${fmt(this.totalInput)} in / ${fmt(this.totalOutput)} out | session: ~$${(this.totalCostCents / 100).toFixed(4)}`
  }
}

function fmt(n: number): string {
  return n.toLocaleString('en-US')
}
