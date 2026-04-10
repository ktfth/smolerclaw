/**
 * Offensive Operations — tool schemas + dispatcher.
 *
 * Exposes the Recon, Payload Mutation and Prompt Injection agents as
 * Claude tools so the model can drive an authorized red-team engagement
 * from the TUI. Each call goes through the shared operation state in
 * `services/offensive` and is scope-gated.
 */

import type Anthropic from '@anthropic-ai/sdk'
import {
  authorizeOperation,
  buildReport,
  createOperation,
  getCurrentOperation,
  isOffensiveOpsInitialized,
  listOperations,
  loadOperation,
  prioritizedVectors,
  revokeAuthorization,
  setKillChainPhase,
  type KillChainPhase,
  type VulnClass,
} from '../services/offensive/state'
import { describeTTPs } from '../services/offensive/mitre'
import { runRecon } from '../services/offensive/recon'
import { runPayloadLoop } from '../services/offensive/payload'
import { runPromptInjection } from '../services/offensive/prompt-inject'
import { runPipeline } from '../services/offensive'

const VULN_CLASSES: VulnClass[] = [
  'sqli', 'xss', 'ssti', 'ssrf', 'rce', 'idor', 'authbypass', 'lfi', 'xxe',
  'open-redirect', 'prompt-injection', 'indirect-prompt-injection',
  'tool-poisoning', 'info-disclosure', 'misconfig', 'leak', 'other',
]

const KILL_CHAIN: KillChainPhase[] = [
  'reconnaissance', 'weaponization', 'delivery', 'exploitation',
  'installation', 'command-and-control', 'actions-on-objectives',
]

// ─── Tool schemas ────────────────────────────────────────────

export const OFFENSIVE_TOOLS: Anthropic.Tool[] = [
  {
    name: 'offensive_op_create',
    description:
      'Create a new offensive operation with an in-scope target list. The operation starts UNAUTHORIZED. ' +
      'You must call offensive_op_authorize with an explicit engagement justification before any agent will run.',
    input_schema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'Short operation name.' },
        domains: { type: 'array', items: { type: 'string' }, description: 'Authorized root domains.' },
        ips: { type: 'array', items: { type: 'string' }, description: 'Authorized IPs or CIDRs.' },
        urls: { type: 'array', items: { type: 'string' }, description: 'Authorized URL prefixes.' },
        org_name: { type: 'string', description: 'Organization name (used for GitHub dork correlation).' },
      },
      required: ['name'],
    },
  },
  {
    name: 'offensive_op_authorize',
    description:
      'Explicitly authorize the current operation. Requires a clear justification — bug-bounty program ID, ' +
      'engagement ID, CTF name, or lab environment notice. The justification is recorded in the operation audit log.',
    input_schema: {
      type: 'object' as const,
      properties: {
        justification: { type: 'string', description: 'Engagement context (bug bounty / pentest / CTF / lab).' },
      },
      required: ['justification'],
    },
  },
  {
    name: 'offensive_op_revoke',
    description: 'Revoke authorization for the current operation. All subsequent agent actions will be refused.',
    input_schema: {
      type: 'object' as const,
      properties: {
        reason: { type: 'string', description: 'Why authorization is being revoked.' },
      },
      required: [],
    },
  },
  {
    name: 'offensive_op_load',
    description: 'Load an existing operation by ID and make it the active one.',
    input_schema: {
      type: 'object' as const,
      properties: {
        operation_id: { type: 'string', description: 'Operation ID returned by offensive_op_create.' },
      },
      required: ['operation_id'],
    },
  },
  {
    name: 'offensive_op_list',
    description: 'List all saved operations.',
    input_schema: { type: 'object' as const, properties: {}, required: [] },
  },
  {
    name: 'offensive_op_status',
    description:
      'Get the current operation state: scope, phase, counts, top vectors and findings. ' +
      'Use this between agent runs to orient yourself.',
    input_schema: { type: 'object' as const, properties: {}, required: [] },
  },
  {
    name: 'offensive_op_phase',
    description: 'Set the current kill-chain phase for the active operation.',
    input_schema: {
      type: 'object' as const,
      properties: {
        phase: { type: 'string', enum: KILL_CHAIN },
      },
      required: ['phase'],
    },
  },
  {
    name: 'offensive_recon',
    description:
      'Run the Recon & Surface Mapping agent against a root target. Enumerates subdomains (subfinder, crt.sh), ' +
      'fingerprints HTTP services (httpx), optionally scans ports (nmap) and runs nuclei templates. ' +
      'All findings are correlated into the operation state. Target must be in scope.',
    input_schema: {
      type: 'object' as const,
      properties: {
        target: { type: 'string', description: 'Root target: domain or URL.' },
        subfinder: { type: 'boolean', description: 'Run subfinder. Default true.' },
        httpx: { type: 'boolean', description: 'Run httpx fingerprinting. Default true.' },
        crtsh: { type: 'boolean', description: 'Query crt.sh. Default true.' },
        shodan: { type: 'boolean', description: 'Query Shodan (requires SHODAN_API_KEY).' },
        github_dorks: { type: 'boolean', description: 'Search GitHub for leaks (requires GITHUB_TOKEN).' },
        nmap: { type: 'boolean', description: 'Run nmap top-100 port scan. Default false.' },
        nuclei: { type: 'boolean', description: 'Run nuclei template scan (info/low/medium). Default false.' },
        step_timeout_sec: { type: 'number', description: 'Per-step timeout seconds. Default 90.' },
      },
      required: ['target'],
    },
  },
  {
    name: 'offensive_payload_loop',
    description:
      'Run the Payload Mutation Loop against a single endpoint+parameter for a given vulnerability class. ' +
      'The loop observes a baseline, probes, classifies WAF/error signals and mutates until the vector is ' +
      'resolved or strategies are exhausted. Every attempt is recorded in operation state; failed payloads ' +
      'are never retried.',
    input_schema: {
      type: 'object' as const,
      properties: {
        target: { type: 'string', description: 'Full URL of the endpoint to probe.' },
        parameter: { type: 'string', description: 'Parameter name to mutate.' },
        location: { type: 'string', enum: ['query', 'body', 'header', 'cookie'], description: 'Where the parameter lives. Default query.' },
        method: { type: 'string', description: 'HTTP method. Default GET or POST by location.' },
        vuln_class: { type: 'string', enum: VULN_CLASSES },
        max_attempts: { type: 'number', description: 'Max probes. Default 12.' },
        request_timeout_sec: { type: 'number', description: 'Per-request timeout. Default 15.' },
        headers: { type: 'object', description: 'Extra headers (auth, content-type).' },
        baseline_body: { type: 'string', description: 'Optional body template for POST targets.' },
      },
      required: ['target', 'parameter', 'vuln_class'],
    },
  },
  {
    name: 'offensive_prompt_inject',
    description:
      'Run the Prompt Injection Prober against an LLM-backed endpoint. Fingerprints the endpoint behavior, ' +
      'then runs direct, indirect and tool-poisoning probes. Each probe is logged with observation + implication. ' +
      'Maps findings to MITRE ATLAS.',
    input_schema: {
      type: 'object' as const,
      properties: {
        target: { type: 'string', description: 'Endpoint URL to probe.' },
        method: { type: 'string', description: 'HTTP method. Default POST.' },
        body_template: { type: 'string', description: 'Body template; use "{{INPUT}}" where the payload should go. Default JSON {"message":"{{INPUT}}"}.' },
        headers: { type: 'object', description: 'Optional extra headers.' },
        max_probes: { type: 'number', description: 'Total probe budget. Default 10.' },
        timeout_sec: { type: 'number', description: 'Per-request timeout. Default 20.' },
        canaries: { type: 'array', items: { type: 'string' }, description: 'Canary strings that, if leaked, confirm instruction-following.' },
      },
      required: ['target'],
    },
  },
  {
    name: 'offensive_pipeline',
    description:
      'Run the full pipeline: recon → optional payload mutation on top vectors → optional prompt injection on ' +
      'LLM-backed assets. Returns the final report (findings, TTPs, recommended next actions).',
    input_schema: {
      type: 'object' as const,
      properties: {
        target: { type: 'string', description: 'Root target.' },
        run_payload_mutation: { type: 'boolean', description: 'Opt in to payload mutation on ranked vectors. Default false.' },
        run_prompt_injection: { type: 'boolean', description: 'Opt in to prompt injection on LLM-backed assets. Default false.' },
        payload_likelihood_floor: { type: 'number', description: 'Only mutate vectors with likelihood ≥ this value. Default 0.5.' },
        max_payload_loops: { type: 'number', description: 'Cap on payload loops. Default 3.' },
      },
      required: ['target'],
    },
  },
  {
    name: 'offensive_op_report',
    description:
      'Produce the final operation report: findings, TTPs mapped to MITRE ATT&CK/ATLAS, top prioritized ' +
      'vectors, and recommended next actions.',
    input_schema: { type: 'object' as const, properties: {}, required: [] },
  },
]

// ─── Dispatcher ──────────────────────────────────────────────

export async function executeOffensiveTool(
  name: string,
  input: Record<string, unknown>,
): Promise<string | null> {
  if (!name.startsWith('offensive_')) return null
  if (!isOffensiveOpsInitialized()) {
    return 'Error: offensive-ops subsystem is not initialized.'
  }

  try {
    switch (name) {
      case 'offensive_op_create': {
        const opName = asString(input.name)
        if (!opName) return 'Error: name is required.'
        const op = createOperation(opName, {
          domains: asStringArray(input.domains),
          ips: asStringArray(input.ips),
          urls: asStringArray(input.urls),
          orgName: asString(input.org_name) || undefined,
        })
        return [
          `Operation created: ${op.scope.operationId}`,
          `Name: ${op.scope.name}`,
          `Scope: ${fmtScope(op.scope.domains, op.scope.ips, op.scope.urls)}`,
          '',
          'Status: UNAUTHORIZED. Call offensive_op_authorize with the engagement justification before any agent will run.',
        ].join('\n')
      }

      case 'offensive_op_authorize': {
        const j = asString(input.justification)
        if (!j) return 'Error: justification is required.'
        authorizeOperation(j)
        return `Operation authorized: ${j}`
      }

      case 'offensive_op_revoke': {
        revokeAuthorization(asString(input.reason) || 'no reason given')
        return 'Authorization revoked. No agent will act until it is re-authorized.'
      }

      case 'offensive_op_load': {
        const id = asString(input.operation_id)
        if (!id) return 'Error: operation_id is required.'
        const op = loadOperation(id)
        return `Loaded operation ${op.scope.operationId} (${op.scope.name}, ${op.scope.authorized ? 'AUTHORIZED' : 'UNAUTHORIZED'}).`
      }

      case 'offensive_op_list': {
        const ops = listOperations()
        if (ops.length === 0) return 'No saved operations.'
        return ops
          .map((o) => `- ${o.operationId}  ${o.authorized ? '[A]' : '[ ]'}  ${o.name}  (${o.createdAt})`)
          .join('\n')
      }

      case 'offensive_op_status': {
        const op = getCurrentOperation()
        if (!op) return 'No active operation. Use offensive_op_create or offensive_op_load first.'
        const top = prioritizedVectors(5)
        const lines = [
          `Operation: ${op.scope.name} (${op.scope.operationId})`,
          `Phase: ${op.phase}`,
          `Authorized: ${op.scope.authorized ? 'YES — ' + op.scope.authorization : 'NO'}`,
          `Scope: ${fmtScope(op.scope.domains, op.scope.ips, op.scope.urls)}`,
          '',
          `Assets: ${op.assets.length} | Vectors: ${op.vectors.length} | Findings: ${op.findings.length}`,
          '',
          'Top vectors:',
        ]
        if (top.length === 0) lines.push('  (none yet — run recon)')
        for (const { vector, asset, score } of top) {
          lines.push(`  - [${score.toFixed(2)}] ${vector.class} @ ${asset?.value ?? vector.assetId} — ${vector.rationale}`)
        }
        return lines.join('\n')
      }

      case 'offensive_op_phase': {
        const phase = asString(input.phase) as KillChainPhase
        if (!KILL_CHAIN.includes(phase)) return `Error: phase must be one of ${KILL_CHAIN.join(', ')}`
        setKillChainPhase(phase)
        return `Phase set to ${phase}.`
      }

      case 'offensive_recon': {
        const target = asString(input.target)
        if (!target) return 'Error: target is required.'
        const res = await runRecon(target, {
          subfinder: asBool(input.subfinder),
          httpx: asBool(input.httpx),
          crtsh: asBool(input.crtsh),
          shodan: asBool(input.shodan),
          githubDorks: asBool(input.github_dorks),
          nmap: asBool(input.nmap),
          nuclei: asBool(input.nuclei),
          stepTimeoutSec: asNumber(input.step_timeout_sec),
        })
        const lines = [
          `Recon complete on ${res.target}`,
          `Ran: ${res.ranSteps.join(', ') || 'none'}`,
          `Skipped: ${res.skippedSteps.map((s) => `${s.step} (${s.reason})`).join(', ') || 'none'}`,
          `Assets: ${res.assetCount} | New vectors: ${res.newVectors}`,
          '',
          'Top vectors:',
        ]
        for (const v of res.topVectors) {
          lines.push(`  - [${v.likelihood.toFixed(2)}] ${v.class} @ ${v.target} — ${v.rationale}`)
        }
        return lines.join('\n')
      }

      case 'offensive_payload_loop': {
        const target = asString(input.target)
        const parameter = asString(input.parameter)
        const vulnClass = asString(input.vuln_class) as VulnClass
        if (!target || !parameter || !vulnClass) {
          return 'Error: target, parameter and vuln_class are required.'
        }
        if (!VULN_CLASSES.includes(vulnClass)) {
          return `Error: vuln_class must be one of ${VULN_CLASSES.join(', ')}`
        }
        const result = await runPayloadLoop({
          target,
          parameter,
          vulnClass,
          location: (asString(input.location) as 'query' | 'body' | 'header' | 'cookie') || undefined,
          method: asString(input.method) || undefined,
          maxAttempts: asNumber(input.max_attempts),
          requestTimeoutSec: asNumber(input.request_timeout_sec),
          headers: (input.headers as Record<string, string>) || undefined,
          baselineBody: asString(input.baseline_body) || undefined,
        })
        return [
          `Payload loop: ${vulnClass} on ${parameter}@${target}`,
          `Status: ${result.status}`,
          `Attempts: ${result.attempts}`,
          `Strategies tried: ${result.strategies.join(' → ')}`,
          `Signals: ${result.signals.join(', ') || '(none)'}`,
          `Reasoning: ${result.reasoning}`,
        ].join('\n')
      }

      case 'offensive_prompt_inject': {
        const target = asString(input.target)
        if (!target) return 'Error: target is required.'
        const result = await runPromptInjection({
          target,
          method: asString(input.method) || undefined,
          bodyTemplate: asString(input.body_template) || undefined,
          headers: (input.headers as Record<string, string>) || undefined,
          maxProbes: asNumber(input.max_probes),
          timeoutSec: asNumber(input.timeout_sec),
          canaries: asStringArray(input.canaries),
        })
        return [
          `Prompt-injection probes on ${target}`,
          `LLM-backed: ${result.isLLMBacked} (confidence ${result.llmConfidence.toFixed(2)})`,
          `Vectors created: ${result.vectorIds.length}`,
          `Findings: ${result.findings}`,
          '',
          result.summary,
        ].join('\n')
      }

      case 'offensive_pipeline': {
        const target = asString(input.target)
        if (!target) return 'Error: target is required.'
        const res = await runPipeline({
          rootTarget: target,
          runPayloadMutation: asBool(input.run_payload_mutation),
          runPromptInjection: asBool(input.run_prompt_injection),
          payloadLikelihoodFloor: asNumber(input.payload_likelihood_floor),
          maxPayloadLoops: asNumber(input.max_payload_loops),
        })
        return formatReport(res.report, res.ttpDetails, res.stages)
      }

      case 'offensive_op_report': {
        const op = getCurrentOperation()
        if (!op) return 'No active operation.'
        const report = buildReport()
        return formatReport(report, describeTTPs(report.ttps))
      }

      default:
        return null
    }
  } catch (err) {
    return `Error: ${err instanceof Error ? err.message : String(err)}`
  }
}

// ─── Formatting ──────────────────────────────────────────────

function formatReport(
  report: ReturnType<typeof buildReport>,
  ttpDetails: string[],
  stages?: {
    recon: { ran: boolean; summary: string }
    payload: { ran: boolean; summary: string }
    promptInject: { ran: boolean; summary: string }
  },
): string {
  const lines = [
    `# Offensive Operation Report: ${report.operation.name}`,
    `ID: ${report.operation.id} | Phase: ${report.operation.phase} | Authorized: ${report.operation.authorized}`,
    '',
    `## Counts`,
    `  Assets:   ${report.counts.assets}`,
    `  Vectors:  ${report.counts.vectors}`,
    `  Findings: ${report.counts.findings}`,
  ]
  if (stages) {
    lines.push(
      '',
      '## Stages',
      `  recon:          ${stages.recon.ran ? stages.recon.summary : 'not run'}`,
      `  payload loop:   ${stages.payload.ran ? stages.payload.summary : 'not run'}`,
      `  prompt-inject:  ${stages.promptInject.ran ? stages.promptInject.summary : 'not run'}`,
    )
  }
  lines.push('', '## Top Vectors')
  if (report.topVectors.length === 0) lines.push('  (none)')
  for (const v of report.topVectors) {
    lines.push(`  - [${v.score.toFixed(2)} | L=${v.likelihood.toFixed(2)}] ${v.class} @ ${v.target}`)
    lines.push(`      rationale: ${v.rationale}`)
  }
  lines.push('', '## Findings')
  if (report.findings.length === 0) lines.push('  (none)')
  for (const f of report.findings) {
    lines.push(`  [${f.severity.toUpperCase()}] ${f.title}`)
    lines.push(`      ${f.description.split('\n').join(' ')}`)
    if (f.ttps.length) lines.push(`      TTPs: ${f.ttps.join(', ')}`)
  }
  lines.push('', '## TTPs')
  if (ttpDetails.length === 0) lines.push('  (none)')
  for (const t of ttpDetails) lines.push(`  - ${t}`)
  lines.push('', '## Recommended Next Actions')
  for (const r of report.recommendedNext) lines.push(`  - ${r}`)
  return lines.join('\n')
}

// ─── small helpers ───────────────────────────────────────────

function asString(v: unknown): string {
  if (typeof v === 'string') return v.trim()
  return ''
}
function asNumber(v: unknown): number | undefined {
  if (typeof v === 'number' && isFinite(v)) return v
  return undefined
}
function asBool(v: unknown): boolean | undefined {
  if (typeof v === 'boolean') return v
  return undefined
}
function asStringArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => String(x)).filter(Boolean)
  return []
}
function fmtScope(domains: string[], ips: string[], urls: string[]): string {
  const parts: string[] = []
  if (domains.length) parts.push(`domains=[${domains.join(', ')}]`)
  if (ips.length) parts.push(`ips=[${ips.join(', ')}]`)
  if (urls.length) parts.push(`urls=[${urls.join(', ')}]`)
  return parts.length ? parts.join(' ') : '(empty)'
}
