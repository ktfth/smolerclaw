/**
 * People management — personal CRM for team, family, and contacts.
 * Stores people, interaction logs, delegated tasks, and follow-up reminders.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// ─── Types ──────────────────────────────────────────────────

export type PersonGroup = 'equipe' | 'familia' | 'contato'

export interface Person {
  id: string
  name: string
  group: PersonGroup
  role?: string           // "dev frontend", "esposa", "filho", "fornecedor"
  contact?: string        // phone, email, etc.
  notes?: string          // free-text notes
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

let _dataDir = ''
let _data: PeopleData = { people: [], interactions: [], delegations: [] }

const DATA_FILE = () => join(_dataDir, 'people.json')

function save(): void {
  writeFileSync(DATA_FILE(), JSON.stringify(_data, null, 2))
}

function load(): void {
  const file = DATA_FILE()
  if (!existsSync(file)) {
    _data = { people: [], interactions: [], delegations: [] }
    return
  }
  try {
    const raw = JSON.parse(readFileSync(file, 'utf-8'))
    _data = {
      people: raw.people || [],
      interactions: raw.interactions || [],
      delegations: raw.delegations || [],
    }
  } catch {
    _data = { people: [], interactions: [], delegations: [] }
  }
}

// ─── Init ───────────────────────────────────────────────────

export function initPeople(dataDir: string): void {
  _dataDir = dataDir
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true })
  load()
}

// ─── People CRUD ────────────────────────────────────────────

export function addPerson(name: string, group: PersonGroup, role?: string, contact?: string): Person {
  const person: Person = {
    id: genId(),
    name: name.trim(),
    group,
    role: role?.trim(),
    contact: contact?.trim(),
    createdAt: new Date().toISOString(),
  }
  _data = { ..._data, people: [..._data.people, person] }
  save()
  return person
}

export function updatePerson(idOrName: string, updates: Partial<Pick<Person, 'name' | 'group' | 'role' | 'contact' | 'notes'>>): Person | null {
  const person = findPerson(idOrName)
  if (!person) return null

  _data = {
    ..._data,
    people: _data.people.map((p) =>
      p.id === person.id ? { ...p, ...stripUndefined(updates) } : p,
    ),
  }
  save()
  return _data.people.find((p) => p.id === person.id) || null
}

export function removePerson(idOrName: string): boolean {
  const person = findPerson(idOrName)
  if (!person) return false

  _data = {
    ..._data,
    people: _data.people.filter((p) => p.id !== person.id),
    interactions: _data.interactions.filter((i) => i.personId !== person.id),
    delegations: _data.delegations.filter((d) => d.personId !== person.id),
  }
  save()
  return true
}

export function findPerson(idOrName: string): Person | null {
  const lower = idOrName.toLowerCase()
  return _data.people.find(
    (p) => p.id === idOrName || p.name.toLowerCase().includes(lower),
  ) || null
}

export function listPeople(group?: PersonGroup): Person[] {
  if (group) return _data.people.filter((p) => p.group === group)
  return [..._data.people]
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
  _data = { ..._data, interactions: [..._data.interactions, interaction] }
  save()
  return interaction
}

export function getInteractions(personIdOrName: string, limit = 10): Interaction[] {
  const person = findPerson(personIdOrName)
  if (!person) return []

  return _data.interactions
    .filter((i) => i.personId === person.id)
    .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
    .slice(0, limit)
}

export function getPendingFollowUps(): Array<{ person: Person; interaction: Interaction }> {
  const now = new Date()
  const results: Array<{ person: Person; interaction: Interaction }> = []

  for (const interaction of _data.interactions) {
    if (interaction.followUpDone || !interaction.followUpDate) continue
    const followUp = new Date(interaction.followUpDate)
    if (isNaN(followUp.getTime())) continue
    if (followUp <= now) {
      const person = _data.people.find((p) => p.id === interaction.personId)
      if (person) results.push({ person, interaction })
    }
  }

  return results.sort((a, b) =>
    new Date(a.interaction.followUpDate!).getTime() - new Date(b.interaction.followUpDate!).getTime(),
  )
}

export function markFollowUpDone(interactionId: string): boolean {
  const found = _data.interactions.find((i) => i.id === interactionId)
  if (!found) return false

  _data = {
    ..._data,
    interactions: _data.interactions.map((i) =>
      i.id === interactionId ? { ...i, followUpDone: true } : i,
    ),
  }
  save()
  return true
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
  _data = { ..._data, delegations: [..._data.delegations, delegation] }
  save()
  return delegation
}

export function updateDelegation(
  delegationId: string,
  status: Delegation['status'],
  notes?: string,
): Delegation | null {
  const found = _data.delegations.find((d) => d.id === delegationId)
  if (!found) return null

  _data = {
    ..._data,
    delegations: _data.delegations.map((d) =>
      d.id === delegationId ? { ...d, status, notes: notes || d.notes } : d,
    ),
  }
  save()
  return _data.delegations.find((d) => d.id === delegationId) || null
}

export function getDelegations(personIdOrName?: string, onlyPending = true): Delegation[] {
  let results = [..._data.delegations]

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
    const person = _data.people.find((p) => p.id === d.personId)
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
  const teamCount = _data.people.filter((p) => p.group === 'equipe').length
  const familyCount = _data.people.filter((p) => p.group === 'familia').length
  const contactCount = _data.people.filter((p) => p.group === 'contato').length
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
      const person = _data.people.find((p) => p.id === d.personId)
      sections.push(`   ${person?.name}: ${d.task}`)
    }
  }

  if (pending.length > 0) {
    sections.push(`\n${pending.length} delegacao(oes) em andamento`)
  }

  // Recent interactions (last 3)
  const recent = [..._data.interactions]
    .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
    .slice(0, 3)

  if (recent.length > 0) {
    sections.push('\nUltimas interacoes:')
    for (const i of recent) {
      const person = _data.people.find((p) => p.id === i.personId)
      const date = new Date(i.date).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' })
      sections.push(`  [${date}] ${person?.name}: ${i.summary}`)
    }
  }

  sections.push('\n========================')
  return sections.join('\n')
}

// ─── Helpers ────────────────────────────────────────────────

function genId(): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789'
  let id = ''
  for (let i = 0; i < 6; i++) {
    id += chars[Math.floor(Math.random() * chars.length)]
  }
  return id
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
