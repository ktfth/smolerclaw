/**
 * Environment variables that shape the engine policy. A leaf module (no
 * imports) so the scheduler can pin them without pulling in the catalog.
 */
export const POLICY_ENV_KEYS = [
  'SMOLERCLAW_READONLY',
  'SMOLERCLAW_ALLOW',
  'SMOLERCLAW_DENY',
  'SMOLERCLAW_ALLOW_SEND',
  'SMOLERCLAW_PLUGINS',
] as const

/** The policy-relevant subset of an environment, for pinning into scheduled runs. */
export function capturePolicyEnv(env: Record<string, string | undefined>): Record<string, string> {
  const captured: Record<string, string> = {}
  for (const key of POLICY_ENV_KEYS) {
    const value = env[key]
    if (value) captured[key] = value
  }
  return captured
}
