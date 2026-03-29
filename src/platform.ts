/**
 * Platform detection and cross-platform utilities.
 *
 * REFACTORED: commandExists now uses windows-executor for PowerShell calls.
 */

import { existsSync } from 'node:fs'
import { checkExecutable, executeCommand } from './utils/windows-executor'

export const IS_WINDOWS = process.platform === 'win32'
export const IS_MAC = process.platform === 'darwin'
export const IS_LINUX = process.platform === 'linux'

/**
 * Returns the shell command prefix for spawning subprocesses.
 * Windows: powershell, Unix: bash with sh fallback.
 */
export function getShell(): [string, ...string[]] {
  if (IS_WINDOWS) {
    return ['powershell', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command']
  }

  // Prefer user's SHELL, then bash, then sh
  const userShell = process.env.SHELL
  if (userShell && existsSync(userShell)) {
    return [userShell, '-c']
  }

  return ['bash', '-c']
}

/**
 * Returns a human-readable shell name for the system prompt.
 */
export function getShellName(): string {
  if (IS_WINDOWS) return 'powershell'
  const shell = process.env.SHELL || '/bin/bash'
  const name = shell.split('/').pop() || 'bash'
  return name
}

/**
 * Check if a command is available on the system.
 */
export async function commandExists(cmd: string): Promise<boolean> {
  if (IS_WINDOWS) {
    const result = await checkExecutable(cmd)
    return result.exists
  }

  // Unix: use 'which'
  try {
    const result = await executeCommand(['which', cmd], { timeout: 5_000 })
    return result.exitCode === 0
  } catch {
    return false
  }
}

// Cache ripgrep availability at startup
let _hasRg: boolean | null = null

export async function hasRipgrep(): Promise<boolean> {
  if (_hasRg !== null) return _hasRg
  _hasRg = await commandExists('rg')
  return _hasRg
}

/**
 * Directories to exclude from file searches.
 */
export const SEARCH_EXCLUDES = [
  'node_modules',
  '.git',
  'dist',
  'build',
  '.next',
  '__pycache__',
  '.venv',
  'target',
  '.cache',
]

/**
 * Check if a path should be excluded from search results.
 */
export function shouldExclude(path: string): boolean {
  const normalized = path.replace(/\\/g, '/')
  return SEARCH_EXCLUDES.some(
    (ex) => normalized.includes(`/${ex}/`) || normalized.startsWith(`${ex}/`),
  )
}
