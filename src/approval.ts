import type { ToolApprovalMode } from './types'

export type ApprovalCallback = (toolName: string, input: Record<string, unknown>, riskLevel: string) => Promise<boolean>

/**
 * Determines whether a tool call needs user approval.
 */
export function needsApproval(
  mode: ToolApprovalMode,
  toolName: string,
  riskLevel: string,
): boolean {
  if (mode === 'auto') return false
  if (riskLevel === 'safe') return false

  if (mode === 'confirm-writes') {
    // Only confirm write operations and commands
    return ['write_file', 'edit_file', 'run_command'].includes(toolName)
  }

  if (mode === 'confirm-all') {
    return riskLevel !== 'safe'
  }

  return false
}

/**
 * Format a tool call for approval display.
 */
export function formatApprovalPrompt(toolName: string, input: Record<string, unknown>): string {
  switch (toolName) {
    case 'write_file':
      return `Write file: ${input.path}`
    case 'edit_file':
      return `Edit file: ${input.path}`
    case 'run_command': {
      const cmd = String(input.command || '')
      return `Run: ${cmd.length > 60 ? cmd.slice(0, 57) + '...' : cmd}`
    }
    default:
      return `${toolName}: ${JSON.stringify(input).slice(0, 60)}`
  }
}

/**
 * Generate a colored diff preview for edit_file operations.
 * Returns lines ready for TUI display.
 */
export function formatEditDiff(oldText: string, newText: string, maxLines: number = 20): string[] {
  const oldLines = oldText.split('\n')
  const newLines = newText.split('\n')
  const lines: string[] = []

  // Show removed lines (red)
  const shownOld = oldLines.slice(0, maxLines)
  for (const line of shownOld) {
    lines.push(`  \x1b[31m- ${line}\x1b[0m`)
  }
  if (oldLines.length > maxLines) {
    lines.push(`  \x1b[2m  ... (${oldLines.length - maxLines} more removed)\x1b[0m`)
  }

  // Show added lines (green)
  const shownNew = newLines.slice(0, maxLines)
  for (const line of shownNew) {
    lines.push(`  \x1b[32m+ ${line}\x1b[0m`)
  }
  if (newLines.length > maxLines) {
    lines.push(`  \x1b[2m  ... (${newLines.length - maxLines} more added)\x1b[0m`)
  }

  return lines
}
