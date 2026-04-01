/**
 * Shared utility functions for tool implementations.
 */
import { parseTime } from '../tasks'

const MAX_OUTPUT = 50_000

export { MAX_OUTPUT }

export function truncate(s: string): string {
  if (s.length <= MAX_OUTPUT) return s
  return s.slice(0, MAX_OUTPUT) + '\n... (output truncated)'
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}K`
  return `${(bytes / (1024 * 1024)).toFixed(1)}M`
}

/**
 * Parse fuzzy date strings: "amanha", "em 3 dias", "sexta", "28/03", etc.
 */
export function parseFuzzyDate(input: string): Date | null {
  const text = input.toLowerCase().trim()
  const now = new Date()

  if (text === 'hoje') return now

  if (text === 'amanha' || text === 'amanhã') {
    const d = new Date(now)
    d.setDate(d.getDate() + 1)
    return d
  }

  // "em X dias"
  const daysMatch = text.match(/em\s+(\d+)\s*dias?/)
  if (daysMatch) {
    const d = new Date(now)
    d.setDate(d.getDate() + parseInt(daysMatch[1]))
    return d
  }

  // "em X semanas"
  const weeksMatch = text.match(/em\s+(\d+)\s*semanas?/)
  if (weeksMatch) {
    const d = new Date(now)
    d.setDate(d.getDate() + parseInt(weeksMatch[1]) * 7)
    return d
  }

  // Day of week: "segunda", "terca", "quarta", "quinta", "sexta", "sabado", "domingo"
  const weekdays: Record<string, number> = {
    domingo: 0, segunda: 1, terca: 2, terça: 2, quarta: 3,
    quinta: 4, sexta: 5, sabado: 6, sábado: 6,
  }
  for (const [name, dayNum] of Object.entries(weekdays)) {
    if (text.includes(name)) {
      const d = new Date(now)
      const diff = (dayNum - d.getDay() + 7) % 7 || 7
      d.setDate(d.getDate() + diff)
      return d
    }
  }

  // "DD/MM" or "DD/MM/YYYY"
  const dateMatch = text.match(/(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\s*/)
  if (dateMatch) {
    const day = parseInt(dateMatch[1])
    const month = parseInt(dateMatch[2]) - 1
    const year = dateMatch[3]
      ? parseInt(dateMatch[3]) + (dateMatch[3].length === 2 ? 2000 : 0)
      : now.getFullYear()
    const d = new Date(year, month, day)
    if (!isNaN(d.getTime())) return d
  }

  // Try parseTime from tasks (handles "18h", "em 30 min", etc.)
  return parseTime(text)
}
