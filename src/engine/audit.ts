import { appendFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

export interface AuditRecord {
  ts: string
  tool: string
  inputHash: string
  decision: 'executed' | 'denied' | 'invalid' | 'unknown'
  risk: string
  ok: boolean
  durationMs: number
  error?: string
}

export interface AuditSink {
  write(record: AuditRecord): void
}

/**
 * Append-only JSONL audit log, one file per UTC day.
 * Stores the input hash, never the raw input, so secrets in arguments
 * do not leak into the log.
 */
export function createFileAuditSink(dir: string): AuditSink {
  return {
    write(record: AuditRecord): void {
      try {
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
        const file = join(dir, `engine-${record.ts.slice(0, 10)}.jsonl`)
        appendFileSync(file, JSON.stringify(record) + '\n')
      } catch (err) {
        // Auditing must never break tool execution; report and continue.
        process.stderr.write(`smolerclaw: audit write failed: ${err instanceof Error ? err.message : String(err)}\n`)
      }
    },
  }
}

export const NULL_AUDIT_SINK: AuditSink = { write: () => {} }
