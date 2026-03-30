import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { writeFileSync, unlinkSync, mkdirSync } from 'node:fs'
import { join, basename } from 'node:path'
import { gatherContext } from '../src/context'

describe('context', () => {
  let testDir: string
  const originalCwd = process.cwd()

  beforeEach(() => {
    testDir = join(process.cwd(), `.test-context-${Date.now()}`)
    try { mkdirSync(testDir, { recursive: true }) } catch { /* dir exists */ }
  })

  afterEach(() => {
    try {
      const files = [
        join(testDir, 'package.json'),
        join(testDir, '.git', 'HEAD'),
        join(testDir, '.git'),
        testDir,
      ]
      for (const f of files) {
        try { unlinkSync(f) } catch { /* ignore */ }
      }
    } catch { /* ignore */ }
  })

  it('gatherContext includes working directory', () => {
    const ctx = gatherContext()
    expect(ctx).toContain('Working directory:')
    expect(ctx).toContain(originalCwd)
  })

  it('gatherContext includes platform info', () => {
    const ctx = gatherContext()
    expect(ctx).toContain('Platform:')
    expect(ctx).toContain(process.platform)
  })

  it('gatherContext includes shell info', () => {
    const ctx = gatherContext()
    expect(ctx).toContain('Shell:')
  })

  it('gatherContext includes Bun version', () => {
    const ctx = gatherContext()
    expect(ctx).toContain('Runtime: Bun')
  })

  it('gatherContext includes date', () => {
    const ctx = gatherContext()
    expect(ctx).toContain('Date:')
    const dateMatch = ctx.match(/Date: (\d{4}-\d{2}-\d{2})/)
    expect(dateMatch).toBeTruthy()
  })

  it('gatherContext detects Node.js projects', () => {
    const pkg = join(testDir, 'package.json')
    writeFileSync(pkg, JSON.stringify({ name: 'test-project' }))
    process.chdir(testDir)
    try {
      const ctx = gatherContext()
      expect(ctx).toContain('Project:')
      expect(ctx).toContain('test-project')
      expect(ctx).toContain('Node.js/JavaScript')
    } finally {
      process.chdir(originalCwd)
    }
  })

  it('gatherContext detects multi-tech projects', () => {
    writeFileSync(join(testDir, 'package.json'), '{}')
    writeFileSync(join(testDir, 'Cargo.toml'), '')
    process.chdir(testDir)
    try {
      const ctx = gatherContext()
      expect(ctx).toContain('Node.js/JavaScript')
      expect(ctx).toContain('Rust')
    } finally {
      process.chdir(originalCwd)
    }
  })

  it('gatherContext uses directory name when package.json has no name', () => {
    writeFileSync(join(testDir, 'package.json'), '{}')
    process.chdir(testDir)
    try {
      const ctx = gatherContext()
      expect(ctx).toContain(`Project: ${basename(testDir)}`)
    } finally {
      process.chdir(originalCwd)
    }
  })

  it('gatherContext ignores missing package.json gracefully', () => {
    const emptyDir = join(testDir, 'empty')
    mkdirSync(emptyDir)
    process.chdir(emptyDir)
    try {
      const ctx = gatherContext()
      expect(ctx).not.toContain('Project:')
    } finally {
      process.chdir(originalCwd)
    }
  })

  it('gatherContext includes Windows syntax note on Windows', () => {
    const ctx = gatherContext()
    if (process.platform === 'win32') {
      expect(ctx).toContain('PowerShell syntax')
      expect(ctx).toContain('Get-ChildItem')
    }
  })
})
