/**
 * Tool safety layer.
 * Classifies tool calls by risk level and detects dangerous patterns.
 * Includes secret detection, protected paths, and rate limiting.
 */

export type RiskLevel = 'safe' | 'moderate' | 'dangerous'

interface ToolRisk {
  level: RiskLevel
  reason?: string
}

// ─── Secret Detection ─────────────────────────────────────────

const SECRET_PATTERNS = [
  /OPENAI_API_KEY\s*=/i,
  /AWS_SECRET_ACCESS_KEY\s*=/i,
  /AWS_SESSION_TOKEN\s*=/i,
  /GITHUB_TOKEN\s*=/i,
  /GH_TOKEN\s*=/i,
  /SLACK_TOKEN\s*=/i,
  /SLACK_BOT_TOKEN\s*=/i,
  /DATABASE_URL\s*=.*:\/\/.+:.+@/i,
  /REDIS_URL\s*=.*:\/\/.+:.+@/i,
  /password\s*=\s*["'][^"']{4,}["']/i,
  /secret\s*=\s*["'][^"']{4,}["']/i,
  /Bearer\s+[A-Za-z0-9\-._~+\/]{20,}/i,
  /sk-[A-Za-z0-9]{20,}/,                 // OpenAI-style key
  /ghp_[A-Za-z0-9]{36,}/,                // GitHub PAT
  /xoxb-[0-9]{10,}/,                     // Slack bot token
]

/**
 * Check if a string contains embedded secrets.
 * Returns the matched pattern name or null.
 */
export function detectSecrets(text: string): string | null {
  for (const pattern of SECRET_PATTERNS) {
    if (pattern.test(text)) {
      return pattern.source.split(/[\\(]/)[0].replace(/\s\*/g, '').slice(0, 30)
    }
  }
  return null
}

// ─── Protected Paths ──────────────────────────────────────────

const PROTECTED_PATHS_WINDOWS = [
  /^[A-Z]:\\Windows\\System32/i,
  /^[A-Z]:\\Windows\\SysWOW64/i,
  /^[A-Z]:\\Program Files/i,
  /^[A-Z]:\\ProgramData/i,
  /\\\.ssh\\/i,
  /\\\.gnupg\\/i,
]

const PROTECTED_PATHS_UNIX = [
  /^\/etc\//,
  /^\/usr\/bin\//,
  /^\/usr\/sbin\//,
  /^\/var\/log\//,
  /^\/root\//,
  /\/\.ssh\//,
  /\/\.gnupg\//,
]

/**
 * Check if a path targets a protected system location.
 */
export function isProtectedPath(filePath: string): boolean {
  const patterns = process.platform === 'win32' ? PROTECTED_PATHS_WINDOWS : PROTECTED_PATHS_UNIX
  return patterns.some((p) => p.test(filePath))
}

// ─── Rate Limiting ────────────────────────────────────────────

interface RateWindow {
  count: number
  windowStart: number
}

const RATE_LIMITS: Record<string, { max: number; windowMs: number }> = {
  write_file: { max: 100, windowMs: 60_000 },
  run_command: { max: 50, windowMs: 60_000 },
  execute_powershell_script: { max: 10, windowMs: 60_000 },
  fetch_url: { max: 30, windowMs: 60_000 },
}

const _rateWindows = new Map<string, RateWindow>()

/**
 * Check if a tool call exceeds its rate limit.
 * Returns true if the call should be allowed.
 */
export function checkRateLimit(toolName: string): boolean {
  const limit = RATE_LIMITS[toolName]
  if (!limit) return true

  const now = Date.now()
  const window = _rateWindows.get(toolName)

  if (!window || now - window.windowStart > limit.windowMs) {
    _rateWindows.set(toolName, { count: 1, windowStart: now })
    return true
  }

  window.count++
  return window.count <= limit.max
}

/** Reset all rate limit windows (for testing). */
export function resetRateLimits(): void {
  _rateWindows.clear()
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

    case 'write_file': {
      const path = String(input.path || '')
      if (isProtectedPath(path)) {
        return { level: 'dangerous', reason: `write to protected path: ${path}` }
      }
      const content = String(input.content || '')
      const secret = detectSecrets(content)
      if (secret) {
        return { level: 'dangerous', reason: `content contains potential secret: ${secret}` }
      }
      return { level: 'moderate', reason: `write ${path}` }
    }

    case 'edit_file': {
      const editPath = String(input.path || '')
      if (isProtectedPath(editPath)) {
        return { level: 'dangerous', reason: `edit protected path: ${editPath}` }
      }
      const newText = String(input.new_text || '')
      const editSecret = detectSecrets(newText)
      if (editSecret) {
        return { level: 'dangerous', reason: `new_text contains potential secret: ${editSecret}` }
      }
      return { level: 'moderate', reason: `edit ${editPath}` }
    }

    case 'run_command': {
      const cmd = String(input.command || '')

      // Check for embedded secrets in commands
      const cmdSecret = detectSecrets(cmd)
      if (cmdSecret) {
        return { level: 'dangerous', reason: `command contains potential secret: ${cmdSecret}` }
      }

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
