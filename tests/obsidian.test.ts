import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { initNotes, closeNotes, addNote, getNote, updateNote, deleteNote, type Note } from '../src/notes'
import { initTasks, addTask, listTasks } from '../src/tasks'
import { resolveVault, ownedPath, type VaultRoot } from '../src/obsidian/paths'
import { push, pull, status, pendingChanges } from '../src/obsidian/sync'
import { slugify, parseFile, renderNote, renderTasks, parseTasks, defaultNotePath } from '../src/obsidian/markdown'
import { createJournalSink, journalLine, teeAudit } from '../src/obsidian/journal'
import { initObsidian } from '../src/obsidian'
import { executeToolResult } from '../src/tools'
import type { AuditRecord } from '../src/engine/audit'

const NOW = new Date('2026-11-20T15:00:00')

function makeVault(): string {
  const vault = mkdtempSync(join(tmpdir(), 'smolerclaw-vault-'))
  mkdirSync(join(vault, '.obsidian'))
  return vault
}

function openVault(): VaultRoot {
  const check = resolveVault(makeVault())
  if (!check.ok) throw new Error(check.error)
  return check.value
}

const read = (vr: VaultRoot, rel: string): string => readFileSync(join(vr.root, ...rel.split('/')), 'utf-8')
const write = (vr: VaultRoot, rel: string, text: string): void => writeFileSync(ownedPath(vr, rel), text)
const noteFile = (vr: VaultRoot, note: Note): string => defaultNotePath(note)

/** Directory junction on Windows (fs.symlinkSync 'junction' panics on Bun 1.2.15), symlink elsewhere. */
function linkDir(target: string, link: string): void {
  if (process.platform !== 'win32') return symlinkSync(target, link, 'dir')
  const proc = Bun.spawnSync(['cmd', '/c', 'mklink', '/J', link, target])
  if (proc.exitCode !== 0) throw new Error(`mklink failed: ${proc.stderr.toString()}`)
}

beforeEach(() => {
  const data = mkdtempSync(join(tmpdir(), 'smolerclaw-obsidian-data-'))
  closeNotes()
  initNotes(data)
  initTasks(data, () => {})
})

afterEach(() => {
  initObsidian(undefined)
  closeNotes()
})

describe('markdown', () => {
  test('slugs keep accents and drop characters Obsidian or Windows reject', () => {
    expect(slugify('Ação: revisar #contrato [v2]?')).toBe('ação-revisar-contrato-v2')
    expect(slugify('...')).toBe('nota')
    expect(slugify('x'.repeat(100))).toHaveLength(60)
  })

  test('a rendered note parses back to the same fields and body', () => {
    const note = addNote({ kind: 'link', url: 'https://bun.sh', title: 'Bun "rápido"', body: 'runtime\n\nsegunda linha #dev' })
    const parsed = parseFile(renderNote(note))
    expect(parsed?.fields).toMatchObject({ id: note.id, kind: 'link', url: 'https://bun.sh', title: 'Bun "rápido"', tags: ['dev'] })
    expect(parsed?.body).toBe(note.body)
  })

  test('frontmatter edge cases', () => {
    expect(parseFile('sem frontmatter\r\n')).toEqual({ fields: {}, body: 'sem frontmatter' })
    expect(parseFile('---\n---\ncorpo')).toEqual({ fields: {}, body: 'corpo' })
    expect(parseFile('---\ntags:\n  - a\n  - b\n---\nx')?.fields.tags).toEqual(['a', 'b'])
    expect(parseFile('---\nid: [unclosed\n---\nx')).toBeNull()
  })

  test('task lines round-trip ids and accept new lines', () => {
    const due = addTask('pagar aluguel')
    const text = renderTasks([due]).replace('- [ ] pagar', '- [x] pagar') + '- [ ] comprar pão 📅 2026-11-21\n'
    expect(parseTasks(text)).toEqual([
      { checked: true, title: 'pagar aluguel', id: due.id, due: null },
      // A date without time defaults to 09:00 local.
      { checked: false, title: 'comprar pão', id: null, due: new Date(2026, 10, 21, 9, 0) },
    ])
  })
})

describe('vault location', () => {
  test('accepts only absolute, local Obsidian vaults', () => {
    expect(resolveVault('relativo/vault').ok).toBe(false)
    expect(resolveVault('\\\\servidor\\share').ok).toBe(false)
    expect(resolveVault(mkdtempSync(join(tmpdir(), 'not-a-vault-'))).ok).toBe(false)
    const ok = resolveVault(makeVault())
    expect(ok.ok && existsSync(ok.value.root)).toBe(true)
  })

  test('owned paths cannot escape the smolerclaw folder, not even through a junction', () => {
    const vr = openVault()
    expect(() => ownedPath(vr, '../fora.md')).toThrow()
    const outside = mkdtempSync(join(tmpdir(), 'smolerclaw-outside-'))
    mkdirSync(join(vr.root, 'Notas'))
    linkDir(outside, join(vr.root, 'Notas', 'atalho'))
    expect(() => ownedPath(vr, 'Notas/atalho/x.md')).toThrow()

    // Scans never follow it either: an edited copy behind the junction is ignored.
    const note = addNote({ kind: 'memo', body: 'dentro' })
    push(vr, NOW)
    writeFileSync(join(outside, 'x.md'), renderNote(note).replace('dentro', 'fora'))
    expect(pull(vr, { now: NOW, inboxSettleMs: 0 }).updated).toEqual([])
    expect(getNote(note.id)?.body).toBe('dentro')
  })
})

describe('push', () => {
  test('projects notes, tasks and panel, then is idempotent', () => {
    const vr = openVault()
    const note = addNote({ kind: 'memo', body: 'ligar pro banco #urgente' })
    addTask('renovar passaporte')

    const first = push(vr, NOW)
    expect(first.written).toEqual(expect.arrayContaining([noteFile(vr, note), 'Tarefas.md', 'Painel.md']))
    expect(read(vr, 'Tarefas.md')).toContain('renovar passaporte')
    expect(read(vr, 'Painel.md')).toContain('![[smolerclaw/Diário/2026-11-20]]')

    expect(push(vr, NOW)).toEqual({ written: [], removed: [], pending: [], errors: [] })
    // Nothing is created outside the owned folder.
    expect(readdirSync(vr.vault).sort()).toEqual(['.obsidian', 'smolerclaw'])
  })

  test('never overwrites a file edited in Obsidian', () => {
    const vr = openVault()
    const note = addNote({ kind: 'memo', body: 'original' })
    push(vr, NOW)
    const rel = noteFile(vr, note)
    write(vr, rel, read(vr, rel).replace('original', 'editado à mão'))
    updateNote(note.id, { title: 'mudou no banco' })

    expect(push(vr, NOW).pending).toEqual([rel])
    expect(read(vr, rel)).toContain('editado à mão')
  })

  test('respects files moved or renamed in Obsidian', () => {
    const vr = openVault()
    const note = addNote({ kind: 'memo', body: 'mover' })
    push(vr, NOW)
    mkdirSync(join(vr.root, 'Notas', 'pessoal'))
    renameSync(ownedPath(vr, noteFile(vr, note)), join(vr.root, 'Notas', 'pessoal', 'meu-nome.md'))

    updateNote(note.id, { body: 'mover depois' })
    push(vr, NOW)
    expect(read(vr, 'Notas/pessoal/meu-nome.md')).toContain('mover depois')
    expect(existsSync(ownedPath(vr, noteFile(vr, note)))).toBe(false)
  })

  test('deleting a file in Obsidian does not delete the note', () => {
    const vr = openVault()
    const note = addNote({ kind: 'memo', body: 'fica' })
    push(vr, NOW)
    unlinkSync(ownedPath(vr, noteFile(vr, note)))
    pull(vr, { now: NOW, inboxSettleMs: 0 })
    push(vr, NOW)
    expect(getNote(note.id)).not.toBeNull()
    expect(read(vr, noteFile(vr, note))).toContain('fica')
  })

  test('a note deleted in smolerclaw removes its file unless it was edited', () => {
    const vr = openVault()
    const clean = addNote({ kind: 'memo', body: 'limpa' })
    const edited = addNote({ kind: 'memo', body: 'editada' })
    push(vr, NOW)
    write(vr, noteFile(vr, edited), read(vr, noteFile(vr, edited)) + '\nminha linha\n')
    deleteNote(clean.id)
    deleteNote(edited.id)

    expect(push(vr, NOW).removed).toEqual([noteFile(vr, clean)])
    expect(read(vr, noteFile(vr, edited))).toContain('minha linha')
  })
})

describe('pull', () => {
  test('applies an edit and push rewrites the file in canonical form', () => {
    const vr = openVault()
    const note = addNote({ kind: 'reference', title: 'VPN', body: 'passo 1', category: 'tecnico' })
    push(vr, NOW)
    const rel = noteFile(vr, note)
    write(vr, rel, read(vr, rel).replace('passo 1', 'passo 1\npasso 2 #rede').replace('"tecnico"', 'guia'))

    expect(pull(vr, { now: NOW, inboxSettleMs: 0 }).updated).toEqual([rel])
    expect(getNote(note.id)).toMatchObject({ body: 'passo 1\npasso 2 #rede', category: 'guia', tags: ['rede'] })
    expect(push(vr, NOW).written).toContain(rel)
    expect(parseFile(read(vr, rel))?.fields.updated).toBe(getNote(note.id)?.updatedAt)
  })

  test('when both sides changed the database wins and the edit is kept beside it', () => {
    const vr = openVault()
    const note = addNote({ kind: 'memo', body: 'base' })
    push(vr, NOW)
    const rel = noteFile(vr, note)
    write(vr, rel, read(vr, rel).replace('base', 'versão do obsidian'))
    updateNote(note.id, { body: 'versão do banco' })

    const report = pull(vr, { now: NOW, inboxSettleMs: 0 })
    expect(report.conflicts).toEqual([rel.replace(/\.md$/, '.conflito.md')])
    push(vr, NOW)
    expect(read(vr, rel)).toContain('versão do banco')
    expect(read(vr, report.conflicts[0])).toContain('versão do obsidian')
    expect(status(vr).conflicts).toEqual(report.conflicts)
  })

  test('deletar: true deletes the note and its file', () => {
    const vr = openVault()
    const note = addNote({ kind: 'memo', body: 'apagar' })
    push(vr, NOW)
    const rel = noteFile(vr, note)
    write(vr, rel, read(vr, rel).replace('---\n\n', 'deletar: true\n---\n\n'))

    expect(pull(vr, { now: NOW, inboxSettleMs: 0 }).deleted).toEqual([rel])
    expect(getNote(note.id)).toBeNull()
    expect(existsSync(ownedPath(vr, rel))).toBe(false)
  })

  test('Inbox files become notes; empty ones wait', () => {
    const vr = openVault()
    write(vr, 'Inbox/Ideia de projeto.md', 'app de receitas #ideia\n')
    write(vr, 'Inbox/link.md', '---\nkind: link\nurl: https://obsidian.md\n---\n')
    write(vr, 'Inbox/rascunho.md', '')

    const report = pull(vr, { now: NOW, inboxSettleMs: 0 })
    expect(report.created).toHaveLength(2)
    expect(existsSync(ownedPath(vr, 'Inbox/rascunho.md'))).toBe(true)
    expect(existsSync(ownedPath(vr, 'Inbox/Ideia de projeto.md'))).toBe(false)
    expect(push(vr, NOW).written.some((p) => p.startsWith('Notas/memo/ideia-de-projeto-'))).toBe(true)
  })

  test('ticked lines complete tasks and new lines create them', () => {
    const vr = openVault()
    const task = addTask('pagar aluguel')
    push(vr, NOW)
    write(vr, 'Tarefas.md', read(vr, 'Tarefas.md').replace('- [ ] pagar', '- [x] pagar') + '- [ ] ligar pro contador\n')

    const report = pull(vr, { now: NOW, inboxSettleMs: 0 })
    expect(report.completed).toEqual(['pagar aluguel'])
    expect(report.tasksCreated).toEqual(['ligar pro contador'])
    expect(listTasks(false).map((t) => t.title)).toEqual(['ligar pro contador'])
    push(vr, NOW)
    expect(read(vr, 'Tarefas.md')).not.toContain(task.id)
  })

  test('a stale file cannot delete a note that changed since export', () => {
    const vr = openVault()
    const note = addNote({ kind: 'memo', body: 'importante' })
    push(vr, NOW)
    const rel = noteFile(vr, note)
    write(vr, rel, read(vr, rel).replace('---\n\n', 'deletar: true\n---\n\n'))
    updateNote(note.id, { body: 'importante e atualizado' })

    const report = pull(vr, { now: NOW, inboxSettleMs: 0 })
    expect(report.deleted).toEqual([])
    expect(report.conflicts).toHaveLength(1)
    expect(getNote(note.id)?.body).toBe('importante e atualizado')
  })

  test('task edits pull cannot apply are kept beside Tarefas.md', () => {
    const vr = openVault()
    addTask('pagar aluguel')
    push(vr, NOW)
    write(vr, 'Tarefas.md', read(vr, 'Tarefas.md').replace('pagar aluguel', 'pagar aluguel de dezembro'))

    expect(pull(vr, { now: NOW, inboxSettleMs: 0 }).conflicts).toEqual(['Tarefas.conflito.md'])
    expect(read(vr, 'Tarefas.conflito.md')).toContain('de dezembro')
    expect(status(vr).conflicts).toContain('Tarefas.conflito.md')
  })

  test('a BOM does not hide the frontmatter', () => {
    const vr = openVault()
    const note = addNote({ kind: 'memo', body: 'antes' })
    push(vr, NOW)
    const rel = noteFile(vr, note)
    write(vr, rel, '﻿' + read(vr, rel).replace('antes', 'depois'))
    expect(pull(vr, { now: NOW, inboxSettleMs: 0 }).updated).toEqual([rel])
    expect(getNote(note.id)?.body).toBe('depois')
  })

  test('a copied note file does not take over the tracked one', () => {
    const vr = openVault()
    const note = addNote({ kind: 'memo', body: 'original' })
    push(vr, NOW)
    const rel = noteFile(vr, note)
    write(vr, 'Notas/aaa-copia.md', read(vr, rel))

    updateNote(note.id, { body: 'atualizada' })
    const report = push(vr, NOW)
    expect(read(vr, rel)).toContain('atualizada')
    expect(read(vr, 'Notas/aaa-copia.md')).toContain('original')
    expect(report.written).toContain(rel)
  })

  test('Inbox files still being written wait for the settle time', () => {
    const vr = openVault()
    write(vr, 'Inbox/digitando.md', 'meio texto')
    expect(pull(vr, { now: new Date(), inboxSettleMs: 30_000 }).created).toEqual([])
    expect(existsSync(ownedPath(vr, 'Inbox/digitando.md'))).toBe(true)
  })
})

describe('journal', () => {
  const record = (over: Partial<AuditRecord>): AuditRecord => ({
    ts: '2026-11-20T18:04:05.000Z', tool: 'save_note', inputHash: 'abc', decision: 'executed',
    risk: 'moderate', ok: true, durationMs: 3, ...over,
  })

  test('lines carry the outcome but never the input', () => {
    expect(journalLine(record({}), NOW)).toBe('- 15:00:00 · `save_note` · ok\n')
    expect(journalLine(record({ decision: 'denied', ok: false }), NOW)).toContain('negado pela política')
    expect(journalLine(record({ ok: false, error: 'segredo@exemplo.com' }), NOW)).not.toContain('segredo')
    // Caller-controlled names and engine text cannot inject Markdown.
    expect(journalLine(record({ tool: 'x\n![[evil]]', decision: 'unknown', ok: false }), NOW)).toContain('(desconhecido)')
    expect(journalLine(record({ decision: 'invalid', ok: false, error: 'bad `code` [[link]]' }), NOW)).not.toMatch(/[`[\]]{2}|`code`/)
  })

  test('appends writes and failures to the day file, skips successful reads', () => {
    const vr = openVault()
    const sink = teeAudit(createJournalSink(() => vr, (t) => t === 'list_notes'))
    sink.write(record({}))
    sink.write(record({ tool: 'list_notes' }))
    sink.write(record({ tool: 'm365_send_email', decision: 'denied', ok: false }))

    const day = readdirSync(join(vr.root, 'Diário'))
    expect(day).toHaveLength(1)
    const text = read(vr, `Diário/${day[0]}`)
    expect(text.startsWith('# Diário smolerclaw')).toBe(true)
    expect(text).toContain('save_note')
    expect(text).toContain('m365_send_email')
    expect(text).not.toContain('list_notes')
  })
})

describe('tools', () => {
  test('obsidian_sync explains how to enable the mirror', async () => {
    const result = await executeToolResult('obsidian_sync', {})
    expect(result.ok).toBe(false)
    expect(result.text).toContain('SMOLERCLAW_OBSIDIAN_VAULT')
  })

  test('a write tool refreshes the vault; obsidian_sync pulls edits', async () => {
    const vault = makeVault()
    initObsidian(vault)
    const saved = await executeToolResult('save_note', { kind: 'memo', body: 'via tool #mcp' })
    const note = saved.ok ? (saved.data as Note) : null
    const root = join(vault, 'smolerclaw')
    expect(note && existsSync(join(root, ...defaultNotePath(note).split('/')))).toBe(true)

    const old = new Date(Date.now() - 60_000)
    writeFileSync(join(root, 'Inbox', 'nova.md'), 'criada no obsidian\n')
    utimesSync(join(root, 'Inbox', 'nova.md'), old, old)
    const synced = await executeToolResult('obsidian_sync', {})
    expect(synced.text).toContain('Notas criadas pela Inbox (1)')
    expect((await executeToolResult('obsidian_status', {})).ok).toBe(true)
  })
})

describe('pull mode', () => {
  /** Vault with one exported note whose file was then edited in "Obsidian". */
  async function editedVault(): Promise<{ vault: string; root: string; note: Note }> {
    const vault = makeVault()
    initObsidian(vault)
    const saved = await executeToolResult('save_note', { kind: 'memo', body: 'versão do banco' })
    const note = saved.data as Note
    const root = join(vault, 'smolerclaw')
    const file = join(root, ...defaultNotePath(note).split('/'))
    writeFileSync(file, readFileSync(file, 'utf-8').replace('versão do banco', 'versão do obsidian'))
    return { vault, root, note }
  }

  test('starts off: nothing is reported or pulled', async () => {
    const { note } = await editedVault()
    const listed = await executeToolResult('list_notes', {})
    expect(listed.text).not.toContain('[obsidian]')
    expect(getNote(note.id)?.body).toBe('versão do banco')
    expect((await executeToolResult('obsidian_mode', {})).text).toContain('off')
  })

  test('ask: the round reports unsynced edits once and changes nothing', async () => {
    const { note } = await editedVault()
    expect((await executeToolResult('obsidian_mode', { pull: 'ask' })).ok).toBe(true)

    const first = await executeToolResult('list_notes', {})
    expect(first.text).toContain('[obsidian] 1 alteração no vault ainda não sincronizada')
    expect(first.text).toContain('obsidian_sync')
    expect((await executeToolResult('list_notes', {})).text).not.toContain('[obsidian]')
    expect(getNote(note.id)?.body).toBe('versão do banco')

    await executeToolResult('obsidian_sync', {})
    expect(getNote(note.id)?.body).toBe('versão do obsidian')
    expect((await executeToolResult('list_notes', {})).text).not.toContain('[obsidian]')
  })

  test('auto: the round pulls before the tool runs and journals it', async () => {
    const { root } = await editedVault()
    await executeToolResult('obsidian_mode', { pull: 'auto' })
    await executeToolResult('create_task', { title: 'pagar aluguel' })
    const tasksFile = join(root, 'Tarefas.md')
    writeFileSync(tasksFile, readFileSync(tasksFile, 'utf-8').replace('- [ ] pagar', '- [x] pagar'))

    const listed = await executeToolResult('list_tasks', {})
    expect(listed.text).toContain('Sincronizado automaticamente')
    expect(listed.text).toContain('1 tarefa concluída')
    expect(listTasks(false)).toEqual([])
    const journal = readdirSync(join(root, 'Diário')).map((f) => readFileSync(join(root, 'Diário', f), 'utf-8')).join('')
    expect(journal).toContain('sync automático do Obsidian')
  })

  test('SMOLERCLAW_OBSIDIAN_PULL overrides the mode stored in the vault', async () => {
    const vault = makeVault()
    initObsidian(vault, 'ask')
    const result = await executeToolResult('obsidian_mode', { pull: 'off' })
    expect(result.text).toContain('SMOLERCLAW_OBSIDIAN_PULL')
    expect((result.data as { mode: string }).mode).toBe('ask')
    expect((await executeToolResult('obsidian_mode', { pull: 'sempre' })).ok).toBe(false)
  })

  test('touching a file without changing it is not an edit', () => {
    const vr = openVault()
    const note = addNote({ kind: 'memo', body: 'igual' })
    push(vr, NOW)
    const later = new Date(Date.now() + 120_000)
    utimesSync(ownedPath(vr, noteFile(vr, note)), later, later)
    expect(pendingChanges(vr)).toEqual({ edits: [], inbox: [] })
    write(vr, noteFile(vr, note), read(vr, noteFile(vr, note)).replace('igual', 'diferente'))
    expect(pendingChanges(vr).edits).toEqual([noteFile(vr, note)])
  })
})
