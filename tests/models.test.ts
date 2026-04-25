import { describe, test, expect } from 'bun:test'
import { resolveModel, modelDisplayName, defaultModelForProvider } from '../src/models'

describe('resolveModel', () => {
  test('resolves aliases', () => {
    expect(resolveModel('haiku')).toBe('claude-haiku-4-5-20251001')
    expect(resolveModel('sonnet')).toBe('claude-sonnet-4-20250514')
    expect(resolveModel('opus')).toBe('claude-opus-4-20250514')
    expect(resolveModel('codex')).toBe('codex:gpt-5.4')
  })

  test('passes through exact model IDs', () => {
    expect(resolveModel('claude-haiku-4-5-20251001')).toBe('claude-haiku-4-5-20251001')
  })

  test('passes through unknown models', () => {
    expect(resolveModel('gpt-4o')).toBe('gpt-4o')
    expect(resolveModel('custom-fine-tuned-v1')).toBe('custom-fine-tuned-v1')
  })

  test('is case-insensitive for aliases', () => {
    expect(resolveModel('Haiku')).toBe('claude-haiku-4-5-20251001')
    expect(resolveModel('SONNET')).toBe('claude-sonnet-4-20250514')
  })
})

describe('modelDisplayName', () => {
  test('returns friendly name for known models', () => {
    expect(modelDisplayName('claude-haiku-4-5-20251001')).toContain('Haiku')
    expect(modelDisplayName('codex:gpt-5.4')).toContain('Codex')
  })

  test('returns ID for unknown models', () => {
    expect(modelDisplayName('gpt-4o')).toBe('gpt-4o')
  })
})

describe('defaultModelForProvider', () => {
  test('returns the expected defaults', () => {
    expect(defaultModelForProvider('anthropic')).toBe('claude-sonnet-4-20250514')
    expect(defaultModelForProvider('codex')).toBe('codex:gpt-5.4')
    expect(defaultModelForProvider('openai')).toBe('openai:gpt-5.4')
    expect(defaultModelForProvider('ollama')).toBe('ollama:llama3')
  })
})
