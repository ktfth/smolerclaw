import { canonicalHash } from './canonical'
import { InputValidator } from './validate'
import { decide, isListed, type EnginePolicy } from './policy'
import type { AuditSink } from './audit'
import type { RiskLevel } from '../tool-safety'
import { toChatText, type ToolResult } from '../core/result'

export interface CatalogTool {
  name: string
  description?: string
  input_schema: unknown
}

export interface ToolDescriptor {
  name: string
  description: string
  inputSchema: unknown
  readOnly: boolean
}

export type InvokeDecision = 'executed' | 'denied' | 'invalid' | 'unknown'

export interface InvokeResult {
  ok: boolean
  tool: string
  decision: InvokeDecision
  risk: RiskLevel | 'n/a'
  output: string
  /** Structured payload from the tool, when it provides one (successful calls only). */
  data?: unknown
  inputHash: string
  durationMs: number
}

export interface EngineDeps {
  /** Source of the tool catalog. Read on every call so late registrations are seen. */
  catalog: () => readonly CatalogTool[]
  /** Executes a tool that already passed validation and policy. */
  execute: (name: string, input: Record<string, unknown>) => Promise<ToolResult>
  policy: EnginePolicy
  audit: AuditSink
  clock?: () => Date
  /** Whether a tool only reads state (advertised to clients as a hint). */
  isReadOnly?: (name: string) => boolean
}

export interface Engine {
  listTools(): ToolDescriptor[]
  invoke(name: string, input: unknown): Promise<InvokeResult>
}

/**
 * Deterministic tool engine: no model in the loop.
 * Every invocation goes through the same fixed pipeline:
 * lookup → schema validation → static policy → execute → audit.
 */
export function createEngine(deps: EngineDeps): Engine {
  const validator = new InputValidator()
  const clock = deps.clock ?? (() => new Date())

  function findTool(name: string): CatalogTool | undefined {
    return deps.catalog().find((t) => t.name === name)
  }

  function listTools(): ToolDescriptor[] {
    const seen = new Set<string>()
    const unique: CatalogTool[] = []
    for (const tool of deps.catalog()) {
      if (seen.has(tool.name)) continue
      seen.add(tool.name)
      unique.push(tool)
    }
    return unique
      .filter((t) => isListed(deps.policy, t.name))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
      .map((t) => ({
        name: t.name,
        description: t.description ?? '',
        inputSchema: t.input_schema,
        readOnly: deps.isReadOnly?.(t.name) ?? false,
      }))
  }

  async function invoke(name: string, rawInput: unknown): Promise<InvokeResult> {
    const startedAt = clock()
    const input = isRecord(rawInput) ? rawInput : {}
    const inputHash = canonicalHash(rawInput ?? null)

    const finish = (
      decision: InvokeDecision,
      risk: InvokeResult['risk'],
      ok: boolean,
      output: string,
      data?: unknown,
    ): InvokeResult => {
      const durationMs = Math.max(0, clock().getTime() - startedAt.getTime())
      deps.audit.write({
        ts: startedAt.toISOString(),
        tool: name,
        inputHash,
        decision,
        risk,
        ok,
        durationMs,
        // Only engine-generated messages are logged: tool output and policy
        // reasons can echo raw arguments, which the audit must never store.
        ...(!ok && (decision === 'invalid' || decision === 'unknown') ? { error: output.slice(0, 500) } : {}),
      })
      return {
        ok, tool: name, decision, risk, output,
        ...(data === undefined ? {} : { data }),
        inputHash, durationMs,
      }
    }

    const tool = findTool(name)
    if (!tool) return finish('unknown', 'n/a', false, `Error: unknown tool "${name.slice(0, 64)}"`)

    if (!isRecord(rawInput)) {
      return finish('invalid', 'n/a', false, 'Error: tool input must be a JSON object')
    }

    if (!validator.canValidate(tool)) {
      return finish('invalid', 'n/a', false, `Error: tool "${name}" has an uncompilable input schema`)
    }

    const validation = validator.validate(tool, input)
    if (!validation.valid) {
      return finish('invalid', 'n/a', false, `Error: invalid input for "${name}": ${validation.errors.join('; ')}`)
    }

    const policy = decide(deps.policy, name, input)
    if (!policy.allowed) {
      return finish('denied', policy.risk, false, `Error: denied by policy: ${policy.reason}`)
    }

    try {
      // Success comes from the tool's structured result, never from its text.
      const result = await deps.execute(name, input)
      return finish('executed', policy.risk, result.ok, toChatText(result), result.ok ? result.data : undefined)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return finish('executed', policy.risk, false, `Error: ${message}`)
    }
  }

  return { listTools, invoke }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
