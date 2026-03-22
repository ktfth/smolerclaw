import { describe, test, expect } from 'bun:test'
import { resolveModel, modelDisplayName } from '../src/models'

describe('resolveModel', () => {
  test('resolves aliases', () => {
    expect(resolveModel('haiku')).toBe('claude-haiku-4-5-20251001')
    expect(resolveModel('sonnet')).toBe('claude-sonnet-4-20250514')
    expect(resolveModel('opus')).toBe('claude-opus-4-20250514')
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
  })

  test('returns ID for unknown models', () => {
    expect(modelDisplayName('gpt-4o')).toBe('gpt-4o')
  })
})
