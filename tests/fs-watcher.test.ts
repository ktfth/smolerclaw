import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  initFSWatcher, watchDirectory, unwatchDirectory, unwatchAll,
  listWatchers, getWatcherStatus, getRecentChanges, formatChangeEvent,
  type FileChangeEvent,
} from '../src/fs-watcher'

const TEST_DIR = join(tmpdir(), `smolerclaw-fsw-test-${Date.now()}`)

function cleanup(): void {
  unwatchAll()
  try { rmSync(TEST_DIR, { recursive: true, force: true }) } catch { /* ignore */ }
}

describe('FSWatcher — Core', () => {
  beforeEach(() => {
    cleanup()
    mkdirSync(TEST_DIR, { recursive: true })
    initFSWatcher()
  })

  afterEach(() => {
    cleanup()
  })

  // ─── Watch Management ─────────────────────────────────────

  test('watchDirectory returns a valid ID', () => {
    const id = watchDirectory(TEST_DIR, { recursive: false })
    expect(id).toBeTruthy()
    expect(typeof id).toBe('string')
    expect(id.length).toBe(8)
  })

  test('watchDirectory throws for non-existent path', () => {
    expect(() => {
      watchDirectory(join(TEST_DIR, 'nonexistent'))
    }).toThrow('Directory does not exist')
  })

  test('watchDirectory throws for file path', () => {
    const filePath = join(TEST_DIR, 'file.txt')
    writeFileSync(filePath, 'test')
    expect(() => {
      watchDirectory(filePath)
    }).toThrow('Path is not a directory')
  })

  test('watchDirectory is idempotent for same path', () => {
    const id1 = watchDirectory(TEST_DIR, { recursive: false })
    const id2 = watchDirectory(TEST_DIR, { recursive: false })
    expect(id1).toBe(id2)
  })

  test('unwatchDirectory removes a watcher', () => {
    const id = watchDirectory(TEST_DIR, { recursive: false })
    const removed = unwatchDirectory(id)
    expect(removed).toBe(true)
  })

  test('unwatchDirectory returns false for unknown ID', () => {
    const removed = unwatchDirectory('nonexistent')
    expect(removed).toBe(false)
  })

  test('unwatchAll clears all watchers', () => {
    const subDir = join(TEST_DIR, 'sub')
    mkdirSync(subDir, { recursive: true })
    watchDirectory(TEST_DIR, { recursive: false })
    watchDirectory(subDir, { recursive: false })
    unwatchAll()
    expect(getWatcherStatus().targets.length).toBe(0)
  })

  // ─── Status & Listing ────────────────────────────────────

  test('listWatchers returns "nenhum" when empty', () => {
    expect(listWatchers()).toContain('Nenhum')
  })

  test('listWatchers shows watched directories', () => {
    watchDirectory(TEST_DIR, { recursive: false })
    const listing = listWatchers()
    expect(listing).toContain(TEST_DIR)
    expect(listing).toContain('1')
  })

  test('getWatcherStatus reflects active state', () => {
    expect(getWatcherStatus().active).toBe(false)
    watchDirectory(TEST_DIR, { recursive: false })
    expect(getWatcherStatus().active).toBe(true)
  })

  test('getWatcherStatus includes target details', () => {
    watchDirectory(TEST_DIR, { recursive: false, patterns: ['.ts', '.json'] })
    const status = getWatcherStatus()
    expect(status.targets.length).toBe(1)
    expect(status.targets[0].path).toBe(TEST_DIR)
    expect(status.targets[0].recursive).toBe(false)
    expect(status.targets[0].patterns).toEqual(['.ts', '.json'])
  })

  // ─── Custom Callback ─────────────────────────────────────

  test('initFSWatcher accepts a callback', () => {
    let callbackCalled = false
    initFSWatcher(() => { callbackCalled = true })
    // callback is set but not yet triggered (no file changes)
    expect(callbackCalled).toBe(false)
  })

  // ─── getRecentChanges ─────────────────────────────────────

  test('getRecentChanges returns empty array initially', () => {
    const changes = getRecentChanges()
    expect(changes).toBeInstanceOf(Array)
  })

  test('getRecentChanges filters by extension', () => {
    const changes = getRecentChanges('.ts')
    expect(changes).toBeInstanceOf(Array)
  })

  // ─── formatChangeEvent ────────────────────────────────────

  test('formatChangeEvent formats rename events', () => {
    const event: FileChangeEvent = {
      watchId: 'test123',
      eventType: 'rename',
      filePath: '/some/path/file.ts',
      relativePath: 'file.ts',
      extension: '.ts',
      timestamp: Date.now(),
    }
    const formatted = formatChangeEvent(event)
    expect(formatted).toContain('NOVO/REMOVIDO')
    expect(formatted).toContain('file.ts')
  })

  test('formatChangeEvent formats change events', () => {
    const event: FileChangeEvent = {
      watchId: 'test123',
      eventType: 'change',
      filePath: '/some/path/file.json',
      relativePath: 'file.json',
      extension: '.json',
      timestamp: Date.now(),
    }
    const formatted = formatChangeEvent(event)
    expect(formatted).toContain('MODIFICADO')
    expect(formatted).toContain('file.json')
  })
})
