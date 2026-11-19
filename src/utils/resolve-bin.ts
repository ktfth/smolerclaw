import { existsSync } from 'node:fs'
import { extname, join } from 'node:path'

/** This package's own node_modules/.bin, independent of the process cwd. */
const PACKAGE_BIN_DIR = join(import.meta.dir, '..', '..', 'node_modules', '.bin')

/**
 * Windows batch shims run through cmd.exe, which re-parses arguments:
 * a value such as `a" & calc & rem` executes commands (BatBadBut).
 */
const BATCH_EXTENSIONS: ReadonlySet<string> = new Set(['.cmd', '.bat'])

export function isBatchShim(path: string): boolean {
  return BATCH_EXTENSIONS.has(extname(path).toLowerCase())
}

/**
 * Resolve a CLI binary that can be spawned with untrusted arguments.
 * Prefers this package's node_modules/.bin (Bun's .exe shims call the
 * target directly), then PATH. Never returns a .cmd/.bat shim.
 */
export function resolveCliBinary(name: string, binDir: string = PACKAGE_BIN_DIR): string | null {
  const candidates = process.platform === 'win32' ? [`${name}.exe`] : [name]
  for (const file of candidates) {
    const path = join(binDir, file)
    if (existsSync(path)) return path
  }
  const onPath = Bun.which(name)
  if (onPath && !isBatchShim(onPath)) return onPath
  return null
}
