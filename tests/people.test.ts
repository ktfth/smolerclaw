import { describe, test, expect, beforeEach } from 'bun:test'
import {
  initPeople, addPerson, findPerson, listPeople, updatePerson, removePerson,
  logInteraction, getInteractions, getPendingFollowUps, markFollowUpDone,
  delegateTask, updateDelegation, getDelegations,
  formatPeopleList, formatPersonDetail, formatDelegationList, formatFollowUps,
  generatePeopleDashboard, exportPeopleSnapshot,
} from '../src/people'
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs'
import { closeStore } from '../src/core/store'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

describe('people', () => {
  beforeEach(() => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'smolerclaw-people-'))
    initPeople(tmpDir)
  })

  // ── CRUD ──

  test('addPerson creates a person', () => {
    const p = addPerson('Joao', 'equipe', 'dev frontend')
    expect(p.id).toBeTruthy()
    expect(p.name).toBe('Joao')
    expect(p.group).toBe('equipe')
    expect(p.role).toBe('dev frontend')
  })

  test('findPerson by name (partial match)', () => {
    addPerson('Maria Silva', 'equipe')
    const found = findPerson('maria')
    expect(found?.name).toBe('Maria Silva')
  })

  test('findPerson by id', () => {
    const p = addPerson('Carlos', 'familia')
    const found = findPerson(p.id)
    expect(found?.name).toBe('Carlos')
  })

  test('findPerson returns null for unknown', () => {
    expect(findPerson('nobody')).toBeNull()
  })

  test('listPeople returns all', () => {
    addPerson('A', 'equipe')
    addPerson('B', 'familia')
    addPerson('C', 'contato')
    expect(listPeople().length).toBe(3)
  })

  test('listPeople filters by group', () => {
    addPerson('A', 'equipe')
    addPerson('B', 'familia')
    addPerson('C', 'equipe')
    expect(listPeople('equipe').length).toBe(2)
    expect(listPeople('familia').length).toBe(1)
  })

  test('updatePerson changes fields', () => {
    const p = addPerson('Ana', 'equipe')
    const updated = updatePerson(p.id, { role: 'tech lead' })
    expect(updated?.role).toBe('tech lead')
    expect(updated?.name).toBe('Ana')
  })

  test('removePerson deletes person and related data', () => {
    const p = addPerson('Temp', 'contato')
    logInteraction(p.id, 'conversa', 'test')
    delegateTask(p.id, 'test task')
    expect(removePerson(p.id)).toBe(true)
    expect(findPerson(p.id)).toBeNull()
    expect(getInteractions(p.id).length).toBe(0)
    expect(getDelegations(p.id).length).toBe(0)
  })

  // ── Interactions ──

  test('logInteraction creates an interaction', () => {
    const p = addPerson('Bob', 'equipe')
    const i = logInteraction(p.id, 'reuniao', 'Sprint planning')
    expect(i?.type).toBe('reuniao')
    expect(i?.summary).toBe('Sprint planning')
  })

  test('logInteraction returns null for unknown person', () => {
    expect(logInteraction('nobody', 'conversa', 'hi')).toBeNull()
  })

  test('getInteractions returns recent first', () => {
    const p = addPerson('Ana', 'equipe')
    logInteraction(p.id, 'email', 'first')
    logInteraction(p.id, 'email', 'second')
    logInteraction(p.id, 'email', 'third')
    const list = getInteractions(p.id)
    expect(list.length).toBe(3)
    expect(list[0].summary).toBe('third')
  })

  test('logInteraction with follow-up', () => {
    const p = addPerson('Joao', 'equipe')
    const future = new Date(Date.now() - 60_000) // 1 min ago = due
    logInteraction(p.id, 'conversa', 'cobrar relatorio', future)
    const followUps = getPendingFollowUps()
    expect(followUps.length).toBe(1)
    expect(followUps[0].person.name).toBe('Joao')
  })

  test('markFollowUpDone clears follow-up', () => {
    const p = addPerson('Joao', 'equipe')
    const past = new Date(Date.now() - 60_000)
    const i = logInteraction(p.id, 'conversa', 'test', past)
    expect(getPendingFollowUps().length).toBe(1)
    markFollowUpDone(i!.id)
    expect(getPendingFollowUps().length).toBe(0)
  })

  // ── Delegations ──

  test('delegateTask creates delegation', () => {
    const p = addPerson('Maria', 'equipe')
    const d = delegateTask(p.id, 'Revisar documento')
    expect(d?.task).toBe('Revisar documento')
    expect(d?.status).toBe('pendente')
  })

  test('delegateTask returns null for unknown person', () => {
    expect(delegateTask('nobody', 'task')).toBeNull()
  })

  test('updateDelegation changes status', () => {
    const p = addPerson('Carlos', 'equipe')
    const d = delegateTask(p.id, 'Fazer deploy')!
    const updated = updateDelegation(d.id, 'concluido', 'deploy feito')
    expect(updated?.status).toBe('concluido')
    expect(updated?.notes).toBe('deploy feito')
  })

  test('getDelegations shows overdue tasks', () => {
    const p = addPerson('Ana', 'equipe')
    const past = new Date(Date.now() - 86_400_000) // yesterday
    delegateTask(p.id, 'task atrasada', past)
    const list = getDelegations(p.id)
    expect(list.length).toBe(1)
    expect(list[0].status).toBe('atrasado')
  })

  test('getDelegations filters completed by default', () => {
    const p = addPerson('Bob', 'equipe')
    const d = delegateTask(p.id, 'done task')!
    updateDelegation(d.id, 'concluido')
    expect(getDelegations(p.id, true).length).toBe(0)
    expect(getDelegations(p.id, false).length).toBe(1)
  })

  // ── Formatting ──

  test('formatPeopleList groups by type', () => {
    addPerson('Alice', 'equipe')
    addPerson('Bob', 'familia')
    const text = formatPeopleList(listPeople())
    expect(text).toContain('Equipe')
    expect(text).toContain('Familia')
    expect(text).toContain('Alice')
    expect(text).toContain('Bob')
  })

  test('formatPeopleList empty', () => {
    expect(formatPeopleList([])).toContain('Nenhuma pessoa')
  })

  test('formatPersonDetail includes interactions and delegations', () => {
    const p = addPerson('Ana', 'equipe', 'tech lead')
    logInteraction(p.id, 'reuniao', 'daily standup')
    delegateTask(p.id, 'code review')
    const text = formatPersonDetail(p)
    expect(text).toContain('Ana')
    expect(text).toContain('tech lead')
    expect(text).toContain('daily standup')
    expect(text).toContain('code review')
  })

  test('formatDelegationList shows items', () => {
    const p = addPerson('X', 'equipe')
    delegateTask(p.id, 'task A')
    const text = formatDelegationList(getDelegations())
    expect(text).toContain('task A')
  })

  test('formatFollowUps empty', () => {
    expect(formatFollowUps([])).toContain('Nenhum follow-up')
  })

  // ── Dashboard ──

  test('generatePeopleDashboard returns structured output', () => {
    addPerson('Team1', 'equipe')
    addPerson('Family1', 'familia')
    const text = generatePeopleDashboard()
    expect(text).toContain('PAINEL DE PESSOAS')
    expect(text).toContain('Equipe: 1')
    expect(text).toContain('Familia: 1')
  })
})

describe('people — SQLite store', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'smolerclaw-people-'))
    initPeople(dir)
  })

  test('people, interactions and delegations survive a restart', () => {
    const ana = addPerson('Ana', 'equipe', 'dev')
    const it = logInteraction('Ana', 'conversa', 'alinhamento')!
    const dg = delegateTask('Ana', 'revisar PR')!
    closeStore()
    initPeople(dir)
    expect(listPeople()).toEqual([ana])
    expect(getInteractions('Ana')).toEqual([it])
    expect(getDelegations('Ana')).toEqual([dg])
  })

  test('optional fields come back absent, not null', () => {
    addPerson('Bia', 'contato')
    closeStore()
    initPeople(dir)
    const bia = findPerson('Bia')!
    expect('role' in bia).toBe(false)
    expect('contact' in bia).toBe(false)
    expect('notes' in bia).toBe(false)
  })

  test('removing a person removes their interactions and delegations', () => {
    addPerson('Caio', 'equipe')
    logInteraction('Caio', 'email', 'x')
    delegateTask('Caio', 'y')
    expect(removePerson('Caio')).toBe(true)
    expect(JSON.parse(exportPeopleSnapshot()!)).toEqual({ people: [], interactions: [], delegations: [] })
  })

  test('legacy people.json is imported once and renamed', () => {
    const legacyDir = mkdtempSync(join(tmpdir(), 'smolerclaw-people-'))
    writeFileSync(join(legacyDir, 'people.json'), JSON.stringify({
      people: [{ id: 'p1', name: 'Duda', group: 'familia', role: 'irmã', createdAt: '2026-04-01T00:00:00.000Z' }, { name: 42 }],
      interactions: [{ id: 'i1', personId: 'p1', date: '2026-04-02T00:00:00.000Z', type: 'ligacao', summary: 'oi', followUpDone: false }],
      delegations: [{ id: 'd1', personId: 'p1', task: 'comprar bolo', assignedAt: '2026-04-03T00:00:00.000Z', status: 'concluido' }],
    }))
    initPeople(legacyDir)
    expect(listPeople()).toEqual([{ id: 'p1', name: 'Duda', group: 'familia', role: 'irmã', createdAt: '2026-04-01T00:00:00.000Z' }])
    expect(getInteractions('Duda').map((i) => i.id)).toEqual(['i1'])
    expect(getDelegations('Duda', false).map((d) => d.status)).toEqual(['concluido'])
    expect(existsSync(join(legacyDir, 'people.json'))).toBe(false)
    expect(existsSync(join(legacyDir, 'people.migrated.json'))).toBe(true)
  })
})
