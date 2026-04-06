/**
 * GWS Calendar — event listing and creation.
 *
 * Wraps gws CLI Calendar commands with caching and typed results.
 * Uses the gws command pattern: gws calendar events <method>
 */

import { executeGws } from './executor'
import { gwsCacheGet, gwsCacheSet } from './cache'
import type { GwsEvent, GwsCreateEventParams, GwsResult } from './types'

// ─── Helpers ────────────────────────────────────────────────

function str(val: unknown, fallback = ''): string {
  if (val === undefined || val === null) return fallback
  return String(val)
}

// ─── Events ─────────────────────────────────────────────────

/**
 * List calendar events (today's events by default).
 */
export async function listCalendarEvents(
  options: { fresh?: boolean } = {},
): Promise<GwsResult<GwsEvent[]>> {
  const cacheKey = 'calendar:events:list'

  if (!options.fresh) {
    const cached = gwsCacheGet<GwsEvent[]>(cacheKey)
    if (cached) {
      return { success: true, data: cached, error: null, raw: '', duration: 0 }
    }
  }

  // Use +agenda helper for today's events
  const now = new Date()
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const endOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1)

  const result = await executeGws<Record<string, unknown>>([
    'calendar', 'events', 'list',
    '--params', JSON.stringify({
      calendarId: 'primary',
      timeMin: startOfDay.toISOString(),
      timeMax: endOfDay.toISOString(),
      singleEvents: true,
      orderBy: 'startTime',
    }),
  ])

  if (!result.success) {
    return result as unknown as GwsResult<GwsEvent[]>
  }

  const items = result.data && typeof result.data === 'object' && 'items' in result.data
    ? (result.data as Record<string, unknown>).items as unknown[]
    : Array.isArray(result.data) ? result.data : []

  const events: GwsEvent[] = (items ?? []).map((raw: unknown) => {
    const r = raw as Record<string, unknown>
    const start = typeof r.start === 'object' && r.start
      ? str((r.start as Record<string, unknown>).dateTime ?? (r.start as Record<string, unknown>).date)
      : str(r.start)
    const end = typeof r.end === 'object' && r.end
      ? str((r.end as Record<string, unknown>).dateTime ?? (r.end as Record<string, unknown>).date)
      : str(r.end)
    const organizer = typeof r.organizer === 'object' && r.organizer
      ? str((r.organizer as Record<string, unknown>).email)
      : str(r.organizer)

    return {
      id: str(r.id),
      summary: str(r.summary, '(no title)'),
      start,
      end,
      location: str(r.location),
      organizer,
      status: str(r.status),
      htmlLink: str(r.htmlLink),
    }
  })

  gwsCacheSet(cacheKey, events, 'calendar')
  return { success: true, data: events, error: null, raw: result.raw, duration: result.duration }
}

/**
 * Create a calendar event.
 */
export async function createCalendarEvent(params: GwsCreateEventParams): Promise<GwsResult<string>> {
  const eventBody: Record<string, unknown> = {
    summary: params.summary,
    start: { dateTime: params.start },
    end: { dateTime: params.end },
  }

  if (params.location) eventBody.location = params.location
  if (params.description) eventBody.description = params.description

  return executeGws<string>([
    'calendar', 'events', 'insert',
    '--params', JSON.stringify({ calendarId: 'primary' }),
    '--json', JSON.stringify(eventBody),
  ])
}

/**
 * Format event list for TUI display.
 */
export function formatCalendarEventList(events: GwsEvent[]): string {
  if (events.length === 0) return 'Nenhum evento encontrado.'

  const lines = ['--- Agenda ---']
  for (const event of events) {
    const start = event.start
      ? new Date(event.start).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
      : '??:??'
    const end = event.end
      ? new Date(event.end).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
      : '??:??'
    const loc = event.location ? ` @ ${event.location}` : ''
    lines.push(`  ${start}-${end} ${event.summary}${loc}`)
  }
  lines.push('-----------------------')
  return lines.join('\n')
}
