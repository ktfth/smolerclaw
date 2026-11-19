/**
 * Email draft system — generate drafts and open in Outlook.
 * Uses mailto: URI for cross-platform or Outlook COM on Windows.
 */

import { IS_WINDOWS } from './platform'
import { psSingleQuoteEscape } from './utils/windows-executor'
import { ok, fail, type ToolResult } from './core/result'

export interface EmailDraft {
  to: string
  subject: string
  body: string
  cc?: string
}

/**
 * Open an email draft in the default mail client.
 * On Windows, tries Outlook COM first, then falls back to mailto:.
 */
export async function openEmailDraft(draft: EmailDraft): Promise<ToolResult> {
  if (IS_WINDOWS) {
    return openInOutlook(draft)
  }
  return openMailto(draft)
}

/**
 * Open draft via Outlook COM (Windows only).
 * Creates a new mail item with fields pre-filled.
 */
async function openInOutlook(draft: EmailDraft): Promise<ToolResult> {
  // Single-quoted PowerShell literals: escaping covers ASCII and typographic
  // quotes, and real newlines are kept as-is (single quotes span lines).
  const to = psSingleQuoteEscape(draft.to)
  const subject = psSingleQuoteEscape(draft.subject)
  const body = psSingleQuoteEscape(draft.body)
  const cc = draft.cc ? psSingleQuoteEscape(draft.cc) : ''

  const cmd = [
    'try {',
    '  $outlook = New-Object -ComObject Outlook.Application -ErrorAction Stop',
    '  $mail = $outlook.CreateItem(0)',  // olMailItem = 0
    `  $mail.To = '${to}'`,
    `  $mail.Subject = '${subject}'`,
    `  $mail.Body = '${body}'`,
    cc ? `  $mail.CC = '${cc}'` : '',
    '  $mail.Display()',
    '  "Email aberto no Outlook."',
    '} catch {',
    '  "Outlook nao disponivel. Usando mailto..."',
    '}',
  ].filter(Boolean).join('\n')

  try {
    const proc = Bun.spawn(
      ['powershell', '-NoProfile', '-NonInteractive', '-Command', cmd],
      { stdout: 'pipe', stderr: 'pipe' },
    )
    const timer = setTimeout(() => proc.kill(), 15_000)
    const [stdout] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])
    await proc.exited
    clearTimeout(timer)

    const result = stdout.trim()

    // If Outlook failed, fall back to mailto
    if (result.includes('mailto')) {
      return openMailto(draft)
    }

    return ok(result || 'Email aberto no Outlook.')
  } catch {
    return openMailto(draft)
  }
}

/**
 * Open draft via mailto: URI (cross-platform fallback).
 */
async function openMailto(draft: EmailDraft): Promise<ToolResult> {
  const params: string[] = []
  if (draft.subject) params.push(`subject=${encodeURIComponent(draft.subject)}`)
  if (draft.body) params.push(`body=${encodeURIComponent(draft.body)}`)
  if (draft.cc) params.push(`cc=${encodeURIComponent(draft.cc)}`)

  const mailto = `mailto:${encodeURIComponent(draft.to)}${params.length ? '?' + params.join('&') : ''}`

  try {
    const openCmd = IS_WINDOWS
      ? ['powershell', '-NoProfile', '-NonInteractive', '-Command', `Start-Process '${psSingleQuoteEscape(mailto)}'`]
      : ['xdg-open', mailto]

    const proc = Bun.spawn(openCmd, { stdout: 'pipe', stderr: 'pipe' })
    const timer = setTimeout(() => proc.kill(), 10_000)
    await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])
    await proc.exited
    clearTimeout(timer)

    return ok('Email aberto no cliente de email padrão.')
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err))
  }
}

/**
 * Format a draft for preview in the TUI.
 */
export function formatDraftPreview(draft: EmailDraft): string {
  const lines = [
    '--- Rascunho de Email ---',
    `Para: ${draft.to}`,
  ]
  if (draft.cc) lines.push(`CC: ${draft.cc}`)
  lines.push(`Assunto: ${draft.subject}`)
  lines.push('')
  lines.push(draft.body)
  lines.push('------------------------')
  return lines.join('\n')
}
