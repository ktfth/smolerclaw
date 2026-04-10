/**
 * MITRE ATT&CK and MITRE ATLAS TTP mapping.
 *
 * Maps internal vulnerability classes and probe outcomes to well-known
 * technique IDs so every finding a smolerclaw operation surfaces can be
 * cross-referenced against the standard threat frameworks. Descriptions
 * are intentionally terse — they are labels, not documentation.
 */

import type { VulnClass } from './state'

export interface TTP {
  id: string
  name: string
  framework: 'ATT&CK' | 'ATLAS'
}

/** Classic ATT&CK techniques relevant to web/API offensive ops. */
export const ATTACK: Record<string, TTP> = {
  T1595: { id: 'T1595', name: 'Active Scanning', framework: 'ATT&CK' },
  'T1595.002': { id: 'T1595.002', name: 'Vulnerability Scanning', framework: 'ATT&CK' },
  T1592: { id: 'T1592', name: 'Gather Victim Host Information', framework: 'ATT&CK' },
  T1589: { id: 'T1589', name: 'Gather Victim Identity Information', framework: 'ATT&CK' },
  T1596: { id: 'T1596', name: 'Search Open Technical Databases', framework: 'ATT&CK' },
  'T1596.003': { id: 'T1596.003', name: 'Digital Certificates', framework: 'ATT&CK' },
  T1190: { id: 'T1190', name: 'Exploit Public-Facing Application', framework: 'ATT&CK' },
  T1133: { id: 'T1133', name: 'External Remote Services', framework: 'ATT&CK' },
  T1059: { id: 'T1059', name: 'Command and Scripting Interpreter', framework: 'ATT&CK' },
  T1552: { id: 'T1552', name: 'Unsecured Credentials', framework: 'ATT&CK' },
  'T1552.001': { id: 'T1552.001', name: 'Credentials In Files', framework: 'ATT&CK' },
  T1213: { id: 'T1213', name: 'Data from Information Repositories', framework: 'ATT&CK' },
}

/** MITRE ATLAS techniques for adversarial ML / LLM systems. */
export const ATLAS: Record<string, TTP> = {
  'AML.T0051': { id: 'AML.T0051', name: 'LLM Prompt Injection', framework: 'ATLAS' },
  'AML.T0051.000': { id: 'AML.T0051.000', name: 'Direct Prompt Injection', framework: 'ATLAS' },
  'AML.T0051.001': { id: 'AML.T0051.001', name: 'Indirect Prompt Injection', framework: 'ATLAS' },
  'AML.T0054': { id: 'AML.T0054', name: 'LLM Jailbreak', framework: 'ATLAS' },
  'AML.T0057': { id: 'AML.T0057', name: 'LLM Data Leakage', framework: 'ATLAS' },
  'AML.T0053': { id: 'AML.T0053', name: 'LLM Plugin Compromise', framework: 'ATLAS' },
  'AML.T0049': { id: 'AML.T0049', name: 'Exploit Public-Facing Application (ML)', framework: 'ATLAS' },
  'AML.T0040': { id: 'AML.T0040', name: 'ML Model Inference API Access', framework: 'ATLAS' },
  'AML.T0048': { id: 'AML.T0048', name: 'External Harms', framework: 'ATLAS' },
}

/**
 * Map a vulnerability class to its canonical TTP IDs. Returns an array so
 * callers can merge with additional context-specific TTPs before storing.
 */
export function ttpsForClass(cls: VulnClass): string[] {
  switch (cls) {
    case 'sqli':
    case 'xss':
    case 'ssti':
    case 'ssrf':
    case 'rce':
    case 'xxe':
    case 'lfi':
    case 'idor':
    case 'authbypass':
    case 'open-redirect':
      return ['T1190']
    case 'prompt-injection':
      return ['AML.T0051', 'AML.T0051.000']
    case 'indirect-prompt-injection':
      return ['AML.T0051', 'AML.T0051.001']
    case 'tool-poisoning':
      return ['AML.T0053', 'AML.T0051.001']
    case 'info-disclosure':
      return ['T1213', 'AML.T0057']
    case 'leak':
      return ['T1552', 'T1552.001']
    case 'misconfig':
      return ['T1190', 'T1133']
    default:
      return []
  }
}

/** Describe a set of TTP IDs for reports. Unknown IDs are returned as-is. */
export function describeTTPs(ids: string[]): string[] {
  return ids.map((id) => {
    const t = ATTACK[id] ?? ATLAS[id]
    if (!t) return `${id} (unknown)`
    return `${t.id} — ${t.name} [${t.framework}]`
  })
}
