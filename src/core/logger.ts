/**
 * Structured logger with levels.
 * Writes to stderr so it doesn't interfere with TUI output.
 * Controlled by LOG_LEVEL env var: debug, info, warn, error (default: warn).
 */

type LogLevel = 'debug' | 'info' | 'warn' | 'error'

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
}

function getMinLevel(): LogLevel {
  const env = process.env.LOG_LEVEL?.toLowerCase()
  if (env && env in LEVEL_ORDER) return env as LogLevel
  if (process.env.DEBUG) return 'debug'
  return 'warn'
}

function shouldLog(level: LogLevel): boolean {
  return LEVEL_ORDER[level] >= LEVEL_ORDER[getMinLevel()]
}

function formatEntry(level: LogLevel, msg: string, ctx?: Record<string, unknown>): string {
  const ts = new Date().toISOString()
  const base = `[${ts}] ${level.toUpperCase()} ${msg}`
  if (ctx && Object.keys(ctx).length > 0) {
    const details = Object.entries(ctx)
      .map(([k, v]) => `${k}=${v instanceof Error ? v.message : JSON.stringify(v)}`)
      .join(' ')
    return `${base} | ${details}`
  }
  return base
}

function log(level: LogLevel, msg: string, ctx?: Record<string, unknown>): void {
  if (!shouldLog(level)) return
  const entry = formatEntry(level, msg, ctx)
  process.stderr.write(entry + '\n')
}

export const logger = {
  debug: (msg: string, ctx?: Record<string, unknown>) => log('debug', msg, ctx),
  info: (msg: string, ctx?: Record<string, unknown>) => log('info', msg, ctx),
  warn: (msg: string, ctx?: Record<string, unknown>) => log('warn', msg, ctx),
  error: (msg: string, ctx?: Record<string, unknown>) => log('error', msg, ctx),
}
