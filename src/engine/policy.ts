import { assessToolRisk, type RiskLevel } from '../tool-safety'
import { SEND_TOOL_NAMES } from '../tools/read-only'
export { POLICY_ENV_KEYS, capturePolicyEnv } from './policy-env'

/**
 * Static execution policy. No callbacks, no prompts: the same tool call
 * under the same policy always gets the same decision.
 */
export interface EnginePolicy {
  /** Allow tools classified as `moderate` (writes, commands, sends). */
  allowModerate: boolean
  /** Tool names that are always denied, regardless of risk. */
  deny: readonly string[]
  /** When non-empty, only these tool names may run. */
  allow: readonly string[]
  /** Allow tools that deliver content to third parties immediately (send email). */
  allowSend: boolean
  /** Plugin tools exposed to the engine. Plugins run arbitrary commands: opt in by name. */
  plugins: readonly string[]
}

export interface PolicyDecision {
  allowed: boolean
  risk: RiskLevel
  reason: string
}

export const DEFAULT_POLICY: EnginePolicy = {
  allowModerate: true,
  deny: [],
  allow: [],
  allowSend: false,
  plugins: [],
}

/** Whether a tool is visible at all under the allow/deny lists. */
export function isListed(policy: EnginePolicy, name: string): boolean {
  if (policy.deny.includes(name)) return false
  return policy.allow.length === 0 || policy.allow.includes(name)
}

export function decide(
  policy: EnginePolicy,
  name: string,
  input: Record<string, unknown>,
): PolicyDecision {
  const risk = assessToolRisk(name, input)

  if (!isListed(policy, name)) {
    return { allowed: false, risk: risk.level, reason: `tool "${name}" is excluded by the allow/deny lists` }
  }
  if (risk.level === 'dangerous') {
    return { allowed: false, risk: risk.level, reason: risk.reason ?? 'dangerous operation' }
  }
  if (SEND_TOOL_NAMES.has(name) && !policy.allowSend) {
    return { allowed: false, risk: risk.level, reason: `sends to third parties: "${name}" requires SMOLERCLAW_ALLOW_SEND=1` }
  }
  if (risk.level === 'moderate' && !policy.allowModerate) {
    return { allowed: false, risk: risk.level, reason: `moderate operation blocked by policy: ${risk.reason ?? name}` }
  }
  return { allowed: true, risk: risk.level, reason: risk.reason ?? 'allowed' }
}

const READ_ONLY_WORKFLOW_ACTIONS: ReadonlySet<string> = new Set(['log', 'wait', 'if_app_running'])
const MODERATE_WORKFLOW_ACTIONS: ReadonlySet<string> = new Set(['open_app', 'open_url', 'notify'])

/**
 * Evaluate a single workflow step under the same static engine policy.
 * Unknown actions fail closed; `run_command` is always assessed for dangerous
 * patterns and denied in read-only mode or when `run_command` is excluded.
 */
export function decideWorkflowStep(
  policy: EnginePolicy,
  action: string,
  target: string,
): PolicyDecision {
  const stepTool = `workflow:${action}`

  if (policy.deny.includes(stepTool) || policy.deny.includes(action)) {
    return { allowed: false, risk: 'moderate', reason: `workflow step "${action}" is excluded by deny list` }
  }
  if (policy.allow.length > 0 && !policy.allow.includes(stepTool) && !policy.allow.includes(action)) {
    return { allowed: false, risk: 'moderate', reason: `workflow step "${action}" is excluded by allow list` }
  }

  if (READ_ONLY_WORKFLOW_ACTIONS.has(action)) {
    return { allowed: true, risk: 'safe', reason: 'allowed' }
  }

  if (action === 'run_command') {
    const risk = assessToolRisk('run_command', { command: target })
    if (risk.level === 'dangerous') {
      return { allowed: false, risk: 'dangerous', reason: risk.reason ?? 'dangerous command' }
    }
    if (!policy.allowModerate) {
      return { allowed: false, risk: 'moderate', reason: 'workflow run_command blocked by read-only policy' }
    }
    return { allowed: true, risk: 'moderate', reason: 'allowed' }
  }

  if (MODERATE_WORKFLOW_ACTIONS.has(action)) {
    if (!policy.allowModerate) {
      return { allowed: false, risk: 'moderate', reason: `workflow ${action} blocked by read-only policy` }
    }
    return { allowed: true, risk: 'moderate', reason: 'allowed' }
  }

  return { allowed: false, risk: 'dangerous', reason: `unknown workflow action: ${action}` }
}

/**
 * Build a policy from environment variables:
 * - SMOLERCLAW_READONLY=1      → deny moderate tools
 * - SMOLERCLAW_DENY=a,b        → deny list
 * - SMOLERCLAW_ALLOW=a,b       → allow list
 * - SMOLERCLAW_ALLOW_SEND=1    → allow sending email to third parties
 * - SMOLERCLAW_PLUGINS=a,b     → plugin tools exposed to the engine
 */
export function policyFromEnv(env: Record<string, string | undefined>): EnginePolicy {
  const list = (raw: string | undefined): string[] =>
    (raw ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  return {
    allowModerate: env.SMOLERCLAW_READONLY !== '1',
    deny: list(env.SMOLERCLAW_DENY),
    allow: list(env.SMOLERCLAW_ALLOW),
    allowSend: env.SMOLERCLAW_ALLOW_SEND === '1',
    plugins: list(env.SMOLERCLAW_PLUGINS),
  }
}
