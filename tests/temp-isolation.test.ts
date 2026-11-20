import { describe, test, expect } from 'bun:test'
import { tmpdir } from 'node:os'
import { basename, dirname } from 'node:path'

describe('test temp isolation', () => {
  test('tmpdir points at a per-run folder that the preload removes', () => {
    expect(basename(tmpdir())).toMatch(/^smolerclaw-test-run-/)
    expect(process.env.SMOLERCLAW_TEST_REAL_TMP).toBe(dirname(tmpdir()))
  })
})
