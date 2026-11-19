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

/**
 * Entry point for the deterministic engine commands. Returns the exit code.
 *
 *   smolerclaw tools [--json]            list the tool catalog
 *   smolerclaw run <tool> [json|-]       invoke one tool, no model involved
 *   smolerclaw workflow <name>           run a saved workflow
 *   smolerclaw mcp                       serve tools over MCP (stdio)
 */
export async function runEngineMode(argv: string[], io: EngineIO = DEFAULT_IO): Promise<number> {
  const [command, ...rest] = argv
  const { asJson, positional } = splitEngineArgs(rest)

  // MCP owns stdout for protocol frames: route stray logging to stderr first.
  if (command === 'mcp') redirectConsoleToStderr()

  const { bootstrapEngine } = await import('../engine/bootstrap')
  const { engine } = await bootstrapEngine()

  switch (command) {
    case 'tools': {
      const tools = engine.listTools()
      if (asJson) {
        io.out(canonicalJson(tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }))))
      } else {
        for (const t of tools) io.out(`${t.name}\t${firstLine(t.description)}`)
      }
      return 0
    }

    case 'run': {
      const [name, rawInput] = positional
      if (!name) {
        io.err('usage: smolerclaw run <tool> [json-input | -] [--json]')
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
      const result = await engine.invoke(name, input)
      emitResult(result, asJson, io)
      return exitCodeFor(result)
    }

    case 'workflow': {
      const [name] = positional
      if (!name) {
        io.err('usage: smolerclaw workflow <name>')
        return 2
      }
      const { runWorkflowOutcome } = await import('../workflows')
      const outcome = await runWorkflowOutcome(name, (msg) => io.err(msg))
      io.out(outcome.text)
      return outcome.ok ? 0 : 1
    }

    case 'mcp': {
      const { serveMcpStdio } = await import('../mcp/server')
      await serveMcpStdio(engine, getVersion())
      return 0
    }

    default:
      io.err(`unknown engine command: ${command}`)
      return 2
  }
}

/** Separate flags from positionals. '-' is a positional meaning "read stdin". */
export function splitEngineArgs(args: readonly string[]): { asJson: boolean; positional: string[] } {
  return {
    asJson: args.includes('--json'),
    positional: args.filter((a) => a === '-' || !a.startsWith('--')),
  }
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
