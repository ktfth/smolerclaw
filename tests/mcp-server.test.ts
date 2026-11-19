import { describe, test, expect } from 'bun:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { createMcpServer } from '../src/mcp/server'
import { createEngine } from '../src/engine/engine'
import { DEFAULT_POLICY } from '../src/engine/policy'
import { withTailCacheBreakpoint } from '../src/claude'
import type Anthropic from '@anthropic-ai/sdk'

async function connect() {
  const engine = createEngine({
    catalog: () => [
      {
        name: 'create_task',
        description: 'Create a task',
        input_schema: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] },
      },
    ],
    execute: async (_name, input) => `created ${String(input.title)}`,
    policy: DEFAULT_POLICY,
    audit: { write: () => {} },
  })
  const server = createMcpServer(engine, '0.0.0-test')
  const client = new Client({ name: 'test-client', version: '0.0.0' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
  return client
}

describe('MCP server', () => {
  test('lists engine tools', async () => {
    const client = await connect()
    const { tools } = await client.listTools()
    expect(tools.map((t) => t.name)).toEqual(['create_task'])
    expect(tools[0].inputSchema.required).toEqual(['title'])
    await client.close()
  })

  test('calls a tool through the engine pipeline', async () => {
    const client = await connect()
    const ok = await client.callTool({ name: 'create_task', arguments: { title: 'pagar conta' } })
    expect(ok.isError).toBe(false)
    expect(ok.content).toEqual([{ type: 'text', text: 'created pagar conta' }])

    const invalid = await client.callTool({ name: 'create_task', arguments: {} })
    expect(invalid.isError).toBe(true)
    await client.close()
  })
})

describe('withTailCacheBreakpoint', () => {
  test('marks the last block without mutating the input', () => {
    const messages: Anthropic.MessageParam[] = [
      { role: 'user', content: 'oi' },
      { role: 'assistant', content: 'ola' },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] },
    ]
    const snapshot = JSON.stringify(messages)
    const marked = withTailCacheBreakpoint(messages)
    expect(JSON.stringify(messages)).toBe(snapshot)
    const tail = marked[2].content as Anthropic.ContentBlockParam[]
    expect(tail[0]).toMatchObject({ type: 'tool_result', cache_control: { type: 'ephemeral' } })
    expect(marked[0]).toBe(messages[0])
  })

  test('converts string content to a marked text block', () => {
    const marked = withTailCacheBreakpoint([{ role: 'user', content: 'hello' }])
    expect(marked[0].content).toEqual([{ type: 'text', text: 'hello', cache_control: { type: 'ephemeral' } }])
  })
})
