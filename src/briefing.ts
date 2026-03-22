/**
 * Daily briefing — morning summary combining calendar, system, and news.
 */

import { getDateTimeInfo, getOutlookEvents, getSystemInfo } from './windows'
import { fetchNews } from './news'
import { IS_WINDOWS } from './platform'

/**
 * Generate a daily briefing with date, calendar, system, and top news.
 */
export async function generateBriefing(): Promise<string> {
  const sections: string[] = []

  // Header
  sections.push('=== BRIEFING DIARIO ===')

  // Date & time
  const dateInfo = await getDateTimeInfo()
  sections.push(dateInfo)

  // Calendar (Windows only, non-blocking)
  if (IS_WINDOWS) {
    try {
      const events = await getOutlookEvents()
      sections.push(`\n--- Agenda ---\n${events}`)
    } catch {
      sections.push('\n--- Agenda ---\nOutlook nao disponivel.')
    }
  }

  // System status
  if (IS_WINDOWS) {
    try {
      const sys = await getSystemInfo()
      sections.push(`\n--- Sistema ---\n${sys}`)
    } catch {
      // Skip system info on error
    }
  }

  // Top news (limited to 3 per source for briefing)
  try {
    const news = await fetchNews(['finance', 'business', 'tech'], 3)
    sections.push(`\n${news}`)
  } catch {
    sections.push('\n--- Noticias ---\nFalha ao carregar noticias.')
  }

  sections.push('\n======================')
  return sections.join('\n')
}
