import { assessToolRisk, type RiskLevel } from '../tool-safety'

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
  if (risk.level === 'moderate' && !policy.allowModerate) {
    return { allowed: false, risk: risk.level, reason: `moderate operation blocked by policy: ${risk.reason ?? name}` }
  }
  return { allowed: true, risk: risk.level, reason: risk.reason ?? 'allowed' }
}

/**
 * Build a policy from environment variables:
 * - SMOLERCLAW_READONLY=1      → deny moderate tools
 * - SMOLERCLAW_DENY=a,b        → deny list
 * - SMOLERCLAW_ALLOW=a,b       → allow list
 */
export function policyFromEnv(env: Record<string, string | undefined>): EnginePolicy {
  const list = (raw: string | undefined): string[] =>
    (raw ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  return {
    allowModerate: env.SMOLERCLAW_READONLY !== '1',
    deny: list(env.SMOLERCLAW_DENY),
    allow: list(env.SMOLERCLAW_ALLOW),
  }
}
