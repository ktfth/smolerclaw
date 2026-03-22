import { describe, test, expect } from 'bun:test'
import { stripAnsi, visibleLength, charWidth, displayWidth } from '../src/ansi'

describe('stripAnsi', () => {
  test('strips ANSI escape codes', () => {
    expect(stripAnsi('\x1b[1mBold\x1b[0m')).toBe('Bold')
    expect(stripAnsi('\x1b[38;5;75mColored\x1b[0m')).toBe('Colored')
  })

  test('passes plain text through', () => {
    expect(stripAnsi('Hello world')).toBe('Hello world')
  })
})

describe('charWidth', () => {
  test('ASCII is width 1', () => {
    expect(charWidth('a')).toBe(1)
    expect(charWidth(' ')).toBe(1)
    expect(charWidth('Z')).toBe(1)
  })

  test('CJK characters are width 2', () => {
    expect(charWidth('\u4e2d')).toBe(2) // 中
    expect(charWidth('\u65e5')).toBe(2) // 日
  })

  test('fullwidth characters are width 2', () => {
    expect(charWidth('\uff01')).toBe(2) // ！
  })
})

describe('visibleLength', () => {
  test('ASCII string', () => {
    expect(visibleLength('Hello')).toBe(5)
  })

  test('ANSI codes do not count', () => {
    expect(visibleLength('\x1b[1mBold\x1b[0m')).toBe(4)
  })

  test('CJK characters count as 2', () => {
    expect(visibleLength('\u4e2d\u6587')).toBe(4) // 中文 = 4 columns
  })
})

describe('displayWidth', () => {
  test('counts width of first N chars', () => {
    expect(displayWidth('Hello', 3)).toBe(3)
  })

  test('handles CJK', () => {
    expect(displayWidth('\u4e2d\u6587abc', 2)).toBe(4) // 2 CJK chars = 4 cols
  })

  test('handles mixed', () => {
    expect(displayWidth('a\u4e2db', 2)).toBe(3) // 'a' + '中' = 1 + 2 = 3
  })
})
