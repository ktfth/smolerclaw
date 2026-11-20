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
  destructive: boolean
  openWorld: boolean
}

export type InvokeDecision = 'executed' | 'dry-run' | 'denied' | 'invalid' | 'unknown'

export interface InvokeOptions {
  /** Validate and check policy without executing the tool handler. */
  dryRun?: boolean
  /** Override per-invocation timeout in milliseconds (0 disables timeout). */
  timeoutMs?: number
}

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
  /** Whether a tool deletes data or triggers irreversible side effects. */
  isDestructive?: (name: string) => boolean
  /** Whether a tool interacts with external systems outside the local store. */
  isOpenWorld?: (name: string) => boolean
  /** Optional correlation id attached to every audit record. */
  runId?: string
  /** Caller surface (e.g. 'cli', 'mcp', 'scheduler') attached to audit records. */
  caller?: string
  /** Default dry-run mode for invocations when not overridden per call. */
  dryRun?: boolean
  /** Default execution timeout in milliseconds (0 or undefined = no timeout). */
  timeoutMs?: number
  /** Optional rate-limit check; returning false denies the invocation. */
  checkRateLimit?: (name: string) => boolean
}

export interface Engine {
  listTools(): ToolDescriptor[]
  invoke(name: string, input: unknown, options?: InvokeOptions): Promise<InvokeResult>
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
        destructive: deps.isDestructive?.(t.name) ?? false,
        openWorld: deps.isOpenWorld?.(t.name) ?? false,
      }))
  }

  async function invoke(name: string, rawInput: unknown, options?: InvokeOptions): Promise<InvokeResult> {
    const startedAt = clock()
    const input = isRecord(rawInput) ? rawInput : {}
    const inputHash = canonicalHash(rawInput ?? null)
    const dryRun = options?.dryRun ?? deps.dryRun ?? false
    const timeoutMs = options?.timeoutMs ?? deps.timeoutMs ?? 0

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
        ...(deps.runId ? { runId: deps.runId } : {}),
        ...(deps.caller ? { caller: deps.caller } : {}),
        tool: name,
        inputHash,
        decision,
        risk,
        ok,
        durationMs,
        ...(dryRun ? { dryRun: true } : {}),
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

    if (deps.checkRateLimit && !deps.checkRateLimit(name)) {
      return finish('denied', policy.risk, false, `Error: denied by policy: rate limit exceeded for "${name}"`)
    }

    if (dryRun) {
      return finish('dry-run', policy.risk, true, `Dry run: "${name}" is valid and allowed by policy (${policy.risk})`)
    }

    try {
      // Success comes from the tool's structured result, never from its text.
      const result = await runWithTimeout(() => deps.execute(name, input), timeoutMs, name)
      return finish('executed', policy.risk, result.ok, toChatText(result), result.ok ? result.data : undefined)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return finish('executed', policy.risk, false, `Error: ${message}`)
    }
  }

  return { listTools, invoke }
}

async function runWithTimeout<T>(fn: () => Promise<T>, timeoutMs: number, toolName: string): Promise<T> {
  if (timeoutMs <= 0) return fn()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      fn(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`tool "${toolName}" timed out after ${timeoutMs}ms`)), timeoutMs)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
