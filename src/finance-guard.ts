/**
 * Finance Guard — verification layer for financial operations.
 *
 * Validates transactions before they are persisted:
 *   - Amount limits and sanity checks
 *   - Duplicate detection (same amount + category within time window)
 *   - Daily spending alerts
 *   - Emits events for audit trail via event bus
 */

import { emit } from './core/event-bus'
import { logger } from './core/logger'

// ─── Types ──────────────────────────────────────────────────

export interface FinanceGuardConfig {
  /** Max single transaction amount (R$). Default: 10_000 */
  maxSingleAmount: number
  /** Daily spending alert threshold (R$). Default: 1_000 */
  dailyAlertThreshold: number
  /** Duplicate detection window (ms). Default: 300_000 (5 min) */
  duplicateWindowMs: number
  /** Whether to block transactions that fail validation. Default: false (warn only) */
  blockOnFailure: boolean
}

export interface VerificationResult {
  readonly allowed: boolean
  readonly warnings: readonly string[]
  readonly blocked: string | null
}

interface RecentTransaction {
  readonly type: 'entrada' | 'saida'
  readonly amount: number
  readonly category: string
  readonly timestamp: number
}

interface DailyTransaction {
  readonly type: 'entrada' | 'saida'
  readonly amount: number
  readonly date: string // YYYY-MM-DD
}

// ─── State ──────────────────────────────────────────────────

const DEFAULT_CONFIG: FinanceGuardConfig = {
  maxSingleAmount: 10_000,
  dailyAlertThreshold: 1_000,
  duplicateWindowMs: 300_000,
  blockOnFailure: false,
}

let _config: FinanceGuardConfig = { ...DEFAULT_CONFIG }
let _recentTransactions: readonly RecentTransaction[] = []
let _dailyTransactions: readonly DailyTransaction[] = []

// ─── Init ───────────────────────────────────────────────────

export function initFinanceGuard(config?: Partial<FinanceGuardConfig>): void {
  _config = { ...DEFAULT_CONFIG, ...config }
  _recentTransactions = []
  _dailyTransactions = []
}

export function getFinanceGuardConfig(): Readonly<FinanceGuardConfig> {
  return _config
}

// ─── Core Verification ─────────────────────────────────────

/**
 * Verify a transaction before it is persisted.
 * Returns warnings and whether the transaction should proceed.
 */
export function verifyTransaction(
  type: 'entrada' | 'saida',
  amount: number,
  category: string,
  description: string,
): VerificationResult {
  const warnings: string[] = []
  let blocked: string | null = null

  // 1. Basic validation
  if (amount <= 0) {
    return { allowed: false, warnings: [], blocked: 'Valor deve ser positivo.' }
  }

  if (!category.trim()) {
    return { allowed: false, warnings: [], blocked: 'Categoria obrigatoria.' }
  }

  if (!description.trim()) {
    return { allowed: false, warnings: [], blocked: 'Descricao obrigatoria.' }
  }

  // 2. Amount limit check
  if (amount > _config.maxSingleAmount) {
    const msg = `Valor alto: R$ ${amount.toFixed(2)} excede limite de R$ ${_config.maxSingleAmount.toFixed(2)}`
    if (_config.blockOnFailure) {
      blocked = msg
    } else {
      warnings.push(msg)
    }
  }

  // 3. Duplicate detection
  const now = Date.now()
  const duplicate = _recentTransactions.find(
    (tx) =>
      tx.type === type &&
      tx.amount === Math.abs(amount) &&
      tx.category === category.toLowerCase().trim() &&
      now - tx.timestamp < _config.duplicateWindowMs,
  )

  if (duplicate) {
    const agoSec = Math.round((now - duplicate.timestamp) / 1000)
    warnings.push(`Possivel duplicata: mesma transacao registrada ha ${agoSec}s atras`)
  }

  // 4. Daily spending check (saidas only) — uses persistent daily ledger
  if (type === 'saida') {
    const today = todayKey()
    const todaySpending = _dailyTransactions
      .filter((tx) => tx.type === 'saida' && tx.date === today)
      .reduce((sum, tx) => sum + tx.amount, 0)

    const projectedTotal = todaySpending + Math.abs(amount)
    if (projectedTotal > _config.dailyAlertThreshold) {
      warnings.push(
        `Alerta: gasto diario projetado R$ ${projectedTotal.toFixed(2)} ` +
        `excede limite de R$ ${_config.dailyAlertThreshold.toFixed(2)}`,
      )
    }
  }

  // 5. Emit audit event
  const allowed = blocked === null
  emitFinanceEvent(type, amount, category, description, allowed, warnings)

  return { allowed, warnings: warnings, blocked }
}

/**
 * Record that a transaction was successfully persisted.
 * Updates the recent transactions list for duplicate detection.
 */
export function recordVerifiedTransaction(
  type: 'entrada' | 'saida',
  amount: number,
  category: string,
): void {
  const absAmount = Math.abs(amount)
  const now = Date.now()

  // Track for duplicate detection (short window)
  const entry: RecentTransaction = {
    type,
    amount: absAmount,
    category: category.toLowerCase().trim(),
    timestamp: now,
  }
  const cutoff = now - _config.duplicateWindowMs * 2
  _recentTransactions = [
    ..._recentTransactions.filter((tx) => tx.timestamp > cutoff),
    entry,
  ]

  // Track for daily spending (persists all day, purges yesterday)
  const today = todayKey()
  _dailyTransactions = [
    ..._dailyTransactions.filter((tx) => tx.date === today),
    { type, amount: absAmount, date: today },
  ]
}

/**
 * Get today's spending summary from the daily ledger.
 */
export function getTodaySpendingSummary(): { total: number; count: number } {
  const today = todayKey()
  const todayTxs = _dailyTransactions.filter(
    (tx) => tx.type === 'saida' && tx.date === today,
  )

  return {
    total: todayTxs.reduce((sum, tx) => sum + tx.amount, 0),
    count: todayTxs.length,
  }
}

/**
 * Format verification result for display.
 */
export function formatVerification(result: VerificationResult): string {
  if (result.blocked) {
    return `BLOQUEADO: ${result.blocked}`
  }
  if (result.warnings.length === 0) {
    return ''
  }
  return result.warnings.map((w) => `AVISO: ${w}`).join('\n')
}

// ─── Internal ───────────────────────────────────────────────

function todayKey(): string {
  return new Date().toISOString().slice(0, 10)
}

function emitFinanceEvent(
  type: 'entrada' | 'saida',
  amount: number,
  category: string,
  description: string,
  allowed: boolean,
  warnings: readonly string[],
): void {
  const level = !allowed ? 'error' : warnings.length > 0 ? 'warning' : 'info'
  const sign = type === 'entrada' ? '+' : '-'

  emit('status:update', {
    source: 'finance-guard',
    message: `${sign} R$ ${Math.abs(amount).toFixed(2)} ${category} — ${description}${
      warnings.length > 0 ? ` (${warnings.length} aviso${warnings.length > 1 ? 's' : ''})` : ''
    }`,
    level,
    timestamp: Date.now(),
  })

  if (warnings.length > 0) {
    logger.debug('Finance guard warnings', { type, amount, category, warnings })
  }
}
