import { describe, test, expect, beforeEach } from 'bun:test'
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  initFinance, addTransaction, removeTransaction, getMonthSummary, getRecentTransactions,
  listTransactions, exportFinanceSnapshot,
} from '../src/finance'
import { closeStore, store } from '../src/core/store'

describe('finance', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'smolerclaw-finance-'))
    initFinance(dir)
  })

  test('addTransaction normalizes and returns the record', () => {
    const tx = addTransaction('saida', -42.5, ' Mercado ', ' feira ')
    expect(tx).toEqual(expect.objectContaining({ type: 'saida', amount: 42.5, category: 'mercado', description: 'feira' }))
    expect(tx.id).toHaveLength(8)
  })

  test('transactions survive a restart', () => {
    const tx = addTransaction('entrada', 1000, 'salario', 'novembro')
    closeStore()
    initFinance(dir)
    expect(listTransactions()).toEqual([tx])
  })

  test('money sums are exact to the cent', () => {
    addTransaction('saida', 0.1, 'a', '')
    addTransaction('saida', 0.2, 'a', '')
    expect(getMonthSummary()).toContain('Saidas:    R$ 0.30')
    expect(listTransactions().map((t) => t.amount)).toEqual([0.1, 0.2])
  })

  test('removeTransaction deletes by id', () => {
    const tx = addTransaction('saida', 10, 'x', '')
    expect(removeTransaction(tx.id)).toBe(true)
    expect(removeTransaction(tx.id)).toBe(false)
    expect(listTransactions()).toEqual([])
  })

  test('getMonthSummary totals income, expenses and categories', () => {
    addTransaction('entrada', 100, 'salario', '')
    addTransaction('saida', 30, 'mercado', '')
    addTransaction('saida', 10, 'transporte', '')
    const summary = getMonthSummary()
    expect(summary).toContain('Entradas:  R$ 100.00')
    expect(summary).toContain('Saldo:     R$ 60.00')
    expect(summary).toMatch(/mercado\s+R\$ 30\.00 \(75%\)/)
  })

  test('getRecentTransactions lists newest first', () => {
    addTransaction('saida', 1, 'primeira', '')
    addTransaction('saida', 2, 'segunda', '')
    const text = getRecentTransactions()
    expect(text.indexOf('segunda')).toBeLessThan(text.indexOf('primeira'))
  })

  test('getRecentTransactions breaks a shared timestamp with the later insert', () => {
    const stamp = '2026-11-20T15:00:00.000Z'
    const insert = store().query(
      'INSERT INTO transactions (id, type, amount_cents, category, description, date) VALUES (?, ?, ?, ?, ?, ?)',
    )
    insert.run('oldrow01', 'saida', 100, 'primeira', '', stamp)
    insert.run('newrow02', 'saida', 200, 'segunda', '', stamp)
    const text = getRecentTransactions()
    expect(text.indexOf('segunda')).toBeLessThan(text.indexOf('primeira'))
  })

  test('exportFinanceSnapshot returns every transaction as JSON', () => {
    const tx = addTransaction('saida', 5, 'cafe', '')
    expect(JSON.parse(exportFinanceSnapshot()!)).toEqual([tx])
  })
})

describe('finance — legacy finance.json', () => {
  test('is imported once with ids kept, then renamed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'smolerclaw-finance-'))
    writeFileSync(join(dir, 'finance.json'), JSON.stringify([
      { id: 'abc12345', type: 'saida', amount: 19.9, category: 'mercado', description: 'pão', date: '2026-04-01T10:00:00.000Z' },
      { id: 'bad', type: 'roubo', amount: 1, category: 'x', description: '', date: '2026-04-01T10:00:00.000Z' },
      { type: 'entrada', amount: 50, category: 'pix', description: 'sem id', date: '2026-04-02T10:00:00.000Z' },
    ]))
    initFinance(dir)

    const txs = listTransactions()
    expect(txs).toHaveLength(2)
    expect(txs[0]).toEqual({ id: 'abc12345', type: 'saida', amount: 19.9, category: 'mercado', description: 'pão', date: '2026-04-01T10:00:00.000Z' })
    expect(txs[1].id).toHaveLength(8)
    expect(existsSync(join(dir, 'finance.json'))).toBe(false)
    expect(existsSync(join(dir, 'finance.migrated.json'))).toBe(true)

    closeStore()
    initFinance(dir)
    expect(listTransactions()).toHaveLength(2)
  })

  test('an unreadable file is left untouched', () => {
    const dir = mkdtempSync(join(tmpdir(), 'smolerclaw-finance-'))
    writeFileSync(join(dir, 'finance.json'), '{ quebrado')
    initFinance(dir)
    expect(listTransactions()).toEqual([])
    expect(readFileSync(join(dir, 'finance.json'), 'utf-8')).toBe('{ quebrado')
  })
})
