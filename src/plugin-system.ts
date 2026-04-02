/**
 * Enhanced Plugin System — extends the basic JSON plugin loader
 * with lifecycle hooks, event subscriptions, enable/disable, and a registry.
 *
 * Plugin types:
 *   - JSON plugins (legacy) — shell command templates, loaded from .json files
 *   - Script plugins — .ts/.js files that export a plugin definition with hooks
 *
 * Lifecycle:
 *   1. Discovery: scan plugin directory for .json and .ts/.js files
 *   2. Registration: validate and register in the plugin registry
 *   3. Load: call onLoad() hook (script plugins only)
 *   4. Runtime: plugins provide tools and/or listen to events
 *   5. Unload: call onUnload() hook on shutdown
 *
 * Directory structure:
 *   ~/.config/smolerclaw/plugins/
 *     my-tool.json          ← legacy JSON plugin
 *     weather.ts            ← script plugin
 *     disabled/             ← disabled plugins moved here
 */

import { existsSync, readdirSync, readFileSync, mkdirSync, renameSync, rmSync } from 'node:fs'
import { join, basename, extname } from 'node:path'
import type Anthropic from '@anthropic-ai/sdk'
import { loadPlugins, pluginsToTools, executePlugin, type Plugin } from './plugins'
import { eventBus } from './core/event-bus'
import { emit } from './core/event-bus'
import { logger } from './core/logger'
import type { EventBusEvents } from './types'

// ─── Types ──────────────────────────────────────────────────

type EventName = keyof EventBusEvents

export interface ScriptPluginDefinition {
  name: string
  description: string
  version: string
  /** Tool schemas this plugin provides */
  tools?: Anthropic.Tool[]
  /** Called when the plugin is loaded */
  onLoad?: (ctx: PluginContext) => void | Promise<void>
  /** Called when the plugin is unloaded */
  onUnload?: () => void | Promise<void>
  /** Execute a tool call for this plugin */
  onToolCall?: (toolName: string, input: Record<string, unknown>) => Promise<string>
  /** Event subscriptions */
  events?: {
    [K in EventName]?: (payload: EventBusEvents[K]) => void
  }
}

export interface PluginContext {
  /** Emit a status update visible to the user */
  notify: (message: string, level?: 'info' | 'warning' | 'error' | 'success') => void
  /** Get the plugin's data directory (for persistent storage) */
  dataDir: string
}

export interface RegisteredPlugin {
  readonly name: string
  readonly description: string
  readonly version: string
  readonly type: 'json' | 'script'
  readonly source: string
  readonly enabled: boolean
  readonly tools: readonly Anthropic.Tool[]
  /** JSON plugin data (for legacy execution) */
  readonly jsonPlugin?: Plugin
  /** Script plugin definition */
  readonly scriptDef?: ScriptPluginDefinition
  /** Event unsubscribe functions */
  readonly eventUnsubs: Array<() => void>
}

// ─── State ──────────────────────────────────────────────────

let _registry: RegisteredPlugin[] = []
let _pluginDir = ''
let _dataDir = ''

// ─── Init ───────────────────────────────────────────────────

/**
 * Initialize the enhanced plugin system.
 * Discovers and loads all plugins from the plugin directory.
 */
export async function initPluginSystem(
  pluginDir: string,
  dataDir: string,
): Promise<RegisteredPlugin[]> {
  _pluginDir = pluginDir
  _dataDir = dataDir
  _registry = []

  if (!existsSync(pluginDir)) {
    mkdirSync(pluginDir, { recursive: true })
    return []
  }

  // 1. Load legacy JSON plugins
  const jsonPlugins = loadPlugins(pluginDir)
  for (const jp of jsonPlugins) {
    _registry = [
      ..._registry,
      {
        name: jp.name,
        description: jp.description,
        version: '1.0.0',
        type: 'json',
        source: jp.source,
        enabled: true,
        tools: pluginsToTools([jp]),
        jsonPlugin: jp,
        eventUnsubs: [],
      },
    ]
  }

  // 2. Discover and load script plugins
  const scriptFiles = readdirSync(pluginDir).filter((f) => {
    const ext = extname(f)
    return ext === '.ts' || ext === '.js'
  })

  for (const file of scriptFiles) {
    const filePath = join(pluginDir, file)
    try {
      const mod = await import(filePath)
      const def: ScriptPluginDefinition = mod.default || mod

      if (!def.name || !def.description) {
        logger.debug(`Skipping invalid script plugin: ${file}`)
        continue
      }

      const plugin = await registerScriptPlugin(def, filePath)
      if (plugin) {
        _registry = [..._registry, plugin]
      }
    } catch (err) {
      logger.debug(`Failed to load script plugin: ${file}`, {
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  emit('status:update', {
    source: 'plugin-system',
    message: `${_registry.length} plugin(s) carregado(s)`,
    level: 'info',
    timestamp: Date.now(),
  })

  return _registry
}

// ─── Registration ───────────────────────────────────────────

async function registerScriptPlugin(
  def: ScriptPluginDefinition,
  source: string,
): Promise<RegisteredPlugin | null> {
  const pluginDataDir = join(_dataDir, 'plugins', def.name)
  if (!existsSync(pluginDataDir)) mkdirSync(pluginDataDir, { recursive: true })

  const ctx: PluginContext = {
    notify: (message, level = 'info') => {
      emit('status:update', {
        source: `plugin:${def.name}`,
        message,
        level,
        timestamp: Date.now(),
      })
    },
    dataDir: pluginDataDir,
  }

  // Call onLoad
  try {
    await def.onLoad?.(ctx)
  } catch (err) {
    logger.debug(`Plugin ${def.name} onLoad failed`, {
      error: err instanceof Error ? err.message : String(err),
    })
    return null
  }

  // Subscribe to events
  const eventUnsubs: Array<() => void> = []
  if (def.events) {
    for (const [eventName, handler] of Object.entries(def.events)) {
      if (handler) {
        const unsub = eventBus.on(
          eventName as EventName,
          handler as (payload: unknown) => void,
          { async: true },
        )
        eventUnsubs.push(unsub)
      }
    }
  }

  return {
    name: def.name,
    description: def.description,
    version: def.version || '1.0.0',
    type: 'script',
    source,
    enabled: true,
    tools: def.tools || [],
    scriptDef: def,
    eventUnsubs,
  }
}

// ─── Runtime ────────────────────────────────────────────────

/**
 * Get all tool definitions from enabled plugins.
 */
export function getPluginTools(): Anthropic.Tool[] {
  return _registry
    .filter((p) => p.enabled)
    .flatMap((p) => [...p.tools])
}

/**
 * Execute a tool call that belongs to a plugin.
 * Returns null if no plugin handles the tool.
 */
export async function executePluginTool(
  toolName: string,
  input: Record<string, unknown>,
): Promise<string | null> {
  for (const plugin of _registry) {
    if (!plugin.enabled) continue

    // Check if this plugin owns the tool
    const ownsTool = plugin.tools.some((t) => t.name === toolName)
    if (!ownsTool) continue

    // Script plugin
    if (plugin.type === 'script' && plugin.scriptDef?.onToolCall) {
      return await plugin.scriptDef.onToolCall(toolName, input)
    }

    // JSON plugin
    if (plugin.type === 'json' && plugin.jsonPlugin) {
      return await executePlugin(plugin.jsonPlugin, input)
    }
  }

  return null
}

// ─── Enable/Disable ─────────────────────────────────────────

/**
 * Disable a plugin by name. Moves it to the disabled/ subdirectory.
 */
export function disablePlugin(name: string): boolean {
  const idx = _registry.findIndex((p) => p.name === name)
  if (idx === -1) return false

  const plugin = _registry[idx]
  if (!plugin.enabled) return false

  // Unsubscribe events
  for (const unsub of plugin.eventUnsubs) {
    unsub()
  }

  // Call onUnload for script plugins
  if (plugin.type === 'script' && plugin.scriptDef?.onUnload) {
    try {
      plugin.scriptDef.onUnload()
    } catch { /* best effort */ }
  }

  // Move file to disabled/ subdirectory
  const disabledDir = join(_pluginDir, 'disabled')
  if (!existsSync(disabledDir)) mkdirSync(disabledDir, { recursive: true })
  const destPath = join(disabledDir, basename(plugin.source))

  try {
    renameSync(plugin.source, destPath)
  } catch {
    // File move failed — just mark as disabled in memory
  }

  // Update registry immutably
  _registry = _registry.map((p, i) =>
    i === idx ? { ...p, enabled: false, eventUnsubs: [] } : p,
  )

  emit('status:update', {
    source: 'plugin-system',
    message: `Plugin "${name}" desabilitado`,
    level: 'info',
    timestamp: Date.now(),
  })

  return true
}

/**
 * Enable a previously disabled plugin.
 */
export async function enablePlugin(name: string): Promise<boolean> {
  // Check if already in registry but disabled
  const existingIdx = _registry.findIndex((p) => p.name === name && !p.enabled)
  if (existingIdx !== -1) {
    const plugin = _registry[existingIdx]

    // Move file back from disabled/ if it was moved there
    const disabledDir = join(_pluginDir, 'disabled')
    const disabledPath = join(disabledDir, basename(plugin.source))
    const activePath = join(_pluginDir, basename(plugin.source))
    if (existsSync(disabledPath)) {
      try { renameSync(disabledPath, activePath) } catch { /* best effort */ }
    }

    _registry = _registry.map((p, i) =>
      i === existingIdx ? { ...p, enabled: true, source: activePath } : p,
    )

    emit('status:update', {
      source: 'plugin-system',
      message: `Plugin "${name}" habilitado`,
      level: 'success',
      timestamp: Date.now(),
    })
    return true
  }

  // Not in registry — check disabled/ directory and re-discover
  const disabledDir = join(_pluginDir, 'disabled')
  if (!existsSync(disabledDir)) return false

  const files = readdirSync(disabledDir)
  const matchFile = files.find((f) => {
    const base = basename(f, extname(f))
    return base === name
  })

  if (!matchFile) return false

  const sourcePath = join(disabledDir, matchFile)
  const destPath = join(_pluginDir, matchFile)

  try {
    renameSync(sourcePath, destPath)
  } catch {
    return false
  }

  // Re-discover and register the plugin from disk
  const ext = extname(matchFile)
  if (ext === '.json') {
    const jsonPlugins = loadPlugins(_pluginDir).filter((p) => p.source === destPath)
    for (const jp of jsonPlugins) {
      _registry = [
        ..._registry,
        {
          name: jp.name,
          description: jp.description,
          version: '1.0.0',
          type: 'json',
          source: jp.source,
          enabled: true,
          tools: pluginsToTools([jp]),
          jsonPlugin: jp,
          eventUnsubs: [],
        },
      ]
    }
  } else if (ext === '.ts' || ext === '.js') {
    try {
      const mod = await import(destPath)
      const def: ScriptPluginDefinition = mod.default || mod
      if (def.name && def.description) {
        const plugin = await registerScriptPlugin(def, destPath)
        if (plugin) {
          _registry = [..._registry, plugin]
        }
      }
    } catch { /* skip invalid */ }
  }

  emit('status:update', {
    source: 'plugin-system',
    message: `Plugin "${name}" habilitado`,
    level: 'success',
    timestamp: Date.now(),
  })

  return true
}

// ─── GitHub Install/Uninstall ────────────────────────────────

/**
 * Install a plugin from a GitHub repository.
 *
 * Supports:
 *   - owner/repo — clones the repo, looks for plugin entry point
 *   - owner/repo#branch — specific branch
 *   - Full URL: https://github.com/owner/repo
 *
 * The repo must contain one of:
 *   - plugin.json (JSON plugin)
 *   - plugin.ts or index.ts (script plugin)
 *   - package.json with "smolerclaw" field pointing to entry
 */
export async function installPlugin(
  source: string,
): Promise<{ success: boolean; name: string; message: string }> {
  if (!_pluginDir) {
    return { success: false, name: '', message: 'Plugin system nao inicializado.' }
  }

  // Parse source: owner/repo, owner/repo#branch, or full URL
  const parsed = parseGitHubSource(source)
  if (!parsed) {
    return { success: false, name: '', message: `Fonte invalida: "${source}". Use owner/repo ou URL do GitHub.` }
  }

  const { owner, repo, branch } = parsed
  const installDir = join(_pluginDir, 'installed', `${owner}--${repo}`)

  // Check if already installed
  if (existsSync(installDir)) {
    return { success: false, name: `${owner}/${repo}`, message: `Plugin ${owner}/${repo} ja instalado. Use /plugin uninstall para remover.` }
  }

  // Clone the repo
  const cloneUrl = `https://github.com/${owner}/${repo}.git`
  const cloneArgs = ['git', 'clone', '--depth', '1']
  if (branch) cloneArgs.push('--branch', branch)
  cloneArgs.push(cloneUrl, installDir)

  try {
    const proc = Bun.spawn(cloneArgs, { stdout: 'pipe', stderr: 'pipe' })
    const timer = setTimeout(() => proc.kill(), 30_000)
    const [, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])
    const code = await proc.exited
    clearTimeout(timer)

    if (code !== 0) {
      // Cleanup on failure
      try { rmSync(installDir, { recursive: true, force: true }) } catch { /* ignore */ }
      return { success: false, name: `${owner}/${repo}`, message: `git clone falhou: ${stderr.trim().split('\n')[0] || `exit code ${code}`}` }
    }
  } catch (err) {
    try { rmSync(installDir, { recursive: true, force: true }) } catch { /* ignore */ }
    return { success: false, name: `${owner}/${repo}`, message: `Erro ao clonar: ${err instanceof Error ? err.message : String(err)}` }
  }

  // Discover entry point
  const entryResult = discoverEntryPoint(installDir)
  if (!entryResult) {
    try { rmSync(installDir, { recursive: true, force: true }) } catch { /* ignore */ }
    return {
      success: false,
      name: `${owner}/${repo}`,
      message: `Nenhum entry point encontrado. O repo deve conter plugin.json, plugin.ts, index.ts, ou package.json com campo "smolerclaw".`,
    }
  }

  // Symlink or copy the entry file to the plugins directory for discovery
  const entryExt = extname(entryResult.path)
  const pluginFileName = `${owner}--${repo}${entryExt}`
  const destPath = join(_pluginDir, pluginFileName)

  // Write a re-export wrapper for script plugins so the plugin dir discovers it
  if (entryExt === '.ts' || entryExt === '.js') {
    const relativePath = entryResult.path.replace(/\\/g, '/')
    const wrapperContent = `// Auto-installed from github.com/${owner}/${repo}\nexport { default } from '${relativePath}'\n`
    Bun.write(destPath, wrapperContent)
  } else {
    // JSON: copy directly
    const content = readFileSync(entryResult.path, 'utf-8')
    Bun.write(destPath, content)
  }

  // Register the plugin immediately
  if (entryExt === '.json') {
    const jsonPlugins = loadPlugins(_pluginDir).filter((p) => p.source === destPath)
    for (const jp of jsonPlugins) {
      _registry = [
        ..._registry,
        {
          name: jp.name,
          description: jp.description,
          version: '1.0.0',
          type: 'json',
          source: destPath,
          enabled: true,
          tools: pluginsToTools([jp]),
          jsonPlugin: jp,
          eventUnsubs: [],
        },
      ]
    }
  } else {
    try {
      const mod = await import(entryResult.path)
      const def: ScriptPluginDefinition = mod.default || mod
      if (def.name && def.description) {
        const plugin = await registerScriptPlugin(def, destPath)
        if (plugin) {
          _registry = [..._registry, plugin]
        }
      }
    } catch { /* skip invalid */ }
  }

  const registered = _registry.find((p) => p.source === destPath)
  const pluginName = registered?.name || `${owner}/${repo}`

  emit('status:update', {
    source: 'plugin-system',
    message: `Plugin "${pluginName}" instalado de github.com/${owner}/${repo}`,
    level: 'success',
    timestamp: Date.now(),
  })

  // Write install metadata
  const metaPath = join(installDir, '.smolerclaw-install.json')
  Bun.write(metaPath, JSON.stringify({
    source: `${owner}/${repo}`,
    branch: branch || 'default',
    installedAt: new Date().toISOString(),
    entryPoint: destPath,
    pluginName,
  }, null, 2))

  return { success: true, name: pluginName, message: `Plugin "${pluginName}" instalado com sucesso de github.com/${owner}/${repo}.` }
}

/**
 * Uninstall a plugin installed from GitHub.
 */
export function uninstallPlugin(name: string): { success: boolean; message: string } {
  if (!_pluginDir) {
    return { success: false, message: 'Plugin system nao inicializado.' }
  }

  const installedDir = join(_pluginDir, 'installed')
  if (!existsSync(installedDir)) {
    return { success: false, message: `Plugin "${name}" nao encontrado.` }
  }

  // Search by plugin name in registry or by owner/repo pattern in installed/
  const plugin = _registry.find((p) => p.name === name)
  let installPath: string | null = null
  let entryPath: string | null = null

  if (plugin) {
    entryPath = plugin.source

    // Find the corresponding install directory
    const dirs = readdirSync(installedDir).filter((d) =>
      existsSync(join(installedDir, d, '.smolerclaw-install.json')),
    )
    for (const dir of dirs) {
      try {
        const meta = JSON.parse(readFileSync(join(installedDir, dir, '.smolerclaw-install.json'), 'utf-8'))
        if (meta.pluginName === name || meta.entryPoint === entryPath) {
          installPath = join(installedDir, dir)
          break
        }
      } catch { /* ignore */ }
    }
  } else {
    // Try interpreting name as owner/repo
    const dirName = name.replace('/', '--')
    const candidatePath = join(installedDir, dirName)
    if (existsSync(candidatePath)) {
      installPath = candidatePath
      try {
        const meta = JSON.parse(readFileSync(join(candidatePath, '.smolerclaw-install.json'), 'utf-8'))
        entryPath = meta.entryPoint || null
      } catch { /* ignore */ }
    }
  }

  if (!installPath && !entryPath) {
    return { success: false, message: `Plugin "${name}" nao encontrado entre os instalados.` }
  }

  // Unload from registry
  if (plugin) {
    for (const unsub of plugin.eventUnsubs) { unsub() }
    if (plugin.scriptDef?.onUnload) {
      try { plugin.scriptDef.onUnload() } catch { /* best effort */ }
    }
    _registry = _registry.filter((p) => p.name !== name)
  }

  // Remove entry file from plugin dir
  if (entryPath && existsSync(entryPath)) {
    try { rmSync(entryPath, { force: true }) } catch { /* ignore */ }
  }

  // Remove cloned repo
  if (installPath) {
    try { rmSync(installPath, { recursive: true, force: true }) } catch { /* ignore */ }
  }

  emit('status:update', {
    source: 'plugin-system',
    message: `Plugin "${name}" desinstalado`,
    level: 'info',
    timestamp: Date.now(),
  })

  return { success: true, message: `Plugin "${name}" desinstalado com sucesso.` }
}

/**
 * List installed GitHub plugins with their metadata.
 */
export function listInstalledPlugins(): Array<{
  name: string
  source: string
  installedAt: string
}> {
  const installedDir = join(_pluginDir, 'installed')
  if (!existsSync(installedDir)) return []

  const results: Array<{ name: string; source: string; installedAt: string }> = []
  const dirs = readdirSync(installedDir)

  for (const dir of dirs) {
    const metaPath = join(installedDir, dir, '.smolerclaw-install.json')
    if (!existsSync(metaPath)) continue
    try {
      const meta = JSON.parse(readFileSync(metaPath, 'utf-8'))
      results.push({
        name: meta.pluginName || dir,
        source: meta.source || dir.replace('--', '/'),
        installedAt: meta.installedAt || 'desconhecido',
      })
    } catch { /* skip */ }
  }

  return results
}

// ─── GitHub Helpers ─────────────────────────────────────────

function parseGitHubSource(
  source: string,
): { owner: string; repo: string; branch: string | null } | null {
  // Full URL: https://github.com/owner/repo
  const urlMatch = source.match(/github\.com\/([^/]+)\/([^/\s#]+)/)
  if (urlMatch) {
    const repo = urlMatch[2].replace(/\.git$/, '')
    const branchMatch = source.match(/#(.+)$/)
    return { owner: urlMatch[1], repo, branch: branchMatch?.[1] || null }
  }

  // Short form: owner/repo or owner/repo#branch
  const shortMatch = source.match(/^([a-zA-Z0-9_.-]+)\/([a-zA-Z0-9_.-]+?)(?:#(.+))?$/)
  if (shortMatch) {
    return { owner: shortMatch[1], repo: shortMatch[2], branch: shortMatch[3] || null }
  }

  return null
}

function discoverEntryPoint(dir: string): { path: string } | null {
  // 1. Check package.json for smolerclaw field
  const pkgPath = join(dir, 'package.json')
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'))
      if (pkg.smolerclaw) {
        const entry = join(dir, pkg.smolerclaw)
        if (existsSync(entry)) return { path: entry }
      }
    } catch { /* ignore */ }
  }

  // 2. Direct entry points in priority order
  const candidates = ['plugin.json', 'plugin.ts', 'plugin.js', 'index.ts', 'index.js']
  for (const name of candidates) {
    const path = join(dir, name)
    if (existsSync(path)) return { path }
  }

  // 3. Check src/ subdirectory
  const srcCandidates = ['src/plugin.ts', 'src/plugin.js', 'src/index.ts', 'src/index.js']
  for (const name of srcCandidates) {
    const path = join(dir, name)
    if (existsSync(path)) return { path }
  }

  return null
}

// ─── Query ──────────────────────────────────────────────────

/**
 * List all registered plugins.
 */
export function listPlugins(): readonly RegisteredPlugin[] {
  return _registry
}

/**
 * Get a plugin by name.
 */
export function getPlugin(name: string): RegisteredPlugin | undefined {
  return _registry.find((p) => p.name === name)
}

/**
 * Format plugin list for TUI display.
 */
export function formatPluginRegistry(): string {
  if (_registry.length === 0) {
    return 'Nenhum plugin carregado. Adicione arquivos em ~/.config/smolerclaw/plugins/'
  }

  const lines = ['Plugins:']
  for (const p of _registry) {
    const status = p.enabled ? '' : ' [desabilitado]'
    const typeLabel = p.type === 'script' ? 'script' : 'json'
    const toolCount = p.tools.length
    lines.push(
      `  ${p.name} v${p.version} (${typeLabel}) — ${p.description}` +
      ` [${toolCount} tool${toolCount !== 1 ? 's' : ''}]${status}`,
    )
  }
  return lines.join('\n')
}

// ─── Shutdown ───────────────────────────────────────────────

/**
 * Unload all plugins cleanly.
 */
export async function shutdownPluginSystem(): Promise<void> {
  for (const plugin of _registry) {
    // Unsubscribe events
    for (const unsub of plugin.eventUnsubs) {
      unsub()
    }

    // Call onUnload for script plugins
    if (plugin.type === 'script' && plugin.scriptDef?.onUnload) {
      try {
        await plugin.scriptDef.onUnload()
      } catch { /* best effort */ }
    }
  }

  _registry = []
}

// ─── Testing Support ────────────────────────────────────────

export function resetPluginSystem(): void {
  _registry = []
  _pluginDir = ''
  _dataDir = ''
}
