import type { Session, Message } from './types'

interface ExportOptions {
  includeToolCalls?: boolean
  includeTimestamps?: boolean
}

/**
 * Export a session to a clean markdown document.
 */
export function exportToMarkdown(session: Session, opts: ExportOptions = {}): string {
  const { includeToolCalls = true, includeTimestamps = true } = opts
  const lines: string[] = []

  lines.push(`# smolerclaw session: ${session.name}`)
  lines.push(`Created: ${new Date(session.created).toLocaleString()}`)
  lines.push('')
  lines.push('---')
  lines.push('')

  for (const msg of session.messages) {
    const ts = includeTimestamps
      ? ` (${new Date(msg.timestamp).toLocaleTimeString('en', { hour: '2-digit', minute: '2-digit' })})`
      : ''

    if (msg.role === 'user') {
      lines.push(`## You${ts}`)
      lines.push('')
      lines.push(msg.content)
      lines.push('')
    } else {
      lines.push(`## Claude${ts}`)
      lines.push('')
      lines.push(msg.content)

      if (includeToolCalls && msg.toolCalls?.length) {
        lines.push('')
        for (const tc of msg.toolCalls) {
          const inputSummary = formatToolInput(tc.name, tc.input)
          lines.push(`> **Tool:** \`${tc.name}\`${inputSummary}`)
          const resultPreview = tc.result.split('\n').slice(0, 5).join('\n')
          if (resultPreview.trim()) {
            lines.push('> ```')
            for (const rl of resultPreview.split('\n')) {
              lines.push(`> ${rl}`)
            }
            lines.push('> ```')
          }
        }
      }

      if (msg.usage) {
        lines.push('')
        lines.push(`*Tokens: ${msg.usage.inputTokens} in / ${msg.usage.outputTokens} out (~$${(msg.usage.costCents / 100).toFixed(4)})*`)
      }

      lines.push('')
    }

    lines.push('---')
    lines.push('')
  }

  return lines.join('\n')
}

function formatToolInput(name: string, input: Record<string, unknown>): string {
  switch (name) {
    case 'read_file':
    case 'write_file':
    case 'edit_file':
      return input.path ? ` \`${input.path}\`` : ''
    case 'search_files':
      return input.pattern ? ` \`/${input.pattern}/\`` : ''
    case 'find_files':
      return input.pattern ? ` \`${input.pattern}\`` : ''
    case 'run_command':
      return input.command ? ` \`${input.command}\`` : ''
    default:
      return ''
  }
}
