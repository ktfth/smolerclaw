import { existsSync, readdirSync, readFileSync, mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type Anthropic from '@anthropic-ai/sdk'
import { getShell } from './platform'

export interface Plugin {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  command: string // shell command template with {{input.field}} placeholders
  source: string  // file path
}

/**
 * Load plugins from a directory.
 * Each .json file defines one tool.
 *
 * Schema:
 * {
 *   "name": "my_tool",
 *   "description": "What it does",
 *   "input_schema": { "type": "object", "properties": {...}, "required": [...] },
 *   "command": "curl -s https://api.example.com/{{input.query}}"
 * }
 */
export function loadPlugins(pluginDir: string): Plugin[] {
  if (!existsSync(pluginDir)) return []

  const plugins: Plugin[] = []
  const files = readdirSync(pluginDir).filter((f) => f.endsWith('.json'))

  for (const file of files) {
    try {
      const raw = JSON.parse(readFileSync(join(pluginDir, file), 'utf-8'))

      // Validate required fields
      if (!raw.name || !raw.description || !raw.command) continue
      if (typeof raw.name !== 'string' || typeof raw.command !== 'string') continue

      // Sanitize: reject commands with obvious injection patterns
      if (raw.command.includes('$(') || raw.command.includes('`')) {
        continue // skip dangerous command templates
      }

      plugins.push({
        name: raw.name,
        description: raw.description,
        inputSchema: raw.input_schema || { type: 'object', properties: {}, required: [] },
        command: raw.command,
        source: join(pluginDir, file),
      })
    } catch {
      // Skip invalid JSON files
    }
  }

  return plugins
}

/**
 * Convert loaded plugins to Anthropic tool definitions.
 */
export function pluginsToTools(plugins: Plugin[]): Anthropic.Tool[] {
  return plugins.map((p) => ({
    name: p.name,
    description: p.description,
    input_schema: p.inputSchema as Anthropic.Tool['input_schema'],
  }))
}

/**
 * Execute a plugin command by interpolating inputs.
 */
export async function executePlugin(
  plugin: Plugin,
  input: Record<string, unknown>,
): Promise<string> {
  // Interpolate {{input.field}} placeholders
  let cmd = plugin.command
  for (const [key, value] of Object.entries(input)) {
    const safeValue = String(value).replace(/[;&|`$()]/g, '') // basic sanitization
    cmd = cmd.replace(new RegExp(`\\{\\{input\\.${key}\\}\\}`, 'g'), safeValue)
  }

  // Remove any remaining unresolved placeholders
  cmd = cmd.replace(/\{\{input\.\w+\}\}/g, '')

  const shell = getShell()
  const proc = Bun.spawn([...shell, cmd], {
    stdout: 'pipe',
    stderr: 'pipe',
    cwd: process.cwd(),
  })

  const timer = setTimeout(() => proc.kill(), 30_000)
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  const code = await proc.exited
  clearTimeout(timer)

  let result = stdout.trim()
  if (stderr.trim()) result += (result ? '\n' : '') + stderr.trim()
  if (code !== 0) result += (result ? '\n' : '') + `Exit code: ${code}`

  return result || '(no output)'
}

/**
 * Format plugin list for display.
 */
export function formatPluginList(plugins: Plugin[]): string {
  if (plugins.length === 0) return 'No plugins loaded. Add .json files to ~/.config/smolerclaw/plugins/'
  return 'Plugins:\n' + plugins.map((p) => `  ${p.name} — ${p.description}`).join('\n')
}

/**
 * Get or create the plugins directory.
 */
export function getPluginDir(configDir: string): string {
  const dir = join(configDir, 'plugins')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}
