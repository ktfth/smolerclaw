import { describe, test, expect } from 'bun:test'
import { openApp, openFile, openUrl } from '../src/windows'

describe('windows security', () => {
  test('openApp rejects injection in argument', async () => {
    const result = await openApp('notepad', '" ; Remove-Item C:\\important')
    expect(result).toContain('invalid characters')
  })

  test('openApp rejects argument with $', async () => {
    const result = await openApp('notepad', '$env:USERNAME')
    expect(result).toContain('invalid characters')
  })

  test('openApp rejects argument with backtick', async () => {
    const result = await openApp('notepad', 'file`name')
    expect(result).toContain('invalid characters')
  })

  test('openApp rejects argument with semicolon', async () => {
    const result = await openApp('notepad', 'file; rm -rf /')
    expect(result).toContain('invalid characters')
  })

  test('openApp rejects argument with pipe', async () => {
    const result = await openApp('notepad', 'file | echo bad')
    expect(result).toContain('invalid characters')
  })

  test('openApp rejects overly long argument', async () => {
    const result = await openApp('notepad', 'a'.repeat(501))
    expect(result).toContain('too long')
  })

  test('openFile rejects injection in path', async () => {
    const result = await openFile('" ; whoami')
    expect(result).toContain('invalid characters')
  })

  test('openUrl rejects non-HTTP URL', async () => {
    const result = await openUrl('javascript:alert(1)')
    expect(result).toContain('must start with http')
  })

  test('openUrl rejects URL with shell chars', async () => {
    const result = await openUrl('https://example.com" ; calc')
    expect(result).toContain('invalid characters')
  })

  test('openApp rejects unknown app name', async () => {
    const result = await openApp('nonexistent')
    expect(result).toContain('Unknown app')
  })

  test('openApp rejects newline in argument', async () => {
    const result = await openApp('notepad', 'file\nname')
    expect(result).toContain('invalid characters')
  })
})
