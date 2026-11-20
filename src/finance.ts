/**
 * Simple personal finance tracker — income/expense by category.
 * Transactions live in the shared SQLite store; amounts are kept in cents so
 * sums stay exact.
 */

import { randomUUID } from 'node:crypto'
import { ensureSchema, hasSchema, importLegacyJson, openStore, store } from './core/store'

// ─── Types ──────────────────────────────────────────────────

export interface Transaction {
  id: string
  type: 'entrada' | 'saida'
  amount: number          // always positive
  category: string
  description: string
  date: string            // ISO date
}

// ─── Storage ────────────────────────────────────────────────

const LEGACY_FILE = 'finance.json'
const TYPES: ReadonlySet<string> = new Set(['entrada', 'saida'])

const SCHEMA = `
CREATE TABLE IF NOT EXISTS transactions (
  id           TEXT PRIMARY KEY,
  type         TEXT NOT NULL CHECK (type IN ('entrada', 'saida')),
  amount_cents INTEGER NOT NULL CHECK (amount_cents >= 0),
  category     TEXT NOT NULL,
  description  TEXT NOT NULL,
  date         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_transactions_date ON transactions(date)
`

interface TransactionRow {
  id: string
  type: Transaction['type']
  amount_cents: number
  category: string
  description: string
  date: string
}

function toTransaction(row: TransactionRow): Transaction {
  return {
    id: row.id,
    type: row.type,
    amount: row.amount_cents / 100,
    category: row.category,
    description: row.description,
    date: row.date,
  }
}

function toCents(amount: number): number {
  return Math.round(Math.abs(amount) * 100)
}

function insertTransaction(tx: Transaction): void {
  store().query(
    'INSERT INTO transactions (id, type, amount_cents, category, description, date) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(tx.id, tx.type, toCents(tx.amount), tx.category, tx.description, tx.date)
}

// ─── Init ───────────────────────────────────────────────────

export function initFinance(dataDir: string): void {
  openStore(dataDir)
  ensureSchema('finance', SCHEMA)
  importLegacyJson(dataDir, LEGACY_FILE, importLegacyTransactions)
}

// ─── Operations ─────────────────────────────────────────────

export function addTransaction(
  type: 'entrada' | 'saida',
  amount: number,
  category: string,
  description: string,
): Transaction {
  const tx: Transaction = {
    id: genId(),
    type,
    amount: toCents(amount) / 100,
    category: category.toLowerCase().trim(),
    description: description.trim(),
    date: new Date().toISOString(),
  }
  insertTransaction(tx)
  return tx
}

export function removeTransaction(id: string): boolean {
  return store().query('DELETE FROM transactions WHERE id = ?').run(id).changes > 0
}

/** Every transaction in insertion order. */
export function listTransactions(): Transaction[] {
  return (store().query('SELECT * FROM transactions ORDER BY rowid').all() as TransactionRow[]).map(toTransaction)
}

/** Every transaction as pretty JSON, for the vault's git backup. Null when the store is not initialized. */
export function exportFinanceSnapshot(): string | null {
  if (!hasSchema('finance')) return null
  return JSON.stringify(listTransactions(), null, 2)
}

// ─── Reports ────────────────────────────────────────────────

export function getMonthSummary(year?: number, month?: number): string {
  const now = new Date()
  const y = year || now.getFullYear()
  const m = month !== undefined ? month : now.getMonth()

  const monthTx = listTransactions().filter((t) => {
    const d = new Date(t.date)
    return d.getFullYear() === y && d.getMonth() === m
  })

  if (monthTx.length === 0) {
    return `Nenhuma transacao em ${formatMonth(m)}/${y}.`
  }

  const income = monthTx.filter((t) => t.type === 'entrada').reduce((s, t) => s + t.amount, 0)
  const expenses = monthTx.filter((t) => t.type === 'saida').reduce((s, t) => s + t.amount, 0)
  const balance = income - expenses

  // Group expenses by category
  const byCategory = new Map<string, number>()
  for (const tx of monthTx.filter((t) => t.type === 'saida')) {
    byCategory.set(tx.category, (byCategory.get(tx.category) || 0) + tx.amount)
  }

  const lines: string[] = [
    `--- Resumo ${formatMonth(m)}/${y} ---`,
    `Entradas:  R$ ${income.toFixed(2)}`,
    `Saidas:    R$ ${expenses.toFixed(2)}`,
    `Saldo:     R$ ${balance.toFixed(2)} ${balance >= 0 ? '' : '(NEGATIVO)'}`,
  ]

  if (byCategory.size > 0) {
    lines.push('')
    lines.push('Saidas por categoria:')
    const sorted = [...byCategory.entries()].sort((a, b) => b[1] - a[1])
    for (const [cat, total] of sorted) {
      const pct = expenses > 0 ? Math.round((total / expenses) * 100) : 0
      lines.push(`  ${cat.padEnd(15)} R$ ${total.toFixed(2)} (${pct}%)`)
    }
  }

  return lines.join('\n')
}

export function getRecentTransactions(limit = 10): string {
  const recent = listTransactions()
    .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
    .slice(0, limit)

  if (recent.length === 0) return 'Nenhuma transacao registrada.'

  const lines = recent.map((t) => {
    const date = new Date(t.date).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' })
    const sign = t.type === 'entrada' ? '+' : '-'
    return `  [${date}] ${sign} R$ ${t.amount.toFixed(2)} ${t.category} — ${t.description} [${t.id}]`
  })

  return `Transacoes recentes:\n${lines.join('\n')}`
}

// ─── Helpers ────────────────────────────────────────────────

function importLegacyTransactions(parsed: unknown): void {
  if (!Array.isArray(parsed)) return
  const taken = store().query('SELECT 1 FROM transactions WHERE id = ?')
  for (const record of parsed) {
    const tx = legacyTransaction(record)
    if (!tx) continue
    // A missing or repeated id gets a fresh one, never a dropped transaction.
    let id = tx.id && !taken.get(tx.id) ? tx.id : genId()
    while (taken.get(id)) id = genId()
    insertTransaction({ ...tx, id })
  }
}

function legacyTransaction(value: unknown): Transaction | null {
  if (!value || typeof value !== 'object') return null
  const r = value as Record<string, unknown>
  if (typeof r.type !== 'string' || !TYPES.has(r.type)) return null
  if (typeof r.amount !== 'number' || !Number.isFinite(r.amount)) return null
  return {
    id: typeof r.id === 'string' ? r.id : '',
    type: r.type as Transaction['type'],
    amount: Math.abs(r.amount),
    category: typeof r.category === 'string' ? r.category : 'geral',
    description: typeof r.description === 'string' ? r.description : '',
    date: typeof r.date === 'string' && !Number.isNaN(Date.parse(r.date)) ? r.date : new Date().toISOString(),
  }
}

function genId(): string {
  return randomUUID().slice(0, 8)
}

function formatMonth(m: number): string {
  const names = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez']
  return names[m] || String(m + 1)
}
