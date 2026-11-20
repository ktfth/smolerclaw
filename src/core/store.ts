/**
 * The shared SQLite store (`smolerclaw.db`). Every process — TUI, MCP server,
 * CLI — opens the same file, and no module keeps an authoritative copy in
 * memory: reads query the database, writes are short transactions. SQLite
 * mediates concurrent processes: WAL lets readers run alongside a writer, and
 * busy_timeout makes a second writer wait its turn instead of failing.
 */
import { Database } from 'bun:sqlite'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { logger } from './logger'

const DB_FILE = 'smolerclaw.db'
/** The store used to hold only notes; an existing one is carried over once. */
const LEGACY_DB_FILE = 'notes.db'
/** An Obsidian sync holds the write lock while it scans the vault: wait for it. */
const BUSY_TIMEOUT_MS = 15_000
const ADOPTING = '.adopting-'
/** A temporary copy older than this was left by a crash, not by a process still copying. */
const STALE_COPY_MS = 10 * 60_000

let _db: Database | null = null
let _path = ''
/** Domains whose tables exist on the open store: open does not mean every domain is ready. */
const _schemas = new Set<string>()

/** Open the store for a data directory. Reopening the same directory is a no-op. */
export function openStore(dataDir: string): Database {
  const path = resolve(dataDir, DB_FILE)
  if (_db && _path === path) return _db
  closeStore()
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true })
  adoptLegacyDb(dataDir, path)
  const db = new Database(path, { create: true, strict: true })
  try {
    db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS};`)
    db.exec('PRAGMA journal_mode = WAL;')
    db.exec('PRAGMA foreign_keys = ON;')
    db.exec('CREATE TABLE IF NOT EXISTS migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL);')
  } catch (err) {
    db.close()
    throw err
  }
  _db = db
  _path = path
  return db
}

export function store(): Database {
  if (!_db) throw new Error('store not initialized')
  return _db
}

/**
 * Create a domain's tables (idempotent) and remember that it is ready.
 * One statement at a time: a multi-statement exec in bun:sqlite 1.2 can drop
 * a "database is locked" error and leave the domain marked ready without its
 * tables. Schemas must not contain ';' inside literals.
 */
export function ensureSchema(domain: string, sql: string): void {
  if (_schemas.has(domain)) return
  const db = store()
  const statements = sql.split(';').map((part) => part.trim()).filter(Boolean)
  db.transaction(() => {
    for (const statement of statements) db.run(statement)
  }).immediate()
  _schemas.add(domain)
}

export function hasSchema(domain: string): boolean {
  return _db !== null && _schemas.has(domain)
}

/** Close the store (tests, shutdown). */
export function closeStore(): void {
  _db?.close()
  _db = null
  _path = ''
  _schemas.clear()
}

/**
 * Run `apply` once per store. The check and the record happen in one
 * BEGIN IMMEDIATE transaction, so two processes starting together cannot both
 * apply it. Returns false when it was already applied.
 */
export function migrateOnce(name: string, apply: (db: Database) => void): boolean {
  const db = store()
  return db.transaction(() => {
    if (db.query('SELECT 1 FROM migrations WHERE name = ?').get(name)) return false
    apply(db)
    db.query('INSERT INTO migrations (name, applied_at) VALUES (?, ?)').run(name, new Date().toISOString())
    return true
  }).immediate()
}

/**
 * Import a legacy JSON file into the store once. `apply` receives the parsed
 * content inside the migration transaction. The file is renamed to
 * *.migrated.json only after the rows are committed, never deleted; an
 * unreadable file is left untouched for manual recovery.
 */
export function importLegacyJson(dataDir: string, file: string, apply: (parsed: unknown, db: Database) => void): void {
  const name = `legacy:${file}`
  if (store().query('SELECT 1 FROM migrations WHERE name = ?').get(name)) return
  const path = join(dataDir, file)
  if (!existsSync(path)) return

  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, 'utf-8'))
  } catch (err) {
    logger.warn('Legacy file is unreadable; skipped', { file, error: err })
    return
  }

  if (!migrateOnce(name, (db) => apply(parsed, db))) return
  try {
    renameSync(path, path.replace(/\.json$/, '.migrated.json'))
  } catch (err) {
    // Rows are committed and the migration recorded; a locked file only stays in place.
    logger.warn('Could not rename migrated file', { file, error: err })
  }
}

/**
 * Run `fn` holding the store's write lock (BEGIN IMMEDIATE), so the same
 * operation in another process waits instead of interleaving. `fn` usually
 * also touches files, which cannot roll back: a failure inside still commits
 * what was recorded, then rethrows.
 */
export function withWriteLock<T>(fn: () => T): T {
  const db = store()
  let failure: { error: unknown } | null = null
  const result = db.transaction(() => {
    try {
      return fn()
    } catch (error) {
      failure = { error }
      return undefined
    }
  }).immediate()
  if (failure) throw (failure as { error: unknown }).error
  return result as T
}

function removeStaleCopies(dataDir: string): void {
  for (const name of readdirSync(dataDir)) {
    if (!name.startsWith(DB_FILE + ADOPTING)) continue
    const file = join(dataDir, name)
    try {
      if (Date.now() - statSync(file).mtimeMs > STALE_COPY_MS) unlinkSync(file)
    } catch { /* gone or still open */ }
  }
}

/** SQLite errors that mean another process holds the lock, as opposed to a real failure. */
export function isBusyError(err: unknown): boolean {
  return err instanceof Error && /SQLITE_BUSY|database is locked/i.test(`${(err as { code?: string }).code ?? ''} ${err.message}`)
}

export const BUSY_MESSAGE = 'Outro processo do smolerclaw está gravando (provavelmente sincronizando o Obsidian). Tente de novo em instantes.'

/**
 * Carry an existing notes.db over to smolerclaw.db, keeping the original as
 * notes.migrated.db. The copy is built under a temporary name and renamed into
 * place, so a crash or a second process starting together never leaves a
 * half-written smolerclaw.db behind.
 */
function adoptLegacyDb(dataDir: string, path: string): void {
  const legacy = join(dataDir, LEGACY_DB_FILE)
  if (existsSync(path) || !existsSync(legacy)) return
  removeStaleCopies(dataDir)
  const temp = `${path}${ADOPTING}${process.pid}`
  try {
    const source = new Database(legacy, { readonly: true })
    try {
      // A consistent copy even if another process still has the old file open.
      source.query('VACUUM INTO ?').run(temp)
    } finally {
      source.close()
    }
  } catch (err) {
    try { unlinkSync(temp) } catch { /* never created */ }
    // Losing the race (the winner already moved notes.db away) is fine; anything else is not.
    if (existsSync(path)) return
    throw err
  }
  try {
    if (existsSync(path)) throw new Error('adopted by another process')
    renameSync(temp, path)
  } catch {
    // Another process won the race: its copy is the store; drop ours.
    try { unlinkSync(temp) } catch { /* already gone */ }
    return
  }
  // The old file and its sidecars move together, so a stale -wal is never replayed onto a new notes.db.
  for (const suffix of ['', '-wal', '-shm']) {
    const file = legacy + suffix
    if (!existsSync(file)) continue
    try {
      renameSync(file, join(dataDir, `notes.migrated.db${suffix}`))
    } catch (err) {
      // The copy is complete; a locked original only stays in place, unused.
      logger.warn('Could not rename the old notes database', { file, error: err })
    }
  }
}
