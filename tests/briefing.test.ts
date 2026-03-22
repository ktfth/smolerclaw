import { describe, test, expect } from 'bun:test'
import { generateBriefing } from '../src/briefing'

describe('briefing', () => {
  test('generateBriefing returns structured output', async () => {
    const result = await generateBriefing()
    expect(result).toContain('BRIEFING DIARIO')
    expect(result).toContain('Semana')
  }, 30_000) // network timeout for news
})
