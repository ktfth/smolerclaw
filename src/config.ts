import { existsSync, mkdirSync, readFileSync, readdirSync, copyFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { IS_WINDOWS } from './platform'
import type { TinyClawConfig } from './types'
import { atomicWriteFile } from './vault'

const HOME = homedir()

// Platform-aware directories
const CONFIG_DIR = IS_WINDOWS
  ? join(process.env.APPDATA || join(HOME, 'AppData', 'Roaming'), 'smolerclaw')
  : join(HOME, '.config', 'smolerclaw')

const DATA_DIR = IS_WINDOWS
  ? join(process.env.LOCALAPPDATA || join(HOME, 'AppData', 'Local'), 'smolerclaw')
  : join(HOME, '.local', 'share', 'smolerclaw')

const CONFIG_FILE = join(CONFIG_DIR, 'config.json')

const DEFAULTS: TinyClawConfig = {
  model: 'claude-haiku-4-5-20251001',
  maxTokens: 4096,
  maxHistory: 50,
  systemPrompt: '',
  skillsDir: './skills',
  dataDir: DATA_DIR,
  toolApproval: 'auto',
  language: 'auto',
  maxSessionCost: 0,
}

function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
}

export function loadConfig(): TinyClawConfig {
  ensureDir(CONFIG_DIR)
  ensureDir(DATA_DIR)
  ensureDir(join(DATA_DIR, 'sessions'))

  // Migrate from old Linux-style paths on Windows if they exist
  if (IS_WINDOWS) {
    migrateOldPaths()
  }

  if (!existsSync(CONFIG_FILE)) {
    atomicWriteFile(CONFIG_FILE, JSON.stringify(DEFAULTS, null, 2))
    return { ...DEFAULTS }
  }

  let raw: Record<string, unknown>
  try {
    raw = JSON.parse(readFileSync(CONFIG_FILE, 'utf-8'))
  } catch {
    // Config file corrupted — reset to defaults
    atomicWriteFile(CONFIG_FILE, JSON.stringify(DEFAULTS, null, 2))
    return { ...DEFAULTS }
  }
  return validateConfig({ ...DEFAULTS, ...raw })
}

function validateConfig(config: Record<string, unknown>): TinyClawConfig {
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
  const validModes: Array<TinyClawConfig['toolApproval']> = ['auto', 'confirm-writes', 'confirm-all']
  if (typeof config.toolApproval === 'string' && validModes.includes(config.toolApproval as TinyClawConfig['toolApproval'])) {
    validated.toolApproval = config.toolApproval as TinyClawConfig['toolApproval']
  }
  if (typeof config.language === 'string') {
    validated.language = config.language
  }
  if (typeof config.maxSessionCost === 'number' && config.maxSessionCost >= 0) {
    validated.maxSessionCost = config.maxSessionCost
  }

  return validated
}

export function saveConfig(config: TinyClawConfig): void {
  ensureDir(CONFIG_DIR)
  atomicWriteFile(CONFIG_FILE, JSON.stringify(config, null, 2))
}

export function getConfigPath(): string {
  return CONFIG_FILE
}

export function getDataDir(): string {
  return DATA_DIR
}

export function getConfigDir(): string {
  return CONFIG_DIR
}

/** One-time migration from old ~/.config/smolerclaw paths on Windows */
function migrateOldPaths(): void {
  const oldConfigDir = join(HOME, '.config', 'smolerclaw')

  // Migrate config.json
  const oldConfig = join(oldConfigDir, 'config.json')
  if (existsSync(oldConfig) && !existsSync(CONFIG_FILE)) {
    try {
      const data = readFileSync(oldConfig, 'utf-8')
      ensureDir(CONFIG_DIR)
      atomicWriteFile(CONFIG_FILE, data)
    } catch { /* best effort */ }
  }

  // Migrate subdirectories (plugins, materials) from old path
  for (const subdir of ['plugins', 'materials']) {
    const oldDir = join(oldConfigDir, subdir)
    const newDir = join(CONFIG_DIR, subdir)
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
