/**
 * People management — personal CRM for team, family, and contacts.
 * Stores people, interaction logs, delegated tasks, and follow-up reminders.
 */

import { randomUUID } from 'node:crypto'
import type { Database } from 'bun:sqlite'
import { ensureSchema, hasSchema, importLegacyJson, openStore, store } from './core/store'

// ─── Types ──────────────────────────────────────────────────

export type PersonGroup = 'equipe' | 'familia' | 'contato'

export interface Person {
  id: string
  name: string
  group: PersonGroup
  role?: string           // "dev frontend", "esposa", "filho", "fornecedor"
  contact?: string        // phone, email, etc.
  notes?: string          // free-text notes
  neighborhood?: string   // linked neighborhood name or ID (Lokaliza)
  location?: string       // free-text location (city, region)
  createdAt: string
}

export interface Interaction {
  id: string
  personId: string
  date: string            // ISO date
  type: InteractionType
  summary: string
  followUpDate?: string   // ISO date — when to follow up
  followUpDone: boolean
}

export type InteractionType = 'conversa' | 'email' | 'reuniao' | 'ligacao' | 'mensagem' | 'delegacao' | 'entrega' | 'outro'

export interface Delegation {
  id: string
  personId: string
  task: string
  assignedAt: string
  dueDate?: string        // ISO date
  status: 'pendente' | 'em_andamento' | 'concluido' | 'atrasado'
  notes?: string
}

interface PeopleData {
  people: Person[]
  interactions: Interaction[]
  delegations: Delegation[]
}

// ─── Storage ────────────────────────────────────────────────
// People, interactions and delegations live in the shared SQLite store.

const LEGACY_FILE = 'people.json'
const GROUPS: ReadonlySet<string> = new Set(['equipe', 'familia', 'contato'])
const INTERACTION_TYPES: ReadonlySet<string> = new Set(['conversa', 'email', 'reuniao', 'ligacao', 'mensagem', 'delegacao', 'entrega', 'outro'])
const DELEGATION_STATUSES: ReadonlySet<string> = new Set(['pendente', 'em_andamento', 'concluido', 'atrasado'])

const SCHEMA = `
CREATE TABLE IF NOT EXISTS people (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  person_group TEXT NOT NULL,
  role         TEXT,
  contact      TEXT,
  notes        TEXT,
  neighborhood TEXT,
  location     TEXT,
  created_at   TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS interactions (
  id             TEXT PRIMARY KEY,
  person_id      TEXT NOT NULL,
  date           TEXT NOT NULL,
  type           TEXT NOT NULL,
  summary        TEXT NOT NULL,
  follow_up_date TEXT,
  follow_up_done INTEGER NOT NULL DEFAULT 0 CHECK (follow_up_done IN (0, 1))
);
CREATE INDEX IF NOT EXISTS idx_interactions_person ON interactions(person_id);
CREATE TABLE IF NOT EXISTS delegations (
  id          TEXT PRIMARY KEY,
  person_id   TEXT NOT NULL,
  task        TEXT NOT NULL,
  assigned_at TEXT NOT NULL,
  due_date    TEXT,
  status      TEXT NOT NULL,
  notes       TEXT
);
CREATE INDEX IF NOT EXISTS idx_delegations_person ON delegations(person_id)
`

type Row = Record<string, string | number | null>

/** Copy only the optional fields that hold a value, so records keep their JSON shape. */
function withOptional<T extends object>(base: T, optional: Record<string, string | number | null | undefined>): T {
  const present = Object.entries(optional).filter(([, v]) => v !== null && v !== undefined)
  return { ...base, ...Object.fromEntries(present) }
}

function toPerson(r: Row): Person {
  return withOptional<Person>(
    { id: String(r.id), name: String(r.name), group: r.person_group as PersonGroup, createdAt: String(r.created_at) },
    { role: r.role, contact: r.contact, notes: r.notes, neighborhood: r.neighborhood, location: r.location },
  )
}

function toInteraction(r: Row): Interaction {
  return withOptional<Interaction>(
    {
      id: String(r.id), personId: String(r.person_id), date: String(r.date),
      type: r.type as InteractionType, summary: String(r.summary), followUpDone: r.follow_up_done === 1,
    },
    { followUpDate: r.follow_up_date },
  )
}

function toDelegation(r: Row): Delegation {
  return withOptional<Delegation>(
    {
      id: String(r.id), personId: String(r.person_id), task: String(r.task),
      assignedAt: String(r.assigned_at), status: r.status as Delegation['status'],
    },
    { dueDate: r.due_date, notes: r.notes },
  )
}

function selectPeople(): Person[] {
  return (store().query('SELECT * FROM people ORDER BY rowid').all() as Row[]).map(toPerson)
}

function selectInteractions(): Interaction[] {
  return (store().query('SELECT * FROM interactions ORDER BY rowid').all() as Row[]).map(toInteraction)
}

function selectDelegations(): Delegation[] {
  return (store().query('SELECT * FROM delegations ORDER BY rowid').all() as Row[]).map(toDelegation)
}

function insertPerson(db: Database, p: Person): void {
  db.query('INSERT INTO people (id, name, person_group, role, contact, notes, neighborhood, location, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(p.id, p.name, p.group, p.role ?? null, p.contact ?? null, p.notes ?? null, p.neighborhood ?? null, p.location ?? null, p.createdAt)
}

function insertInteraction(db: Database, i: Interaction): void {
  db.query('INSERT INTO interactions (id, person_id, date, type, summary, follow_up_date, follow_up_done) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(i.id, i.personId, i.date, i.type, i.summary, i.followUpDate ?? null, i.followUpDone ? 1 : 0)
}

function insertDelegation(db: Database, d: Delegation): void {
  db.query('INSERT INTO delegations (id, person_id, task, assigned_at, due_date, status, notes) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(d.id, d.personId, d.task, d.assignedAt, d.dueDate ?? null, d.status, d.notes ?? null)
}

// ─── Init ───────────────────────────────────────────────────

export function initPeople(dataDir: string): void {
  openStore(dataDir)
  ensureSchema('people', SCHEMA)
  importLegacyJson(dataDir, LEGACY_FILE, importLegacyPeople)
}

/** Every person, interaction and delegation as pretty JSON, for the vault's git backup. */
export function exportPeopleSnapshot(): string | null {
  if (!hasSchema('people')) return null
  return JSON.stringify({ people: selectPeople(), interactions: selectInteractions(), delegations: selectDelegations() }, null, 2)
}

// ─── People CRUD ────────────────────────────────────────────

export function addPerson(name: string, group: PersonGroup, role?: string, contact?: string, neighborhood?: string, location?: string): Person {
  const person: Person = {
    id: genId(),
    name: name.trim(),
    group,
    role: role?.trim(),
    contact: contact?.trim(),
    neighborhood: neighborhood?.trim(),
    location: location?.trim(),
    createdAt: new Date().toISOString(),
  }
  insertPerson(store(), person)
  return person
}

export function updatePerson(idOrName: string, updates: Partial<Pick<Person, 'name' | 'group' | 'role' | 'contact' | 'notes' | 'neighborhood' | 'location'>>): Person | null {
  const person = findPerson(idOrName)
  if (!person) return null

  const updated = { ...person, ...stripUndefined(updates) } as Person
  store().query('UPDATE people SET name = ?, person_group = ?, role = ?, contact = ?, notes = ?, neighborhood = ?, location = ? WHERE id = ?')
    .run(updated.name, updated.group, updated.role ?? null, updated.contact ?? null, updated.notes ?? null, updated.neighborhood ?? null, updated.location ?? null, person.id)
  return findPerson(person.id)
}

export function removePerson(idOrName: string): boolean {
  const person = findPerson(idOrName)
  if (!person) return false

  const db = store()
  db.transaction(() => {
    db.query('DELETE FROM interactions WHERE person_id = ?').run(person.id)
    db.query('DELETE FROM delegations WHERE person_id = ?').run(person.id)
    db.query('DELETE FROM people WHERE id = ?').run(person.id)
  }).immediate()
  return true
}

export function findPerson(idOrName: string): Person | null {
  const lower = idOrName.toLowerCase()
  return selectPeople().find(
    (p) => p.id === idOrName || p.name.toLowerCase().includes(lower),
  ) || null
}

export function listPeople(group?: PersonGroup): Person[] {
  const people = selectPeople()
  return group ? people.filter((p) => p.group === group) : people
}

// ─── Interactions ───────────────────────────────────────────

export function logInteraction(
  personIdOrName: string,
  type: InteractionType,
  summary: string,
  followUpDate?: Date,
): Interaction | null {
  const person = findPerson(personIdOrName)
  if (!person) return null

  const interaction: Interaction = {
    id: genId(),
    personId: person.id,
    date: new Date().toISOString(),
    type,
    summary: summary.trim(),
    followUpDate: followUpDate?.toISOString(),
    followUpDone: false,
  }
  insertInteraction(store(), interaction)
  return interaction
}

export function getInteractions(personIdOrName: string, limit = 10): Interaction[] {
  const person = findPerson(personIdOrName)
  if (!person) return []

  return selectInteractions()
    .filter((i) => i.personId === person.id)
    .reverse() // newest insertion last → first after reverse
    .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
    .slice(0, limit)
}

export function getPendingFollowUps(): Array<{ person: Person; interaction: Interaction }> {
  const now = new Date()
  const results: Array<{ person: Person; interaction: Interaction }> = []

  const people = selectPeople()
  for (const interaction of selectInteractions()) {
    if (interaction.followUpDone || !interaction.followUpDate) continue
    const followUp = new Date(interaction.followUpDate)
    if (isNaN(followUp.getTime())) continue
    if (followUp <= now) {
      const person = people.find((p) => p.id === interaction.personId)
      if (person) results.push({ person, interaction })
    }
  }

  return results.sort((a, b) =>
    new Date(a.interaction.followUpDate!).getTime() - new Date(b.interaction.followUpDate!).getTime(),
  )
}

export function markFollowUpDone(interactionId: string): boolean {
  return store().query('UPDATE interactions SET follow_up_done = 1 WHERE id = ?').run(interactionId).changes > 0
}

// ─── Delegations ────────────────────────────────────────────

export function delegateTask(
  personIdOrName: string,
  task: string,
  dueDate?: Date,
): Delegation | null {
  const person = findPerson(personIdOrName)
  if (!person) return null

  const delegation: Delegation = {
    id: genId(),
    personId: person.id,
    task: task.trim(),
    assignedAt: new Date().toISOString(),
    dueDate: dueDate?.toISOString(),
    status: 'pendente',
  }
  insertDelegation(store(), delegation)
  return delegation
}

export function updateDelegation(
  delegationId: string,
  status: Delegation['status'],
  notes?: string,
): Delegation | null {
  const found = selectDelegations().find((d) => d.id === delegationId)
  if (!found) return null

  const keptNotes = notes || found.notes
  const updated: Delegation = { ...found, status, ...(keptNotes ? { notes: keptNotes } : {}) }
  store().query('UPDATE delegations SET status = ?, notes = ? WHERE id = ?').run(updated.status, updated.notes ?? null, delegationId)
  return updated
}

export function getDelegations(personIdOrName?: string, onlyPending = true): Delegation[] {
  let results = selectDelegations()

  if (personIdOrName) {
    const person = findPerson(personIdOrName)
    if (!person) return []
    results = results.filter((d) => d.personId === person.id)
  }

  if (onlyPending) {
    results = results.filter((d) => d.status !== 'concluido')
  }

  // Mark overdue delegations
  const now = new Date()
  results = results.map((d) => {
    if (d.status === 'pendente' && d.dueDate) {
      const due = new Date(d.dueDate)
      if (!isNaN(due.getTime()) && due < now) {
        return { ...d, status: 'atrasado' as const }
      }
    }
    return d
  })

  return results.sort((a, b) => {
    // Overdue first, then by due date
    if (a.status === 'atrasado' && b.status !== 'atrasado') return -1
    if (b.status === 'atrasado' && a.status !== 'atrasado') return 1
    const da = a.dueDate ? new Date(a.dueDate).getTime() : Infinity
    const db = b.dueDate ? new Date(b.dueDate).getTime() : Infinity
    return da - db
  })
}

// ─── Formatting ─────────────────────────────────────────────

const GROUP_LABELS: Record<PersonGroup, string> = {
  equipe: 'Equipe',
  familia: 'Familia',
  contato: 'Contato',
}

export function formatPeopleList(people: Person[]): string {
  if (people.length === 0) return 'Nenhuma pessoa cadastrada.'

  const grouped = new Map<PersonGroup, Person[]>()
  for (const p of people) {
    const list = grouped.get(p.group) || []
    grouped.set(p.group, [...list, p])
  }

  const sections: string[] = []
  const order: PersonGroup[] = ['equipe', 'familia', 'contato']

  for (const group of order) {
    const groupPeople = grouped.get(group)
    if (!groupPeople?.length) continue

    const lines = groupPeople.map((p) => {
      const role = p.role ? ` (${p.role})` : ''
      const contact = p.contact ? ` — ${p.contact}` : ''
      return `  ${p.name}${role}${contact}  [${p.id}]`
    })
    sections.push(`--- ${GROUP_LABELS[group]} ---\n${lines.join('\n')}`)
  }

  return sections.join('\n\n')
}

export function formatPersonDetail(person: Person): string {
  const lines: string[] = []
  lines.push(`${person.name} [${person.id}]`)
  lines.push(`Grupo: ${GROUP_LABELS[person.group]}`)
  if (person.role) lines.push(`Papel: ${person.role}`)
  if (person.contact) lines.push(`Contato: ${person.contact}`)
  if (person.neighborhood) lines.push(`Bairro: ${person.neighborhood}`)
  if (person.location) lines.push(`Local: ${person.location}`)
  if (person.notes) lines.push(`Notas: ${person.notes}`)

  // Recent interactions
  const interactions = getInteractions(person.id, 5)
  if (interactions.length > 0) {
    lines.push('\nInteracoes recentes:')
    for (const i of interactions) {
      const date = new Date(i.date).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' })
      lines.push(`  [${date}] ${i.type}: ${i.summary}`)
    }
  }

  // Pending delegations
  const delegations = getDelegations(person.id)
  if (delegations.length > 0) {
    lines.push('\nTarefas delegadas:')
    for (const d of delegations) {
      const statusIcon = d.status === 'atrasado' ? '!!' : d.status === 'em_andamento' ? '>>' : '  '
      const due = d.dueDate ? ` (${formatDate(d.dueDate)})` : ''
      lines.push(`  ${statusIcon} ${d.task}${due} [${d.status}]`)
    }
  }

  return lines.join('\n')
}

export function formatDelegationList(delegations: Delegation[]): string {
  if (delegations.length === 0) return 'Nenhuma tarefa delegada pendente.'

  const lines = delegations.map((d) => {
    const person = selectPeople().find((p) => p.id === d.personId)
    const name = person?.name || '?'
    const statusIcon = d.status === 'atrasado' ? '!! ' : d.status === 'em_andamento' ? '>> ' : '   '
    const due = d.dueDate ? ` (${formatDate(d.dueDate)})` : ''
    return `${statusIcon}${name}: ${d.task}${due} [${d.status}] [${d.id}]`
  })

  return `Delegacoes (${delegations.length}):\n${lines.join('\n')}`
}

export function formatFollowUps(items: Array<{ person: Person; interaction: Interaction }>): string {
  if (items.length === 0) return 'Nenhum follow-up pendente.'

  const lines = items.map(({ person, interaction }) => {
    const date = formatDate(interaction.followUpDate!)
    return `  [${date}] ${person.name}: ${interaction.summary}  [${interaction.id}]`
  })

  return `Follow-ups pendentes (${items.length}):\n${lines.join('\n')}`
}

// ─── Dashboard ──────────────────────────────────────────────

export function generatePeopleDashboard(): string {
  const sections: string[] = []
  sections.push('=== PAINEL DE PESSOAS ===\n')

  // Summary counts
  const teamCount = selectPeople().filter((p) => p.group === 'equipe').length
  const familyCount = selectPeople().filter((p) => p.group === 'familia').length
  const contactCount = selectPeople().filter((p) => p.group === 'contato').length
  sections.push(`Equipe: ${teamCount} | Familia: ${familyCount} | Contatos: ${contactCount}`)

  // Overdue follow-ups
  const followUps = getPendingFollowUps()
  if (followUps.length > 0) {
    sections.push(`\n!! ${followUps.length} follow-up(s) pendente(s):`)
    for (const { person, interaction } of followUps.slice(0, 5)) {
      sections.push(`   ${person.name}: ${interaction.summary}`)
    }
  }

  // Overdue/pending delegations
  const allDelegations = getDelegations()
  const overdue = allDelegations.filter((d) => d.status === 'atrasado')
  const pending = allDelegations.filter((d) => d.status === 'pendente' || d.status === 'em_andamento')

  if (overdue.length > 0) {
    sections.push(`\n!! ${overdue.length} delegacao(oes) atrasada(s):`)
    for (const d of overdue.slice(0, 5)) {
      const person = selectPeople().find((p) => p.id === d.personId)
      sections.push(`   ${person?.name}: ${d.task}`)
    }
  }

  if (pending.length > 0) {
    sections.push(`\n${pending.length} delegacao(oes) em andamento`)
  }

  // Recent interactions (last 3)
  const recent = selectInteractions()
    .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
    .slice(0, 3)

  if (recent.length > 0) {
    sections.push('\nUltimas interacoes:')
    for (const i of recent) {
      const person = selectPeople().find((p) => p.id === i.personId)
      const date = new Date(i.date).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' })
      sections.push(`  [${date}] ${person?.name}: ${i.summary}`)
    }
  }

  sections.push('\n========================')
  return sections.join('\n')
}

// ─── Helpers ────────────────────────────────────────────────

function importLegacyPeople(parsed: unknown, db: Database): void {
  if (!parsed || typeof parsed !== 'object') return
  const raw = parsed as Record<string, unknown>
  const list = (key: string): Record<string, unknown>[] =>
    Array.isArray(raw[key])
      ? (raw[key] as unknown[]).filter((x): x is Record<string, unknown> => !!x && typeof x === 'object')
      : []
  const text = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v : undefined)
  const now = new Date().toISOString()
  const taken = new Set<string>()
  // A missing or repeated id gets a fresh one, never a dropped record.
  const freshId = (id: unknown): string => {
    let next = typeof id === 'string' && id && !taken.has(id) ? id : genId()
    while (taken.has(next)) next = genId()
    taken.add(next)
    return next
  }

  const personIds = new Set<string>()
  for (const r of list('people')) {
    const name = text(r.name)
    if (!name) continue
    const id = freshId(r.id)
    personIds.add(id)
    insertPerson(db, {
      id, name, createdAt: text(r.createdAt) ?? now,
      group: (GROUPS.has(String(r.group)) ? r.group : 'contato') as PersonGroup,
      role: text(r.role), contact: text(r.contact), notes: text(r.notes),
      neighborhood: text(r.neighborhood), location: text(r.location),
    })
  }
  for (const r of list('interactions')) {
    if (typeof r.personId !== 'string' || !personIds.has(r.personId)) continue
    insertInteraction(db, {
      id: freshId(r.id), personId: r.personId, date: text(r.date) ?? now,
      type: (INTERACTION_TYPES.has(String(r.type)) ? r.type : 'outro') as InteractionType,
      summary: typeof r.summary === 'string' ? r.summary : '',
      followUpDate: text(r.followUpDate), followUpDone: r.followUpDone === true,
    })
  }
  for (const r of list('delegations')) {
    const task = text(r.task)
    if (typeof r.personId !== 'string' || !personIds.has(r.personId) || !task) continue
    insertDelegation(db, {
      id: freshId(r.id), personId: r.personId, task, assignedAt: text(r.assignedAt) ?? now,
      status: (DELEGATION_STATUSES.has(String(r.status)) ? r.status : 'pendente') as Delegation['status'],
      dueDate: text(r.dueDate), notes: text(r.notes),
    })
  }
}

function genId(): string {
  return randomUUID().slice(0, 8)
}

function formatDate(isoDate: string): string {
  const d = new Date(isoDate)
  if (isNaN(d.getTime())) return '?'
  const now = new Date()
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const target = new Date(d.getFullYear(), d.getMonth(), d.getDate())

  if (target.getTime() === today.getTime()) return 'hoje'
  const tomorrow = new Date(today)
  tomorrow.setDate(tomorrow.getDate() + 1)
  if (target.getTime() === tomorrow.getTime()) return 'amanha'

  const diff = Math.floor((target.getTime() - today.getTime()) / 86_400_000)
  if (diff < 0) return `${Math.abs(diff)}d atras`
  if (diff <= 7) return `em ${diff}d`

  return d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' })
}

function stripUndefined(obj: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const [key, val] of Object.entries(obj)) {
    if (val !== undefined) result[key] = val
  }
  return result
}
