/**
 * Tool safety layer.
 * Classifies tool calls by risk level and detects dangerous patterns.
 */

export type RiskLevel = 'safe' | 'moderate' | 'dangerous'

interface ToolRisk {
  level: RiskLevel
  reason?: string
}

// Dangerous command patterns (case-insensitive)
const DANGEROUS_COMMANDS = [
  /\brm\s+(-rf?|--recursive)/i,
  /\brmdir\s/i,
  /\bdel\s+\/[sS]/i,           // Windows: del /S
  /\bRemove-Item\s.*-Recurse/i, // PowerShell
  /\bformat\s+[a-z]:/i,         // Windows: format C:
  /\bgit\s+(push\s+--force|reset\s+--hard|clean\s+-fd)/i,
  /\bdrop\s+(table|database)/i,
  /\btruncate\s+table/i,
  /\bchmod\s+777/i,
  /\bchown\s+-R/i,
  /\bcurl\s.*\|\s*(bash|sh)/i,  // Pipe to shell
  /\bwget\s.*\|\s*(bash|sh)/i,
  /\bnpm\s+publish/i,
  /\bsudo\s/i,
  /\bkill\s+-9/i,
  /\bshutdown/i,
  /\breboot/i,
]

// Patterns that indicate elevated risk but are common
const MODERATE_COMMANDS = [
  /\bgit\s+push/i,
  /\bgit\s+commit/i,
  /\bnpm\s+install/i,
  /\bbun\s+(install|add)/i,
  /\bpip\s+install/i,
  /\bcargo\s+install/i,
  /\bmkdir\s+-p/i,
]

/**
 * Assess risk level of a tool call.
 */
export function assessToolRisk(name: string, input: Record<string, unknown>): ToolRisk {
  switch (name) {
    case 'read_file':
    case 'list_directory':
    case 'find_files':
    case 'search_files':
    case 'fetch_url':
    case 'read_clipboard_content':
    case 'analyze_screen_context':
    case 'memory_status':
    case 'recall_memory':
      return { level: 'safe' }

    case 'write_file':
      return { level: 'moderate', reason: `write ${input.path}` }

    case 'edit_file':
      return { level: 'moderate', reason: `edit ${input.path}` }

    case 'run_command': {
      const cmd = String(input.command || '')

      // Check dangerous patterns first
      for (const pattern of DANGEROUS_COMMANDS) {
        if (pattern.test(cmd)) {
          return { level: 'dangerous', reason: cmd }
        }
      }

      // Check moderate patterns
      for (const pattern of MODERATE_COMMANDS) {
        if (pattern.test(cmd)) {
          return { level: 'moderate', reason: cmd }
        }
      }

      return { level: 'moderate', reason: cmd }
    }

    case 'execute_powershell_script':
      return { level: 'dangerous', reason: `PowerShell script execution` }

    default:
      return { level: 'moderate', reason: `unknown tool: ${name}` }
  }
}

/**
 * Format a risk assessment for display.
 */
export function formatRisk(risk: ToolRisk): string {
  switch (risk.level) {
    case 'safe':
      return ''
    case 'moderate':
      return risk.reason || 'modification'
    case 'dangerous':
      return `DANGEROUS: ${risk.reason}`
  }
}
