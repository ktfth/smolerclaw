// ─── ANSI Escape Helpers ─────────────────────────────────────
const ESC = '\x1b'
const CSI = `${ESC}[`

// Detect NO_COLOR / TERM=dumb for graceful degradation
export const NO_COLOR = !!(process.env.NO_COLOR || process.env.TERM === 'dumb')

function esc(code: string): string {
  return NO_COLOR ? '' : code
}

export const A = {
  altOn:       esc(`${CSI}?1049h`),
  altOff:      esc(`${CSI}?1049l`),
  clear:       `${CSI}2J`,       // always need cursor control
  clearLine:   `${CSI}2K`,
  hide:        `${CSI}?25l`,
  show:        `${CSI}?25h`,
  to:          (r: number, c: number) => `${CSI}${r};${c}H`,
  bold:        esc(`${CSI}1m`),
  dim:         esc(`${CSI}2m`),
  italic:      esc(`${CSI}3m`),
  underline:   esc(`${CSI}4m`),
  reset:       esc(`${CSI}0m`),
  inv:         esc(`${CSI}7m`),
  fg:          (n: number) => esc(`${CSI}38;5;${n}m`),
  bg:          (n: number) => esc(`${CSI}48;5;${n}m`),
}

export { CSI }

// ─── Theme ───────────────────────────────────────────────────
export const C = {
  user:    A.fg(75),
  ai:      A.fg(114),
  tool:    A.fg(215),
  err:     A.fg(196),
  sys:     A.fg(245),
  prompt:  A.fg(220),
  code:    A.fg(180),
  heading: A.fg(75),
  link:    A.fg(39),
  quote:   A.fg(245),
}

// ─── Persona-Aware Theme Palettes ──────────────────────────────
// Dynamic color schemes for Time & Load Balancer

export type PersonaPalette = {
  primary: string
  secondary: string
  accent: string
  muted: string
  header: string
}

/**
 * Weekday productivity theme — intense, focused colors (Cyan/Blue)
 */
export const ProductivityPalette: PersonaPalette = {
  primary: A.fg(75),    // Bright blue
  secondary: A.fg(39),  // Cyan
  accent: A.fg(220),    // Yellow for alerts
  muted: A.fg(245),     // Gray
  header: A.fg(81),     // Light cyan
}

/**
 * Weekend spillover alert theme — warm warning tones
 */
export const SpilloverPalette: PersonaPalette = {
  primary: A.fg(215),   // Orange
  secondary: A.fg(220), // Yellow
  accent: A.fg(196),    // Red for urgency
  muted: A.fg(245),     // Gray
  header: A.fg(214),    // Amber
}

/**
 * Weekend relax theme — soft, calm colors (Magenta pastel/Light green)
 */
export const RelaxPalette: PersonaPalette = {
  primary: A.fg(183),   // Pastel magenta
  secondary: A.fg(157), // Light green
  accent: A.fg(147),    // Soft purple
  muted: A.fg(242),     // Dim gray
  header: A.fg(183),    // Pastel magenta
}

/**
 * Get the appropriate color palette for a persona mode.
 */
export function getPalette(persona: 'productivity' | 'spillover_alert' | 'sharpen_or_relax'): PersonaPalette {
  switch (persona) {
    case 'productivity':
      return ProductivityPalette
    case 'spillover_alert':
      return SpilloverPalette
    case 'sharpen_or_relax':
      return RelaxPalette
  }
}

// ─── Utilities ───────────────────────────────────────────────

export function w(s: string): void {
  process.stdout.write(s)
}

const ANSI_RE = /\x1b\[[0-9;]*[a-zA-Z]/g

export function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, '')
}

/**
 * Get the display width of a character.
 * CJK and emoji occupy 2 columns; most others occupy 1.
 */
export function charWidth(ch: string): number {
  const code = ch.codePointAt(0) || 0
  // CJK Unified Ideographs, CJK Compatibility, Hangul, Fullwidth forms
  if (
    (code >= 0x1100 && code <= 0x115f) ||   // Hangul Jamo
    (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f) || // CJK
    (code >= 0xac00 && code <= 0xd7a3) ||   // Hangul Syllables
    (code >= 0xf900 && code <= 0xfaff) ||   // CJK Compatibility Ideographs
    (code >= 0xfe10 && code <= 0xfe6f) ||   // CJK Compatibility Forms
    (code >= 0xff01 && code <= 0xff60) ||   // Fullwidth
    (code >= 0xffe0 && code <= 0xffe6) ||   // Fullwidth
    (code >= 0x1f300 && code <= 0x1fbff) || // Emoji & misc symbols
    (code >= 0x20000 && code <= 0x2ffff)    // CJK Extension B+
  ) {
    return 2
  }
  return 1
}

/**
 * Get the visible display width of a string (non-ANSI, width-aware).
 */
export function visibleLength(s: string): number {
  const plain = stripAnsi(s)
  let width = 0
  for (const ch of plain) {
    width += charWidth(ch)
  }
  return width
}

/**
 * Get the display width of a string's first N characters.
 */
export function displayWidth(s: string, charCount: number): number {
  let width = 0
  let i = 0
  for (const ch of s) {
    if (i >= charCount) break
    width += charWidth(ch)
    i++
  }
  return width
}

/**
 * Clip a string to a maximum visible width, adding ellipsis if truncated.
 * Strips ANSI codes from the truncated portion for simplicity.
 */
export function clipText(s: string, maxWidth: number): string {
  if (maxWidth < 1) return ''
  if (visibleLength(s) <= maxWidth) return s

  const plain = stripAnsi(s)
  let width = 0
  let i = 0
  for (const ch of plain) {
    const cw = charWidth(ch)
    if (width + cw > maxWidth - 1) break
    width += cw
    i += ch.length
  }

  return plain.slice(0, i) + '…'
}

/**
 * Word-wrap text to maxWidth, preserving ANSI escape codes.
 * Lines are split on word boundaries. Continuation lines get 2-space indent.
 */
export function wrapText(text: string, maxWidth: number): string[] {
  if (maxWidth < 10) maxWidth = 10
  const results: string[] = []

  for (const rawLine of text.split('\n')) {
    const plainLen = visibleLength(rawLine)
    if (plainLen <= maxWidth) {
      results.push(rawLine)
      continue
    }

    // For ANSI-containing lines, we need to track visible position
    // Simple approach: work with plain text for wrapping decisions,
    // but rebuild output by walking the original with ANSI codes
    const plain = stripAnsi(rawLine)
    const words = plain.split(' ')
    const lines: string[] = []
    let current = ''

    for (const word of words) {
      // Hard-break words that exceed maxWidth on their own (URLs, long tokens)
      if (word.length > maxWidth) {
        if (current) {
          lines.push(current)
          current = ''
        }
        let remaining = word
        while (remaining.length > maxWidth) {
          lines.push(remaining.slice(0, maxWidth))
          remaining = remaining.slice(maxWidth)
        }
        if (remaining) {
          current = '  ' + remaining
        }
        continue
      }

      const testLen = current.length + (current ? 1 : 0) + word.length
      if (testLen > maxWidth && current) {
        lines.push(current)
        current = '  ' + word
      } else {
        current += (current ? ' ' : '') + word
      }
    }
    if (current) lines.push(current)

    // If the original had ANSI codes and we're wrapping to plain text,
    // re-apply the dominant ANSI prefix from the original line
    const ansiPrefix = extractAnsiPrefix(rawLine)
    for (let i = 0; i < lines.length; i++) {
      if (ansiPrefix && i === 0) {
        lines[i] = ansiPrefix + lines[i] + A.reset
      } else if (ansiPrefix) {
        lines[i] = ansiPrefix + lines[i] + A.reset
      }
    }

    results.push(...lines)
  }

  return results
}

/**
 * Extract leading ANSI escape sequences from a string.
 */
function extractAnsiPrefix(s: string): string {
  const match = s.match(/^(\x1b\[[0-9;]*[a-zA-Z])+/)
  return match ? match[0] : ''
}
