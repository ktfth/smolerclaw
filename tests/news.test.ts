import { describe, test, expect } from 'bun:test'
import { getNewsCategories } from '../src/news'

describe('news', () => {
  test('getNewsCategories returns category list', () => {
    const result = getNewsCategories()
    expect(result).toContain('business')
    expect(result).toContain('tech')
    expect(result).toContain('finance')
    expect(result).toContain('brazil')
    expect(result).toContain('world')
  })
})
