import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { initNotes, closeNotes, addNote, getNote, updateNote, deleteNote, type Note } from '../src/notes'
import { initTasks, addTask, listTasks } from '../src/tasks'
import { resolveVault, ownedPath, type VaultRoot } from '../src/obsidian/paths'
import { push, pull, status, pendingChanges } from '../src/obsidian/sync'
import { slugify, parseFile, renderNote, renderTasks, parseTasks, defaultNotePath, noteBody, displayTitle, CONTENT_MARK } from '../src/obsidian/markdown'
import { describeCall } from '../src/obsidian/describe'
import { appendJournal, createJournalSink, journalLine, teeAudit } from '../src/obsidian/journal'
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
/** Edit the note's own text, below the generated header, as a person would. */
const editText = (file: string, from: string, to: string): string => {
  const at = file.indexOf(CONTENT_MARK)
  return file.slice(0, at) + file.slice(at).replace(from, to)
}

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
    expect(noteBody(parsed?.body ?? '')).toBe(note.body)
  })

  test('a note reads as a document: title, what it is, when, and a clickable link', () => {
    const note = addNote({ kind: 'link', url: 'https://bun.sh/docs', title: 'Docs [Bun]', body: '' })
    const text = renderNote(note)
    expect(text).toContain('# Docs \\[Bun\\]')
    expect(text).toMatch(/> 🔗 link · criada em \d{1,2} de \w+ de \d{4} às \d{2}:\d{2}/u)
    expect(text).toContain('> Abrir: [Docs \\[Bun\\]](<https://bun.sh/docs>)')
    // Empty optional fields stay out of the properties.
    expect(text).not.toContain('category:')
    expect(text).not.toContain('null')
  })

  test('titles drop inline tags and are cut at a word, file names read like the title', () => {
    const note = addNote({ kind: 'memo', body: 'Matheus vai trabalhar no restante do SO -> WO #SO #WO #Matheus' })
    expect(displayTitle(note)).toBe('Matheus vai trabalhar no restante do SO -> WO')
    expect(defaultNotePath(note)).toBe(`Notas/memo/Matheus vai trabalhar no restante do SO - WO (${note.id}).md`)
    const long = addNote({ kind: 'memo', body: 'palavra '.repeat(30) })
    expect(displayTitle(long).endsWith('palavra…')).toBe(true)
  })

  test('a note that opens with its own heading is not given a second one', () => {
    const note = addNote({ kind: 'memo', body: '# Plano de estudos\n\n- capítulo 1' })
    expect(renderNote(note).match(/^# Plano de estudos$/gm)).toHaveLength(1)
  })

  test('a colon in the title becomes a dash in the file name', () => {
    const note = addNote({ kind: 'memo', body: 'Bug encontrado: data errada' })
    expect(defaultNotePath(note)).toBe(`Notas/memo/Bug encontrado - data errada (${note.id}).md`)
  })

  test('a non-web url is shown, never linked', () => {
    const note = addNote({ kind: 'link', url: 'javascript:alert(1)', title: 'x', body: '' })
    expect(renderNote(note)).not.toContain('](<javascript')
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
    expect(push(vr, NOW).written.some((p) => p.startsWith('Notas/memo/Ideia de projeto ('))).toBe(true)
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
    write(vr, rel, '﻿' + editText(read(vr, rel), 'antes', 'depois'))
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

  test('the generated header never leaks into the note text; retyping the heading renames it', () => {
    const vr = openVault()
    const note = addNote({ kind: 'memo', body: 'corpo original' })
    push(vr, NOW)
    const rel = noteFile(vr, note)
    write(vr, rel, read(vr, rel).replace('# corpo original', '# Título novo'))

    expect(pull(vr, { now: NOW, inboxSettleMs: 0 }).updated).toEqual([rel])
    expect(getNote(note.id)).toMatchObject({ title: 'Título novo', body: 'corpo original' })
  })

  test('an untouched file under an old slug name moves to the readable name', () => {
    const vr = openVault()
    const note = addNote({ kind: 'memo', body: 'nota antiga' })
    push(vr, NOW)
    const legacy = `Notas/memo/nota-antiga-${note.id}.md`
    renameSync(ownedPath(vr, noteFile(vr, note)), ownedPath(vr, legacy))
    // Point the manifest at the legacy path, as an older version would have left it.
    push(vr, NOW)
    expect(existsSync(ownedPath(vr, legacy))).toBe(true)
    updateNote(note.id, { body: 'nota antiga editada' })

    push(vr, NOW)
    expect(existsSync(ownedPath(vr, legacy))).toBe(false)
    const renamed = getNote(note.id)
    expect(renamed && read(vr, noteFile(vr, renamed))).toContain('nota antiga editada')
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

  test('lines say what happened in words, with the tool name hidden in a comment', () => {
    expect(journalLine(record({ summary: 'Concluiu a tarefa “[P0] backup”' }), NOW))
      .toBe('- **15:00** Concluiu a tarefa “\\[P0\\] backup” %%save_note%%\n')
    // Without a sentence from the call, a generic one; without that, the tool name.
    expect(journalLine(record({}), NOW)).toBe('- **15:00** Salvou uma nota %%save_note%%\n')
    expect(journalLine(record({ tool: 'plugin_x' }), NOW)).toBe('- **15:00** Executou `plugin_x` %%plugin_x%%\n')
    expect(journalLine(record({ summary: '![[evil]] `x`' }), NOW)).not.toMatch(/!\[\[|`x`/)
  })

  test('describer uses titles and names, never bodies, amounts or recipients', () => {
    expect(describeCall('complete_task', { reference: 'abc' }, { title: 'pagar aluguel' })).toBe('Concluiu a tarefa “pagar aluguel”')
    const note = addNote({ kind: 'memo', body: 'ligar pro banco #urgente' })
    expect(describeCall('save_note', {}, note)).toBe('Salvou a nota “ligar pro banco”')
    expect(describeCall('manage_work_session', { action: 'stop' }, { durationMinutes: 42 })).toBe('Encerrou a sessão de trabalho (42 min)')
    const money = describeCall('record_transaction', { type: 'saida', amount: 1234.5, category: 'mercado', description: 'segredo' }, null)
    expect(money).toBe('Registrou uma despesa em “mercado”')
    expect(describeCall('m365_send_email', { to: 'a@b.com', subject: 'confidencial', body: 'x' }, null)).not.toMatch(/a@b|confidencial/)
    expect(describeCall('list_notes', {}, null)).toBeNull()
  })

  test('lines carry the outcome but never the input', () => {
    expect(journalLine(record({ decision: 'denied', ok: false }), NOW)).toContain('Bloqueado pela política')
    expect(journalLine(record({ ok: false, error: 'segredo@exemplo.com' }), NOW)).not.toContain('segredo')
    // Caller-controlled names and engine text cannot inject Markdown.
    expect(journalLine(record({ tool: 'x\n![[evil]]', decision: 'unknown', ok: false }), NOW)).not.toContain('evil')
    expect(journalLine(record({ decision: 'invalid', ok: false, error: 'bad `code` [[link]]' }), NOW)).not.toMatch(/[`[\]]{2}|`code`/)
  })

  test('journals in the old terse format are rewritten as sentences on push', () => {
    const vr = openVault()
    mkdirSync(join(vr.root, 'Diário'), { recursive: true })
    write(vr, 'Diário/2026-11-19.md', [
      '# Diário smolerclaw — 2026-11-19', '',
      '- 19:38:03 · `complete_task` · ok',
      '- 19:40:00 · `m365_send_email` · negado pela política',
      '- 19:41:00 · sync automático do Obsidian · 1 tarefa concluída',
      'linha escrita à mão', '',
    ].join('\n'))

    expect(push(vr, NOW).written).toContain('Diário/2026-11-19.md')
    expect(read(vr, 'Diário/2026-11-19.md')).toBe([
      '# Diário — quinta-feira, 19 de novembro de 2026', '',
      '> O que o smolerclaw fez neste dia: o que foi criado, concluído ou alterado, e o que falhou. Consultas não aparecem.', '',
      '- **19:38** Concluiu uma tarefa %%complete_task%%',
      '- **19:40** 🚫 Bloqueado pela política: `m365_send_email` %%m365_send_email%%',
      '- **19:41** Trouxe edições do Obsidian: 1 tarefa concluída %%sync-automatico%%',
      'linha escrita à mão', '',
    ].join('\n'))
    // Already upgraded: the next push leaves it alone.
    expect(push(vr, NOW).written).not.toContain('Diário/2026-11-19.md')
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
    expect(text.startsWith('# Diário — ')).toBe(true)
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
    writeFileSync(file, editText(readFileSync(file, 'utf-8'), 'versão do banco', 'versão do obsidian'))
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
    expect(journal).toContain('Trouxe edições do Obsidian: 1 tarefa concluída')
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

describe('panel journal embed', () => {
  const HEADER = '# Diário — sexta-feira, 20 de novembro de 2026\n\n'
    + '> O que o smolerclaw fez neste dia: o que foi criado, concluído ou alterado, e o que falhou. Consultas não aparecem.\n\n'

  test('push creates the day journal so the panel embed is never broken', () => {
    const vr = openVault()
    push(vr, NOW)
    expect(read(vr, 'Diário/2026-11-20.md')).toBe(HEADER)
  })

  test('the first activity after push appends without a second header', () => {
    const vr = openVault()
    push(vr, NOW)
    appendJournal(vr, NOW, '- linha\n')
    expect(read(vr, 'Diário/2026-11-20.md')).toBe(`${HEADER}- linha\n`)
  })

  test('push leaves an existing journal untouched', () => {
    const vr = openVault()
    appendJournal(vr, NOW, '- antes\n')
    push(vr, NOW)
    expect(read(vr, 'Diário/2026-11-20.md')).toBe(`${HEADER}- antes\n`)
  })
})
