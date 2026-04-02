/**
 * Counter — stateful plugin example with event subscriptions.
 *
 * Demonstrates:
 *   - Persistent state via ctx.dataDir
 *   - Event bus subscriptions (reacts to file saves)
 *   - Multiple tools from a single plugin
 *   - onLoad reads saved state, onUnload persists it
 *
 * Install:
 *   Copy this file to ~/.config/smolerclaw/plugins/counter.ts
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

let count = 0
let dataFile = ''

export default {
  name: 'counter',
  description: 'A stateful counter plugin — persists between sessions, reacts to file saves.',
  version: '1.0.0',

  tools: [
    {
      name: 'counter_increment',
      description: 'Increment the counter by a given amount (default 1).',
      input_schema: {
        type: 'object' as const,
        properties: {
          amount: { type: 'number', description: 'Amount to add (default 1)' },
        },
        required: [],
      },
    },
    {
      name: 'counter_value',
      description: 'Get the current counter value.',
      input_schema: {
        type: 'object' as const,
        properties: {},
        required: [],
      },
    },
    {
      name: 'counter_reset',
      description: 'Reset the counter to zero.',
      input_schema: {
        type: 'object' as const,
        properties: {},
        required: [],
      },
    },
  ],

  onLoad(ctx: { notify: (msg: string, level?: string) => void; dataDir: string }) {
    dataFile = join(ctx.dataDir, 'counter.json')

    // Restore persisted state
    if (existsSync(dataFile)) {
      try {
        const saved = JSON.parse(readFileSync(dataFile, 'utf-8'))
        count = saved.count || 0
      } catch {
        count = 0
      }
    }

    ctx.notify(`Counter plugin loaded (current: ${count})`, 'info')
  },

  onUnload() {
    // Persist state on shutdown
    if (dataFile) {
      writeFileSync(dataFile, JSON.stringify({ count }, null, 2))
    }
  },

  // React to file saves — increment counter on each save
  events: {
    'file:saved': () => {
      count++
    },
  },

  async onToolCall(toolName: string, input: Record<string, unknown>): Promise<string> {
    switch (toolName) {
      case 'counter_increment': {
        const amount = typeof input.amount === 'number' ? input.amount : 1
        count += amount
        persist()
        return `Counter: ${count} (+${amount})`
      }
      case 'counter_value':
        return `Counter: ${count}`
      case 'counter_reset':
        count = 0
        persist()
        return 'Counter reset to 0.'
      default:
        return `Unknown tool: ${toolName}`
    }
  },
}

function persist(): void {
  if (dataFile) {
    writeFileSync(dataFile, JSON.stringify({ count }, null, 2))
  }
}
