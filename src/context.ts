import { existsSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { getShellName, IS_WINDOWS } from './platform'
import { logger } from './core/logger'

/**
 * Gather context about the current working environment.
 * Injected into the system prompt so Claude knows where it is.
 */
export function gatherContext(): string {
  const cwd = process.cwd()
  const parts: string[] = []

  parts.push(`Working directory: ${cwd}`)
  parts.push(`Platform: ${process.platform} (${process.arch})`)
  parts.push(`Shell: ${getShellName()}`)
  parts.push(`Runtime: Bun ${Bun.version}`)
  parts.push(`Date: ${new Date().toISOString().split('T')[0]}`)

  if (IS_WINDOWS) {
    parts.push('Note: Use PowerShell syntax for commands (e.g., Get-ChildItem instead of ls, Get-Content instead of cat).')
  }

  const project = detectProject(cwd)
  if (project) parts.push(`Project: ${project}`)

  const git = detectGit(cwd)
  if (git) parts.push(git)

  return parts.join('\n')
}

function detectProject(cwd: string): string | null {
  const indicators: [string, string][] = [
    ['package.json', 'Node.js/JavaScript'],
    ['Cargo.toml', 'Rust'],
    ['go.mod', 'Go'],
    ['pyproject.toml', 'Python'],
    ['requirements.txt', 'Python'],
    ['pom.xml', 'Java (Maven)'],
    ['build.gradle', 'Java (Gradle)'],
    ['Gemfile', 'Ruby'],
    ['composer.json', 'PHP'],
    ['Makefile', 'Make'],
    ['CMakeLists.txt', 'C/C++ (CMake)'],
    ['Dockerfile', 'Docker'],
  ]

  const detected: string[] = []
  for (const [file, label] of indicators) {
    if (existsSync(join(cwd, file))) {
      detected.push(label)
    }
  }

  if (detected.length === 0) return null

  let name = basename(cwd)
  try {
    const pkg = join(cwd, 'package.json')
    if (existsSync(pkg)) {
      const data = JSON.parse(readFileSync(pkg, 'utf-8'))
      if (data.name) name = data.name
    }
  } catch (err) {
    logger.debug('Failed to parse package.json for project name', { error: err })
  }

  return `Project: ${name} (${detected.join(', ')})`
}

/**
 * Gather rich git context: branch, last commit, changed files summary.
 */
function detectGit(cwd: string): string | null {
  if (!existsSync(join(cwd, '.git'))) return null

  const lines: string[] = []

  // Branch
  try {
    const head = readFileSync(join(cwd, '.git', 'HEAD'), 'utf-8').trim()
    const branch = head.startsWith('ref: refs/heads/')
      ? head.slice('ref: refs/heads/'.length)
      : head.slice(0, 8)
    lines.push(`Git branch: ${branch}`)
  } catch {
    lines.push('Git: initialized')
    return lines.join('\n')
  }

  // Last commit (read from git log via COMMIT_EDITMSG or packed-refs is unreliable, use spawn)
  try {
    const proc = Bun.spawnSync(['git', 'log', '--oneline', '-1'], { cwd, stdout: 'pipe', stderr: 'pipe' })
    if (proc.exitCode === 0) {
      const lastCommit = new TextDecoder().decode(proc.stdout).trim()
      if (lastCommit) lines.push(`Last commit: ${lastCommit}`)
    }
  } catch (err) {
    logger.debug('git log failed', { error: err })
  }

  // Changed files summary (git diff --stat, limited)
  try {
    const proc = Bun.spawnSync(['git', 'diff', '--stat', '--stat-width=60'], { cwd, stdout: 'pipe', stderr: 'pipe' })
    if (proc.exitCode === 0) {
      const diff = new TextDecoder().decode(proc.stdout).trim()
      if (diff) {
        const diffLines = diff.split('\n')
        const shown = diffLines.slice(0, 15)
        if (diffLines.length > 15) shown.push(`... and ${diffLines.length - 15} more files`)
        lines.push('Uncommitted changes:\n' + shown.join('\n'))
      }
    }
  } catch (err) {
    logger.debug('git diff --stat failed', { error: err })
  }

  // Staged files
  try {
    const proc = Bun.spawnSync(['git', 'diff', '--cached', '--stat', '--stat-width=60'], { cwd, stdout: 'pipe', stderr: 'pipe' })
    if (proc.exitCode === 0) {
      const staged = new TextDecoder().decode(proc.stdout).trim()
      if (staged) {
        const stagedLines = staged.split('\n').slice(0, 10)
        lines.push('Staged:\n' + stagedLines.join('\n'))
      }
    }
  } catch (err) {
    logger.debug('git diff --cached failed', { error: err })
  }

  return lines.length > 0 ? lines.join('\n') : null
}
