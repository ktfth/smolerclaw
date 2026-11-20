import type Anthropic from '@anthropic-ai/sdk'
import {
  obsidianError, obsidianPullMode, obsidianVault, parsePullMode, status, sync, writePullMode,
  PULL_MODES, type PullModeSetting, type VaultRoot,
} from '../../obsidian'
import { bindTools, ok, fail, type ToolHandler, type ToolResult } from '../../core/result'

const MODE_LABEL: Record<string, string> = {
  off: 'off — só com obsidian_sync',
  ask: 'ask — avisa a cada rodada e pergunta',
  auto: 'auto — sincroniza antes de cada tool de notas/tarefas',
}

function describeMode(setting: PullModeSetting): string {
  const source = setting.source === 'env' ? ' (fixado por SMOLERCLAW_OBSIDIAN_PULL)' : setting.source === 'default' ? ' (padrão)' : ''
  return `Retorno Obsidian → smolerclaw: ${MODE_LABEL[setting.mode]}${source}`
}

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
  {
    name: 'obsidian_mode',
    description:
      'Show or set how edits made in Obsidian come back. "off" (default): only obsidian_sync applies them. ' +
      '"ask": every note/task call reports unsynced edits so you can ask the user. "auto": they are pulled ' +
      'before every note/task call. Use when the user says "sincroniza sempre", "me pergunta antes", "desliga o retorno". ' +
      'Omit pull to just show the current mode.',
    input_schema: {
      type: 'object' as const,
      properties: { pull: { type: 'string', enum: [...PULL_MODES], description: 'New mode.' } },
      required: [],
    },
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
    const mode = obsidianPullMode(vr)
    const text = [
      `Pasta: ${s.root}`,
      describeMode(mode),
      `Arquivos rastreados: ${s.tracked}`,
      ...section('Edições aguardando sync', s.pendingEdits),
      ...section('Inbox', s.inbox),
      ...section('Conflitos', s.conflicts),
      ...section('Erros', s.errors),
    ].join('\n')
    return ok(text, { ...s, pullMode: mode })
  }),
  obsidian_mode: (input) => withVault((vr) => {
    const requested = parsePullMode(input.pull)
    if (input.pull !== undefined && !requested) return fail(`pull deve ser um de: ${PULL_MODES.join(', ')}`)
    if (requested) writePullMode(vr, requested)
    const mode = obsidianPullMode(vr)
    const overridden = requested && mode.source === 'env' && mode.mode !== requested
      ? `\nAtenção: gravado "${requested}" no vault, mas SMOLERCLAW_OBSIDIAN_PULL fixa "${mode.mode}" neste processo.`
      : ''
    return ok(`${describeMode(mode)}${overridden}`, mode)
  }),
}

export const OBSIDIAN_TOOLS = bindTools(SCHEMAS, HANDLERS, ['obsidian_status'])
