import { describe, test, expect } from 'bun:test'
import { needsApproval, formatApprovalPrompt } from '../src/approval'

describe('needsApproval', () => {
  test('auto mode never needs approval', () => {
    expect(needsApproval('auto', 'write_file', 'moderate')).toBe(false)
    expect(needsApproval('auto', 'run_command', 'moderate')).toBe(false)
  })

  test('confirm-writes approves read tools', () => {
    expect(needsApproval('confirm-writes', 'read_file', 'safe')).toBe(false)
    expect(needsApproval('confirm-writes', 'search_files', 'safe')).toBe(false)
    expect(needsApproval('confirm-writes', 'list_directory', 'safe')).toBe(false)
  })

  test('confirm-writes requires approval for writes', () => {
    expect(needsApproval('confirm-writes', 'write_file', 'moderate')).toBe(true)
    expect(needsApproval('confirm-writes', 'edit_file', 'moderate')).toBe(true)
    expect(needsApproval('confirm-writes', 'run_command', 'moderate')).toBe(true)
  })

  test('confirm-all requires approval for all non-safe', () => {
    expect(needsApproval('confirm-all', 'write_file', 'moderate')).toBe(true)
    expect(needsApproval('confirm-all', 'fetch_url', 'safe')).toBe(false)
  })
})

describe('formatApprovalPrompt', () => {
  test('formats write_file', () => {
    expect(formatApprovalPrompt('write_file', { path: 'src/foo.ts' })).toContain('src/foo.ts')
  })

  test('formats run_command', () => {
    expect(formatApprovalPrompt('run_command', { command: 'npm test' })).toContain('npm test')
  })

  test('truncates long commands', () => {
    const long = 'a'.repeat(100)
    const result = formatApprovalPrompt('run_command', { command: long })
    expect(result.length).toBeLessThan(80)
    expect(result).toContain('...')
  })
})
