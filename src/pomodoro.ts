/**
 * Pomodoro timer — focus sessions with break notifications.
 * 25 min work / 5 min break cycle with Windows toast notifications.
 *
 * REFACTORED: All PowerShell execution now goes through windows-executor.ts
 */

import { IS_WINDOWS } from './platform'
import { showToast } from './utils/windows-executor'

// ─── Types ──────────────────────────────────────────────────

interface PomodoroSession {
  startedAt: number
  durationMs: number
  breakMs: number
  label: string
  type: 'work' | 'break'
}

type PomodoroCallback = (message: string) => void

// ─── State ──────────────────────────────────────────────────

let _session: PomodoroSession | null = null
let _timer: ReturnType<typeof setTimeout> | null = null
let _onNotify: PomodoroCallback | null = null
let _cycleCount = 0

// ─── Public API ─────────────────────────────────────────────

export function initPomodoro(onNotify: PomodoroCallback): void {
  _onNotify = onNotify
}

export function startPomodoro(
  label = 'foco',
  workMinutes = 25,
  breakMinutes = 5,
): string {
  if (_session) {
    return `Pomodoro ja ativo: "${_session.label}" (${formatRemaining()}). Use /pomodoro stop para parar.`
  }

  _session = {
    startedAt: Date.now(),
    durationMs: workMinutes * 60_000,
    breakMs: breakMinutes * 60_000,
    label,
    type: 'work',
  }
  _cycleCount++

  scheduleNotification()

  return `Pomodoro #${_cycleCount} iniciado: "${label}" (${workMinutes}min trabalho / ${breakMinutes}min pausa)`
}

export function stopPomodoro(): string {
  if (!_session) return 'Nenhum pomodoro ativo.'

  const label = _session.label
  const elapsed = Math.floor((Date.now() - _session.startedAt) / 60_000)
  clearTimer()
  _session = null

  return `Pomodoro parado: "${label}" (${elapsed}min decorridos)`
}

export function pomodoroStatus(): string {
  if (!_session) return 'Nenhum pomodoro ativo. Use /pomodoro <descricao> para iniciar.'

  const remaining = formatRemaining()
  const type = _session.type === 'work' ? 'Trabalhando' : 'Pausa'

  return `${type}: "${_session.label}" — ${remaining} restante(s) (ciclo #${_cycleCount})`
}

export function isActive(): boolean {
  return _session !== null
}

// ─── Internal ───────────────────────────────────────────────

function scheduleNotification(): void {
  if (!_session) return
  clearTimer()

  const remaining = (_session.startedAt + _session.durationMs) - Date.now()
  if (remaining <= 0) {
    onPhaseEnd()
    return
  }

  _timer = setTimeout(onPhaseEnd, remaining)
}

function onPhaseEnd(): void {
  if (!_session) return

  if (_session.type === 'work') {
    // Work phase ended — start break
    const msg = `Pomodoro: "${_session.label}" concluido! Hora da pausa (${_session.breakMs / 60_000}min).`
    fireToast('Pausa!', `"${_session.label}" concluido. Descanse ${_session.breakMs / 60_000} minutos.`)
    _onNotify?.(msg)

    _session = {
      ..._session,
      type: 'break',
      startedAt: Date.now(),
      durationMs: _session.breakMs,
    }
    scheduleNotification()
  } else {
    // Break ended — notify and reset
    const msg = 'Pausa concluida! Pronto para o proximo ciclo. Use /pomodoro para iniciar.'
    fireToast('Volta ao trabalho!', 'Pausa concluida. Pronto para o proximo ciclo.')
    _onNotify?.(msg)
    clearTimer()
    _session = null
  }
}

function clearTimer(): void {
  if (_timer) {
    clearTimeout(_timer)
    _timer = null
  }
}

function formatRemaining(): string {
  if (!_session) return '0min'
  const remaining = Math.max(0, (_session.startedAt + _session.durationMs) - Date.now())
  const mins = Math.ceil(remaining / 60_000)
  return `${mins}min`
}

async function fireToast(title: string, body: string): Promise<void> {
  if (!IS_WINDOWS) return

  try {
    await showToast(title, body, { timeout: 10_000 })
  } catch { /* best effort */ }
}

export function stopPomodoroTimer(): void {
  clearTimer()
  _session = null
}
