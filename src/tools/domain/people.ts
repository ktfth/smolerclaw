import type Anthropic from '@anthropic-ai/sdk'
import {
  addPerson, findPerson, listPeople, logInteraction, delegateTask, updateDelegation,
  formatPeopleList, formatPersonDetail, generatePeopleDashboard,
  type PersonGroup, type InteractionType,
} from '../../people'
import { parseFuzzyDate } from '../helpers'
import { bindTools, ok, fail, requireText, optionalText, type ToolHandler } from '../../core/result'

const SCHEMAS: Anthropic.Tool[] = [
  {
    name: 'add_person',
    description:
      'Register a person (team member, family, or contact). ' +
      'Groups: equipe (work team), familia (family/home), contato (other contacts).',
    input_schema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'Person name' },
        group: { type: 'string', enum: ['equipe', 'familia', 'contato'], description: 'Group: equipe, familia, or contato' },
        role: { type: 'string', description: 'Role or relationship (e.g. "dev frontend", "esposa", "fornecedor"). Optional.' },
        contact: { type: 'string', description: 'Phone, email, or other contact info. Optional.' },
        neighborhood: { type: 'string', description: 'Neighborhood the person lives in. Optional.' },
        location: { type: 'string', description: 'Free-text location (city, region). Optional.' },
      },
      required: ['name', 'group'],
    },
  },
  {
    name: 'find_person_info',
    description:
      'Look up a person by name or ID. Returns their profile, recent interactions, and pending delegated tasks.',
    input_schema: {
      type: 'object' as const,
      properties: {
        name_or_id: { type: 'string', description: 'Person name (partial match) or ID' },
      },
      required: ['name_or_id'],
    },
  },
  {
    name: 'list_people',
    description: 'List all registered people, optionally filtered by group.',
    input_schema: {
      type: 'object' as const,
      properties: {
        group: { type: 'string', enum: ['equipe', 'familia', 'contato'], description: 'Filter by group. Optional.' },
      },
      required: [],
    },
  },
  {
    name: 'log_interaction',
    description:
      'Log an interaction with a person. Types: conversa, email, reuniao, ligacao, mensagem, delegacao, entrega, outro. ' +
      'Optionally set a follow-up date for a reminder.',
    input_schema: {
      type: 'object' as const,
      properties: {
        person: { type: 'string', description: 'Person name or ID' },
        type: { type: 'string', enum: ['conversa', 'email', 'reuniao', 'ligacao', 'mensagem', 'delegacao', 'entrega', 'outro'], description: 'Interaction type' },
        summary: { type: 'string', description: 'What was discussed or happened' },
        follow_up: { type: 'string', description: 'When to follow up (e.g. "em 3 dias", "amanha", "25/03"). Optional.' },
      },
      required: ['person', 'type', 'summary'],
    },
  },
  {
    name: 'delegate_to_person',
    description:
      'Delegate/assign a task to a person with optional due date. ' +
      'Use to track what you asked someone to do.',
    input_schema: {
      type: 'object' as const,
      properties: {
        person: { type: 'string', description: 'Person name or ID' },
        task: { type: 'string', description: 'What they need to do' },
        due_date: { type: 'string', description: 'Due date (e.g. "sexta", "em 3 dias", "28/03"). Optional.' },
      },
      required: ['person', 'task'],
    },
  },
  {
    name: 'update_delegation_status',
    description: 'Update the status of a delegated task. Statuses: pendente, em_andamento, concluido.',
    input_schema: {
      type: 'object' as const,
      properties: {
        delegation_id: { type: 'string', description: 'Delegation ID' },
        status: { type: 'string', enum: ['pendente', 'em_andamento', 'concluido'], description: 'New status' },
        notes: { type: 'string', description: 'Optional notes about the update' },
      },
      required: ['delegation_id', 'status'],
    },
  },
  {
    name: 'get_people_dashboard',
    description:
      'Show the people management dashboard: summary of team/family/contacts, ' +
      'overdue follow-ups, overdue delegations, and recent interactions.',
    input_schema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  },
]

const GROUPS: readonly PersonGroup[] = ['equipe', 'familia', 'contato']
type DelegationStatus = 'pendente' | 'em_andamento' | 'concluido'

const HANDLERS: Record<string, ToolHandler> = {
  add_person: (input) => {
    const name = requireText(input, 'name')
    if (!name) return fail('name is required.')
    const group = input.group as PersonGroup
    if (!GROUPS.includes(group)) return fail('group must be equipe, familia, or contato.')
    const person = addPerson(
      name, group, optionalText(input, 'role'), optionalText(input, 'contact'),
      optionalText(input, 'neighborhood'), optionalText(input, 'location'),
    )
    const loc = person.neighborhood ? ` — Bairro: ${person.neighborhood}` : person.location ? ` — ${person.location}` : ''
    return ok(`Pessoa adicionada: ${person.name} (${group})${loc} [${person.id}]`, person)
  },
  find_person_info: (input) => {
    const ref = requireText(input, 'name_or_id')
    if (!ref) return fail('name_or_id is required.')
    const person = findPerson(ref)
    return person ? ok(formatPersonDetail(person), person) : fail(`Pessoa não encontrada: "${ref}"`)
  },
  list_people: (input) => {
    const people = listPeople(input.group as PersonGroup | undefined)
    return ok(formatPeopleList(people), people)
  },
  log_interaction: (input) => {
    const personRef = requireText(input, 'person')
    if (!personRef) return fail('person is required.')
    const summary = requireText(input, 'summary')
    if (!summary) return fail('summary is required.')
    const type = input.type as InteractionType
    const followUpStr = optionalText(input, 'follow_up')
    const followUpDate = followUpStr ? parseFuzzyDate(followUpStr) : null
    if (followUpStr && !followUpDate) return fail(`could not parse follow_up "${followUpStr}".`)
    const interaction = logInteraction(personRef, type, summary, followUpDate ?? undefined)
    if (!interaction) return fail(`Pessoa não encontrada: "${personRef}"`)
    const fuMsg = followUpDate ? ` — follow-up: ${followUpDate.toLocaleDateString('pt-BR')}` : ''
    return ok(`Interação registrada: ${type} com ${personRef}${fuMsg}`, interaction)
  },
  delegate_to_person: (input) => {
    const personRef = requireText(input, 'person')
    if (!personRef) return fail('person is required.')
    const task = requireText(input, 'task')
    if (!task) return fail('task is required.')
    const dueDateStr = optionalText(input, 'due_date')
    const dueDate = dueDateStr ? parseFuzzyDate(dueDateStr) : null
    if (dueDateStr && !dueDate) return fail(`could not parse due_date "${dueDateStr}".`)
    const delegation = delegateTask(personRef, task, dueDate ?? undefined)
    if (!delegation) return fail(`Pessoa não encontrada: "${personRef}"`)
    const dueMsg = dueDate ? ` — prazo: ${dueDate.toLocaleDateString('pt-BR')}` : ''
    return ok(`Tarefa delegada para ${personRef}: "${task}"${dueMsg} [${delegation.id}]`, delegation)
  },
  update_delegation_status: (input) => {
    const id = requireText(input, 'delegation_id')
    if (!id) return fail('delegation_id is required.')
    const status = input.status as DelegationStatus
    const result = updateDelegation(id, status, optionalText(input, 'notes'))
    return result
      ? ok(`Delegação atualizada: "${result.task}" -> ${status}`, result)
      : fail(`Delegação não encontrada: "${id}"`)
  },
  get_people_dashboard: () => ok(generatePeopleDashboard()),
}

export const PEOPLE_TOOLS = bindTools(SCHEMAS, HANDLERS, ['find_person_info', 'list_people', 'get_people_dashboard'])
