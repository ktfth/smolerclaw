import { A, C, wrapText, visibleLength } from './ansi'

/**
 * Render markdown text to ANSI-formatted terminal lines.
 * Handles: headers, bold, italic, inline code, code blocks,
 * bullet/numbered lists, blockquotes, and links.
 *
 * @param width - Terminal width for wrapping. Defaults to stdout columns.
 */
export function renderMarkdown(text: string, width?: number): string[] {
  const termWidth = width ?? (process.stdout.columns || 80)
  const lines = text.split('\n')
  const output: string[] = []
  let inCodeBlock = false
  let codeLang = ''

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]

    // ── Code block toggle ──
    if (line.trimStart().startsWith('```')) {
      if (!inCodeBlock) {
        inCodeBlock = true
        codeLang = line.trimStart().slice(3).trim()
        const label = codeLang ? ` ${codeLang}` : ''
        output.push(`  ${A.dim}┌──${label}${'─'.repeat(Math.max(1, 40 - label.length))}${A.reset}`)
      } else {
        inCodeBlock = false
        codeLang = ''
        output.push(`  ${A.dim}└${'─'.repeat(42)}${A.reset}`)
      }
      continue
    }

    // ── Inside code block ──
    if (inCodeBlock) {
      output.push(`  ${A.dim}│${A.reset} ${C.code}${line}${A.reset}`)
      continue
    }

    // ── Blank line ──
    if (!line.trim()) {
      output.push('')
      continue
    }

    // ── Headers ──
    const headerMatch = line.match(/^(#{1,3})\s+(.+)/)
    if (headerMatch) {
      const level = headerMatch[1].length
      const text = headerMatch[2]
      const prefix = level === 1 ? '━' : level === 2 ? '─' : '·'
      output.push(`  ${C.heading}${A.bold}${prefix} ${renderInline(text)}${A.reset}`)
      continue
    }

    // ── Blockquote ──
    if (line.trimStart().startsWith('>')) {
      const content = line.replace(/^\s*>\s?/, '')
      pushWrapped(output, `  ${C.quote}│ ${renderInline(content)}${A.reset}`, termWidth)
      continue
    }

    // ── Bullet list ──
    const bulletMatch = line.match(/^(\s*)([-*+])\s+(.+)/)
    if (bulletMatch) {
      const indent = Math.floor(bulletMatch[1].length / 2)
      const content = bulletMatch[3]
      const pad = '  '.repeat(indent)
      pushWrapped(output, `  ${pad}${A.dim}•${A.reset} ${renderInline(content)}`, termWidth)
      continue
    }

    // ── Numbered list ──
    const numMatch = line.match(/^(\s*)(\d+)[.)]\s+(.+)/)
    if (numMatch) {
      const indent = Math.floor(numMatch[1].length / 2)
      const num = numMatch[2]
      const content = numMatch[3]
      const pad = '  '.repeat(indent)
      pushWrapped(output, `  ${pad}${A.dim}${num}.${A.reset} ${renderInline(content)}`, termWidth)
      continue
    }

    // ── Horizontal rule ──
    if (/^[-*_]{3,}\s*$/.test(line.trim())) {
      output.push(`  ${A.dim}${'─'.repeat(40)}${A.reset}`)
      continue
    }

    // ── Regular paragraph line ──
    const rendered = `  ${renderInline(line)}`
    if (visibleLength(rendered) > termWidth) {
      for (const wl of wrapText(rendered, termWidth)) {
        output.push(wl)
      }
    } else {
      output.push(rendered)
    }
  }

  // Close unclosed code block
  if (inCodeBlock) {
    output.push(`  ${A.dim}└${'─'.repeat(42)}${A.reset}`)
  }

  return output
}

/**
 * Push a line to output, wrapping if it exceeds terminal width.
 */
function pushWrapped(output: string[], line: string, maxWidth: number): void {
  if (visibleLength(line) > maxWidth) {
    for (const wl of wrapText(line, maxWidth)) {
      output.push(wl)
    }
  } else {
    output.push(line)
  }
}

/**
 * Apply inline markdown formatting (bold, italic, code, links).
 */
function renderInline(text: string): string {
  let result = text

  // Inline code (must come before bold/italic to avoid conflicts)
  result = result.replace(/`([^`]+)`/g, `${A.inv} $1 ${A.reset}`)

  // Bold + italic
  result = result.replace(/\*\*\*(.+?)\*\*\*/g, `${A.bold}${A.italic}$1${A.reset}`)

  // Bold
  result = result.replace(/\*\*(.+?)\*\*/g, `${A.bold}$1${A.reset}`)
  result = result.replace(/__(.+?)__/g, `${A.bold}$1${A.reset}`)

  // Italic
  result = result.replace(/\*(.+?)\*/g, `${A.italic}$1${A.reset}`)
  result = result.replace(/_(.+?)_/g, `${A.italic}$1${A.reset}`)

  // Links [text](url)
  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g,
    `${A.underline}$1${A.reset} ${C.link}($2)${A.reset}`)

  return result
}
