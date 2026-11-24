/**
 * One readable sentence per successful tool call, for the vault journal.
 * Only titles and names are used (a task title, a project name): never bodies,
 * amounts, recipients or e-mail subjects, which may not belong in a vault
 * that is often synced to a cloud.
 */
import { displayTitle } from './markdown'
import type { Note } from '../notes'

type Fields = Readonly<Record<string, unknown>>
type Describer = (input: Fields, data: unknown) => string

const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null)
const record = (v: unknown): Fields => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Fields) : {})
const quoted = (v: unknown): string => {
  const t = text(v)
  return t ? ` “${t}”` : ''
}

function noteName(data: unknown): string {
  const note = record(data)
  return typeof note.body === 'string' && typeof note.kind === 'string' ? ` “${displayTitle(note as unknown as Note)}”` : ''
}

function session(input: Fields, data: unknown): string {
  const action = text(input.action)
  const minutes = record(data).durationMinutes
  if (action === 'start') return 'Iniciou uma sessão de trabalho'
  if (action === 'stop') return typeof minutes === 'number' ? `Encerrou a sessão de trabalho (${minutes} min)` : 'Encerrou a sessão de trabalho'
  return 'Consultou a sessão de trabalho'
}

const DESCRIBERS: Readonly<Record<string, Describer>> = {
  create_task: (input, data) => `Criou a tarefa${quoted(record(data).title ?? input.title)}`,
  complete_task: (_, data) => `Concluiu a tarefa${quoted(record(data).title)}`,
  save_note: (_, data) => `Salvou a nota${noteName(data)}`,
  update_note: (_, data) => `Atualizou a nota${noteName(data)}`,
  delete_note: () => 'Apagou uma nota',
  schedule_job: (input) => `Agendou o lembrete${quoted(input.name)}`,
  remove_scheduled_job: (input) => `Removeu o agendamento${quoted(input.reference)}`,
  enable_scheduled_job: (input) => `Reativou o agendamento${quoted(input.reference)}`,
  disable_scheduled_job: (input) => `Pausou o agendamento${quoted(input.reference)}`,
  run_scheduled_job_now: (input) => `Rodou agora o agendamento${quoted(input.reference)}`,
  add_person: (input) => `Cadastrou${quoted(input.name)} nos contatos`,
  log_interaction: (input) => `Registrou uma interação com${quoted(input.person)}`,
  delegate_to_person: (input) => `Delegou uma tarefa para${quoted(input.person)}`,
  update_delegation_status: (input) => `Marcou uma delegação como${quoted(input.status)}`,
  record_transaction: (input) => `Registrou uma ${input.type === 'entrada' ? 'receita' : 'despesa'} em${quoted(input.category)}`,
  log_decision: (input) => `Registrou a decisão${quoted(input.title)}`,
  set_active_project: (input, data) => `Definiu o projeto ativo:${quoted(record(data).name ?? input.name_or_id)}`,
  manage_work_session: session,
  add_project: (input) => `Registrou o projeto${quoted(input.name)}`,
  add_opportunity: (input) => `Registrou a oportunidade${quoted(input.title)}`,
  update_opportunity_status: (input, data) => `Moveu a oportunidade${quoted(record(data).title)} para${quoted(input.status)}`,
  draft_email: () => 'Preparou um rascunho de e-mail',
  send_notification: () => 'Enviou uma notificação',
  vault_backup: () => 'Fez backup do vault',
  vault_init_backup: () => 'Iniciou o backup versionado do vault',
  sync_cloud_context: () => 'Sincronizou o contexto com a nuvem',
  obsidian_sync: () => 'Sincronizou o vault do Obsidian',
  obsidian_mode: (input) => (text(input.pull) ? `Mudou a leitura de edições do Obsidian para ${text(input.pull)}` : 'Consultou o modo de leitura do Obsidian'),
  m365_send_email: () => 'Enviou um e-mail pelo Microsoft 365',
  gws_send_email: () => 'Enviou um e-mail pelo Google',
  m365_create_event: (input) => `Criou o evento${quoted(input.subject)} no Outlook`,
  gws_create_event: (input) => `Criou o evento${quoted(input.summary)} no Google Agenda`,
  m365_create_todo: (input) => `Criou o to-do${quoted(input.title)} no Microsoft To Do`,
  m365_complete_todo: () => 'Concluiu um to-do no Microsoft To Do',
}

/** What a call did when nothing is known about its data: older journal lines, calls without a describer sentence. */
const GENERIC: Readonly<Record<string, string>> = {
  create_task: 'Criou uma tarefa',
  complete_task: 'Concluiu uma tarefa',
  save_note: 'Salvou uma nota',
  update_note: 'Atualizou uma nota',
  schedule_job: 'Agendou um lembrete',
  remove_scheduled_job: 'Removeu um agendamento',
  enable_scheduled_job: 'Reativou um agendamento',
  disable_scheduled_job: 'Pausou um agendamento',
  run_scheduled_job_now: 'Rodou um agendamento',
  add_person: 'Cadastrou um contato',
  log_interaction: 'Registrou uma interação',
  delegate_to_person: 'Delegou uma tarefa',
  update_delegation_status: 'Atualizou uma delegação',
  record_transaction: 'Registrou uma transação',
  log_decision: 'Registrou uma decisão',
  set_active_project: 'Trocou o projeto ativo',
  manage_work_session: 'Mexeu na sessão de trabalho',
  add_project: 'Registrou um projeto',
  add_opportunity: 'Registrou uma oportunidade',
  update_opportunity_status: 'Atualizou uma oportunidade',
  m365_create_event: 'Criou um evento no Outlook',
  gws_create_event: 'Criou um evento no Google Agenda',
  m365_create_todo: 'Criou um to-do no Microsoft To Do',
}

/** Sentence for a call whose data is unknown, or null when there is nothing better than its name. */
export function describeTool(tool: string): string | null {
  return GENERIC[tool] ?? describeCall(tool, {}, null)
}

/** Readable sentence for a successful call, or null when the tool has no describer. */
export function describeCall(tool: string, input: Fields, data: unknown): string | null {
  const describe = DESCRIBERS[tool]
  if (!describe) return null
  try {
    return describe(input, data)
  } catch {
    return null
  }
}
