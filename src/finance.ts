/**
 * Simple personal finance tracker — income/expense by category.
 */

import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { atomicWriteFile } from './vault'

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

let _dataDir = ''
let _transactions: Transaction[] = []

const DATA_FILE = () => join(_dataDir, 'finance.json')

function save(): void {
  atomicWriteFile(DATA_FILE(), JSON.stringify(_transactions, null, 2))
}

function load(): void {
  const file = DATA_FILE()
  if (!existsSync(file)) { _transactions = []; return }
  try { _transactions = JSON.parse(readFileSync(file, 'utf-8')) }
  catch { _transactions = [] }
}

// ─── Init ───────────────────────────────────────────────────

export function initFinance(dataDir: string): void {
  _dataDir = dataDir
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true })
  load()
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
    amount: Math.abs(amount),
    category: category.toLowerCase().trim(),
    description: description.trim(),
    date: new Date().toISOString(),
  }
  _transactions = [..._transactions, tx]
  save()
  return tx
}

export function removeTransaction(id: string): boolean {
  const idx = _transactions.findIndex((t) => t.id === id)
  if (idx === -1) return false
  _transactions = [..._transactions.slice(0, idx), ..._transactions.slice(idx + 1)]
  save()
  return true
}

// ─── Reports ────────────────────────────────────────────────

export function getMonthSummary(year?: number, month?: number): string {
  const now = new Date()
  const y = year || now.getFullYear()
  const m = month !== undefined ? month : now.getMonth()

  const monthTx = _transactions.filter((t) => {
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
  const recent = [..._transactions]
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

function genId(): string {
  return randomUUID().slice(0, 8)
}

function formatMonth(m: number): string {
  const names = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez']
  return names[m] || String(m + 1)
}
