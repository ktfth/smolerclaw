import { getVersion } from '../cli'
import { canonicalJson } from '../engine/canonical'
import type { InvokeResult } from '../engine/engine'

export const ENGINE_COMMANDS = ['tools', 'run', 'workflow', 'mcp'] as const
export type EngineCommand = (typeof ENGINE_COMMANDS)[number]

export function isEngineCommand(arg: string | undefined): arg is EngineCommand {
  return (ENGINE_COMMANDS as readonly string[]).includes(arg ?? '')
}

export interface EngineIO {
  out: (text: string) => void
  err: (text: string) => void
  readStdin: () => Promise<string>
}

const DEFAULT_IO: EngineIO = {
  out: (text) => process.stdout.write(text.endsWith('\n') ? text : text + '\n'),
  err: (text) => process.stderr.write(text.endsWith('\n') ? text : text + '\n'),
  readStdin: () => Bun.stdin.text(),
}

export interface ParsedEngineArgs {
  asJson: boolean
  dryRun: boolean
  dataDir?: string
  timeoutMs?: number
  positional: string[]
}

/**
 * Entry point for the deterministic engine commands. Returns the exit code.
 *
 *   smolerclaw tools [--json] [--data-dir <dir>]
 *   smolerclaw run <tool> [json|-] [--json] [--dry-run] [--data-dir <dir>] [--timeout <ms>]
 *   smolerclaw workflow <name> [--json] [--dry-run] [--data-dir <dir>]
 *   smolerclaw mcp [--data-dir <dir>] [--dry-run] [--timeout <ms>]
 */
export async function runEngineMode(argv: string[], io: EngineIO = DEFAULT_IO): Promise<number> {
  const [command, ...rest] = argv
  let parsed: ParsedEngineArgs
  try {
    parsed = parseEngineArgs(rest)
  } catch (err) {
    io.err(err instanceof Error ? err.message : String(err))
    return 2
  }
  const { asJson, dryRun, dataDir, timeoutMs, positional } = parsed

  // MCP owns stdout for protocol frames: route stray logging to stderr first.
  if (command === 'mcp') redirectConsoleToStderr()

  const { bootstrapEngine } = await import('../engine/bootstrap')
  const runtime = await bootstrapEngine({
    dataDir,
    dryRun,
    timeoutMs,
    caller: command === 'mcp' ? 'mcp' : 'cli',
  })

  try {
    switch (command) {
      case 'tools': {
        const tools = runtime.engine.listTools()
        if (asJson) {
          io.out(canonicalJson(tools.map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema,
            readOnly: t.readOnly,
            destructive: t.destructive,
            openWorld: t.openWorld,
          }))))
        } else {
          for (const t of tools) io.out(`${t.name}\t${firstLine(t.description)}`)
        }
        return 0
      }

      case 'run': {
        const [name, rawInput] = positional
        if (!name) {
          io.err('usage: smolerclaw run <tool> [json-input | -] [--json] [--dry-run] [--data-dir <dir>] [--timeout <ms>]')
          return 2
        }
        const text = rawInput === '-' ? await io.readStdin() : rawInput ?? '{}'
        let input: unknown
        try {
          input = JSON.parse(text || '{}')
        } catch (err) {
          io.err(`invalid JSON input: ${err instanceof Error ? err.message : String(err)}`)
          return 2
        }
        const result = await runtime.engine.invoke(name, input, { dryRun, timeoutMs })
        emitResult(result, asJson, io)
        return exitCodeFor(result)
      }

      case 'workflow': {
        const [name] = positional
        if (!name) {
          io.err('usage: smolerclaw workflow <name> [--json] [--dry-run] [--data-dir <dir>]')
          return 2
        }
        const { runWorkflowOutcome } = await import('../workflows')
        const outcome = await runWorkflowOutcome(
          name,
          asJson ? undefined : (msg) => io.err(msg),
          {
            policy: runtime.policy,
            audit: runtime.audit,
            runId: runtime.runId,
            caller: runtime.caller,
            dryRun: runtime.dryRun,
          },
        )
        if (asJson) {
          io.out(canonicalJson({
            ok: outcome.ok,
            decision: outcome.denied ? 'denied' : runtime.dryRun ? 'dry-run' : 'executed',
            workflow: name,
            output: outcome.text,
          }))
        } else if (outcome.ok) {
          io.out(outcome.text)
        } else {
          io.err(outcome.text)
        }
        if (outcome.ok) return 0
        return outcome.denied ? 3 : 1
      }

      case 'mcp': {
        const { serveMcpStdio } = await import('../mcp/server')
        const { startAutoBackup, stopAutoBackup } = await import('../vault')
        // Long-lived process: the only engine command allowed to back up in the background.
        startAutoBackup()
        try {
          await serveMcpStdio(runtime.engine, getVersion())
        } finally {
          stopAutoBackup()
        }
        return 0
      }

      default:
        io.err(`unknown engine command: ${command}`)
        return 2
    }
  } finally {
    runtime.dispose()
  }
}

/** Parse engine flags and positionals. '-' is a positional meaning "read stdin". */
export function parseEngineArgs(args: readonly string[]): ParsedEngineArgs {
  let asJson = false
  let dryRun = false
  let dataDir: string | undefined
  let timeoutMs: number | undefined
  const positional: string[] = []

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--json') {
      asJson = true
    } else if (arg === '--dry-run') {
      dryRun = true
    } else if (arg === '--data-dir') {
      const value = args[++i]
      if (!value) throw new Error('--data-dir requires a path')
      dataDir = value
    } else if (arg.startsWith('--data-dir=')) {
      const value = arg.slice('--data-dir='.length)
      if (!value) throw new Error('--data-dir requires a path')
      dataDir = value
    } else if (arg === '--timeout') {
      const raw = args[++i]
      const ms = Number(raw)
      if (!raw || !Number.isFinite(ms) || ms < 0) throw new Error('--timeout requires a non-negative number of milliseconds')
      timeoutMs = ms
    } else if (arg.startsWith('--timeout=')) {
      const raw = arg.slice('--timeout='.length)
      const ms = Number(raw)
      if (!raw || !Number.isFinite(ms) || ms < 0) throw new Error('--timeout requires a non-negative number of milliseconds')
      timeoutMs = ms
    } else if (arg === '-' || !arg.startsWith('--')) {
      positional.push(arg)
    } else {
      throw new Error(`unknown option: ${arg}`)
    }
  }

  return {
    asJson,
    dryRun,
    ...(dataDir !== undefined ? { dataDir } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    positional,
  }
}

/** Separate flags from positionals. '-' is a positional meaning "read stdin". */
export function splitEngineArgs(args: readonly string[]): { asJson: boolean; positional: string[] } {
  const { asJson, positional } = parseEngineArgs(args)
  return { asJson, positional }
}

function emitResult(result: InvokeResult, asJson: boolean, io: EngineIO): void {
  if (asJson) {
    io.out(canonicalJson(result))
    return
  }
  if (result.ok) io.out(result.output)
  else io.err(result.output)
}

/** 0 ok · 1 tool error · 2 invalid input / unknown tool · 3 denied by policy */
export function exitCodeFor(result: InvokeResult): number {
  if (result.ok) return 0
  switch (result.decision) {
    case 'denied': return 3
    case 'invalid':
    case 'unknown': return 2
    default: return 1
  }
}

function firstLine(text: string): string {
  const line = text.split('\n')[0] ?? ''
  return line.length > 100 ? line.slice(0, 97) + '...' : line
}

function redirectConsoleToStderr(): void {
  const toErr = (...args: unknown[]) => process.stderr.write(args.map(String).join(' ') + '\n')
  console.log = toErr
  console.info = toErr
  console.warn = toErr
  console.debug = toErr
}
