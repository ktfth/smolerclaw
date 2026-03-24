import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { IS_WINDOWS } from './platform'
import type { TinyClawConfig } from './types'

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
    writeFileSync(CONFIG_FILE, JSON.stringify(DEFAULTS, null, 2))
    return { ...DEFAULTS }
  }

  let raw: Record<string, unknown>
  try {
    raw = JSON.parse(readFileSync(CONFIG_FILE, 'utf-8'))
  } catch {
    // Config file corrupted — reset to defaults
    writeFileSync(CONFIG_FILE, JSON.stringify(DEFAULTS, null, 2))
    return { ...DEFAULTS }
  }
  return { ...DEFAULTS, ...raw }
}

export function saveConfig(config: TinyClawConfig): void {
  ensureDir(CONFIG_DIR)
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2))
}

export function getConfigPath(): string {
  return CONFIG_FILE
}

export function getDataDir(): string {
  return DATA_DIR
}

/** One-time migration from old ~/.config/smolerclaw paths on Windows */
function migrateOldPaths(): void {
  const oldConfig = join(HOME, '.config', 'smolerclaw', 'config.json')
  if (existsSync(oldConfig) && !existsSync(CONFIG_FILE)) {
    try {
      const data = readFileSync(oldConfig, 'utf-8')
      ensureDir(CONFIG_DIR)
      writeFileSync(CONFIG_FILE, data)
    } catch { /* best effort */ }
  }
}
