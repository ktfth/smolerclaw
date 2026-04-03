/**
 * Macros — quick program launchers for workstation productivity.
 *
 * Macros provide one-command access to frequently used programs, URLs,
 * and commands. Unlike workflows, macros execute a single action instantly.
 *
 * Actions:
 * - open_app: Launch a program by name
 * - open_url: Open a URL in default browser
 * - open_file: Open a file with default application
 * - run_command: Execute a PowerShell command
 *
 * Storage: %LOCALAPPDATA%/smolerclaw/macros.json
 */

import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { atomicWriteFile } from './vault'
import { openApp, openFile, openUrl } from './windows'
import { IS_WINDOWS } from './platform'
import { executePowerShell } from './utils/windows-executor'

// ─── Types ──────────────────────────────────────────────────

export type MacroAction = 'open_app' | 'open_url' | 'open_file' | 'run_command'

export interface Macro {
  id: string
  name: string
  description: string
  action: MacroAction
  target: string              // app name, URL, file path, or command
  args?: string               // optional arguments (for apps/commands)
  icon?: string               // optional emoji for display
  tags: string[]
  enabled: boolean
  createdAt: string
  updatedAt: string
}

export interface MacroRunResult {
  macro: string
  success: boolean
  message: string
  duration: number
}

// ─── Storage ────────────────────────────────────────────────

let _dataDir = ''
let _macros: Macro[] = []

const DATA_FILE = () => join(_dataDir, 'macros.json')

function save(): void {
  atomicWriteFile(DATA_FILE(), JSON.stringify(_macros, null, 2))
}

function load(): void {
  const file = DATA_FILE()
  if (!existsSync(file)) {
    _macros = seedDefaults()
    save()
    return
  }
  try {
    const data = JSON.parse(readFileSync(file, 'utf-8'))
    if (!Array.isArray(data)) {
      _macros = seedDefaults()
      save()
      return
    }
    // Migrate/validate data
    _macros = data.map((m: Record<string, unknown>) => ({
      id: (m.id as string) || genId(),
      name: (m.name as string) || 'unnamed',
      description: (m.description as string) || '',
      action: (m.action as MacroAction) || 'open_app',
      target: (m.target as string) || '',
      args: m.args as string | undefined,
      icon: m.icon as string | undefined,
      tags: Array.isArray(m.tags) ? m.tags : [],
      enabled: m.enabled !== false,
      createdAt: (m.createdAt as string) || new Date().toISOString(),
      updatedAt: (m.updatedAt as string) || new Date().toISOString(),
    }))
  } catch {
    _macros = seedDefaults()
    save()
  }
}

function seedDefaults(): Macro[] {
  const now = new Date().toISOString()
  return [
    // Productivity apps
    {
      id: genId(),
      name: 'vscode',
      description: 'Abrir VS Code',
      action: 'open_app',
      target: 'vscode',
      icon: '💻',
      tags: ['dev', 'editor'],
      enabled: true,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: genId(),
      name: 'terminal',
      description: 'Abrir Terminal Windows',
      action: 'open_app',
      target: 'terminal',
      icon: '⌨️',
      tags: ['dev', 'terminal'],
      enabled: true,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: genId(),
      name: 'excel',
      description: 'Abrir Microsoft Excel',
      action: 'open_app',
      target: 'excel',
      icon: '📊',
      tags: ['office', 'planilha'],
      enabled: true,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: genId(),
      name: 'word',
      description: 'Abrir Microsoft Word',
      action: 'open_app',
      target: 'word',
      icon: '📝',
      tags: ['office', 'documento'],
      enabled: true,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: genId(),
      name: 'outlook',
      description: 'Abrir Microsoft Outlook',
      action: 'open_app',
      target: 'outlook',
      icon: '📧',
      tags: ['office', 'email'],
      enabled: true,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: genId(),
      name: 'teams',
      description: 'Abrir Microsoft Teams',
      action: 'open_app',
      target: 'teams',
      icon: '💬',
      tags: ['office', 'comunicacao'],
      enabled: true,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: genId(),
      name: 'edge',
      description: 'Abrir Microsoft Edge',
      action: 'open_app',
      target: 'edge',
      icon: '🌐',
      tags: ['browser', 'web'],
      enabled: true,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: genId(),
      name: 'chrome',
      description: 'Abrir Google Chrome',
      action: 'open_app',
      target: 'chrome',
      icon: '🔵',
      tags: ['browser', 'web'],
      enabled: true,
      createdAt: now,
      updatedAt: now,
    },
    // System utilities
    {
      id: genId(),
      name: 'explorer',
      description: 'Abrir Explorador de Arquivos',
      action: 'open_app',
      target: 'explorer',
      icon: '📁',
      tags: ['sistema', 'arquivos'],
      enabled: true,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: genId(),
      name: 'calc',
      description: 'Abrir Calculadora',
      action: 'open_app',
      target: 'calculator',
      icon: '🔢',
      tags: ['sistema', 'utilitario'],
      enabled: true,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: genId(),
      name: 'notepad',
      description: 'Abrir Bloco de Notas',
      action: 'open_app',
      target: 'notepad',
      icon: '📄',
      tags: ['editor', 'texto'],
      enabled: true,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: genId(),
      name: 'tarefas',
      description: 'Abrir Gerenciador de Tarefas',
      action: 'open_app',
      target: 'taskmanager',
      icon: '📋',
      tags: ['sistema', 'monitor'],
      enabled: true,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: genId(),
      name: 'settings',
      description: 'Abrir Configuracoes do Windows',
      action: 'open_app',
      target: 'settings',
      icon: '⚙️',
      tags: ['sistema', 'config'],
      enabled: true,
      createdAt: now,
      updatedAt: now,
    },
    // Web shortcuts
    {
      id: genId(),
      name: 'github',
      description: 'Abrir GitHub',
      action: 'open_url',
      target: 'https://github.com',
      icon: '🐙',
      tags: ['dev', 'web'],
      enabled: true,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: genId(),
      name: 'claude',
      description: 'Abrir Claude.ai',
      action: 'open_url',
      target: 'https://claude.ai',
      icon: '🤖',
      tags: ['ia', 'web'],
      enabled: true,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: genId(),
      name: 'chatgpt',
      description: 'Abrir ChatGPT',
      action: 'open_url',
      target: 'https://chat.openai.com',
      icon: '💬',
      tags: ['ia', 'web'],
      enabled: true,
      createdAt: now,
      updatedAt: now,
    },
  ]
}

// ─── Init ───────────────────────────────────────────────────

export function initMacros(dataDir: string): void {
  _dataDir = dataDir
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true })
  load()
}

// ─── CRUD ───────────────────────────────────────────────────

export function getMacro(nameOrId: string): Macro | null {
  const lower = nameOrId.toLowerCase().trim()
  return (
    _macros.find((m) => m.id === nameOrId) ||
    _macros.find((m) => m.name.toLowerCase() === lower) ||
    _macros.find((m) => m.name.toLowerCase().includes(lower)) ||
    null
  )
}

export function listMacros(tag?: string): Macro[] {
  let result = [..._macros]
  if (tag) {
    const lower = tag.toLowerCase()
    result = result.filter((m) => m.tags.some((t) => t.toLowerCase() === lower))
  }
  return result.filter((m) => m.enabled)
}

export function listAllMacros(): Macro[] {
  return [..._macros]
}

export function createMacro(
  name: string,
  description: string,
  action: MacroAction,
  target: string,
  options?: { args?: string; icon?: string; tags?: string[] },
): Macro {
  const now = new Date().toISOString()
  // Remove existing with same name
  _macros = _macros.filter((m) => m.name.toLowerCase() !== name.toLowerCase().trim())
  const macro: Macro = {
    id: genId(),
    name: name.toLowerCase().trim(),
    description: description.trim(),
    action,
    target: target.trim(),
    args: options?.args,
    icon: options?.icon,
    tags: (options?.tags || []).map((t) => t.toLowerCase().trim()).filter(Boolean),
    enabled: true,
    createdAt: now,
    updatedAt: now,
  }
  _macros = [..._macros, macro]
  save()
  return macro
}

export function updateMacro(
  nameOrId: string,
  updates: Partial<Pick<Macro, 'description' | 'target' | 'args' | 'icon' | 'tags' | 'enabled'>>,
): Macro | null {
  const found = getMacro(nameOrId)
  if (!found) return null

  _macros = _macros.map((m) =>
    m.id === found.id
      ? { ...m, ...updates, updatedAt: new Date().toISOString() }
      : m,
  )
  save()
  return _macros.find((m) => m.id === found.id) || null
}

export function deleteMacro(nameOrId: string): boolean {
  const found = getMacro(nameOrId)
  if (!found) return false
  _macros = _macros.filter((m) => m.id !== found.id)
  save()
  return true
}

// ─── Execution ──────────────────────────────────────────────

/**
 * Execute a macro. Returns result with success status and message.
 */
export async function runMacro(nameOrId: string): Promise<MacroRunResult> {
  const start = performance.now()
  const macro = getMacro(nameOrId)

  if (!macro) {
    // Check if the input matches a tag instead of a macro name
    const lower = nameOrId.toLowerCase().trim()
    const tagMatches = _macros.filter(
      (m) => m.enabled && m.tags.some((t) => t === lower),
    )
    if (tagMatches.length > 0) {
      const names = tagMatches.map((m) => m.name).join(', ')
      return {
        macro: nameOrId,
        success: false,
        message: `"${nameOrId}" e uma tag, nao um macro. Macros com tag "${nameOrId}": ${names}`,
        duration: Math.round(performance.now() - start),
      }
    }
    const available = _macros.filter((m) => m.enabled).map((m) => m.name).join(', ')
    return {
      macro: nameOrId,
      success: false,
      message: `Macro nao encontrado: "${nameOrId}". Disponiveis: ${available}`,
      duration: Math.round(performance.now() - start),
    }
  }

  if (!macro.enabled) {
    return {
      macro: macro.name,
      success: false,
      message: `Macro "${macro.name}" esta desativado.`,
      duration: Math.round(performance.now() - start),
    }
  }

  try {
    const result = await executeMacroAction(macro)
    return {
      macro: macro.name,
      success: true,
      message: result,
      duration: Math.round(performance.now() - start),
    }
  } catch (err) {
    return {
      macro: macro.name,
      success: false,
      message: `Erro: ${err instanceof Error ? err.message : String(err)}`,
      duration: Math.round(performance.now() - start),
    }
  }
}

async function executeMacroAction(macro: Macro): Promise<string> {
  switch (macro.action) {
    case 'open_app': {
      if (!IS_WINDOWS) return `skip: ${macro.target} (not Windows)`
      const result = await openApp(macro.target, macro.args)
      return result
    }

    case 'open_url': {
      if (!IS_WINDOWS) return `skip: ${macro.target} (not Windows)`
      const url = macro.target.trim()
      if (!url.startsWith('http://') && !url.startsWith('https://')) {
        throw new Error(`URL invalida (deve comecar com http/https): ${url}`)
      }
      const result = await openUrl(url)
      return result
    }

    case 'open_file': {
      if (!IS_WINDOWS) return `skip: ${macro.target} (not Windows)`
      const result = await openFile(macro.target)
      return result
    }

    case 'run_command': {
      if (!IS_WINDOWS) return `skip: command (not Windows)`
      const cmd = macro.args ? `${macro.target} ${macro.args}` : macro.target
      if (!cmd.trim()) throw new Error('Comando vazio')

      const result = await executePowerShell(cmd, { timeout: 30_000 })

      if (result.timedOut) {
        throw new Error('Command timeout (30s)')
      }
      if (result.exitCode !== 0 && result.stderr.trim()) {
        throw new Error(`exit ${result.exitCode}: ${result.stderr.trim().slice(0, 200)}`)
      }

      const output = result.stdout.trim().slice(0, 200)
      return `Command: ${cmd.slice(0, 60)}${output ? ' -> ' + output : ''}`
    }

    default:
      throw new Error(`Acao desconhecida: ${macro.action}`)
  }
}

// ─── Formatting ─────────────────────────────────────────────

export function formatMacroList(macros?: Macro[]): string {
  const list = macros || _macros.filter((m) => m.enabled)
  if (list.length === 0) return 'Nenhum macro configurado.'

  // Group by tags for better organization
  const byTag: Record<string, Macro[]> = {}
  const noTag: Macro[] = []

  for (const m of list) {
    if (m.tags.length === 0) {
      noTag.push(m)
    } else {
      const primaryTag = m.tags[0]
      if (!byTag[primaryTag]) byTag[primaryTag] = []
      byTag[primaryTag].push(m)
    }
  }

  const lines: string[] = [`Macros (${list.length}):`]

  // Sort tags alphabetically
  const tags = Object.keys(byTag).sort()

  for (const tag of tags) {
    lines.push(`\n  [${tag}]`)
    for (const m of byTag[tag]) {
      const icon = m.icon || '▸'
      const status = m.enabled ? '' : ' (desativado)'
      lines.push(`    ${icon} ${m.name.padEnd(12)} ${m.description}${status}`)
    }
  }

  if (noTag.length > 0) {
    lines.push('\n  [outros]')
    for (const m of noTag) {
      const icon = m.icon || '▸'
      const status = m.enabled ? '' : ' (desativado)'
      lines.push(`    ${icon} ${m.name.padEnd(12)} ${m.description}${status}`)
    }
  }

  lines.push('\nUso: /macro <nome> para executar')
  return lines.join('\n')
}

export function formatMacroDetail(macro: Macro): string {
  const status = macro.enabled ? 'ativo' : 'desativado'
  const tags = macro.tags.length > 0 ? `Tags: ${macro.tags.map((t) => `#${t}`).join(' ')}` : ''
  const lines: string[] = [
    `--- Macro {${macro.id}} ---`,
    `Nome: ${macro.icon || ''} ${macro.name}`,
    `Descricao: ${macro.description}`,
    `Acao: ${macro.action}`,
    `Target: ${macro.target}`,
  ]
  if (macro.args) lines.push(`Args: ${macro.args}`)
  lines.push(`Status: ${status}`)
  if (tags) lines.push(tags)
  lines.push(`Criado: ${new Date(macro.createdAt).toLocaleDateString('pt-BR')}`)
  return lines.join('\n')
}

export function getMacroNames(): string[] {
  return _macros.filter((m) => m.enabled).map((m) => m.name)
}

// ─── Helpers ────────────────────────────────────────────────

function genId(): string {
  return randomUUID().slice(0, 8)
}
