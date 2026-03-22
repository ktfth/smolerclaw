import { describe, test, expect } from 'bun:test'
import { resolve, sep } from 'node:path'

// Inline the guardPath logic for testing (can't import private function)
function guardPath(filePath: string): string | null {
  const resolved = resolve(filePath)
  const cwd = process.cwd()
  if (resolved !== cwd && !resolved.startsWith(cwd + sep)) {
    return `Error: path outside working directory is not permitted: ${resolved}`
  }
  return null
}

describe('guardPath', () => {
  test('allows paths within cwd', () => {
    expect(guardPath('src/index.ts')).toBeNull()
    expect(guardPath('./package.json')).toBeNull()
    expect(guardPath('tests/foo.test.ts')).toBeNull()
  })

  test('allows cwd itself', () => {
    expect(guardPath('.')).toBeNull()
  })

  test('blocks paths outside cwd', () => {
    expect(guardPath('/etc/passwd')).not.toBeNull()
    expect(guardPath('../../.ssh/id_rsa')).not.toBeNull()
    expect(guardPath('../../../etc/shadow')).not.toBeNull()
  })

  test('blocks home directory paths', () => {
    const home = process.env.HOME || process.env.USERPROFILE || ''
    if (home) {
      expect(guardPath(home + '/.ssh/id_rsa')).not.toBeNull()
    }
  })
})
