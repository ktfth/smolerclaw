import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdirSync, writeFileSync, rmSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  initPluginSystem,
  shutdownPluginSystem,
  resetPluginSystem,
  getPluginTools,
  executePluginTool,
  disablePlugin,
  enablePlugin,
  listPlugins,
  getPlugin,
  formatPluginRegistry,
  installPlugin,
  uninstallPlugin,
  listInstalledPlugins,
} from '../src/plugin-system'

const TEST_DIR = join(tmpdir(), `smolerclaw-plugin-test-${Date.now()}`)
const PLUGIN_DIR = join(TEST_DIR, 'plugins')
const DATA_DIR = join(TEST_DIR, 'data')

function cleanup(): void {
  try { rmSync(TEST_DIR, { recursive: true, force: true }) } catch { /* ignore */ }
}

function writeJsonPlugin(name: string, def: Record<string, unknown>): void {
  writeFileSync(join(PLUGIN_DIR, `${name}.json`), JSON.stringify(def, null, 2))
}

function writeScriptPlugin(name: string, code: string): void {
  writeFileSync(join(PLUGIN_DIR, `${name}.ts`), code)
}

describe('Plugin System', () => {
  beforeEach(() => {
    cleanup()
    mkdirSync(PLUGIN_DIR, { recursive: true })
    mkdirSync(DATA_DIR, { recursive: true })
    resetPluginSystem()
  })

  afterEach(async () => {
    await shutdownPluginSystem()
    cleanup()
  })

  // ─── Initialization ─────────────────────────────────────

  test('initializes with empty directory', async () => {
    const plugins = await initPluginSystem(PLUGIN_DIR, DATA_DIR)
    expect(plugins).toHaveLength(0)
  })

  test('creates plugin directory if missing', async () => {
    const newDir = join(TEST_DIR, 'new-plugins')
    await initPluginSystem(newDir, DATA_DIR)
    expect(existsSync(newDir)).toBe(true)
  })

  // ─── JSON Plugin Loading ────────────────────────────────

  test('loads JSON plugins', async () => {
    writeJsonPlugin('hello', {
      name: 'hello_world',
      description: 'Say hello',
      command: 'echo hello',
    })

    const plugins = await initPluginSystem(PLUGIN_DIR, DATA_DIR)
    expect(plugins).toHaveLength(1)
    expect(plugins[0].name).toBe('hello_world')
    expect(plugins[0].type).toBe('json')
    expect(plugins[0].enabled).toBe(true)
  })

  test('JSON plugins provide tools', async () => {
    writeJsonPlugin('greet', {
      name: 'greet',
      description: 'Greet someone',
      command: 'echo hi {{input.name}}',
      input_schema: {
        type: 'object',
        properties: { name: { type: 'string' } },
        required: ['name'],
      },
    })

    await initPluginSystem(PLUGIN_DIR, DATA_DIR)
    const tools = getPluginTools()
    expect(tools).toHaveLength(1)
    expect(tools[0].name).toBe('greet')
  })

  test('skips invalid JSON plugins', async () => {
    writeJsonPlugin('bad', { invalid: true }) // missing name, description, command
    writeJsonPlugin('good', {
      name: 'good_plugin',
      description: 'A valid plugin',
      command: 'echo good',
    })

    const plugins = await initPluginSystem(PLUGIN_DIR, DATA_DIR)
    expect(plugins).toHaveLength(1)
    expect(plugins[0].name).toBe('good_plugin')
  })

  // ─── Script Plugin Loading ──────────────────────────────

  test('loads script plugins', async () => {
    writeScriptPlugin('weather', `
      export default {
        name: 'weather',
        description: 'Get weather info',
        version: '2.0.0',
        tools: [{
          name: 'get_weather',
          description: 'Get weather for a city',
          input_schema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
        }],
        onToolCall: async (toolName, input) => {
          return 'Sunny in ' + input.city
        },
      }
    `)

    const plugins = await initPluginSystem(PLUGIN_DIR, DATA_DIR)
    const weatherPlugin = plugins.find((p) => p.name === 'weather')
    expect(weatherPlugin).toBeDefined()
    expect(weatherPlugin!.type).toBe('script')
    expect(weatherPlugin!.version).toBe('2.0.0')
    expect(weatherPlugin!.tools).toHaveLength(1)
  })

  test('script plugin onToolCall executes', async () => {
    writeScriptPlugin('echo', `
      export default {
        name: 'echo_plugin',
        description: 'Echo input',
        version: '1.0.0',
        tools: [{
          name: 'echo_tool',
          description: 'Echo back',
          input_schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
        }],
        onToolCall: async (toolName, input) => {
          return 'Echo: ' + input.text
        },
      }
    `)

    await initPluginSystem(PLUGIN_DIR, DATA_DIR)
    const result = await executePluginTool('echo_tool', { text: 'hello' })
    expect(result).toBe('Echo: hello')
  })

  test('script plugin onLoad receives context', async () => {
    writeScriptPlugin('ctx-test', `
      export default {
        name: 'ctx_test',
        description: 'Context test',
        version: '1.0.0',
        onLoad: (ctx) => {
          if (!ctx.dataDir) throw new Error('Missing dataDir')
          if (!ctx.notify) throw new Error('Missing notify')
        },
      }
    `)

    const plugins = await initPluginSystem(PLUGIN_DIR, DATA_DIR)
    expect(plugins.find((p) => p.name === 'ctx_test')).toBeDefined()
  })

  test('skips script plugins that fail onLoad', async () => {
    writeScriptPlugin('broken', `
      export default {
        name: 'broken_plugin',
        description: 'Will fail',
        version: '1.0.0',
        onLoad: () => { throw new Error('Init failed') },
      }
    `)

    const plugins = await initPluginSystem(PLUGIN_DIR, DATA_DIR)
    expect(plugins.find((p) => p.name === 'broken_plugin')).toBeUndefined()
  })

  // ─── Enable/Disable ─────────────────────────────────────

  test('disablePlugin marks plugin as disabled', async () => {
    writeJsonPlugin('togglable', {
      name: 'togglable',
      description: 'Can be toggled',
      command: 'echo test',
    })

    await initPluginSystem(PLUGIN_DIR, DATA_DIR)
    expect(disablePlugin('togglable')).toBe(true)

    const plugin = getPlugin('togglable')
    expect(plugin?.enabled).toBe(false)
  })

  test('disabled plugins are excluded from tools', async () => {
    writeJsonPlugin('tool-plugin', {
      name: 'tool_plugin',
      description: 'Has tools',
      command: 'echo test',
    })

    await initPluginSystem(PLUGIN_DIR, DATA_DIR)
    expect(getPluginTools()).toHaveLength(1)

    disablePlugin('tool_plugin')
    expect(getPluginTools()).toHaveLength(0)
  })

  test('disablePlugin returns false for unknown plugin', async () => {
    await initPluginSystem(PLUGIN_DIR, DATA_DIR)
    expect(disablePlugin('nonexistent')).toBe(false)
  })

  test('enablePlugin re-enables a disabled plugin', async () => {
    writeJsonPlugin('reactivate', {
      name: 'reactivate',
      description: 'Will be reactivated',
      command: 'echo test',
    })

    await initPluginSystem(PLUGIN_DIR, DATA_DIR)
    disablePlugin('reactivate')
    expect(getPlugin('reactivate')?.enabled).toBe(false)

    await enablePlugin('reactivate')
    expect(getPlugin('reactivate')?.enabled).toBe(true)
  })

  // ─── Tool Execution ─────────────────────────────────────

  test('executePluginTool returns null for unknown tool', async () => {
    await initPluginSystem(PLUGIN_DIR, DATA_DIR)
    const result = await executePluginTool('nonexistent', {})
    expect(result).toBeNull()
  })

  test('executePluginTool skips disabled plugins', async () => {
    writeScriptPlugin('disabled-exec', `
      export default {
        name: 'disabled_exec',
        description: 'Should not execute',
        version: '1.0.0',
        tools: [{
          name: 'disabled_tool',
          description: 'A tool',
          input_schema: { type: 'object', properties: {}, required: [] },
        }],
        onToolCall: async () => 'should not see this',
      }
    `)

    await initPluginSystem(PLUGIN_DIR, DATA_DIR)
    disablePlugin('disabled_exec')
    const result = await executePluginTool('disabled_tool', {})
    expect(result).toBeNull()
  })

  // ─── Query ──────────────────────────────────────────────

  test('listPlugins returns all registered plugins', async () => {
    writeJsonPlugin('p1', { name: 'p1', description: 'First', command: 'echo 1' })
    writeJsonPlugin('p2', { name: 'p2', description: 'Second', command: 'echo 2' })

    await initPluginSystem(PLUGIN_DIR, DATA_DIR)
    expect(listPlugins()).toHaveLength(2)
  })

  test('getPlugin returns plugin by name', async () => {
    writeJsonPlugin('findme', { name: 'findme', description: 'Find me', command: 'echo found' })

    await initPluginSystem(PLUGIN_DIR, DATA_DIR)
    const found = getPlugin('findme')
    expect(found).toBeDefined()
    expect(found!.name).toBe('findme')
  })

  test('getPlugin returns undefined for missing plugin', async () => {
    await initPluginSystem(PLUGIN_DIR, DATA_DIR)
    expect(getPlugin('nope')).toBeUndefined()
  })

  // ─── Format ─────────────────────────────────────────────

  test('formatPluginRegistry shows empty message', async () => {
    await initPluginSystem(PLUGIN_DIR, DATA_DIR)
    const formatted = formatPluginRegistry()
    expect(formatted).toContain('Nenhum plugin')
  })

  test('formatPluginRegistry lists plugins with details', async () => {
    writeJsonPlugin('format-test', {
      name: 'format_test',
      description: 'Test formatting',
      command: 'echo test',
    })

    await initPluginSystem(PLUGIN_DIR, DATA_DIR)
    const formatted = formatPluginRegistry()
    expect(formatted).toContain('format_test')
    expect(formatted).toContain('json')
    expect(formatted).toContain('1 tool')
  })

  test('formatPluginRegistry shows disabled status', async () => {
    writeJsonPlugin('show-disabled', {
      name: 'show_disabled',
      description: 'Will be disabled',
      command: 'echo test',
    })

    await initPluginSystem(PLUGIN_DIR, DATA_DIR)
    disablePlugin('show_disabled')
    const formatted = formatPluginRegistry()
    expect(formatted).toContain('desabilitado')
  })

  // ─── Shutdown ───────────────────────────────────────────

  test('shutdown clears registry', async () => {
    writeJsonPlugin('shutdown-test', {
      name: 'shutdown_test',
      description: 'Will be cleared',
      command: 'echo test',
    })

    await initPluginSystem(PLUGIN_DIR, DATA_DIR)
    expect(listPlugins()).toHaveLength(1)

    await shutdownPluginSystem()
    expect(listPlugins()).toHaveLength(0)
  })

  // ─── Multiple plugin types ──────────────────────────────

  test('loads both JSON and script plugins together', async () => {
    writeJsonPlugin('json-one', {
      name: 'json_one',
      description: 'JSON plugin',
      command: 'echo json',
    })

    writeScriptPlugin('script-one', `
      export default {
        name: 'script_one',
        description: 'Script plugin',
        version: '1.0.0',
        tools: [{
          name: 'script_tool',
          description: 'A script tool',
          input_schema: { type: 'object', properties: {}, required: [] },
        }],
      }
    `)

    const plugins = await initPluginSystem(PLUGIN_DIR, DATA_DIR)
    expect(plugins).toHaveLength(2)

    const types = plugins.map((p) => p.type).sort()
    expect(types).toEqual(['json', 'script'])

    const tools = getPluginTools()
    expect(tools).toHaveLength(2)
  })

  // ─── GitHub Install ─────────────────────────────────────

  test('installPlugin rejects invalid source format', async () => {
    await initPluginSystem(PLUGIN_DIR, DATA_DIR)
    const result = await installPlugin('just-a-name')
    expect(result.success).toBe(false)
    expect(result.message).toContain('Fonte invalida')
  })

  test('installPlugin rejects when not initialized', async () => {
    resetPluginSystem()
    const result = await installPlugin('owner/repo')
    expect(result.success).toBe(false)
    expect(result.message).toContain('nao inicializado')
  })

  test('installPlugin prevents duplicate install', async () => {
    await initPluginSystem(PLUGIN_DIR, DATA_DIR)

    // Create a fake installed dir to simulate prior install
    const installedDir = join(PLUGIN_DIR, 'installed', 'owner--repo')
    mkdirSync(installedDir, { recursive: true })

    const result = await installPlugin('owner/repo')
    expect(result.success).toBe(false)
    expect(result.message).toContain('ja instalado')
  })

  test('installPlugin parses owner/repo format', async () => {
    await initPluginSystem(PLUGIN_DIR, DATA_DIR)
    // Will fail at git clone (no such repo) but validates parsing worked
    const result = await installPlugin('fake-owner-xyz/fake-repo-xyz')
    expect(result.success).toBe(false)
    // Should fail at clone, not at parsing
    expect(result.message).not.toContain('Fonte invalida')
  })

  test('installPlugin parses GitHub URL format', async () => {
    await initPluginSystem(PLUGIN_DIR, DATA_DIR)
    const result = await installPlugin('https://github.com/fake-owner-xyz/fake-repo-xyz')
    expect(result.success).toBe(false)
    expect(result.message).not.toContain('Fonte invalida')
  })

  test('installPlugin parses owner/repo#branch format', async () => {
    await initPluginSystem(PLUGIN_DIR, DATA_DIR)
    const result = await installPlugin('fake-owner-xyz/fake-repo-xyz#main')
    expect(result.success).toBe(false)
    expect(result.message).not.toContain('Fonte invalida')
  })

  // ─── GitHub Uninstall ───────────────────────────────────

  test('uninstallPlugin returns error for unknown plugin', async () => {
    await initPluginSystem(PLUGIN_DIR, DATA_DIR)
    const result = uninstallPlugin('nonexistent')
    expect(result.success).toBe(false)
  })

  test('uninstallPlugin rejects when not initialized', () => {
    resetPluginSystem()
    const result = uninstallPlugin('anything')
    expect(result.success).toBe(false)
    expect(result.message).toContain('nao inicializado')
  })

  test('uninstallPlugin removes installed directory', async () => {
    await initPluginSystem(PLUGIN_DIR, DATA_DIR)

    // Simulate an installed plugin
    const installedDir = join(PLUGIN_DIR, 'installed', 'owner--repo')
    mkdirSync(installedDir, { recursive: true })
    writeFileSync(join(installedDir, '.smolerclaw-install.json'), JSON.stringify({
      source: 'owner/repo',
      pluginName: 'my_plugin',
      entryPoint: join(PLUGIN_DIR, 'owner--repo.json'),
      installedAt: new Date().toISOString(),
    }))

    const result = uninstallPlugin('owner/repo')
    expect(result.success).toBe(true)
    expect(existsSync(installedDir)).toBe(false)
  })

  // ─── List Installed ─────────────────────────────────────

  test('listInstalledPlugins returns empty with no installs', async () => {
    await initPluginSystem(PLUGIN_DIR, DATA_DIR)
    expect(listInstalledPlugins()).toHaveLength(0)
  })

  test('listInstalledPlugins returns installed metadata', async () => {
    await initPluginSystem(PLUGIN_DIR, DATA_DIR)

    const installedDir = join(PLUGIN_DIR, 'installed', 'user--cool-plugin')
    mkdirSync(installedDir, { recursive: true })
    writeFileSync(join(installedDir, '.smolerclaw-install.json'), JSON.stringify({
      source: 'user/cool-plugin',
      pluginName: 'cool_plugin',
      installedAt: '2026-04-01T12:00:00.000Z',
    }))

    const installed = listInstalledPlugins()
    expect(installed).toHaveLength(1)
    expect(installed[0].name).toBe('cool_plugin')
    expect(installed[0].source).toBe('user/cool-plugin')
  })
})
