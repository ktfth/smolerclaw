/**
 * Search/find tool implementations: search_files, find_files, list_directory
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { resolve, join, sep } from 'node:path'
import { hasRipgrep, shouldExclude, SEARCH_EXCLUDES } from '../platform'
import { guardPath, requireString } from './security'
import { truncate, formatSize } from './helpers'

// ─── search_files: ripgrep → pure-Bun fallback ─────────────

export async function toolSearchFiles(input: Record<string, unknown>): Promise<string> {
  const patternErr = requireString(input, 'pattern')
  if (patternErr) return patternErr
  const pattern = input.pattern as string
  const dir = resolve((input.path as string) || '.')
  const pathErr = guardPath(dir)
  if (pathErr) return pathErr
  const include = input.include as string | undefined

  if (await hasRipgrep()) {
    return searchWithRipgrep(pattern, dir, include)
  }
  return searchWithBun(pattern, dir, include)
}

async function searchWithRipgrep(
  pattern: string,
  dir: string,
  include?: string,
): Promise<string> {
  const args = ['rg', '--no-heading', '--line-number', '--color=never']
  if (include) args.push('--glob', include)
  for (const ex of SEARCH_EXCLUDES) {
    args.push('--glob', `!${ex}`)
  }
  args.push('-e', pattern, dir)

  const proc = Bun.spawn(args, { stdout: 'pipe', stderr: 'pipe' })
  const stdout = await new Response(proc.stdout).text()
  const stderr = await new Response(proc.stderr).text()
  await proc.exited

  if (!stdout.trim() && !stderr.trim()) return 'No matches found.'
  if (stderr.trim() && !stdout.trim()) return `Error: ${stderr.trim()}`

  return formatSearchResults(stdout, dir)
}

async function searchWithBun(
  pattern: string,
  dir: string,
  include?: string,
): Promise<string> {
  let regex: RegExp
  try {
    regex = new RegExp(pattern)
  } catch (err) {
    return `Error: invalid regex pattern: ${err instanceof Error ? err.message : pattern}`
  }
  const fileGlob = include || '**/*'
  const glob = new Bun.Glob(fileGlob)
  const results: string[] = []
  let fileCount = 0
  const MAX_FILES = 5000

  for await (const entry of glob.scan({ cwd: dir, onlyFiles: true })) {
    if (shouldExclude(entry)) continue
    if (++fileCount > MAX_FILES) {
      results.push(`... (stopped after scanning ${MAX_FILES} files)`)
      break
    }

    const fullPath = join(dir, entry)
    try {
      const content = readFileSync(fullPath, 'utf-8')
      const lines = content.split('\n')
      for (let i = 0; i < lines.length; i++) {
        if (regex.test(lines[i])) {
          results.push(`${entry}:${i + 1}:${lines[i]}`)
          if (results.length >= 100) break
        }
      }
    } catch {
      // Skip binary or unreadable files
    }
    if (results.length >= 100) break
  }

  if (results.length === 0) return 'No matches found.'

  let result = results.slice(0, 100).join('\n')
  if (results.length > 100) {
    result += `\n... (showing first 100 matches)`
  }
  return truncate(result)
}

// ─── find_files: Bun.Glob (cross-platform) ─────────────────

export async function toolFindFiles(input: Record<string, unknown>): Promise<string> {
  const patternErr = requireString(input, 'pattern')
  if (patternErr) return patternErr
  const pattern = input.pattern as string
  const dir = resolve((input.path as string) || '.')
  const pathErr = guardPath(dir)
  if (pathErr) return pathErr

  const glob = new Bun.Glob(pattern)
  const matches: string[] = []

  for await (const entry of glob.scan({ cwd: dir, onlyFiles: true })) {
    if (shouldExclude(entry)) continue
    matches.push(entry)
    if (matches.length >= 200) break
  }

  if (matches.length === 0) return 'No files found.'

  let result = matches.join('\n')
  if (matches.length >= 200) {
    result += '\n... (showing first 200 files)'
  }
  return result
}

// ─── list_directory ─────────────────────────────────────────

export function toolListDirectory(input: Record<string, unknown>): string {
  const dir = resolve((input.path as string) || '.')
  const pathErr = guardPath(dir)
  if (pathErr) return pathErr
  if (!existsSync(dir)) return `Error: not found: ${dir}`

  const entries = readdirSync(dir, { withFileTypes: true })
  const lines = entries
    .sort((a, b) => {
      if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1
      return a.name.localeCompare(b.name)
    })
    .map((e) => {
      if (e.isDirectory()) return `d  ${e.name}/`
      try {
        const stat = statSync(join(dir, e.name))
        const size = formatSize(stat.size)
        return `f  ${e.name}  ${size}`
      } catch {
        return `f  ${e.name}`
      }
    })

  return lines.join('\n')
}

// ─── Helpers ─────────────────────────────────────────────────

function formatSearchResults(stdout: string, baseDir: string): string {
  const cwd = process.cwd()
  const cwdPrefix = cwd + sep
  const baseDirPrefix = baseDir + sep
  const lines = stdout.trim().split('\n')
  const relativized = lines.map((line) => {
    if (line.startsWith(cwdPrefix)) return '.' + line.slice(cwd.length).replace(/\\/g, '/')
    if (line.startsWith(baseDirPrefix)) return '.' + line.slice(baseDir.length).replace(/\\/g, '/')
    return line
  })

  const count = relativized.length
  let result = relativized.slice(0, 100).join('\n')
  if (count > 100) result += `\n... (${count - 100} more matches)`
  return truncate(result)
}
