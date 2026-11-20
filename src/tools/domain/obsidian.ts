import type Anthropic from '@anthropic-ai/sdk'
import { obsidianError, obsidianVault, status, sync, type VaultRoot } from '../../obsidian'
import { bindTools, ok, fail, type ToolHandler, type ToolResult } from '../../core/result'

const SCHEMAS: Anthropic.Tool[] = [
  {
    name: 'obsidian_sync',
    description:
      'Sync the Obsidian vault mirror both ways: apply edits made in Obsidian (edited notes, files in Inbox/, ' +
      'ticked or new lines in Tarefas.md, `deletar: true`), then re-project notes, tasks and the panel. ' +
      'Use when the user says "sincroniza o obsidian", "puxa o que eu editei", or before reading notes they may have edited.',
    input_schema: { type: 'object' as const, properties: {}, required: [] },
  },
  {
    name: 'obsidian_status',
    description:
      'Show the Obsidian mirror state: vault folder, tracked files, edits waiting for sync, Inbox files and conflicts.',
    input_schema: { type: 'object' as const, properties: {}, required: [] },
  },
]

function withVault(run: (vr: VaultRoot) => ToolResult): ToolResult {
  const vr = obsidianVault()
  if (vr) return run(vr)
  return fail(obsidianError() ?? 'Espelho do Obsidian desligado: defina SMOLERCLAW_OBSIDIAN_VAULT com o caminho do vault.')
}

const section = (label: string, items: readonly string[]): string[] =>
  items.length ? [`${label} (${items.length}):`, ...items.map((i) => `  - ${i}`)] : []

const HANDLERS: Record<string, ToolHandler> = {
  obsidian_sync: () => withVault((vr) => {
    const result = sync(vr)
    const { pull, push } = result
    const lines = [
      ...section('Notas atualizadas', pull.updated),
      ...section('Notas criadas pela Inbox', pull.created),
      ...section('Notas apagadas (deletar: true)', pull.deleted),
      ...section('Tarefas concluídas', pull.completed),
      ...section('Tarefas criadas', pull.tasksCreated),
      ...section('Conflitos (o banco venceu; sua versão ficou ao lado)', pull.conflicts),
      ...section('Arquivos escritos', push.written),
      ...section('Arquivos removidos', push.removed),
      ...section('Erros', [...pull.errors, ...push.errors]),
    ]
    const text = lines.length ? lines.join('\n') : 'Vault já sincronizado.'
    const errors = pull.errors.length + push.errors.length
    return errors ? fail(text) : ok(text, result)
  }),
  obsidian_status: () => withVault((vr) => {
    const s = status(vr)
    const text = [
      `Pasta: ${s.root}`,
      `Arquivos rastreados: ${s.tracked}`,
      ...section('Edições aguardando sync', s.pendingEdits),
      ...section('Inbox', s.inbox),
      ...section('Conflitos', s.conflicts),
      ...section('Erros', s.errors),
    ].join('\n')
    return ok(text, s)
  }),
}

export const OBSIDIAN_TOOLS = bindTools(SCHEMAS, HANDLERS, ['obsidian_status'])
