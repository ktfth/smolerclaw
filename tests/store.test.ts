import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { Database } from 'bun:sqlite'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { BUSY_MESSAGE, closeStore, isBusyError, migrateOnce, openStore, store, withWriteLock } from '../src/core/store'
import { initNotes, getNote, listNotes, addNote, updateNote } from '../src/notes'
import { initTasks, stopTasks, addTask, completeTask, listTasks, checkDueTasks, type Task } from '../src/tasks'
import { resolveVault } from '../src/obsidian/paths'
import { push, status } from '../src/obsidian/sync'

const SRC = resolve(import.meta.dir, '..', 'src')

let data: string

function vaultRoot() {
  const vault = mkdtempSync(join(tmpdir(), 'smolerclaw-vault-'))
  mkdirSync(join(vault, '.obsidian'))
  const check = resolveVault(vault)
  if (!check.ok) throw new Error(check.error)
  return check.value
}

/** A second connection to the same file: what another smolerclaw process sees. */
function otherProcess(): Database {
  const db = new Database(join(data, 'smolerclaw.db'))
  db.exec('PRAGMA busy_timeout = 5000;')
  return db
}

beforeEach(() => {
  data = mkdtempSync(join(tmpdir(), 'smolerclaw-store-'))
})

afterEach(() => {
  stopTasks()
  closeStore()
})

describe('store', () => {
  test('opens in WAL mode with a busy timeout, so processes wait instead of failing', () => {
    openStore(data)
    expect((store().query('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode).toBe('wal')
    expect((store().query('PRAGMA busy_timeout').get() as { timeout: number }).timeout).toBe(15000)
  })

  test('a migration runs once even when asked twice', () => {
    openStore(data)
    let runs = 0
    expect(migrateOnce('x', () => { runs++ })).toBe(true)
    expect(migrateOnce('x', () => { runs++ })).toBe(false)
    expect(runs).toBe(1)
  })

  test('the write lock commits what was recorded before a failure, then rethrows', () => {
    openStore(data)
    store().exec('CREATE TABLE t (v TEXT)')
    expect(() => withWriteLock(() => {
      store().query('INSERT INTO t VALUES (?)').run('kept')
      throw new Error('boom')
    })).toThrow('boom')
    expect(store().query('SELECT v FROM t').all()).toEqual([{ v: 'kept' }])
  })

  test('an existing notes.db is carried over and kept as notes.migrated.db', () => {
    const old = new Database(join(data, 'notes.db'), { create: true })
    old.exec(`CREATE TABLE notes (id TEXT PRIMARY KEY, kind TEXT NOT NULL, title TEXT NOT NULL DEFAULT '', body TEXT NOT NULL DEFAULT '',
      url TEXT, category TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`)
    old.query("INSERT INTO notes VALUES ('n1', 'memo', '', 'antiga', NULL, NULL, '2026-01-01', '2026-01-01')").run()
    old.close()

    initNotes(data)
    expect(getNote('n1')?.body).toBe('antiga')
    expect(existsSync(join(data, 'notes.migrated.db'))).toBe(true)
    expect(existsSync(join(data, 'notes.db'))).toBe(false)
  })

  test('two processes adopting notes.db together end with one complete store', async () => {
    const old = new Database(join(data, 'notes.db'), { create: true })
    old.exec(`CREATE TABLE notes (id TEXT PRIMARY KEY, kind TEXT NOT NULL, title TEXT NOT NULL DEFAULT '', body TEXT NOT NULL DEFAULT '',
      url TEXT, category TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`)
    for (let i = 0; i < 200; i++) old.query("INSERT INTO notes VALUES (?, 'memo', '', 'x', NULL, NULL, '2026-01-01', '2026-01-01')").run(`n${i}`)
    old.close()
    const gate = join(data, 'gate')
    const script = join(data, 'adopt.ts')
    // Spawn staggers startup enough to hide the race. Each process waits until
    // all six are blocked, then they enter initNotes together.
    writeFileSync(script, [
      `import { closeSync, openSync, existsSync } from 'node:fs'`,
      `import { initNotes, listNotes } from ${JSON.stringify(pathToFileURL(join(SRC, 'notes.ts')).href)}`,
      `closeSync(openSync(process.argv[3] + '.' + process.pid, 'w'))`,
      `while (!existsSync(process.argv[3])) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5)`,
      'initNotes(process.argv[2])',
      'console.log(listNotes({ limit: 1000 }).length)',
      'process.exit(0)',
    ].join('\n'))
    const procs = [0, 1, 2, 3, 4, 5].map(() => Bun.spawn([process.execPath, script, data, gate], { stdout: 'pipe', stderr: 'pipe' }))
    const readyBy = Date.now() + 5_000
    while (readdirSync(data).filter((f) => f.startsWith('gate.')).length < 6) {
      if (Date.now() > readyBy) throw new Error('adopters did not start')
      await Bun.sleep(5)
    }
    writeFileSync(gate, '')
    const outs = await Promise.all(procs.map(async (p) => ({ code: await p.exited, out: (await new Response(p.stdout).text()).trim() })))
    expect(outs).toEqual([0, 1, 2, 3, 4, 5].map(() => ({ code: 0, out: '200' })))
    expect(readdirSync(data).some((f) => f.includes('.adopting-'))).toBe(false)
  })

  test('busy errors are recognised and get a readable message', () => {
    expect(isBusyError(new Error('database is locked'))).toBe(true)
    expect(isBusyError(new Error('no such table: x'))).toBe(false)
    expect(BUSY_MESSAGE).toContain('Tente de novo')
  })

  test('updateNote applies only the patched fields over the current row', () => {
    initNotes(data)
    const note = addNote({ kind: 'link', url: 'https://a.example', body: 'corpo' })
    const other = otherProcess()
    other.query('UPDATE notes SET url = ? WHERE id = ?').run('https://b.example', note.id)
    other.close()
    const updated = updateNote(note.id, { body: 'corpo novo' })
    expect(updated).toMatchObject({ body: 'corpo novo', url: 'https://b.example' })
  })
})

describe('tasks across processes', () => {
  beforeEach(() => initTasks(data, () => {}))

  test('a task added by another process is seen, and survives this process writing', () => {
    const other = otherProcess()
    other.query("INSERT INTO tasks (id, title, created_at) VALUES ('o1', 'do outro processo', '2026-11-20T10:00:00.000Z')").run()
    addTask('deste processo')
    expect(listTasks().map((t) => t.title)).toEqual(['do outro processo', 'deste processo'])
    other.close()
  })

  test('completing a task another process already completed reports nothing done', () => {
    const task = addTask('pagar boleto')
    const other = otherProcess()
    other.query('UPDATE tasks SET done = 1 WHERE id = ?').run(task.id)
    other.close()
    expect(completeTask(task.id)).toBeNull()
  })

  test('a reminder fires once, in whichever process claims it first', () => {
    const due = new Date(Date.now() - 60_000)
    const fired: Task[] = []
    const a = addTask('reunião', due)
    const b = addTask('ligar', due)
    const other = otherProcess()
    other.query('UPDATE tasks SET notified = 1 WHERE id = ?').run(b.id) // the other process got this one
    other.close()

    checkDueTasks((t) => fired.push(t))
    checkDueTasks((t) => fired.push(t))
    expect(fired.map((t) => t.id)).toEqual([a.id])
  })

  test('two real processes and this one add tasks at the same time without losing any', async () => {
    const script = join(data, 'writer.ts')
    writeFileSync(script, [
      `import { initTasks, stopTasks, addTask } from ${JSON.stringify(pathToFileURL(join(SRC, 'tasks.ts')).href)}`,
      `import { closeStore } from ${JSON.stringify(pathToFileURL(join(SRC, 'core', 'store.ts')).href)}`,
      'initTasks(process.argv[2], () => {})',
      'stopTasks()',
      'for (let i = 0; i < 20; i++) addTask(`${process.argv[3]} ${i}`)',
      'closeStore()',
      'process.exit(0)',
    ].join('\n'))
    const writers = ['a', 'b'].map((name) => Bun.spawn([process.execPath, script, data, name], { stderr: 'pipe' }))
    for (let i = 0; i < 20; i++) addTask(`local ${i}`)
    const codes = await Promise.all(writers.map((w) => w.exited))
    expect(codes).toEqual([0, 0])
    expect(listTasks().length).toBe(60)
  })

  test('tasks.json is imported once, keeping ids and order, and renamed', () => {
    closeStore()
    const legacyDir = mkdtempSync(join(tmpdir(), 'smolerclaw-legacy-tasks-'))
    writeFileSync(join(legacyDir, 'tasks.json'), JSON.stringify([
      { id: 'a1', title: 'primeira', dueAt: null, createdAt: '2026-01-01T00:00:00.000Z', done: false, notified: false },
      { id: 'a1', title: 'id repetido', dueAt: 'não é data', createdAt: '2026-01-02T00:00:00.000Z', done: true, notified: false },
      { title: '' },
      'lixo',
    ]))
    initTasks(legacyDir, () => {})
    const tasks = listTasks(true)
    expect(tasks.map((t) => t.title)).toEqual(['primeira', 'id repetido'])
    expect(tasks[0].id).toBe('a1')
    expect(tasks[1].id).not.toBe('a1')
    expect(tasks[1]).toMatchObject({ done: true, dueAt: null })
    expect(existsSync(join(legacyDir, 'tasks.migrated.json'))).toBe(true)

    // A tasks.json written later by an old version is not imported again.
    writeFileSync(join(legacyDir, 'tasks.json'), JSON.stringify([{ id: 'z', title: 'tarde demais' }]))
    closeStore()
    initTasks(legacyDir, () => {})
    expect(listTasks(true)).toHaveLength(2)
  })
})

describe('obsidian manifest in the store', () => {
  test('the old JSON manifest is imported once and renamed', () => {
    initNotes(data)
    initTasks(data, () => {})
    const vr = vaultRoot()
    mkdirSync(vr.root, { recursive: true })
    writeFileSync(join(vr.root, '.smolerclaw-sync.json'), JSON.stringify({ version: 1, files: { 'note:velha': { path: 'Notas/memo/velha.md', hash: 'abc' } } }))

    expect(status(vr).tracked).toBe(1)
    expect(existsSync(join(vr.root, '.smolerclaw-sync.json'))).toBe(false)
    expect(existsSync(join(vr.root, '.smolerclaw-sync.migrated.json'))).toBe(true)
    push(vr)
    const keys = (store().query('SELECT key FROM obsidian_files WHERE vault = ?').all(process.platform === 'win32' ? vr.root.toLowerCase() : vr.root) as { key: string }[]).map((r) => r.key)
    expect(keys.sort()).toEqual(['panel', 'tasks'])
    expect(listNotes()).toHaveLength(0)
  })

  test('a first push imports the legacy manifest, so a file it tracked is not mistaken for an edit', () => {
    initNotes(data)
    initTasks(data, () => {})
    const vr = vaultRoot()
    push(vr)
    const tracked = store().query('SELECT key, path, hash, mtime FROM obsidian_files').all() as { key: string; path: string; hash: string; mtime: number | null }[]
    // Simulate an older install: the manifest only in the vault, nothing in the store.
    store().exec('DELETE FROM obsidian_files')
    store().exec("DELETE FROM migrations WHERE name LIKE 'obsidian-manifest:%'")
    const files = Object.fromEntries(tracked.map((r) => [r.key, { path: r.path, hash: r.hash, mtime: r.mtime ?? undefined }]))
    writeFileSync(join(vr.root, '.smolerclaw-sync.json'), JSON.stringify({ version: 1, files }))
    const report = push(vr)
    expect(report.pending).toEqual([])
    expect(existsSync(join(vr.root, '.smolerclaw-sync.migrated.json'))).toBe(true)
  })

  test('a sync waits for another process holding the write lock', () => {
    initNotes(data)
    initTasks(data, () => {})
    const vr = vaultRoot()
    const other = otherProcess()
    other.exec('BEGIN IMMEDIATE')
    store().exec('PRAGMA busy_timeout = 0') // fail fast instead of waiting, to observe the lock
    expect(() => push(vr)).toThrow(/locked|busy/i)
    other.exec('ROLLBACK')
    other.close()
    expect(push(vr).errors).toEqual([])
  })
})
