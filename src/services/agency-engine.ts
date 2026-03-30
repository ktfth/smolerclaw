/**
 * High Agency Engine — Draft-then-Commit Protocol
 *
 * Implements a structured planning system that requires explicit user
 * approval before executing operations that modify state, files, or
 * make architectural decisions.
 *
 * Core Principles:
 * 1. Impact Analysis: Evaluate dependencies and side effects silently
 * 2. Draft Proposal: Present technical, opinionated plans
 * 3. No Early Writes: Block modifications until user confirms
 * 4. Self-Correction: Stop and propose alternatives on obstacles
 */

import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { atomicWriteFile } from '../vault'
import { getEventBus } from '../core/event-bus'

// ─── Types ──────────────────────────────────────────────────

export type PlanStatus = 'draft' | 'pending_approval' | 'approved' | 'rejected' | 'executing' | 'completed' | 'blocked' | 'abandoned'

export type TaskComplexity = 'trivial' | 'simple' | 'moderate' | 'complex' | 'architectural'

export type RiskLevel = 'none' | 'low' | 'medium' | 'high' | 'critical'

export interface PlanStep {
  id: string
  order: number
  action: string
  target: string          // file, module, or system affected
  description: string
  estimatedImpact: RiskLevel
  dependencies: string[]  // IDs of steps that must complete first
  status: 'pending' | 'in_progress' | 'completed' | 'skipped' | 'blocked'
  result?: string
  blockedReason?: string
}

export interface ImpactAnalysis {
  complexity: TaskComplexity
  filesAffected: string[]
  modulesAffected: string[]
  risks: string[]
  assumptions: string[]
  requiresApproval: boolean
  reason: string
}

export interface Plan {
  id: string
  objective: string
  strategy: PlanStep[]
  assumptions: string[]
  risks: string[]
  status: PlanStatus
  complexity: TaskComplexity
  createdAt: string
  updatedAt: string
  approvedAt?: string
  completedAt?: string
  blockedAt?: string
  blockedReason?: string
  userFeedback?: string
}

export interface PlanHistoryEntry {
  planId: string
  objective: string
  status: PlanStatus
  complexity: TaskComplexity
  stepsCompleted: number
  totalSteps: number
  createdAt: string
  completedAt?: string
  learnings?: string[]
}

export interface AgencyConfig {
  requireApprovalFor: TaskComplexity[]
  autoApproveComplexity: TaskComplexity[]
  maxStepsWithoutCheckpoint: number
  enableSelfCorrection: boolean
}

// ─── Constants ──────────────────────────────────────────────

const DEFAULT_CONFIG: AgencyConfig = {
  requireApprovalFor: ['moderate', 'complex', 'architectural'],
  autoApproveComplexity: ['trivial', 'simple'],
  maxStepsWithoutCheckpoint: 5,
  enableSelfCorrection: true,
}

// Keywords that indicate complex operations requiring planning
const COMPLEXITY_INDICATORS = {
  architectural: [
    'refactor', 'redesign', 'migrate', 'architecture', 'restructure',
    'microservice', 'monolith', 'database schema', 'api design',
  ],
  complex: [
    'implement feature', 'add functionality', 'integrate', 'authentication',
    'authorization', 'security', 'performance', 'optimize', 'cache',
  ],
  moderate: [
    'update', 'modify', 'change', 'fix bug', 'add endpoint', 'create component',
    'add validation', 'error handling',
  ],
  simple: [
    'rename', 'move', 'delete unused', 'add comment', 'format', 'lint',
  ],
  trivial: [
    'typo', 'spacing', 'import order', 'semicolon',
  ],
}

// File patterns that indicate high-risk modifications
const HIGH_RISK_PATTERNS = [
  /config\.(ts|js|json)$/,
  /package\.json$/,
  /\.env/,
  /migration/,
  /schema\.(ts|prisma|sql)$/,
  /auth/i,
  /security/i,
]

// ─── Singleton State ────────────────────────────────────────

let _dataDir = ''
let _currentPlan: Plan | null = null
let _planHistory: PlanHistoryEntry[] = []
let _config: AgencyConfig = { ...DEFAULT_CONFIG }
let _initialized = false
let _onPlanProposed: ((plan: Plan) => Promise<boolean>) | null = null

const HISTORY_FILE = () => join(_dataDir, 'plan-history.json')
const CONFIG_FILE = () => join(_dataDir, 'agency-config.json')

// ─── Initialization ─────────────────────────────────────────

export function initAgencyEngine(
  dataDir: string,
  onPlanProposed?: (plan: Plan) => Promise<boolean>,
): void {
  _dataDir = join(dataDir, 'agency-engine')
  _onPlanProposed = onPlanProposed || null

  if (!existsSync(_dataDir)) mkdirSync(_dataDir, { recursive: true })

  loadConfig()
  loadHistory()

  _currentPlan = null
  _initialized = true
}

export function isAgencyEngineInitialized(): boolean {
  return _initialized
}

export function getAgencyConfig(): AgencyConfig {
  return { ..._config }
}

export function updateAgencyConfig(updates: Partial<AgencyConfig>): void {
  _config = { ..._config, ...updates }
  saveConfig()
}

// ─── Impact Analysis ────────────────────────────────────────

/**
 * Analyze the potential impact of a task before planning.
 * This is the "silent evaluation" phase of the protocol.
 */
export function analyzeTaskImpact(
  taskDescription: string,
  context?: { files?: string[]; modules?: string[] },
): ImpactAnalysis {
  const lower = taskDescription.toLowerCase()
  const complexity = detectComplexity(lower)
  const filesAffected = context?.files || []
  const modulesAffected = context?.modules || []

  const risks: string[] = []
  const assumptions: string[] = []

  // Check for high-risk file patterns
  for (const file of filesAffected) {
    for (const pattern of HIGH_RISK_PATTERNS) {
      if (pattern.test(file)) {
        risks.push(`Modifying sensitive file: ${file}`)
      }
    }
  }

  // Detect multi-file changes
  if (filesAffected.length > 3) {
    risks.push(`Affects ${filesAffected.length} files — higher coordination risk`)
  }

  // Detect cross-module changes
  if (modulesAffected.length > 1) {
    risks.push(`Spans ${modulesAffected.length} modules — may have cascading effects`)
  }

  // Add assumptions based on keywords
  if (lower.includes('api')) {
    assumptions.push('API contract may need versioning consideration')
  }
  if (lower.includes('database') || lower.includes('schema')) {
    assumptions.push('Database changes may require migration')
  }
  if (lower.includes('auth') || lower.includes('security')) {
    assumptions.push('Security changes require thorough review')
  }

  const requiresApproval = _config.requireApprovalFor.includes(complexity)
  const reason = requiresApproval
    ? `Task classified as "${complexity}" — requires explicit approval`
    : `Task classified as "${complexity}" — can proceed with auto-approval`

  return {
    complexity,
    filesAffected,
    modulesAffected,
    risks,
    assumptions,
    requiresApproval,
    reason,
  }
}

/**
 * Detect task complexity based on keywords and patterns.
 */
function detectComplexity(taskDescription: string): TaskComplexity {
  // Check from most complex to least
  for (const keyword of COMPLEXITY_INDICATORS.architectural) {
    if (taskDescription.includes(keyword)) return 'architectural'
  }
  for (const keyword of COMPLEXITY_INDICATORS.complex) {
    if (taskDescription.includes(keyword)) return 'complex'
  }
  for (const keyword of COMPLEXITY_INDICATORS.moderate) {
    if (taskDescription.includes(keyword)) return 'moderate'
  }
  for (const keyword of COMPLEXITY_INDICATORS.simple) {
    if (taskDescription.includes(keyword)) return 'simple'
  }
  for (const keyword of COMPLEXITY_INDICATORS.trivial) {
    if (taskDescription.includes(keyword)) return 'trivial'
  }

  // Default to moderate if unclear
  return 'moderate'
}

// ─── Plan Creation ──────────────────────────────────────────

/**
 * Create a new plan for a task.
 * Returns the plan in 'draft' status.
 */
export function createPlan(
  objective: string,
  steps: Omit<PlanStep, 'id' | 'status'>[],
  options?: { assumptions?: string[]; risks?: string[] },
): Plan {
  const impact = analyzeTaskImpact(objective)

  const plan: Plan = {
    id: genId(),
    objective,
    strategy: steps.map((step, index) => ({
      ...step,
      id: genId(),
      order: index + 1,
      status: 'pending' as const,
    })),
    assumptions: [...(options?.assumptions || []), ...impact.assumptions],
    risks: [...(options?.risks || []), ...impact.risks],
    status: 'draft',
    complexity: impact.complexity,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }

  _currentPlan = plan
  getEventBus().emit('planning:started', { planId: plan.id, objective })

  return plan
}

/**
 * Add a step to the current plan.
 */
export function addPlanStep(
  step: Omit<PlanStep, 'id' | 'status' | 'order'>,
): PlanStep | null {
  if (!_currentPlan || _currentPlan.status !== 'draft') {
    return null
  }

  const newStep: PlanStep = {
    ...step,
    id: genId(),
    order: _currentPlan.strategy.length + 1,
    status: 'pending',
  }

  _currentPlan = {
    ..._currentPlan,
    strategy: [..._currentPlan.strategy, newStep],
    updatedAt: new Date().toISOString(),
  }

  getEventBus().emit('planning:step_added', {
    planId: _currentPlan.id,
    stepId: newStep.id,
    action: newStep.action,
  })

  return newStep
}

// ─── Plan Approval ──────────────────────────────────────────

/**
 * Submit plan for user approval.
 * Changes status from 'draft' to 'pending_approval'.
 */
export async function submitPlanForApproval(): Promise<{
  success: boolean
  plan: Plan | null
  message: string
}> {
  if (!_currentPlan) {
    return { success: false, plan: null, message: 'No active plan to submit' }
  }

  if (_currentPlan.status !== 'draft') {
    return { success: false, plan: _currentPlan, message: `Plan already in status: ${_currentPlan.status}` }
  }

  _currentPlan = {
    ..._currentPlan,
    status: 'pending_approval',
    updatedAt: new Date().toISOString(),
  }

  // Check if auto-approval applies
  if (_config.autoApproveComplexity.includes(_currentPlan.complexity)) {
    return approvePlan('Auto-approved based on complexity classification')
  }

  // Request user approval via callback
  if (_onPlanProposed) {
    const approved = await _onPlanProposed(_currentPlan)
    if (approved) {
      return approvePlan('Approved by user')
    } else {
      return rejectPlan('Rejected by user')
    }
  }

  return {
    success: true,
    plan: _currentPlan,
    message: 'Plan submitted for approval — awaiting user confirmation',
  }
}

/**
 * Approve the current plan.
 */
export function approvePlan(feedback?: string): {
  success: boolean
  plan: Plan | null
  message: string
} {
  if (!_currentPlan) {
    return { success: false, plan: null, message: 'No active plan to approve' }
  }

  if (_currentPlan.status !== 'pending_approval' && _currentPlan.status !== 'draft') {
    return { success: false, plan: _currentPlan, message: `Cannot approve plan in status: ${_currentPlan.status}` }
  }

  _currentPlan = {
    ..._currentPlan,
    status: 'approved',
    approvedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    userFeedback: feedback,
  }

  getEventBus().emit('planning:approved', {
    planId: _currentPlan.id,
    feedback,
  })

  return {
    success: true,
    plan: _currentPlan,
    message: 'Plan approved — execution may proceed',
  }
}

/**
 * Reject the current plan.
 */
export function rejectPlan(feedback?: string): {
  success: boolean
  plan: Plan | null
  message: string
} {
  if (!_currentPlan) {
    return { success: false, plan: null, message: 'No active plan to reject' }
  }

  _currentPlan = {
    ..._currentPlan,
    status: 'rejected',
    updatedAt: new Date().toISOString(),
    userFeedback: feedback,
  }

  getEventBus().emit('planning:rejected', {
    planId: _currentPlan.id,
    feedback,
  })

  // Archive rejected plan
  archivePlan(_currentPlan)
  _currentPlan = null

  return {
    success: true,
    plan: null,
    message: 'Plan rejected — create a new plan with adjustments',
  }
}

// ─── Plan Execution ─────────────────────────────────────────

/**
 * Check if execution is allowed (plan approved).
 */
export function canExecute(): { allowed: boolean; reason: string } {
  if (!_currentPlan) {
    return { allowed: true, reason: 'No plan required — trivial operation' }
  }

  if (_currentPlan.status === 'approved' || _currentPlan.status === 'executing') {
    return { allowed: true, reason: 'Plan approved — execution permitted' }
  }

  if (_currentPlan.status === 'draft' || _currentPlan.status === 'pending_approval') {
    return {
      allowed: false,
      reason: `Execution blocked — plan awaiting approval (status: ${_currentPlan.status})`,
    }
  }

  return {
    allowed: false,
    reason: `Execution blocked — plan status: ${_currentPlan.status}`,
  }
}

/**
 * Start executing the current plan.
 */
export function startExecution(): { success: boolean; message: string } {
  const check = canExecute()
  if (!check.allowed) {
    return { success: false, message: check.reason }
  }

  if (_currentPlan && _currentPlan.status === 'approved') {
    _currentPlan = {
      ..._currentPlan,
      status: 'executing',
      updatedAt: new Date().toISOString(),
    }
  }

  return { success: true, message: 'Execution started' }
}

/**
 * Mark a step as completed.
 */
export function completeStep(stepId: string, result?: string): {
  success: boolean
  message: string
  nextStep?: PlanStep
} {
  if (!_currentPlan) {
    return { success: false, message: 'No active plan' }
  }

  const stepIndex = _currentPlan.strategy.findIndex(s => s.id === stepId)
  if (stepIndex === -1) {
    return { success: false, message: `Step not found: ${stepId}` }
  }

  const updatedStrategy = _currentPlan.strategy.map((step, i) =>
    i === stepIndex
      ? { ...step, status: 'completed' as const, result }
      : step
  )

  _currentPlan = {
    ..._currentPlan,
    strategy: updatedStrategy,
    updatedAt: new Date().toISOString(),
  }

  getEventBus().emit('planning:step_completed', {
    planId: _currentPlan.id,
    stepId,
    result,
  })

  // Find next pending step
  const nextStep = _currentPlan.strategy.find(s => s.status === 'pending')

  // Save step action before potential plan completion (which clears _currentPlan)
  const completedStepAction = _currentPlan.strategy[stepIndex].action

  // Check if all steps completed
  const allCompleted = _currentPlan.strategy.every(s =>
    s.status === 'completed' || s.status === 'skipped'
  )

  if (allCompleted) {
    completePlan()
  }

  return {
    success: true,
    message: `Step completed: ${completedStepAction}`,
    nextStep,
  }
}

/**
 * Report a blocked step (self-correction trigger).
 */
export function reportBlockedStep(
  stepId: string,
  reason: string,
  proposedAlternative?: string,
): { success: boolean; message: string } {
  if (!_currentPlan) {
    return { success: false, message: 'No active plan' }
  }

  const stepIndex = _currentPlan.strategy.findIndex(s => s.id === stepId)
  if (stepIndex === -1) {
    return { success: false, message: `Step not found: ${stepId}` }
  }

  const updatedStrategy = _currentPlan.strategy.map((step, i) =>
    i === stepIndex
      ? { ...step, status: 'blocked' as const, blockedReason: reason }
      : step
  )

  _currentPlan = {
    ..._currentPlan,
    strategy: updatedStrategy,
    status: 'blocked',
    blockedAt: new Date().toISOString(),
    blockedReason: reason,
    updatedAt: new Date().toISOString(),
  }

  getEventBus().emit('planning:blocked', {
    planId: _currentPlan.id,
    stepId,
    reason,
    proposedAlternative,
  })

  return {
    success: true,
    message: proposedAlternative
      ? `Step blocked: ${reason}. Proposed alternative: ${proposedAlternative}`
      : `Step blocked: ${reason}. Awaiting user guidance.`,
  }
}

/**
 * Mark plan as completed.
 */
function completePlan(): void {
  if (!_currentPlan) return

  _currentPlan = {
    ..._currentPlan,
    status: 'completed',
    completedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }

  getEventBus().emit('planning:completed', {
    planId: _currentPlan.id,
    stepsCompleted: _currentPlan.strategy.filter(s => s.status === 'completed').length,
  })

  archivePlan(_currentPlan)
  _currentPlan = null
}

/**
 * Abandon the current plan.
 */
export function abandonPlan(reason: string): { success: boolean; message: string } {
  if (!_currentPlan) {
    return { success: false, message: 'No active plan to abandon' }
  }

  _currentPlan = {
    ..._currentPlan,
    status: 'abandoned',
    blockedReason: reason,
    updatedAt: new Date().toISOString(),
  }

  archivePlan(_currentPlan)
  _currentPlan = null

  return { success: true, message: `Plan abandoned: ${reason}` }
}

// ─── Plan Queries ───────────────────────────────────────────

export function getCurrentPlan(): Plan | null {
  return _currentPlan ? { ..._currentPlan } : null
}

export function getPlanHistory(limit: number = 10): PlanHistoryEntry[] {
  return _planHistory.slice(-limit)
}

export function getPlanById(planId: string): PlanHistoryEntry | undefined {
  return _planHistory.find(p => p.planId === planId)
}

// ─── Formatting ─────────────────────────────────────────────

/**
 * Format a plan as the Draft-then-Commit protocol output.
 */
export function formatPlanAsDraft(plan: Plan): string {
  const stepLines = plan.strategy.map(step => {
    const statusIcon = step.status === 'completed' ? '✓'
      : step.status === 'in_progress' ? '→'
      : step.status === 'blocked' ? '✗'
      : '○'
    return `${statusIcon} Passo ${step.order}: ${step.action} → ${step.target}`
  })

  const assumptionLines = plan.assumptions.length > 0
    ? plan.assumptions.map(a => `  - ${a}`).join('\n')
    : '  (nenhuma)'

  const riskLines = plan.risks.length > 0
    ? plan.risks.map(r => `  - ${r}`).join('\n')
    : '  (nenhum identificado)'

  return [
    `**Objetivo:** ${plan.objective}`,
    '',
    `**Complexidade:** ${plan.complexity}`,
    '',
    '**Estratégia Técnica:**',
    ...stepLines,
    '',
    '**Premissas/Riscos:**',
    assumptionLines,
    riskLines,
    '',
    '**Bloqueio:** Posso prosseguir com este plano ou deseja ajustar algum detalhe?',
  ].join('\n')
}

/**
 * Format plan status for display.
 */
export function formatPlanStatus(plan: Plan): string {
  const completed = plan.strategy.filter(s => s.status === 'completed').length
  const total = plan.strategy.length
  const currentStep = plan.strategy.find(s => s.status === 'in_progress' || s.status === 'pending')

  return [
    `Plano: ${plan.objective}`,
    `Status: ${plan.status}`,
    `Progresso: ${completed}/${total} passos`,
    currentStep ? `Próximo: ${currentStep.action}` : '',
  ].filter(Boolean).join('\n')
}

// ─── Persistence ────────────────────────────────────────────

function archivePlan(plan: Plan): void {
  const entry: PlanHistoryEntry = {
    planId: plan.id,
    objective: plan.objective,
    status: plan.status,
    complexity: plan.complexity,
    stepsCompleted: plan.strategy.filter(s => s.status === 'completed').length,
    totalSteps: plan.strategy.length,
    createdAt: plan.createdAt,
    completedAt: plan.completedAt,
  }

  _planHistory = [..._planHistory, entry]
  saveHistory()
}

function saveHistory(): void {
  if (!_initialized) return
  atomicWriteFile(HISTORY_FILE(), JSON.stringify(_planHistory, null, 2))
}

function loadHistory(): void {
  const file = HISTORY_FILE()
  if (!existsSync(file)) {
    _planHistory = []
    return
  }

  try {
    const data = JSON.parse(readFileSync(file, 'utf-8'))
    _planHistory = Array.isArray(data) ? data : []
  } catch {
    _planHistory = []
  }
}

function saveConfig(): void {
  if (!_initialized) return
  atomicWriteFile(CONFIG_FILE(), JSON.stringify(_config, null, 2))
}

function loadConfig(): void {
  const file = CONFIG_FILE()
  if (!existsSync(file)) {
    _config = { ...DEFAULT_CONFIG }
    return
  }

  try {
    const data = JSON.parse(readFileSync(file, 'utf-8'))
    _config = { ...DEFAULT_CONFIG, ...data }
  } catch {
    _config = { ...DEFAULT_CONFIG }
  }
}

// ─── Helpers ────────────────────────────────────────────────

function genId(): string {
  return createHash('sha256')
    .update(`${Date.now()}-${Math.random()}`)
    .digest('hex')
    .slice(0, 8)
}

// ─── System Prompt Injection ────────────────────────────────

/**
 * Generate the High Agency Protocol section for system prompt injection.
 */
export function getAgencySystemPromptSection(): string {
  return `
## Protocolo de Alta Agência

Você opera sob o protocolo "Draft-then-Commit" que requer planejamento explícito antes de execução.

### Regras Fundamentais

1. **Análise de Impacto Silenciosa**: Antes de responder, avalie internamente as dependências e efeitos colaterais.

2. **Proposta de Plano (The Draft)**: Para tarefas não-triviais, apresente sua intenção de forma técnica e opinativa:
   - Use a ferramenta \`propose_plan\` para estruturar o plano
   - Não pergunte o que fazer; diga o que você decidiu fazer e por quê
   - Aguarde confirmação antes de executar

3. **Proibição de Escrita Precoce**: É TERMINANTEMENTE PROIBIDO:
   - Modificar arquivos antes da aprovação do plano
   - Executar comandos destrutivos sem confirmação
   - Fazer chamadas de API de escrita sem autorização

4. **Alta Agência na Decisão**:
   - Se houver múltiplas formas de implementar, escolha a que segue Clean Code e performance
   - Justifique brevemente sua escolha na estratégia técnica
   - Seja opinativo mas fundamentado

5. **Auto-Correção**: Se encontrar um obstáculo que invalide o plano:
   - PARE imediatamente a execução
   - Use \`report_plan_deviation\` para explicar o desvio
   - Proponha uma alternativa antes de continuar

### Classificação de Complexidade

- **trivial/simple**: Pode executar diretamente (typos, formatting, renames)
- **moderate**: Requer plano breve, pode auto-aprovar se baixo risco
- **complex/architectural**: OBRIGATÓRIO apresentar plano e aguardar aprovação

### Formato do Plano

Ao usar \`propose_plan\`, estruture assim:
- **Objetivo**: Descrição concisa do resultado final
- **Estratégia Técnica**: Lista ordenada de passos com arquivos-alvo
- **Premissas/Riscos**: Dependências assumidas e potenciais quebras
- **Bloqueio**: Sempre termine com "Posso prosseguir com este plano?"
`.trim()
}
