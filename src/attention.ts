/**
 * Attention Manager — intelligent notification triage and focus protection.
 *
 * Filters, prioritizes, and queues notifications based on context:
 * - Focus mode (blocks low-priority interruptions)
 * - Time-aware (quieter at night, during breaks)
 * - Priority classification (urgente, importante, informativo, ruido)
 * - End-of-day digest generation
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { atomicWriteFile } from './vault'
import { getEnergyState, type EnergyLevel } from './energy'

// ─── Types ──────────────────────────────────────────────────

export type Priority = 'urgente' | 'importante' | 'informativo' | 'ruido'
export type FocusMode = 'desligado' | 'leve' | 'profundo' | 'nao_perturbe'

export interface Notification {
  id: string
  source: string            // module that emitted it (e.g., 'tasks', 'news', 'monitor')
  title: string
  body: string
  priority: Priority
  timestamp: number
  delivered: boolean         // shown to user
  dismissed: boolean
  snoozedUntil?: number     // timestamp
}

export interface DailyDigest {
  date: string
  sessionDurationMin: number
  interactions: number
  breaksTaken: number
  avgEnergy: number
  tasksCompleted: number
  tasksPending: number
  notificationsReceived: number
  notificationsBlocked: number
  topEvents: string[]
  suggestion: string
}

interface AttentionData {
  focusMode: FocusMode
  focusUntil: number | null   // auto-expire timestamp
  notifications: Notification[]
  dailyDigests: DailyDigest[]
  blockedToday: number
}

// ─── Constants ──────────────────────────────────────────────

const MAX_NOTIFICATIONS = 200
const MAX_DIGESTS = 30
const QUIET_HOURS_START = 22
const QUIET_HOURS_END = 7

// Priority thresholds per focus mode (which priorities get through)
const FOCUS_FILTERS: Record<FocusMode, Priority[]> = {
  desligado: ['urgente', 'importante', 'informativo', 'ruido'],
  leve: ['urgente', 'importante', 'informativo'],
  profundo: ['urgente', 'importante'],
  nao_perturbe: ['urgente'],
}

// ─── Storage ────────────────────────────────────────────────

let _dataDir = ''
let _data: AttentionData = {
  focusMode: 'desligado',
  focusUntil: null,
  notifications: [],
  dailyDigests: [],
  blockedToday: 0,
}
let _notifyCallback: ((msg: string) => void) | null = null
let _lastDigestDate = ''

const DATA_FILE = () => join(_dataDir, 'attention.json')

function save(): void {
  atomicWriteFile(DATA_FILE(), JSON.stringify({
    focusMode: _data.focusMode,
    focusUntil: _data.focusUntil,
    dailyDigests: _data.dailyDigests,
    blockedToday: _data.blockedToday,
  }, null, 2))
}

function load(): void {
  const file = DATA_FILE()
  if (!existsSync(file)) return
  try {
    const raw = JSON.parse(readFileSync(file, 'utf-8'))
    _data = {
      ..._data,
      focusMode: raw.focusMode ?? 'desligado',
      focusUntil: raw.focusUntil ?? null,
      dailyDigests: raw.dailyDigests ?? [],
      blockedToday: raw.blockedToday ?? 0,
    }
  } catch { /* keep defaults */ }
}

// ─── Init ───────────────────────────────────────────────────

export function initAttention(dataDir: string, onNotify?: (msg: string) => void): void {
  _dataDir = dataDir
  _notifyCallback = onNotify ?? null
  load()

  // Reset daily counter if new day
  const today = new Date().toISOString().split('T')[0]
  if (_lastDigestDate !== today) {
    _data = { ..._data, blockedToday: 0 }
    _lastDigestDate = today
  }

  // Check if focus mode expired
  if (_data.focusUntil && Date.now() > _data.focusUntil) {
    _data = { ..._data, focusMode: 'desligado', focusUntil: null }
    save()
  }
}

// ─── Focus Mode ─────────────────────────────────────────────

export function setFocusMode(mode: FocusMode, durationMin?: number): string {
  const until = durationMin ? Date.now() + durationMin * 60000 : null
  _data = { ..._data, focusMode: mode, focusUntil: until }
  save()

  const labels: Record<FocusMode, string> = {
    desligado: 'Desligado — todas as notificacoes ativas',
    leve: 'Leve — ruido filtrado',
    profundo: 'Profundo — so urgente e importante',
    nao_perturbe: 'Nao Perturbe — so urgencias',
  }

  const duration = durationMin ? ` por ${durationMin} minutos` : ''
  return `Foco: ${labels[mode]}${duration}`
}

export function getFocusMode(): FocusMode {
  // Auto-expire
  if (_data.focusUntil && Date.now() > _data.focusUntil) {
    _data = { ..._data, focusMode: 'desligado', focusUntil: null }
    save()
  }
  return _data.focusMode
}

// ─── Notification Triage ────────────────────────────────────

export function classifyPriority(source: string, title: string, body: string): Priority {
  const text = `${title} ${body}`.toLowerCase()

  // Urgente: deadlines, errors, security
  if (text.includes('erro') || text.includes('falha') || text.includes('crash') ||
      text.includes('urgente') || text.includes('agora') || text.includes('critico') ||
      text.includes('expirou') || text.includes('venceu')) {
    return 'urgente'
  }

  // Importante: tasks due, follow-ups, meetings
  if (source === 'tasks' || source === 'calendar' || source === 'delegation' ||
      text.includes('reuniao') || text.includes('prazo') || text.includes('lembrete') ||
      text.includes('follow-up') || text.includes('atrasado')) {
    return 'importante'
  }

  // Informativo: news, status updates, completions
  if (source === 'news' || source === 'projects' || source === 'monitor' ||
      text.includes('concluido') || text.includes('atualizado')) {
    return 'informativo'
  }

  // Default: ruido
  return 'ruido'
}

export function pushNotification(
  source: string,
  title: string,
  body: string,
  priorityOverride?: Priority,
): { delivered: boolean; reason: string } {
  const priority = priorityOverride ?? classifyPriority(source, title, body)
  const now = Date.now()

  const notification: Notification = {
    id: `n_${now}_${Math.random().toString(36).slice(2, 6)}`,
    source,
    title,
    body,
    priority,
    timestamp: now,
    delivered: false,
    dismissed: false,
  }

  // Check focus mode filter
  const focus = getFocusMode()
  const allowed = FOCUS_FILTERS[focus]
  if (!allowed.includes(priority)) {
    _data = {
      ..._data,
      notifications: [..._data.notifications.slice(-MAX_NOTIFICATIONS), { ...notification, delivered: false }],
      blockedToday: _data.blockedToday + 1,
    }
    return { delivered: false, reason: `Bloqueado pelo modo foco (${focus}). Prioridade: ${priority}` }
  }

  // Check quiet hours
  const hour = new Date().getHours()
  if ((hour >= QUIET_HOURS_START || hour < QUIET_HOURS_END) && priority !== 'urgente') {
    _data = {
      ..._data,
      notifications: [..._data.notifications.slice(-MAX_NOTIFICATIONS), { ...notification, delivered: false }],
      blockedToday: _data.blockedToday + 1,
    }
    return { delivered: false, reason: 'Bloqueado por horario de silencio (22h-7h).' }
  }

  // Check energy level — if critical, only deliver urgent
  try {
    const energy = getEnergyState()
    if (energy.level === 'critico' && priority !== 'urgente') {
      _data = {
        ..._data,
        notifications: [..._data.notifications.slice(-MAX_NOTIFICATIONS), { ...notification, delivered: false }],
        blockedToday: _data.blockedToday + 1,
      }
      return { delivered: false, reason: 'Bloqueado por energia critica. Descanse primeiro.' }
    }
  } catch { /* energy not initialized yet */ }

  // Deliver
  const delivered = { ...notification, delivered: true }
  _data = {
    ..._data,
    notifications: [..._data.notifications.slice(-MAX_NOTIFICATIONS), delivered],
  }

  // Fire callback
  if (_notifyCallback) {
    const icon = priority === 'urgente' ? '🔴' : priority === 'importante' ? '🟡' : 'ℹ️'
    _notifyCallback(`${icon} [${source}] ${title}`)
  }

  return { delivered: true, reason: `Entregue (${priority})` }
}

// ─── Queries ────────────────────────────────────────────────

export function getPendingNotifications(): Notification[] {
  return _data.notifications.filter((n) => n.delivered && !n.dismissed)
}

export function dismissNotification(id: string): boolean {
  const found = _data.notifications.find((n) => n.id === id)
  if (!found) return false
  _data = {
    ..._data,
    notifications: _data.notifications.map((n) =>
      n.id === id ? { ...n, dismissed: true } : n,
    ),
  }
  return true
}

export function dismissAll(): number {
  const pending = getPendingNotifications()
  _data = {
    ..._data,
    notifications: _data.notifications.map((n) =>
      n.delivered && !n.dismissed ? { ...n, dismissed: true } : n,
    ),
  }
  return pending.length
}

export function getAttentionStats(): {
  focusMode: FocusMode
  pending: number
  blockedToday: number
  totalToday: number
} {
  const today = new Date().toISOString().split('T')[0]
  const todayNotifications = _data.notifications.filter(
    (n) => new Date(n.timestamp).toISOString().split('T')[0] === today,
  )
  return {
    focusMode: getFocusMode(),
    pending: getPendingNotifications().length,
    blockedToday: _data.blockedToday,
    totalToday: todayNotifications.length,
  }
}

// ─── Daily Digest ───────────────────────────────────────────

export function generateDailyDigest(
  tasksCompleted: number,
  tasksPending: number,
  sessionDurationMin: number,
  interactions: number,
  breaksTaken: number,
  avgEnergy: number,
): DailyDigest {
  const today = new Date().toISOString().split('T')[0]
  const todayNotifications = _data.notifications.filter(
    (n) => new Date(n.timestamp).toISOString().split('T')[0] === today,
  )

  // Top events (most important delivered notifications)
  const topEvents = todayNotifications
    .filter((n) => n.delivered && n.priority !== 'ruido')
    .sort((a, b) => {
      const order: Record<Priority, number> = { urgente: 0, importante: 1, informativo: 2, ruido: 3 }
      return order[a.priority] - order[b.priority]
    })
    .slice(0, 5)
    .map((n) => `[${n.priority}] ${n.title}`)

  // Generate suggestion based on day patterns
  let suggestion = 'Bom trabalho hoje.'
  if (breaksTaken === 0 && sessionDurationMin > 60) {
    suggestion = 'Voce nao fez nenhuma pausa hoje. Tente incorporar pausas de 5 min a cada 45 min.'
  } else if (avgEnergy < 40) {
    suggestion = 'Energia media baixa hoje. Considere dormir mais cedo ou ajustar sua rotina.'
  } else if (tasksCompleted > 5) {
    suggestion = 'Dia altamente produtivo! Descanse bem para manter o ritmo.'
  } else if (tasksPending > 10) {
    suggestion = `${tasksPending} tarefas pendentes. Considere priorizar ou delegar amanha.`
  }

  const digest: DailyDigest = {
    date: today,
    sessionDurationMin,
    interactions,
    breaksTaken,
    avgEnergy,
    tasksCompleted,
    tasksPending,
    notificationsReceived: todayNotifications.length,
    notificationsBlocked: _data.blockedToday,
    topEvents,
    suggestion,
  }

  _data = {
    ..._data,
    dailyDigests: [..._data.dailyDigests.slice(-MAX_DIGESTS), digest],
  }
  save()

  return digest
}

export function formatDigest(digest: DailyDigest): string {
  const lines = [
    `# Resumo do Dia — ${digest.date}`,
    '',
    '## Produtividade',
    `  Sessao: ${digest.sessionDurationMin} min | Interacoes: ${digest.interactions}`,
    `  Pausas: ${digest.breaksTaken} | Energia media: ${digest.avgEnergy}/100`,
    '',
    '## Tarefas',
    `  Concluidas: ${digest.tasksCompleted} | Pendentes: ${digest.tasksPending}`,
    '',
    '## Notificacoes',
    `  Recebidas: ${digest.notificationsReceived} | Bloqueadas: ${digest.notificationsBlocked}`,
  ]

  if (digest.topEvents.length > 0) {
    lines.push('')
    lines.push('## Eventos Principais')
    for (const evt of digest.topEvents) {
      lines.push(`  • ${evt}`)
    }
  }

  lines.push('')
  lines.push(`💡 ${digest.suggestion}`)

  return lines.join('\n')
}

export function formatAttentionStatus(): string {
  const stats = getAttentionStats()
  const focusLabels: Record<FocusMode, string> = {
    desligado: 'Desligado',
    leve: 'Leve',
    profundo: 'Profundo',
    nao_perturbe: 'Nao Perturbe',
  }

  const remaining = _data.focusUntil
    ? ` (${Math.max(0, Math.round((_data.focusUntil - Date.now()) / 60000))} min restantes)`
    : ''

  return [
    `Modo foco: ${focusLabels[stats.focusMode]}${remaining}`,
    `Pendentes: ${stats.pending} | Bloqueadas hoje: ${stats.blockedToday} | Total hoje: ${stats.totalToday}`,
  ].join('\n')
}
