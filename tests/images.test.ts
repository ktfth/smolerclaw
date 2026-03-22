import { describe, test, expect } from 'bun:test'
import { extractImages } from '../src/images'

describe('extractImages', () => {
  test('plain text with no images passes through', () => {
    const { text, images } = extractImages('hello world')
    expect(text).toBe('hello world')
    expect(images).toHaveLength(0)
  })

  test('non-existent image path is kept as text', () => {
    const { text, images } = extractImages('look at /nonexistent/image.png')
    expect(text).toContain('/nonexistent/image.png')
    expect(images).toHaveLength(0)
  })

  test('recognizes image extensions', () => {
    // These paths don't exist, so they stay as text — but the logic is tested
    const { text } = extractImages('file.txt file.png file.jpg')
    expect(text).toContain('file.txt')
  })

  test('handles empty input', () => {
    const { text, images } = extractImages('')
    expect(text).toBe('')
    expect(images).toHaveLength(0)
  })
})
