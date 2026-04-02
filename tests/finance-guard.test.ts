import { describe, test, expect, beforeEach } from 'bun:test'
import {
  initFinanceGuard,
  verifyTransaction,
  recordVerifiedTransaction,
  formatVerification,
  getTodaySpendingSummary,
  getFinanceGuardConfig,
} from '../src/finance-guard'

describe('Finance Guard', () => {
  beforeEach(() => {
    initFinanceGuard()
  })

  // ─── Basic validation ────────────────────────────────────

  test('rejects zero amount', () => {
    const result = verifyTransaction('saida', 0, 'food', 'test')
    expect(result.allowed).toBe(false)
    expect(result.blocked).toContain('positivo')
  })

  test('rejects negative amount', () => {
    const result = verifyTransaction('saida', -50, 'food', 'test')
    expect(result.allowed).toBe(false)
    expect(result.blocked).toContain('positivo')
  })

  test('rejects empty category', () => {
    const result = verifyTransaction('saida', 50, '', 'test')
    expect(result.allowed).toBe(false)
    expect(result.blocked).toContain('Categoria')
  })

  test('rejects empty description', () => {
    const result = verifyTransaction('saida', 50, 'food', '')
    expect(result.allowed).toBe(false)
    expect(result.blocked).toContain('Descricao')
  })

  test('allows valid transaction', () => {
    const result = verifyTransaction('saida', 50, 'food', 'almoco')
    expect(result.allowed).toBe(true)
    expect(result.blocked).toBeNull()
    expect(result.warnings).toHaveLength(0)
  })

  test('allows valid entrada', () => {
    const result = verifyTransaction('entrada', 5000, 'salario', 'pagamento mensal')
    expect(result.allowed).toBe(true)
    expect(result.blocked).toBeNull()
  })

  // ─── Amount limits ───────────────────────────────────────

  test('warns on high amount (default config)', () => {
    const result = verifyTransaction('saida', 15_000, 'equipamento', 'notebook')
    expect(result.allowed).toBe(true) // warn only by default
    expect(result.warnings.length).toBeGreaterThan(0)
    expect(result.warnings[0]).toContain('Valor alto')
  })

  test('blocks on high amount when blockOnFailure is true', () => {
    initFinanceGuard({ blockOnFailure: true })
    const result = verifyTransaction('saida', 15_000, 'equipamento', 'notebook')
    expect(result.allowed).toBe(false)
    expect(result.blocked).toContain('Valor alto')
  })

  test('custom maxSingleAmount', () => {
    initFinanceGuard({ maxSingleAmount: 500 })
    const result = verifyTransaction('saida', 600, 'food', 'jantar caro')
    expect(result.allowed).toBe(true)
    expect(result.warnings[0]).toContain('Valor alto')
  })

  // ─── Duplicate detection ─────────────────────────────────

  test('detects duplicate transaction', () => {
    recordVerifiedTransaction('saida', 50, 'food')
    const result = verifyTransaction('saida', 50, 'food', 'almoco de novo')
    expect(result.warnings.some((w) => w.includes('duplicata'))).toBe(true)
  })

  test('no duplicate for different amounts', () => {
    recordVerifiedTransaction('saida', 50, 'food')
    const result = verifyTransaction('saida', 75, 'food', 'almoco')
    expect(result.warnings.some((w) => w.includes('duplicata'))).toBe(false)
  })

  test('no duplicate for different categories', () => {
    recordVerifiedTransaction('saida', 50, 'food')
    const result = verifyTransaction('saida', 50, 'transport', 'uber')
    expect(result.warnings.some((w) => w.includes('duplicata'))).toBe(false)
  })

  test('no duplicate for different types', () => {
    recordVerifiedTransaction('entrada', 50, 'reembolso')
    const result = verifyTransaction('saida', 50, 'reembolso', 'pagar de volta')
    expect(result.warnings.some((w) => w.includes('duplicata'))).toBe(false)
  })

  // ─── Daily spending alert ────────────────────────────────

  test('warns when daily spending exceeds threshold', () => {
    initFinanceGuard({ dailyAlertThreshold: 200 })
    recordVerifiedTransaction('saida', 150, 'food')
    const result = verifyTransaction('saida', 100, 'transport', 'uber')
    expect(result.warnings.some((w) => w.includes('gasto diario'))).toBe(true)
  })

  test('no daily alert for entradas', () => {
    initFinanceGuard({ dailyAlertThreshold: 100 })
    recordVerifiedTransaction('saida', 80, 'food')
    const result = verifyTransaction('entrada', 500, 'salario', 'pagamento')
    expect(result.warnings.some((w) => w.includes('gasto diario'))).toBe(false)
  })

  // ─── Today spending summary ──────────────────────────────

  test('getTodaySpendingSummary returns correct totals', () => {
    recordVerifiedTransaction('saida', 50, 'food')
    recordVerifiedTransaction('saida', 30, 'transport')
    recordVerifiedTransaction('entrada', 1000, 'salario')

    const summary = getTodaySpendingSummary()
    expect(summary.total).toBe(80)
    expect(summary.count).toBe(2)
  })

  test('getTodaySpendingSummary returns zero with no transactions', () => {
    const summary = getTodaySpendingSummary()
    expect(summary.total).toBe(0)
    expect(summary.count).toBe(0)
  })

  // ─── Format ──────────────────────────────────────────────

  test('formatVerification returns empty for clean result', () => {
    const result = verifyTransaction('saida', 50, 'food', 'almoco')
    expect(formatVerification(result)).toBe('')
  })

  test('formatVerification shows warnings', () => {
    initFinanceGuard({ maxSingleAmount: 100 })
    const result = verifyTransaction('saida', 200, 'equipamento', 'teclado')
    const formatted = formatVerification(result)
    expect(formatted).toContain('AVISO:')
  })

  test('formatVerification shows blocked', () => {
    const result = verifyTransaction('saida', 0, 'food', 'test')
    const formatted = formatVerification(result)
    expect(formatted).toContain('BLOQUEADO:')
  })

  // ─── Config ──────────────────────────────────────────────

  test('getFinanceGuardConfig returns current config', () => {
    const config = getFinanceGuardConfig()
    expect(config.maxSingleAmount).toBe(10_000)
    expect(config.dailyAlertThreshold).toBe(1_000)
    expect(config.blockOnFailure).toBe(false)
  })

  test('custom config is applied', () => {
    initFinanceGuard({ maxSingleAmount: 500, blockOnFailure: true })
    const config = getFinanceGuardConfig()
    expect(config.maxSingleAmount).toBe(500)
    expect(config.blockOnFailure).toBe(true)
  })
})
