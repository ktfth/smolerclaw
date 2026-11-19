import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import type { Engine } from '../engine/engine'

/**
 * Build an MCP server that exposes the deterministic engine's tools.
 * The agent (e.g. Claude Code) supplies the reasoning; this side only
 * validates, applies policy, executes and audits.
 */
export function createMcpServer(engine: Engine, version: string): Server {
  const server = new Server(
    { name: 'smolerclaw', version },
    { capabilities: { tools: {} } },
  )

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: engine.listTools().map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema as { type: 'object'; [key: string]: unknown },
    })),
  }))

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const result = await engine.invoke(request.params.name, request.params.arguments ?? {})
    return {
      content: [{ type: 'text' as const, text: result.output }],
      isError: !result.ok,
    }
  })

  return server
}

/**
 * Serve the engine over stdio. Resolves when the client disconnects, so the
 * caller can exit even if some module keeps a timer or watcher alive.
 */
export async function serveMcpStdio(engine: Engine, version: string): Promise<void> {
  const server = createMcpServer(engine, version)
  const closed = new Promise<void>((resolve) => {
    server.onclose = () => resolve()
    process.stdin.once('end', () => resolve())
  })
  await server.connect(new StdioServerTransport())
  await closed
}
