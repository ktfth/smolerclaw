import {
  existsSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  statSync,
} from 'node:fs'
import { resolve, relative, join, sep, dirname } from 'node:path'
import type Anthropic from '@anthropic-ai/sdk'
import { getShell, hasRipgrep, shouldExclude, SEARCH_EXCLUDES } from './platform'
import { UndoStack } from './undo'
import { type Plugin, executePlugin } from './plugins'

// Global undo stack shared across tool calls
export const undoStack = new UndoStack()

// Registered plugins (set from index.ts at startup)
let _plugins: Plugin[] = []
export function registerPlugins(plugins: Plugin[]): void {
  _plugins = plugins
}

// ─── Tool Definitions ────────────────────────────────────────

export const TOOLS: Anthropic.Tool[] = [
  {
    name: 'read_file',
    description:
      'Read file contents. For large files, use offset/limit to read specific line ranges.',
    input_schema: {
      type: 'object' as const,
      properties: {
        path: { type: 'string', description: 'File path (relative or absolute)' },
        offset: {
          type: 'number',
          description: 'Start reading from this line number (1-based). Optional.',
        },
        limit: {
          type: 'number',
          description: 'Max lines to read. Optional, defaults to 500.',
        },
      },
      required: ['path'],
    },
  },
  {
    name: 'write_file',
    description: 'Create a new file or completely overwrite an existing file.',
    input_schema: {
      type: 'object' as const,
      properties: {
        path: { type: 'string', description: 'File path to write' },
        content: { type: 'string', description: 'Full file content' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'edit_file',
    description:
      'Make a precise edit to a file. Finds old_text and replaces it with new_text. ' +
      'The old_text must match exactly (including whitespace). ' +
      'Use this instead of write_file when modifying existing files — it preserves the rest of the file.',
    input_schema: {
      type: 'object' as const,
      properties: {
        path: { type: 'string', description: 'File path to edit' },
        old_text: {
          type: 'string',
          description: 'Exact text to find (must be unique in the file)',
        },
        new_text: { type: 'string', description: 'Replacement text' },
      },
      required: ['path', 'old_text', 'new_text'],
    },
  },
  {
    name: 'search_files',
    description:
      'Search file contents using a regex pattern (like grep). ' +
      'Returns matching lines with file paths and line numbers.',
    input_schema: {
      type: 'object' as const,
      properties: {
        pattern: { type: 'string', description: 'Regex pattern to search for' },
        path: {
          type: 'string',
          description: 'Directory to search in. Defaults to cwd.',
        },
        include: {
          type: 'string',
          description: 'Glob pattern to filter files, e.g. "*.ts" or "*.py"',
        },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'find_files',
    description:
      'Find files by name pattern (glob). Returns matching file paths.',
    input_schema: {
      type: 'object' as const,
      properties: {
        pattern: {
          type: 'string',
          description: 'Glob pattern, e.g. "**/*.ts", "src/**/test*"',
        },
        path: { type: 'string', description: 'Base directory. Defaults to cwd.' },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'list_directory',
    description: 'List files and directories with type indicators and sizes.',
    input_schema: {
      type: 'object' as const,
      properties: {
        path: { type: 'string', description: 'Directory to list. Defaults to cwd.' },
      },
      required: [],
    },
  },
  {
    name: 'run_command',
    description:
      'Run a shell command. Use for: git operations, running tests, installing packages, ' +
      'building projects, or any CLI task. Commands run in the current working directory.',
    input_schema: {
      type: 'object' as const,
      properties: {
        command: { type: 'string', description: 'Shell command to execute' },
        timeout: {
          type: 'number',
          description: 'Timeout in seconds. Default 30, max 120.',
        },
      },
      required: ['command'],
    },
  },
  {
    name: 'fetch_url',
    description:
      'Fetch the content of a URL. Use for: reading documentation, checking APIs, ' +
      'downloading config files, or verifying endpoints. Returns the response body as text. ' +
      'For HTML pages, returns a text-only extraction (no tags).',
    input_schema: {
      type: 'object' as const,
      properties: {
        url: { type: 'string', description: 'The URL to fetch' },
        method: {
          type: 'string',
          description: 'HTTP method. Default GET.',
          enum: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD'],
        },
        headers: {
          type: 'object',
          description: 'Optional request headers as key-value pairs.',
        },
        body: {
          type: 'string',
          description: 'Optional request body (for POST/PUT/PATCH).',
        },
      },
      required: ['url'],
    },
  },
]

// ─── Tool Execution ──────────────────────────────────────────

const MAX_OUTPUT = 50_000

export async function executeTool(
  name: string,
  input: Record<string, unknown>,
): Promise<string> {
  try {
    switch (name) {
      case 'read_file':
        return toolReadFile(input)
      case 'write_file':
        return toolWriteFile(input)
      case 'edit_file':
        return toolEditFile(input)
      case 'search_files':
        return await toolSearchFiles(input)
      case 'find_files':
        return await toolFindFiles(input)
      case 'list_directory':
        return toolListDirectory(input)
      case 'run_command':
        return await toolRunCommand(input)
      case 'fetch_url':
        return await toolFetchUrl(input)
      default: {
        // Check plugins
        const plugin = _plugins.find((p) => p.name === name)
        if (plugin) return await executePlugin(plugin, input)
        return `Error: unknown tool "${name}"`
      }
    }
  } catch (err) {
    return `Error: ${err instanceof Error ? err.message : String(err)}`
  }
}

// ─── Security ───────────────────────────────────────────────

const MAX_FILE_SIZE = 10 * 1024 * 1024 // 10 MB

/**
 * Atomic write: write to temp file then rename.
 * Prevents corruption from crash/power loss mid-write.
 */
function atomicWrite(filePath: string, content: string): void {
  const tmp = join(dirname(filePath), `.${Date.now()}.tmp`)
  writeFileSync(tmp, content)
  renameSync(tmp, filePath)
}

function guardPath(filePath: string): string | null {
  const resolved = resolve(filePath)
  const cwd = process.cwd()
  if (resolved !== cwd && !resolved.startsWith(cwd + sep)) {
    return `Error: path outside working directory is not permitted: ${resolved}`
  }
  return null
}

// ─── Implementations ─────────────────────────────────────────

function toolReadFile(input: Record<string, unknown>): string {
  const path = resolve(input.path as string)
  const pathErr = guardPath(path)
  if (pathErr) return pathErr
  if (!existsSync(path)) return `Error: file not found: ${path}`

  // Check file size before reading
  const size = statSync(path).size
  if (size > MAX_FILE_SIZE) {
    return `Error: file too large (${formatSize(size)}). Max is ${formatSize(MAX_FILE_SIZE)}.`
  }

  const content = readFileSync(path, 'utf-8')
  const lines = content.split('\n')
  const offset = Math.max(1, (input.offset as number) || 1)
  const limit = Math.min(2000, (input.limit as number) || 500)

  const slice = lines.slice(offset - 1, offset - 1 + limit)
  const numbered = slice.map((l, i) => `${String(offset + i).padStart(4)}  ${l}`)

  let result = numbered.join('\n')
  const remaining = lines.length - (offset - 1 + limit)
  if (remaining > 0) {
    result += `\n... (${remaining} more lines, total ${lines.length})`
  }
  return truncate(result)
}

function toolWriteFile(input: Record<string, unknown>): string {
  const path = resolve(input.path as string)
  const pathErr = guardPath(path)
  if (pathErr) return pathErr
  const content = input.content as string
  const existed = existsSync(path)
  undoStack.saveState(path)
  atomicWrite(path, content)
  const lines = content.split('\n').length
  return `${existed ? 'Updated' : 'Created'}: ${path} (${lines} lines)`
}

function toolEditFile(input: Record<string, unknown>): string {
  const path = resolve(input.path as string)
  const pathErr = guardPath(path)
  if (pathErr) return pathErr
  if (!existsSync(path)) return `Error: file not found: ${path}`

  const content = readFileSync(path, 'utf-8')
  const oldText = input.old_text as string
  const newText = input.new_text as string

  const count = content.split(oldText).length - 1
  if (count === 0) {
    return 'Error: old_text not found in file. Make sure it matches exactly, including whitespace and indentation.'
  }
  if (count > 1) {
    return `Error: old_text found ${count} times. It must be unique. Include more surrounding context.`
  }

  undoStack.saveState(path)
  const updated = content.replace(oldText, newText)
  atomicWrite(path, updated)

  const oldLines = oldText.split('\n').length
  const newLines = newText.split('\n').length
  return `Edited: ${path} (replaced ${oldLines} lines with ${newLines} lines)`
}

// ─── search_files: ripgrep → pure-Bun fallback ─────────────

async function toolSearchFiles(input: Record<string, unknown>): Promise<string> {
  const pattern = input.pattern as string
  const dir = resolve((input.path as string) || '.')
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

async function toolFindFiles(input: Record<string, unknown>): Promise<string> {
  const pattern = input.pattern as string
  const dir = resolve((input.path as string) || '.')

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

function toolListDirectory(input: Record<string, unknown>): string {
  const dir = resolve((input.path as string) || '.')
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

// ─── run_command: cross-platform shell ──────────────────────

async function toolRunCommand(input: Record<string, unknown>): Promise<string> {
  const cmd = input.command as string
  const timeoutSec = Math.min(120, Math.max(5, (input.timeout as number) || 30))

  const shell = getShell()
  const proc = Bun.spawn([...shell, cmd], {
    stdout: 'pipe',
    stderr: 'pipe',
    cwd: process.cwd(),
  })

  const timer = setTimeout(() => proc.kill(), timeoutSec * 1000)
  // Drain both pipes concurrently to avoid deadlock (HIGH-1 fix)
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  const exitCode = await proc.exited
  clearTimeout(timer)

  let result = ''
  if (stdout.trim()) result += stdout.trim()
  if (stderr.trim()) {
    result += (result ? '\n' : '') + 'STDERR:\n' + stderr.trim()
  }
  if (exitCode !== 0) {
    result += (result ? '\n' : '') + `Exit code: ${exitCode}`
  }

  return truncate(result || '(no output)')
}

// ─── fetch_url: HTTP client ─────────────────────────────────

async function toolFetchUrl(input: Record<string, unknown>): Promise<string> {
  const url = input.url as string
  const method = (input.method as string) || 'GET'
  const headers = (input.headers as Record<string, string>) || {}
  const body = input.body as string | undefined

  // URL validation
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    return 'Error: URL must start with http:// or https://'
  }

  // SSRF protection: block private/internal hostnames
  const ssrfErr = checkSsrf(url)
  if (ssrfErr) return ssrfErr

  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 30_000)

    const resp = await fetch(url, {
      method,
      redirect: 'manual', // prevent redirect-based SSRF
      headers: {
        'User-Agent': 'tinyclaw/1.0',
        'Accept': 'text/html, application/json, text/plain, */*',
        ...headers,
      },
      body: body && method !== 'GET' && method !== 'HEAD' ? body : undefined,
      signal: controller.signal,
    })
    clearTimeout(timeout)

    // Handle redirects manually (max 5 hops, re-check SSRF on each)
    if (resp.status >= 300 && resp.status < 400) {
      const location = resp.headers.get('location')
      if (!location) return `Status: ${resp.status} (redirect with no location header)`
      const redirErr = checkSsrf(location)
      if (redirErr) return `Redirect blocked: ${redirErr}`
      return `Status: ${resp.status} -> Redirect to: ${location}\n(Use fetch_url on the redirect target if needed)`
    }

    const status = `${resp.status} ${resp.statusText}`
    const contentType = resp.headers.get('content-type') || ''

    if (method === 'HEAD') {
      const headerLines = [...resp.headers.entries()]
        .map(([k, v]) => `${k}: ${v}`)
        .join('\n')
      return `Status: ${status}\n${headerLines}`
    }

    const text = await resp.text()

    // For HTML, extract readable text (strip tags)
    if (contentType.includes('text/html')) {
      const clean = stripHtml(text)
      return truncate(`Status: ${status}\n\n${clean}`)
    }

    return truncate(`Status: ${status}\n\n${text}`)
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      return 'Error: Request timed out after 30 seconds.'
    }
    return `Error: ${err instanceof Error ? err.message : String(err)}`
  }
}

/**
 * Block SSRF: reject URLs pointing to private/internal networks.
 */
function checkSsrf(urlStr: string): string | null {
  try {
    const parsed = new URL(urlStr)
    const host = parsed.hostname.toLowerCase()

    // Block private hostnames
    if (host === 'localhost' || host === '127.0.0.1' || host === '::1') {
      return 'Error: requests to localhost are blocked for security.'
    }
    if (host.endsWith('.local') || host.endsWith('.internal')) {
      return 'Error: requests to internal hostnames are blocked.'
    }

    // Block private IP ranges
    const parts = host.split('.').map(Number)
    if (parts.length === 4 && parts.every((n) => !isNaN(n))) {
      if (parts[0] === 10) return 'Error: requests to private IPs (10.x) are blocked.'
      if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return 'Error: requests to private IPs (172.16-31.x) are blocked.'
      if (parts[0] === 192 && parts[1] === 168) return 'Error: requests to private IPs (192.168.x) are blocked.'
      if (parts[0] === 169 && parts[1] === 254) return 'Error: requests to link-local IPs are blocked.'
      if (parts[0] === 0) return 'Error: requests to 0.x IPs are blocked.'
    }

    // Block file:// and other schemes that might slip through
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return `Error: protocol ${parsed.protocol} is not allowed.`
    }
  } catch {
    return 'Error: invalid URL.'
  }
  return null
}

/**
 * Strip HTML tags and extract readable text.
 * Simple heuristic — not a full parser.
 */
function stripHtml(html: string): string {
  let text = html
    // Remove script and style blocks
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, '')
    .replace(/<header[^>]*>[\s\S]*?<\/header>/gi, '')
    .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, '')
    // Convert block elements to newlines
    .replace(/<\/(p|div|h[1-6]|li|tr|br|hr)[^>]*>/gi, '\n')
    .replace(/<(br|hr)[^>]*\/?>/gi, '\n')
    // Strip remaining tags
    .replace(/<[^>]+>/g, ' ')
    // Decode common HTML entities
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    // Collapse whitespace
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()

  return text
}

// ─── Helpers ─────────────────────────────────────────────────

function formatSearchResults(stdout: string, baseDir: string): string {
  const cwd = process.cwd()
  const lines = stdout.trim().split('\n')
  const relativized = lines.map((line) => {
    if (line.startsWith(cwd)) return '.' + line.slice(cwd.length).replace(/\\/g, '/')
    if (line.startsWith(baseDir)) return '.' + line.slice(baseDir.length).replace(/\\/g, '/')
    return line
  })

  const count = relativized.length
  let result = relativized.slice(0, 100).join('\n')
  if (count > 100) result += `\n... (${count - 100} more matches)`
  return truncate(result)
}

function truncate(s: string): string {
  if (s.length <= MAX_OUTPUT) return s
  return s.slice(0, MAX_OUTPUT) + '\n... (output truncated)'
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}K`
  return `${(bytes / (1024 * 1024)).toFixed(1)}M`
}
