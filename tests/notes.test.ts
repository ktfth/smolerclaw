import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  initNotes, closeNotes, addNote, getNote, updateNote, deleteNote, listNotes, searchNotes,
  noteTags, noteCategories, collectTags, buildReferenceContext, exportNotesSnapshot,
} from '../src/notes'
import { executeToolResult } from '../src/tools'

beforeEach(() => {
  initNotes(mkdtempSync(join(tmpdir(), 'smolerclaw-notes-')))
})

afterEach(() => closeNotes())

describe('notes store', () => {
  test('collects explicit and #hashtag tags, normalised and unique', () => {
    expect(collectTags(['Work', '#work'], 'see #Ação and #ação-2')).toEqual(['work', 'ação', 'ação-2'])
    // Spaces cannot survive: tags are read back from a space-separated group_concat.
    expect(collectTags(['foo  bar'])).toEqual(['foo-bar'])
  })

  test('add, get, update and delete round-trip', () => {
    const note = addNote({ kind: 'link', url: 'https://www.example.com/x', title: 'Ex', body: 'docs #ref' })
    expect(getNote(note.id)).toMatchObject({ kind: 'link', url: 'https://www.example.com/x', tags: ['ref'] })

    const updated = updateNote(note.id, { url: '', tags: ['a'] })
    expect(updated?.url).toBeNull()
    expect(updated?.tags).toEqual(['a', 'ref'])

    expect(deleteNote(note.id)).toBe(true)
    expect(getNote(note.id)).toBeNull()
    expect(deleteNote(note.id)).toBe(false)
  })

  test('deleting a note removes its tags', () => {
    const note = addNote({ kind: 'memo', body: 'x #solo' })
    deleteNote(note.id)
    expect(noteTags()).toEqual([])
  })

  test('search by words, #tag and @category/@domain', () => {
    addNote({ kind: 'memo', body: 'pagar aluguel dia 5 #casa' })
    addNote({ kind: 'link', url: 'https://github.com/x/y', title: 'repo', body: '' })
    addNote({ kind: 'reference', title: 'Deploy', body: 'passos', category: 'procedimento' })

    expect(searchNotes('aluguel pagar').map((n) => n.kind)).toEqual(['memo'])
    expect(searchNotes('#casa')).toHaveLength(1)
    expect(searchNotes('@github.com').map((n) => n.kind)).toEqual(['link'])
    expect(searchNotes('@procedimento').map((n) => n.title)).toEqual(['Deploy'])
    expect(searchNotes('aluguel', { kind: 'link' })).toEqual([])
  })

  test('lists by kind and category, with a limit', () => {
    addNote({ kind: 'reference', title: 'A', body: 'a', category: 'Guia' })
    addNote({ kind: 'reference', title: 'B', body: 'b', category: 'guia' })
    addNote({ kind: 'memo', body: 'm' })
    expect(listNotes({ kind: 'reference' })).toHaveLength(2)
    expect(noteCategories('reference')).toEqual([{ category: 'guia', count: 2 }])
    expect(listNotes({ limit: 1 })).toHaveLength(1)
  })

  test('reference context and backup snapshot', () => {
    expect(buildReferenceContext()).toBe('')
    addNote({ kind: 'reference', title: 'VPN', body: 'conectar via x', category: 'tecnico' })
    expect(buildReferenceContext()).toContain('[tecnico]')
    expect(JSON.parse(exportNotesSnapshot() ?? '[]')).toHaveLength(1)
  })
})

describe('legacy migration', () => {
  test('imports memos, bookmarks and materials once and keeps the originals', () => {
    closeNotes()
    const legacy = mkdtempSync(join(tmpdir(), 'smolerclaw-notes-legacy-'))
    writeFileSync(join(legacy, 'memos.json'), JSON.stringify([
      { id: 'm1', content: 'ligar pro banco #urgente', tags: [], createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-02T00:00:00.000Z' },
    ]))
    writeFileSync(join(legacy, 'bookmarks.json'), JSON.stringify([
      { id: 'b1', url: 'https://bun.sh', title: 'Bun', description: '', tags: ['dev'], domain: 'bun.sh' },
    ]))
    writeFileSync(join(legacy, 'materials.json'), JSON.stringify([
      { id: 'abc123', title: 'Onboarding', content: 'passo a passo', category: 'Guia', tags: [] },
    ]))

    initNotes(legacy)
    expect(getNote('m1')).toMatchObject({ kind: 'memo', tags: ['urgente'], createdAt: '2026-01-01T00:00:00.000Z' })
    expect(getNote('b1')).toMatchObject({ kind: 'link', url: 'https://bun.sh', tags: ['dev'] })
    expect(getNote('abc123')).toMatchObject({ kind: 'reference', category: 'guia' })
    for (const f of ['memos', 'bookmarks', 'materials']) {
      expect(existsSync(join(legacy, `${f}.json`))).toBe(false)
      expect(existsSync(join(legacy, `${f}.migrated.json`))).toBe(true)
    }

    // A file reappearing later is not imported twice.
    writeFileSync(join(legacy, 'memos.json'), JSON.stringify([{ id: 'm2', content: 'novo' }]))
    initNotes(legacy)
    expect(getNote('m2')).toBeNull()
    expect(listNotes()).toHaveLength(3)
  })

  test('an unreadable legacy file is left untouched', () => {
    closeNotes()
    const legacy = mkdtempSync(join(tmpdir(), 'smolerclaw-notes-bad-'))
    writeFileSync(join(legacy, 'memos.json'), '{ not json')
    initNotes(legacy)
    expect(existsSync(join(legacy, 'memos.json'))).toBe(true)
    expect(listNotes()).toEqual([])
  })
})

describe('note tools', () => {
  test('link notes need a url; schema rejects unknown kinds', async () => {
    expect((await executeToolResult('save_note', { kind: 'link', body: 'x' })).ok).toBe(false)
    expect((await executeToolResult('save_note', { kind: 'bookmark', body: 'x' })).ok).toBe(false)
    const saved = await executeToolResult('save_note', { kind: 'reference', title: 'T', body: 'conteúdo' })
    expect(saved.ok && (saved.data as { category: string }).category).toBe('geral')
  })

  test('missing notes fail structurally', async () => {
    expect((await executeToolResult('get_note', { id: 'nada' })).ok).toBe(false)
    expect((await executeToolResult('delete_note', { id: 'nada' })).ok).toBe(false)
    expect((await executeToolResult('update_note', { id: 'nada', body: 'x' })).ok).toBe(false)
  })
})
