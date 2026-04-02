/**
 * Hello World — script plugin example.
 *
 * Demonstrates:
 *   - Tool definition with typed input
 *   - onLoad / onUnload lifecycle hooks
 *   - onToolCall handler (pure logic, no shell)
 *
 * Install:
 *   Copy this file to ~/.config/smolerclaw/plugins/hello-script.ts
 *   (or %APPDATA%/smolerclaw/plugins/ on Windows)
 */

export default {
  name: 'hello_script',
  description: 'A hello world script plugin with lifecycle hooks.',
  version: '1.0.0',

  tools: [
    {
      name: 'greet',
      description: 'Greet someone by name. Returns a personalized greeting.',
      input_schema: {
        type: 'object' as const,
        properties: {
          name: { type: 'string', description: 'Name to greet' },
          language: {
            type: 'string',
            description: 'Language: en or pt',
            enum: ['en', 'pt'],
          },
        },
        required: ['name'],
      },
    },
  ],

  onLoad(ctx) {
    ctx.notify('Hello Script plugin loaded!', 'success')
  },

  onUnload() {
    // Cleanup resources here (close connections, flush buffers, etc.)
  },

  async onToolCall(toolName: string, input: Record<string, unknown>): Promise<string> {
    const name = String(input.name || 'World')
    const lang = String(input.language || 'en')

    if (toolName === 'greet') {
      return lang === 'pt'
        ? `Ola, ${name}! Bem-vindo ao smolerclaw.`
        : `Hello, ${name}! Welcome to smolerclaw.`
    }

    return `Unknown tool: ${toolName}`
  },
}
