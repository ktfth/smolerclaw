/**
 * Test preload: every suite's tmpdir() lands in one folder per run, removed
 * on exit, so mkdtemp(tmpdir()) in tests never piles up in the real %TEMP%.
 * Runs left behind (a crash, a file still locked at exit) are swept on the
 * next start once they are an hour old.
 */
import { afterAll } from 'bun:test'
import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { closeStore } from '../src/core/store'

const PREFIX = 'smolerclaw-test-run-'
const STALE_MS = 60 * 60_000

const realTmp = process.env.SMOLERCLAW_TEST_REAL_TMP ?? tmpdir()

function sweepStaleRuns(): void {
  const now = Date.now()
  for (const name of readdirSync(realTmp)) {
    if (!name.startsWith(PREFIX)) continue
    const dir = join(realTmp, name)
    try {
      if (now - statSync(dir).mtimeMs > STALE_MS) rmSync(dir, { recursive: true, force: true })
    } catch {
      // Still locked by another run: try again next time.
    }
  }
}

sweepStaleRuns()
const runDir = mkdtempSync(join(realTmp, PREFIX))
process.env.SMOLERCLAW_TEST_REAL_TMP = realTmp
for (const key of ['TEMP', 'TMP', 'TMPDIR']) process.env[key] = runDir

// A preload hook runs once, after every test file (process exit hooks do not fire under bun test).
afterAll(() => {
  // Windows cannot delete a database file that is still open.
  closeStore()
  removeBestEffort(runDir)
})

/** Remove each entry on its own, so one locked file does not keep everything else. */
function removeBestEffort(dir: string): void {
  for (const name of readdirSync(dir)) {
    try {
      rmSync(join(dir, name), { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
    } catch {
      // Still open in this process; the next run sweeps it.
    }
  }
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    // Not empty yet: swept by a later run.
  }
}
