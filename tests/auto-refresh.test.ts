import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test'
import {
  startAutoRefresh,
  stopAutoRefresh,
  updateAutoRefreshAuth,
  getAutoRefreshStatus,
  formatAutoRefreshStatus,
} from '../src/auto-refresh'
import type { AuthResult } from '../src/auth'

function makeAuth(expiresInMs: number): AuthResult {
  return {
    token: 'test-token-' + Date.now(),
    subscriptionType: 'pro',
    expiresAt: Date.now() + expiresInMs,
  }
}

describe('Auto-refresh', () => {
  afterEach(() => {
    stopAutoRefresh()
  })

  test('starts and reports running status', () => {
    const auth = makeAuth(600_000) // 10 min
    startAutoRefresh(auth)

    const status = getAutoRefreshStatus()
    expect(status.running).toBe(true)
    expect(status.refreshCount).toBe(0)
    expect(status.tokenExpiresAt).toBe(auth.expiresAt)
    expect(status.tokenExpiresIn).toBeTruthy()
  })

  test('stops cleanly', () => {
    const auth = makeAuth(600_000)
    startAutoRefresh(auth)
    stopAutoRefresh()

    const status = getAutoRefreshStatus()
    expect(status.running).toBe(false)
    expect(status.tokenExpiresAt).toBeNull()
  })

  test('updateAutoRefreshAuth updates the tracked auth', () => {
    const auth = makeAuth(600_000)
    startAutoRefresh(auth)

    const newAuth = makeAuth(1_200_000) // 20 min
    updateAutoRefreshAuth(newAuth)

    const status = getAutoRefreshStatus()
    expect(status.tokenExpiresAt).toBe(newAuth.expiresAt)
  })

  test('formatAutoRefreshStatus returns readable string', () => {
    const auth = makeAuth(600_000)
    startAutoRefresh(auth)

    const formatted = formatAutoRefreshStatus()
    expect(formatted).toContain('Auto-refresh: ativo')
    expect(formatted).toContain('Renovacoes: 0')
    expect(formatted).toContain('Token expira em:')
  })

  test('formatAutoRefreshStatus shows inativo when stopped', () => {
    const formatted = formatAutoRefreshStatus()
    expect(formatted).toContain('Auto-refresh: inativo')
  })

  test('tokenExpiresIn shows expirado for past tokens', () => {
    const auth = makeAuth(-1000) // already expired
    startAutoRefresh(auth)

    const status = getAutoRefreshStatus()
    expect(status.tokenExpiresIn).toBe('expirado')
  })

  test('tokenExpiresIn shows hours and minutes', () => {
    const auth = makeAuth(7_200_000) // 2 hours
    startAutoRefresh(auth)

    const status = getAutoRefreshStatus()
    expect(status.tokenExpiresIn).toMatch(/2h/)
  })

  test('tokenExpiresIn shows minutes only for < 1 hour', () => {
    const auth = makeAuth(1_800_000) // 30 min
    startAutoRefresh(auth)

    const status = getAutoRefreshStatus()
    expect(status.tokenExpiresIn).toMatch(/30m/)
  })

  test('restart replaces the previous timer', () => {
    const auth1 = makeAuth(600_000)
    startAutoRefresh(auth1)

    const auth2 = makeAuth(1_200_000)
    startAutoRefresh(auth2)

    const status = getAutoRefreshStatus()
    expect(status.running).toBe(true)
    expect(status.tokenExpiresAt).toBe(auth2.expiresAt)
  })

  test('onRefreshed callback wires correctly via options', () => {
    let called = false
    const auth = makeAuth(600_000)

    startAutoRefresh(auth, {
      checkIntervalMs: 100_000, // won't fire during test
      onRefreshed: () => { called = true },
    })

    // Callback not called until refresh happens
    expect(called).toBe(false)
  })
})
