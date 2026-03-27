import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import {
  initVault, isVaultInitialized, atomicWriteFile, writeJson, readJson,
  getVaultStatus, formatVaultStatus, initShadowBackup, performBackup,
  getBackupDir,
} from '../src/vault'

const TEST_DIR = join(tmpdir(), `smolerclaw-vault-test-${Date.now()}`)
const CONFIG_DIR = join(TEST_DIR, 'config')

function cleanup(): void {
  try { rmSync(TEST_DIR, { recursive: true, force: true }) } catch { /* ignore */ }
}

describe('Vault — Core', () => {
  beforeEach(() => {
    cleanup()
    mkdirSync(TEST_DIR, { recursive: true })
    mkdirSync(CONFIG_DIR, { recursive: true })
    initVault(TEST_DIR, CONFIG_DIR)
  })

  afterEach(() => {
    cleanup()
  })

  test('initVault sets initialized state', () => {
    expect(isVaultInitialized()).toBe(true)
  })

  // ─── Atomic Writes ──────────────────────────────────────

  test('atomicWriteFile creates file', () => {
    const path = join(TEST_DIR, 'test.txt')
    atomicWriteFile(path, 'hello world')
    expect(existsSync(path)).toBe(true)
    expect(readFileSync(path, 'utf-8')).toBe('hello world')
  })

  test('atomicWriteFile overwrites existing file', () => {
    const path = join(TEST_DIR, 'overwrite.txt')
    atomicWriteFile(path, 'first')
    atomicWriteFile(path, 'second')
    expect(readFileSync(path, 'utf-8')).toBe('second')
  })

  test('atomicWriteFile creates parent directories', () => {
    const path = join(TEST_DIR, 'sub', 'dir', 'deep.txt')
    atomicWriteFile(path, 'deep content')
    expect(readFileSync(path, 'utf-8')).toBe('deep content')
  })

  test('atomicWriteFile leaves no .tmp files', () => {
    const path = join(TEST_DIR, 'notmp.txt')
    atomicWriteFile(path, 'content')
    const files = require('fs').readdirSync(TEST_DIR) as string[]
    const tmpFiles = files.filter((f: string) => f.endsWith('.tmp'))
    expect(tmpFiles.length).toBe(0)
  })

  // ─── JSON Read/Write ───────────────────────────────────

  test('writeJson + readJson roundtrip', () => {
    const path = join(TEST_DIR, 'data.json')
    const data = { name: 'test', items: [1, 2, 3] }
    writeJson(path, data)
    const loaded = readJson(path, null)
    expect(loaded).toEqual(data)
  })

  test('readJson returns fallback for missing file', () => {
    const result = readJson(join(TEST_DIR, 'nonexistent.json'), { default: true })
    expect(result).toEqual({ default: true })
  })

  test('readJson returns fallback for corrupted JSON', () => {
    const path = join(TEST_DIR, 'corrupt.json')
    writeFileSync(path, '{ invalid json }}}')
    const result = readJson(path, [])
    expect(result).toEqual([])
  })

  test('readJson works with valid JSON from external write', () => {
    const path = join(TEST_DIR, 'external.json')
    writeFileSync(path, JSON.stringify({ external: true }))
    const result = readJson(path, null)
    expect(result).toEqual({ external: true })
  })

  // ─── Checksum Tracking ─────────────────────────────────

  test('atomicWriteFile updates checksum for tracked files', () => {
    const path = join(TEST_DIR, 'memos.json')
    const data = JSON.stringify([{ id: '1', content: 'test' }])
    atomicWriteFile(path, data)

    // Read checksum store
    const checksumFile = join(TEST_DIR, 'vault-checksums.json')
    expect(existsSync(checksumFile)).toBe(true)

    const store = JSON.parse(readFileSync(checksumFile, 'utf-8'))
    const record = store.checksums.find((c: { file: string }) => c.file === 'memos.json')
    expect(record).toBeTruthy()
    expect(record.sha256).toBe(createHash('sha256').update(data).digest('hex'))
  })

  test('checksum not tracked for non-tracked files', () => {
    const path = join(TEST_DIR, 'random-file.txt')
    atomicWriteFile(path, 'not tracked')

    const checksumFile = join(TEST_DIR, 'vault-checksums.json')
    if (existsSync(checksumFile)) {
      const store = JSON.parse(readFileSync(checksumFile, 'utf-8'))
      const record = store.checksums.find((c: { file: string }) => c.file === 'random-file.txt')
      expect(record).toBeUndefined()
    }
  })

  // ─── Vault Status ──────────────────────────────────────

  test('getVaultStatus returns file list', () => {
    const status = getVaultStatus()
    expect(status.totalFiles).toBeGreaterThanOrEqual(0)
    expect(status.files.length).toBeGreaterThan(0)
    expect(status.backupEnabled).toBe(false)
  })

  test('getVaultStatus reports existing files', () => {
    writeJson(join(TEST_DIR, 'memos.json'), [])
    writeJson(join(TEST_DIR, 'tasks.json'), [])

    const status = getVaultStatus()
    const memos = status.files.find((f) => f.file === 'memos.json')
    expect(memos).toBeTruthy()
    expect(memos!.exists).toBe(true)
    expect(memos!.size).toBeGreaterThan(0)
  })

  test('getVaultStatus detects checksum validity', () => {
    const path = join(TEST_DIR, 'memos.json')
    atomicWriteFile(path, '[]') // tracked file -> checksum saved

    const status = getVaultStatus()
    const memos = status.files.find((f) => f.file === 'memos.json')
    expect(memos).toBeTruthy()
    expect(memos!.checksumValid).toBe(true)
  })

  test('getVaultStatus detects corrupted checksum', () => {
    const path = join(TEST_DIR, 'memos.json')
    atomicWriteFile(path, '[]') // saves checksum for '[]'

    // Externally modify file without updating checksum
    writeFileSync(path, '[{"modified": true}]')

    const status = getVaultStatus()
    const memos = status.files.find((f) => f.file === 'memos.json')
    expect(memos).toBeTruthy()
    // Checksum won't match since file was modified externally
    expect(memos!.checksumValid).toBe(false)
  })

  test('formatVaultStatus produces readable output', () => {
    atomicWriteFile(join(TEST_DIR, 'memos.json'), '[]')
    const status = getVaultStatus()
    const text = formatVaultStatus(status)
    expect(text).toContain('Vault Status')
    expect(text).toContain('Integridade')
    expect(text).toContain('memos.json')
  })

  test('getVaultStatus shows corruptFiles count 0 when all good', () => {
    atomicWriteFile(join(TEST_DIR, 'memos.json'), '[]')
    atomicWriteFile(join(TEST_DIR, 'tasks.json'), '[]')
    const status = getVaultStatus()
    expect(status.corruptFiles).toBe(0)
  })

  // ─── Checksums persist across re-init ──────────────────

  test('checksums persist across re-init', () => {
    atomicWriteFile(join(TEST_DIR, 'memos.json'), '["data"]')

    // Re-init
    initVault(TEST_DIR, CONFIG_DIR)

    const status = getVaultStatus()
    const memos = status.files.find((f) => f.file === 'memos.json')
    expect(memos!.checksumValid).toBe(true)
  })
})

describe('Vault — Shadow Backup', () => {
  beforeEach(() => {
    cleanup()
    mkdirSync(TEST_DIR, { recursive: true })
    mkdirSync(CONFIG_DIR, { recursive: true })
    initVault(TEST_DIR, CONFIG_DIR)
  })

  afterEach(() => {
    cleanup()
  })

  test('initShadowBackup creates git repo', async () => {
    const result = await initShadowBackup()
    expect(result).toContain('inicializado')
    expect(existsSync(join(getBackupDir(), '.git'))).toBe(true)
    expect(existsSync(join(getBackupDir(), '.gitignore'))).toBe(true)
  })

  test('initShadowBackup creates .gitignore with security patterns', async () => {
    await initShadowBackup()
    const gitignore = readFileSync(join(getBackupDir(), '.gitignore'), 'utf-8')
    expect(gitignore).toContain('credentials.json')
    expect(gitignore).toContain('.tmp')
  })

  test('performBackup commits tracked files', async () => {
    await initShadowBackup()

    // Create some data
    atomicWriteFile(join(TEST_DIR, 'memos.json'), JSON.stringify([{ id: '1' }]))
    atomicWriteFile(join(TEST_DIR, 'tasks.json'), JSON.stringify([]))

    const result = await performBackup('test backup')
    expect(result).toContain('Backup concluido')
  })

  test('performBackup reports no changes', async () => {
    await initShadowBackup()

    // First backup
    atomicWriteFile(join(TEST_DIR, 'memos.json'), '[]')
    await performBackup('first')

    // Second backup with no changes
    const result = await performBackup('second')
    expect(result).toContain('Nenhuma mudanca')
  })

  test('performBackup fails gracefully without init', async () => {
    const result = await performBackup()
    expect(result).toContain('nao ativado')
  })

  test('vault status reflects backup state after init', async () => {
    await initShadowBackup()
    atomicWriteFile(join(TEST_DIR, 'memos.json'), '[]')
    await performBackup()

    // Re-init to pick up backup state
    initVault(TEST_DIR, CONFIG_DIR)
    const status = getVaultStatus()
    expect(status.backupEnabled).toBe(true)
    expect(status.lastBackup).toBeTruthy()
  })
})
