import { existsSync, mkdirSync, readFileSync, readdirSync, copyFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { IS_WINDOWS } from './platform'
import type { SmolerclawConfig } from './types'
import { atomicWriteFile } from './vault'

const HOME = homedir()

// Default platform-aware directories
const DEFAULT_CONFIG_DIR = IS_WINDOWS
  ? join(process.env.APPDATA || join(HOME, 'AppData', 'Roaming'), 'smolerclaw')
  : join(HOME, '.config', 'smolerclaw')

const DEFAULT_DATA_DIR = IS_WINDOWS
  ? join(process.env.LOCALAPPDATA || join(HOME, 'AppData', 'Local'), 'smolerclaw')
  : join(HOME, '.local', 'share', 'smolerclaw')

const DEFAULTS: SmolerclawConfig = {
  model: 'claude-haiku-4-5-20251001',
  maxTokens: 4096,
  maxHistory: 50,
  systemPrompt: '',
  skillsDir: './skills',
  dataDir: DEFAULT_DATA_DIR,
  toolApproval: 'auto',
  language: 'auto',
  maxSessionCost: 0,
  obsidianVault: '',
}

function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
}

export function getConfigDir(env: Record<string, string | undefined> = process.env): string {
  const override = env.SMOLERCLAW_CONFIG_DIR?.trim()
  return override ? resolve(override) : DEFAULT_CONFIG_DIR
}

export function getDataDir(env: Record<string, string | undefined> = process.env): string {
  const override = env.SMOLERCLAW_DATA_DIR?.trim()
  return override ? resolve(override) : DEFAULT_DATA_DIR
}

export function getConfigPath(env: Record<string, string | undefined> = process.env): string {
  return join(getConfigDir(env), 'config.json')
}

export function loadConfig(env: Record<string, string | undefined> = process.env): SmolerclawConfig {
  const dataDirOverride = env.SMOLERCLAW_DATA_DIR?.trim()
  const configDirOverride = env.SMOLERCLAW_CONFIG_DIR?.trim()
  const configDir = getConfigDir(env)
  const dataDir = getDataDir(env)
  const configFile = join(configDir, 'config.json')

  ensureDir(dataDir)
  ensureDir(join(dataDir, 'sessions'))

  // Isolated harness run: SMOLERCLAW_DATA_DIR set without a custom config dir
  // must not touch the user's real %APPDATA%/smolerclaw/config.json.
  if (dataDirOverride && !configDirOverride) {
    return { ...DEFAULTS, dataDir }
  }

  ensureDir(configDir)

  // Migrate from old Linux-style paths on Windows if they exist
  if (IS_WINDOWS && !configDirOverride) {
    migrateOldPaths(configDir, configFile)
  }

  if (!existsSync(configFile)) {
    const initial = { ...DEFAULTS, dataDir }
    atomicWriteFile(configFile, JSON.stringify(initial, null, 2))
    return initial
  }

  let raw: Record<string, unknown>
  try {
    raw = JSON.parse(readFileSync(configFile, 'utf-8'))
  } catch {
    // Config file corrupted — reset to defaults
    const initial = { ...DEFAULTS, dataDir }
    atomicWriteFile(configFile, JSON.stringify(initial, null, 2))
    return initial
  }
  const validated = validateConfig({ ...DEFAULTS, ...raw })
  if (dataDirOverride) validated.dataDir = dataDir
  return validated
}

function validateConfig(config: Record<string, unknown>): SmolerclawConfig {
  const validated = { ...DEFAULTS }

  if (typeof config.model === 'string' && config.model.trim()) {
    validated.model = config.model
  }
  if (typeof config.maxTokens === 'number' && config.maxTokens > 0 && config.maxTokens <= 100_000) {
    validated.maxTokens = config.maxTokens
  }
  if (typeof config.maxHistory === 'number' && config.maxHistory > 0 && config.maxHistory <= 1000) {
    validated.maxHistory = config.maxHistory
  }
  if (typeof config.systemPrompt === 'string') {
    validated.systemPrompt = config.systemPrompt
  }
  if (typeof config.skillsDir === 'string' && config.skillsDir.trim()) {
    validated.skillsDir = config.skillsDir
  }
  if (typeof config.dataDir === 'string' && config.dataDir.trim()) {
    validated.dataDir = config.dataDir
  }
  const validModes: Array<SmolerclawConfig['toolApproval']> = ['auto', 'confirm-writes', 'confirm-all']
  if (typeof config.toolApproval === 'string' && validModes.includes(config.toolApproval as SmolerclawConfig['toolApproval'])) {
    validated.toolApproval = config.toolApproval as SmolerclawConfig['toolApproval']
  }
  if (typeof config.language === 'string') {
    validated.language = config.language
  }
  if (typeof config.maxSessionCost === 'number' && config.maxSessionCost >= 0) {
    validated.maxSessionCost = config.maxSessionCost
  }
  if (typeof config.obsidianVault === 'string') {
    validated.obsidianVault = config.obsidianVault
  }

  return validated
}

export function saveConfig(config: SmolerclawConfig, env: Record<string, string | undefined> = process.env): void {
  const configDir = getConfigDir(env)
  ensureDir(configDir)
  atomicWriteFile(join(configDir, 'config.json'), JSON.stringify(config, null, 2))
}

/** One-time migration from old ~/.config/smolerclaw paths on Windows */
function migrateOldPaths(configDir: string, configFile: string): void {
  const oldConfigDir = join(HOME, '.config', 'smolerclaw')

  // Migrate config.json
  const oldConfig = join(oldConfigDir, 'config.json')
  if (existsSync(oldConfig) && !existsSync(configFile)) {
    try {
      const data = readFileSync(oldConfig, 'utf-8')
      ensureDir(configDir)
      atomicWriteFile(configFile, data)
    } catch { /* best effort */ }
  }

  // Migrate subdirectories (plugins, materials) from old path
  for (const subdir of ['plugins', 'materials']) {
    const oldDir = join(oldConfigDir, subdir)
    const newDir = join(configDir, subdir)
    if (existsSync(oldDir) && (!existsSync(newDir) || isEmptyDir(newDir))) {
      try {
        copyDirRecursive(oldDir, newDir)
      } catch { /* best effort */ }
    }
  }
}

function isEmptyDir(dir: string): boolean {
  try {
    return readdirSync(dir).length === 0
  } catch {
    return true
  }
}

function copyDirRecursive(src: string, dest: string): void {
  ensureDir(dest)
  const entries = readdirSync(src, { withFileTypes: true })
  for (const entry of entries) {
    const srcPath = join(src, entry.name)
    const destPath = join(dest, entry.name)
    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, destPath)
    } else if (entry.isFile()) {
      copyFileSync(srcPath, destPath)
    }
  }
}
