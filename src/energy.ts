/**
 * Energy Engine — cognitive load tracking and fatigue detection.
 *
 * Monitors session duration, interaction patterns, time-of-day,
 * and produces energy scores with smart break recommendations.
 * Learns work patterns over time to optimize suggestions.
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { atomicWriteFile } from './vault'

// ─── Types ──────────────────────────────────────────────────

export type EnergyLevel = 'alto' | 'medio' | 'baixo' | 'critico'
export type WorkPhase = 'aquecimento' | 'pico' | 'sustentado' | 'declinio' | 'esgotado'

export interface EnergyState {
  level: EnergyLevel
  score: number              // 0-100
  phase: WorkPhase
  sessionStartedAt: number
  sessionDurationMin: number
  interactionCount: number
  lastInteractionAt: number
  lastBreakAt: number
  breaksTaken: number
  currentStreak: number      // minutes without break
  suggestion: string
}

export interface WorkBlock {
  date: string               // YYYY-MM-DD
  startHour: number
  endHour: number
  durationMin: number
  interactions: number
  breaks: number
  avgEnergy: number
  peakHour: number
}

export interface EnergyProfile {
  bestHours: number[]        // hours where user is most productive
  avgSessionMin: number
  avgBreakInterval: number   // typical minutes between breaks
  totalSessions: number
  weekdayPattern: Record<string, number> // day -> avg energy
}

interface EnergyData {
  history: WorkBlock[]
  profile: EnergyProfile
}

// ─── Constants ──────────────────────────────────────────────

const BREAK_INTERVAL_MS = 45 * 60 * 1000      // suggest break every 45 min
const SHORT_BREAK_MIN = 5
const LONG_BREAK_MIN = 15
const LONG_BREAK_THRESHOLD = 3                  // after 3 short breaks, suggest long
const FATIGUE_THRESHOLD_MIN = 120               // 2h continuous = fatigue warning
const CRITICAL_THRESHOLD_MIN = 180              // 3h continuous = critical
const MAX_HISTORY_DAYS = 90

// ─── Time-of-day energy curve (circadian baseline) ──────────
// Based on typical cognitive performance research
const CIRCADIAN_CURVE: Record<number, number> = {
  0: 20, 1: 15, 2: 10, 3: 10, 4: 15, 5: 20,
  6: 35, 7: 50, 8: 65, 9: 80, 10: 90, 11: 85,
  12: 60, 13: 55, 14: 65, 15: 75, 16: 80, 17: 70,
  18: 60, 19: 50, 20: 45, 21: 40, 22: 35, 23: 25,
}

// ─── Storage ────────────────────────────────────────────────

let _dataDir = ''
let _data: EnergyData = {
  history: [],
  profile: {
    bestHours: [9, 10, 11, 16],
    avgSessionMin: 60,
    avgBreakInterval: 45,
    totalSessions: 0,
    weekdayPattern: {},
  },
}

// Session state (in-memory, not persisted per-interaction)
let _sessionStart = Date.now()
let _interactionCount = 0
let _lastInteraction = Date.now()
let _lastBreak = Date.now()
let _breaksTaken = 0
let _energySamples: number[] = []

const DATA_FILE = () => join(_dataDir, 'energy.json')

function save(): void {
  atomicWriteFile(DATA_FILE(), JSON.stringify(_data, null, 2))
}

function load(): void {
  const file = DATA_FILE()
  if (!existsSync(file)) return
  try {
    const raw = JSON.parse(readFileSync(file, 'utf-8'))
    _data = {
      history: raw.history ?? [],
      profile: { ..._data.profile, ...raw.profile },
    }
  } catch { /* keep defaults */ }
}

// ─── Init ───────────────────────────────────────────────────

export function initEnergy(dataDir: string): void {
  _dataDir = dataDir
  load()
  _sessionStart = Date.now()
  _lastBreak = Date.now()
  _interactionCount = 0
  _breaksTaken = 0
  _energySamples = []
}

// ─── Core: Record interaction ───────────────────────────────

export function recordInteraction(): void {
  _interactionCount++
  _lastInteraction = Date.now()
}

export function recordBreak(): void {
  _breaksTaken++
  _lastBreak = Date.now()
}

// ─── Core: Calculate energy state ───────────────────────────

export function getEnergyState(): EnergyState {
  const now = Date.now()
  const sessionMin = (now - _sessionStart) / 60000
  const streakMin = (now - _lastBreak) / 60000
  const hour = new Date().getHours()

  // Base energy from circadian rhythm
  const circadian = CIRCADIAN_CURVE[hour] ?? 50

  // Session fatigue penalty (increases over time)
  const fatiguePenalty = Math.min(50, Math.pow(sessionMin / 60, 1.5) * 10)

  // Streak penalty (continuous work without break)
  const streakPenalty = Math.min(30, (streakMin / 45) * 15)

  // Interaction velocity bonus (engaged = higher energy)
  const recentMin = (now - _lastInteraction) / 60000
  const velocityBonus = recentMin < 2 ? 5 : recentMin < 5 ? 0 : -10

  // Break recovery bonus
  const breakBonus = _breaksTaken * 3

  // Personal profile adjustment
  const isOptimalHour = _data.profile.bestHours.includes(hour)
  const profileBonus = isOptimalHour ? 10 : 0

  // Final score
  const raw = circadian - fatiguePenalty - streakPenalty + velocityBonus + breakBonus + profileBonus
  const score = Math.max(0, Math.min(100, Math.round(raw)))

  // Track sample
  _energySamples = [..._energySamples, score]

  // Determine level
  const level: EnergyLevel =
    score >= 70 ? 'alto' :
    score >= 45 ? 'medio' :
    score >= 25 ? 'baixo' : 'critico'

  // Determine phase
  const phase: WorkPhase =
    sessionMin < 15 ? 'aquecimento' :
    score >= 70 ? 'pico' :
    score >= 45 ? 'sustentado' :
    score >= 25 ? 'declinio' : 'esgotado'

  // Generate suggestion
  const suggestion = generateSuggestion(level, phase, streakMin, sessionMin, hour)

  return {
    level,
    score,
    phase,
    sessionStartedAt: _sessionStart,
    sessionDurationMin: Math.round(sessionMin),
    interactionCount: _interactionCount,
    lastInteractionAt: _lastInteraction,
    lastBreakAt: _lastBreak,
    breaksTaken: _breaksTaken,
    currentStreak: Math.round(streakMin),
    suggestion,
  }
}

function generateSuggestion(
  level: EnergyLevel,
  phase: WorkPhase,
  streakMin: number,
  sessionMin: number,
  hour: number,
): string {
  if (level === 'critico') {
    return 'Energia critica. Pare agora — descanse 15-20 minutos antes de continuar.'
  }

  if (streakMin >= CRITICAL_THRESHOLD_MIN) {
    return `${Math.round(streakMin)} minutos sem pausa. Faca uma pausa longa de ${LONG_BREAK_MIN} minutos.`
  }

  if (streakMin >= FATIGUE_THRESHOLD_MIN) {
    return `${Math.round(streakMin)} minutos contínuos. Levante, alongue, tome agua.`
  }

  if (streakMin >= 45 && _breaksTaken % LONG_BREAK_THRESHOLD === 0 && _breaksTaken > 0) {
    return `${_breaksTaken} ciclos completos. Hora de uma pausa longa de ${LONG_BREAK_MIN} minutos.`
  }

  if (streakMin >= 45) {
    return `${Math.round(streakMin)} minutos focado. Uma pausa de ${SHORT_BREAK_MIN} minutos ajudaria.`
  }

  if (phase === 'aquecimento') {
    return 'Fase de aquecimento. Comece com tarefas leves para entrar no ritmo.'
  }

  if (phase === 'pico') {
    return 'Voce esta no pico! Aproveite para as tarefas mais complexas.'
  }

  if (hour >= 22 || hour < 6) {
    return 'Horario tardio. Considere encerrar e descansar.'
  }

  if (level === 'baixo') {
    return 'Energia em declinio. Alterne para tarefas mais leves ou faca uma pausa.'
  }

  return 'Ritmo bom. Continue focado.'
}

// ─── End session: persist work block ────────────────────────

export function endSession(): WorkBlock {
  const now = Date.now()
  const sessionMin = (now - _sessionStart) / 60000
  const startHour = new Date(_sessionStart).getHours()
  const endHour = new Date().getHours()
  const avgEnergy = _energySamples.length > 0
    ? Math.round(_energySamples.reduce((a, b) => a + b, 0) / _energySamples.length)
    : 50

  // Find peak hour from samples
  const hourSamples = new Map<number, number[]>()
  for (let i = 0; i < _energySamples.length; i++) {
    const sampleTime = _sessionStart + (i * sessionMin * 60000 / _energySamples.length)
    const h = new Date(sampleTime).getHours()
    const existing = hourSamples.get(h) ?? []
    hourSamples.set(h, [...existing, _energySamples[i]])
  }
  let peakHour = startHour
  let peakAvg = 0
  for (const [h, samples] of hourSamples) {
    const avg = samples.reduce((a, b) => a + b, 0) / samples.length
    if (avg > peakAvg) { peakAvg = avg; peakHour = h }
  }

  const block: WorkBlock = {
    date: new Date().toISOString().split('T')[0],
    startHour,
    endHour,
    durationMin: Math.round(sessionMin),
    interactions: _interactionCount,
    breaks: _breaksTaken,
    avgEnergy,
    peakHour,
  }

  // Update history
  _data = {
    ..._data,
    history: [..._data.history.slice(-MAX_HISTORY_DAYS), block],
  }

  // Update profile
  updateProfile()
  save()

  return block
}

function updateProfile(): void {
  const history = _data.history
  if (history.length < 3) return

  // Calculate best hours from peak hours
  const hourCounts = new Map<number, number>()
  for (const block of history) {
    hourCounts.set(block.peakHour, (hourCounts.get(block.peakHour) ?? 0) + 1)
  }
  const bestHours = [...hourCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([h]) => h)

  // Average session and break interval
  const avgSessionMin = Math.round(
    history.reduce((a, b) => a + b.durationMin, 0) / history.length,
  )
  const avgBreakInterval = history.filter((b) => b.breaks > 0).length > 0
    ? Math.round(
        history.filter((b) => b.breaks > 0)
          .reduce((a, b) => a + b.durationMin / b.breaks, 0) /
        history.filter((b) => b.breaks > 0).length,
      )
    : 45

  // Weekday pattern
  const weekdayPattern: Record<string, number> = {}
  const weekdays = ['domingo', 'segunda', 'terca', 'quarta', 'quinta', 'sexta', 'sabado']
  for (const block of history) {
    const day = weekdays[new Date(block.date).getDay()]
    const existing = weekdayPattern[day]
    weekdayPattern[day] = existing
      ? Math.round((existing + block.avgEnergy) / 2)
      : block.avgEnergy
  }

  _data = {
    ..._data,
    profile: {
      bestHours,
      avgSessionMin,
      avgBreakInterval,
      totalSessions: history.length,
      weekdayPattern,
    },
  }
}

// ─── Formatting ─────────────────────────────────────────────

const LEVEL_ICONS: Record<EnergyLevel, string> = {
  alto: '🟢', medio: '🟡', baixo: '🟠', critico: '🔴',
}

const PHASE_LABELS: Record<WorkPhase, string> = {
  aquecimento: 'Aquecimento',
  pico: 'Pico',
  sustentado: 'Sustentado',
  declinio: 'Declinio',
  esgotado: 'Esgotado',
}

export function formatEnergyState(state: EnergyState): string {
  const icon = LEVEL_ICONS[state.level]
  const lines = [
    `${icon} Energia: ${state.score}/100 (${state.level})`,
    `Fase: ${PHASE_LABELS[state.phase]}`,
    `Sessao: ${state.sessionDurationMin} min | Streak: ${state.currentStreak} min`,
    `Interacoes: ${state.interactionCount} | Pausas: ${state.breaksTaken}`,
    '',
    `💡 ${state.suggestion}`,
  ]
  return lines.join('\n')
}

export function formatEnergyProfile(): string {
  const p = _data.profile
  if (p.totalSessions < 3) {
    return 'Perfil de energia ainda em construcao. Use o smolerclaw por mais alguns dias.'
  }

  const bestHoursStr = p.bestHours.map((h) => `${h}h`).join(', ')
  const weekdayStr = Object.entries(p.weekdayPattern)
    .sort((a, b) => b[1] - a[1])
    .map(([day, avg]) => `  ${day}: ${avg}/100`)
    .join('\n')

  return [
    '# Seu Perfil de Energia',
    '',
    `Sessoes registradas: ${p.totalSessions}`,
    `Sessao media: ${p.avgSessionMin} min`,
    `Intervalo medio entre pausas: ${p.avgBreakInterval} min`,
    `Horarios de pico: ${bestHoursStr}`,
    '',
    '## Energia por dia da semana',
    weekdayStr,
  ].join('\n')
}

export function getProfile(): EnergyProfile {
  return _data.profile
}
