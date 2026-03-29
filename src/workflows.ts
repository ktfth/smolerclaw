/**
 * Workflow automation — flexible named sequences of actions.
 *
 * Supports: open apps, open URLs, run commands, wait, notify (toast),
 * conditional steps (if_app_running), variables, and error handling.
 *
 * Security: run_command uses windows-executor with mandatory flags.
 * open_url validates HTTP(S) scheme. All step timeouts use Promise.race.
 *
 * REFACTORED: All PowerShell execution now goes through windows-executor.ts
 */

import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { atomicWriteFile } from './vault'
import { openApp, openUrl, getKnownApps } from './windows'
import { IS_WINDOWS } from './platform'
import {
  executePowerShell,
  showToast,
  isProcessRunning,
  psSingleQuoteEscape,
} from './utils/windows-executor'

// ─── Types ──────────────────────────────────────────────────

export type StepAction =
  | 'open_app'
  | 'open_url'
  | 'run_command'
  | 'wait'
  | 'notify'
  | 'if_app_running'
  | 'log'

export interface WorkflowStep {
  action: StepAction
  target: string              // app name, URL, command, seconds, message, or app to check
  on_error?: 'stop' | 'skip' | 'continue'  // default: 'continue'
  condition_steps?: WorkflowStep[]          // steps to run if condition is true (for if_app_running)
  label?: string              // optional human-readable label
}

export interface Workflow {
  id: string
  name: string
  description: string
  steps: WorkflowStep[]
  tags: string[]
  enabled: boolean
  createdAt: string
  updatedAt: string
}

export interface WorkflowRunResult {
  workflow: string
  success: boolean
  stepsRun: number
  stepsSkipped: number
  stepsFailed: number
  log: string[]
  duration: number
}

// ─── Storage ────────────────────────────────────────────────

let _dataDir = ''
let _workflows: Workflow[] = []

const DATA_FILE = () => join(_dataDir, 'workflows.json')

function save(): void {
  atomicWriteFile(DATA_FILE(), JSON.stringify(_workflows, null, 2))
}

function load(): void {
  const file = DATA_FILE()
  if (!existsSync(file)) {
    _workflows = seedDefaults()
    save()
    return
  }
  try {
    const data = JSON.parse(readFileSync(file, 'utf-8'))
    if (!Array.isArray(data)) {
      _workflows = seedDefaults()
      save()
      return
    }
    // Migrate old format (no id) to new format
    _workflows = data.map((w: Record<string, unknown>) => ({
      id: (w.id as string) || genId(),
      name: (w.name as string) || 'unnamed',
      description: (w.description as string) || '',
      steps: Array.isArray(w.steps) ? w.steps : [],
      tags: Array.isArray(w.tags) ? w.tags : [],
      enabled: w.enabled !== false,
      createdAt: (w.createdAt as string) || new Date().toISOString(),
      updatedAt: (w.updatedAt as string) || new Date().toISOString(),
    }))
  } catch {
    _workflows = seedDefaults()
    save()
  }
}

function seedDefaults(): Workflow[] {
  const now = new Date().toISOString()
  return [
    {
      id: genId(),
      name: 'iniciar-dia',
      description: 'Abrir apps de trabalho: terminal e ferramentas',
      steps: [
        { action: 'notify', target: 'Iniciando ambiente de trabalho...' },
        { action: 'open_app', target: 'terminal', label: 'Terminal' },
        { action: 'wait', target: '2' },
        { action: 'open_app', target: 'vscode', label: 'VS Code', on_error: 'skip' },
        { action: 'notify', target: 'Ambiente pronto!' },
      ],
      tags: ['trabalho', 'diario'],
      enabled: true,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: genId(),
      name: 'dev',
      description: 'Ambiente de desenvolvimento: VSCode + Terminal',
      steps: [
        { action: 'open_app', target: 'vscode', label: 'VS Code' },
        { action: 'wait', target: '1' },
        { action: 'open_app', target: 'terminal', label: 'Terminal' },
      ],
      tags: ['dev'],
      enabled: true,
      createdAt: now,
      updatedAt: now,
    },
  ]
}

// ─── Init ───────────────────────────────────────────────────

export function initWorkflows(dataDir: string): void {
  _dataDir = dataDir
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true })
  load()
}

// ─── CRUD ───────────────────────────────────────────────────

export function getWorkflow(nameOrId: string): Workflow | null {
  const lower = nameOrId.toLowerCase().trim()
  return (
    _workflows.find((w) => w.id === nameOrId) ||
    _workflows.find((w) => w.name.toLowerCase() === lower) ||
    _workflows.find((w) => w.name.toLowerCase().includes(lower)) ||
    null
  )
}

export function listWorkflows(tag?: string): Workflow[] {
  let result = [..._workflows]
  if (tag) {
    const lower = tag.toLowerCase()
    result = result.filter((w) => w.tags.some((t) => t.toLowerCase() === lower))
  }
  return result
}

export function createWorkflow(
  name: string,
  description: string,
  steps: WorkflowStep[],
  tags: string[] = [],
): Workflow {
  const now = new Date().toISOString()
  // Remove existing with same name
  _workflows = _workflows.filter((w) => w.name.toLowerCase() !== name.toLowerCase().trim())
  const workflow: Workflow = {
    id: genId(),
    name: name.toLowerCase().trim(),
    description: description.trim(),
    steps,
    tags: tags.map((t) => t.toLowerCase().trim()).filter(Boolean),
    enabled: true,
    createdAt: now,
    updatedAt: now,
  }
  _workflows = [..._workflows, workflow]
  save()
  return workflow
}

export function updateWorkflow(
  nameOrId: string,
  updates: Partial<Pick<Workflow, 'description' | 'steps' | 'tags' | 'enabled'>>,
): Workflow | null {
  const found = getWorkflow(nameOrId)
  if (!found) return null

  _workflows = _workflows.map((w) =>
    w.id === found.id
      ? { ...w, ...updates, updatedAt: new Date().toISOString() }
      : w,
  )
  save()
  return _workflows.find((w) => w.id === found.id) || null
}

export function deleteWorkflow(nameOrId: string): boolean {
  const found = getWorkflow(nameOrId)
  if (!found) return false
  _workflows = _workflows.filter((w) => w.id !== found.id)
  save()
  return true
}

export function duplicateWorkflow(nameOrId: string, newName: string): Workflow | null {
  const source = getWorkflow(nameOrId)
  if (!source) return null
  return createWorkflow(
    newName,
    source.description,
    JSON.parse(JSON.stringify(source.steps)),
    [...source.tags],
  )
}

export function addStepToWorkflow(
  nameOrId: string,
  step: WorkflowStep,
  position?: number,
): Workflow | null {
  const found = getWorkflow(nameOrId)
  if (!found) return null

  const newSteps = [...found.steps]
  if (position !== undefined && position >= 0 && position <= newSteps.length) {
    newSteps.splice(position, 0, step)
  } else {
    newSteps.push(step)
  }
  return updateWorkflow(found.id, { steps: newSteps })
}

export function removeStepFromWorkflow(
  nameOrId: string,
  stepIndex: number,
): Workflow | null {
  const found = getWorkflow(nameOrId)
  if (!found || stepIndex < 0 || stepIndex >= found.steps.length) return null

  const newSteps = [...found.steps.slice(0, stepIndex), ...found.steps.slice(stepIndex + 1)]
  return updateWorkflow(found.id, { steps: newSteps })
}

// ─── Execution ──────────────────────────────────────────────

/**
 * Execute a workflow step by step.
 * Returns structured result with log and stats.
 */
export async function runWorkflow(
  nameOrId: string,
  onStep?: (msg: string) => void,
): Promise<string> {
  const workflow = getWorkflow(nameOrId)
  if (!workflow) {
    const available = _workflows.map((w) => w.name).join(', ')
    return `Workflow nao encontrado: "${nameOrId}". Disponiveis: ${available}`
  }

  if (!workflow.enabled) {
    return `Workflow "${workflow.name}" esta desativado.`
  }

  const result = await executeSteps(workflow.name, workflow.steps, onStep)
  return formatRunResult(result)
}

async function executeSteps(
  workflowName: string,
  steps: WorkflowStep[],
  onStep?: (msg: string) => void,
): Promise<WorkflowRunResult> {
  const start = performance.now()
  const log: string[] = [`Executando workflow: "${workflowName}"`]
  let stepsRun = 0
  let stepsSkipped = 0
  let stepsFailed = 0
  let success = true

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]
    const label = step.label || `${step.action}:${step.target}`
    const prefix = `[${i + 1}/${steps.length}]`
    const onError = step.on_error || 'continue'

    onStep?.(`${prefix} ${label}...`)

    try {
      const stepResult = await executeStep(step, onStep)
      log.push(`  ${prefix} ${stepResult}`)
      stepsRun++
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err)
      stepsFailed++

      switch (onError) {
        case 'stop':
          log.push(`  ${prefix} ERRO (parando): ${errMsg}`)
          success = false
          return { workflow: workflowName, success, stepsRun, stepsSkipped, stepsFailed, log, duration: Math.round(performance.now() - start) }
        case 'skip':
          log.push(`  ${prefix} ERRO (pulado): ${errMsg}`)
          stepsSkipped++
          break
        case 'continue':
        default:
          log.push(`  ${prefix} ERRO (continuando): ${errMsg}`)
          break
      }
    }
  }

  return {
    workflow: workflowName,
    success,
    stepsRun,
    stepsSkipped,
    stepsFailed,
    log,
    duration: Math.round(performance.now() - start),
  }
}

async function executeStep(
  step: WorkflowStep,
  onStep?: (msg: string) => void,
): Promise<string> {
  switch (step.action) {
    case 'open_app': {
      if (!IS_WINDOWS) return `skip: ${step.target} (not Windows)`
      const result = await openApp(step.target)
      return result
    }

    case 'open_url': {
      if (!IS_WINDOWS) return `skip: ${step.target} (not Windows)`
      const url = step.target.trim()
      if (!url.startsWith('http://') && !url.startsWith('https://')) {
        throw new Error(`URL invalida (deve comecar com http/https): ${url}`)
      }
      const result = await openUrl(url)
      return result
    }

    case 'run_command': {
      if (!IS_WINDOWS) return `skip: command (not Windows)`
      const cmd = step.target
      if (!cmd.trim()) throw new Error('Comando vazio')

      const result = await executePowerShell(cmd, { timeout: 30_000 })

      if (result.timedOut) {
        throw new Error('Command timeout (30s)')
      }
      if (result.exitCode !== 0 && result.stderr.trim()) {
        throw new Error(`exit ${result.exitCode}: ${result.stderr.trim().slice(0, 200)}`)
      }

      const output = result.stdout.trim().slice(0, 200)
      return `Command: ${cmd.slice(0, 60)}${output ? ' -> ' + output : ''}`
    }

    case 'wait': {
      const secs = Math.max(0, Math.min(parseInt(step.target) || 1, 60))
      await new Promise((r) => setTimeout(r, secs * 1000))
      return `Wait: ${secs}s`
    }

    case 'notify': {
      if (IS_WINDOWS) {
        try {
          // Use toast notification for non-blocking notify
          showToast('smolerclaw', step.target, { timeout: 10_000 }).catch(() => {})
        } catch { /* best effort */ }
      }
      return `Notify: ${step.target}`
    }

    case 'if_app_running': {
      if (!IS_WINDOWS) return `skip: condition (not Windows)`
      const appName = step.target.toLowerCase()

      const running = await isProcessRunning(appName, { timeout: 5_000 })

      if (running && step.condition_steps && step.condition_steps.length > 0) {
        const subResult = await executeSteps(`${step.target}-conditional`, step.condition_steps, onStep)
        return `Condition: ${appName} running=true, ran ${subResult.stepsRun} sub-steps`
      }
      return `Condition: ${appName} running=${running}${!running ? ' (skipped sub-steps)' : ''}`
    }

    case 'log': {
      return `Log: ${step.target}`
    }

    default:
      throw new Error(`Acao desconhecida: ${(step as WorkflowStep).action}`)
  }
}

// ─── Formatting ─────────────────────────────────────────────

export function formatWorkflowList(workflows?: Workflow[]): string {
  const list = workflows || _workflows
  if (list.length === 0) return 'Nenhum workflow configurado.'

  const lines = list.map((w) => {
    const status = w.enabled ? '' : ' [DESATIVADO]'
    const tags = w.tags.length > 0 ? ` [${w.tags.join(', ')}]` : ''
    const stepsDesc = w.steps.map((s) => {
      const label = s.label || s.target
      return s.action === 'wait' ? `${s.target}s` : label
    }).join(' -> ')
    return `  ${w.name}${status}${tags} — ${w.description}\n${' '.repeat(4)}${stepsDesc}  {${w.id}}`
  })

  return `Workflows (${list.length}):\n${lines.join('\n\n')}`
}

export function formatWorkflowDetail(workflow: Workflow): string {
  const status = workflow.enabled ? 'ativo' : 'desativado'
  const tags = workflow.tags.length > 0 ? `Tags: ${workflow.tags.map((t) => `#${t}`).join(' ')}` : ''
  const lines: string[] = [
    `--- Workflow {${workflow.id}} ---`,
    `Nome: ${workflow.name}`,
    `Descricao: ${workflow.description}`,
    `Status: ${status}`,
  ]
  if (tags) lines.push(tags)
  lines.push(`Criado: ${new Date(workflow.createdAt).toLocaleDateString('pt-BR')}`)
  lines.push('')
  lines.push('Steps:')
  workflow.steps.forEach((s, i) => {
    const label = s.label ? ` (${s.label})` : ''
    const onErr = s.on_error && s.on_error !== 'continue' ? ` [on_error: ${s.on_error}]` : ''
    lines.push(`  ${i + 1}. ${s.action}: ${s.target}${label}${onErr}`)
    if (s.action === 'if_app_running' && s.condition_steps) {
      for (const sub of s.condition_steps) {
        lines.push(`     ↳ ${sub.action}: ${sub.target}`)
      }
    }
  })
  return lines.join('\n')
}

function formatRunResult(result: WorkflowRunResult): string {
  const lines = [...result.log]
  lines.push('')
  lines.push(`Concluido em ${result.duration}ms — ${result.stepsRun} executados, ${result.stepsSkipped} pulados, ${result.stepsFailed} falhas`)
  return lines.join('\n')
}

// ─── Helpers ────────────────────────────────────────────────

function genId(): string {
  return randomUUID().slice(0, 8)
}
