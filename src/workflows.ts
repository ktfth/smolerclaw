/**
 * Workflow automation — named sequences of Windows actions.
 * E.g. "iniciar-dia" opens Outlook + Teams + Excel.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { openApp, getKnownApps } from './windows'
import { IS_WINDOWS } from './platform'

// ─── Types ──────────────────────────────────────────────────

export interface WorkflowStep {
  action: 'open_app' | 'open_url' | 'run_command' | 'wait'
  target: string       // app name, URL, command, or seconds
}

export interface Workflow {
  name: string
  description: string
  steps: WorkflowStep[]
}

// ─── Storage ────────────────────────────────────────────────

let _dataDir = ''
let _workflows: Workflow[] = []

const DATA_FILE = () => join(_dataDir, 'workflows.json')

function save(): void {
  writeFileSync(DATA_FILE(), JSON.stringify(_workflows, null, 2))
}

function load(): void {
  const file = DATA_FILE()
  if (!existsSync(file)) {
    // Seed with default workflows
    _workflows = DEFAULT_WORKFLOWS
    save()
    return
  }
  try { _workflows = JSON.parse(readFileSync(file, 'utf-8')) }
  catch { _workflows = DEFAULT_WORKFLOWS; save() }
}

// ─── Defaults ───────────────────────────────────────────────

const DEFAULT_WORKFLOWS: Workflow[] = [
  {
    name: 'iniciar-dia',
    description: 'Abrir terminal e Postman',
    steps: [
      { action: 'open_app', target: 'terminal' },
      { action: 'wait', target: '2' },
      { action: 'open_app', target: 'postman' },
    ],
  },
  {
    name: 'dev',
    description: 'Abrir ambiente de desenvolvimento: VSCode e Terminal',
    steps: [
      { action: 'open_app', target: 'vscode' },
      { action: 'wait', target: '1' },
      { action: 'open_app', target: 'terminal' },
    ],
  },
]

// ─── Init ───────────────────────────────────────────────────

export function initWorkflows(dataDir: string): void {
  _dataDir = dataDir
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true })
  load()
}

// ─── Operations ─────────────────────────────────────────────

export function getWorkflow(name: string): Workflow | null {
  return _workflows.find((w) => w.name.toLowerCase() === name.toLowerCase()) || null
}

export function listWorkflows(): Workflow[] {
  return [..._workflows]
}

export function createWorkflow(name: string, description: string, steps: WorkflowStep[]): Workflow {
  // Remove existing with same name
  _workflows = _workflows.filter((w) => w.name.toLowerCase() !== name.toLowerCase())
  const workflow: Workflow = { name: name.toLowerCase(), description, steps }
  _workflows = [..._workflows, workflow]
  save()
  return workflow
}

export function deleteWorkflow(name: string): boolean {
  const before = _workflows.length
  _workflows = _workflows.filter((w) => w.name.toLowerCase() !== name.toLowerCase())
  if (_workflows.length === before) return false
  save()
  return true
}

/**
 * Execute a workflow step by step.
 * Returns a log of what was done.
 */
export async function runWorkflow(
  name: string,
  onStep?: (msg: string) => void,
): Promise<string> {
  const workflow = getWorkflow(name)
  if (!workflow) {
    const available = _workflows.map((w) => w.name).join(', ')
    return `Workflow nao encontrado: "${name}". Disponiveis: ${available}`
  }

  if (!IS_WINDOWS) {
    return 'Error: workflows are only available on Windows.'
  }

  const log: string[] = [`Executando workflow: "${workflow.name}" — ${workflow.description}`]

  for (let i = 0; i < workflow.steps.length; i++) {
    const step = workflow.steps[i]

    switch (step.action) {
      case 'open_app': {
        onStep?.(`[${i + 1}/${workflow.steps.length}] Abrindo ${step.target}...`)
        const result = await openApp(step.target)
        log.push(`  ${i + 1}. ${result}`)
        break
      }

      case 'open_url': {
        onStep?.(`[${i + 1}/${workflow.steps.length}] Abrindo ${step.target}...`)
        // Reuse openApp with 'edge' or just use Start-Process
        const proc = Bun.spawn(
          ['powershell', '-NoProfile', '-NonInteractive', '-Command', `Start-Process '${step.target}'`],
          { stdout: 'pipe', stderr: 'pipe' },
        )
        const timer = setTimeout(() => proc.kill(), 10_000)
        await Promise.all([
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
        ])
        await proc.exited
        clearTimeout(timer)
        log.push(`  ${i + 1}. Opened: ${step.target}`)
        break
      }

      case 'run_command': {
        onStep?.(`[${i + 1}/${workflow.steps.length}] Executando: ${step.target}...`)
        const proc = Bun.spawn(
          ['powershell', '-NoProfile', '-NonInteractive', '-Command', step.target],
          { stdout: 'pipe', stderr: 'pipe' },
        )
        const timer = setTimeout(() => proc.kill(), 30_000)
        const [stdout] = await Promise.all([
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
        ])
        await proc.exited
        clearTimeout(timer)
        const preview = stdout.trim().slice(0, 100)
        log.push(`  ${i + 1}. Command: ${step.target}${preview ? ' -> ' + preview : ''}`)
        break
      }

      case 'wait': {
        const secs = parseInt(step.target) || 1
        onStep?.(`[${i + 1}/${workflow.steps.length}] Aguardando ${secs}s...`)
        await new Promise((r) => setTimeout(r, secs * 1000))
        log.push(`  ${i + 1}. Wait: ${secs}s`)
        break
      }
    }
  }

  log.push(`\nWorkflow "${workflow.name}" concluido.`)
  return log.join('\n')
}

// ─── Formatting ─────────────────────────────────────────────

export function formatWorkflowList(): string {
  if (_workflows.length === 0) return 'Nenhum workflow configurado.'

  const lines = _workflows.map((w) => {
    const steps = w.steps.map((s) => `${s.action}:${s.target}`).join(' -> ')
    return `  ${w.name.padEnd(15)} ${w.description}\n${' '.repeat(17)}${steps}`
  })

  return `Workflows (${_workflows.length}):\n${lines.join('\n\n')}`
}
