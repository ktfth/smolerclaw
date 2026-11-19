import type Anthropic from '@anthropic-ai/sdk'
import { addTransaction, getMonthSummary } from '../../finance'
import { verifyTransaction, recordVerifiedTransaction, formatVerification } from '../../finance-guard'
import { logDecision, searchDecisions, listDecisions, formatDecisionList } from '../../decisions'
import { bindTools, ok, fail, requireText, optionalText, optionalStrings, type ToolHandler } from '../../core/result'

const SCHEMAS: Anthropic.Tool[] = [
  {
    name: 'record_transaction',
    description:
      'Record a financial transaction (income or expense). ' +
      'Use when user mentions spending, receiving money, or financial tracking.',
    input_schema: {
      type: 'object' as const,
      properties: {
        type: { type: 'string', enum: ['entrada', 'saida'], description: 'Transaction type: entrada (income) or saida (expense)' },
        amount: { type: 'number', description: 'Amount in BRL (always positive)' },
        category: { type: 'string', description: 'Category (e.g. alimentacao, transporte, salario, freelance)' },
        description: { type: 'string', description: 'Description of the transaction' },
      },
      required: ['type', 'amount', 'category', 'description'],
    },
  },
  {
    name: 'financial_summary',
    description: 'Show monthly financial summary with income, expenses, and balance by category.',
    input_schema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  },
  {
    name: 'log_decision',
    description:
      'Record an important decision with context and rationale. ' +
      'Use when the user says "decidi", "optei por", "escolhi", or discusses a major choice.',
    input_schema: {
      type: 'object' as const,
      properties: {
        title: { type: 'string', description: 'Decision title (short)' },
        context: { type: 'string', description: 'Why this decision was needed' },
        chosen: { type: 'string', description: 'What was decided' },
        alternatives: { type: 'string', description: 'What was considered but rejected. Optional.' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Tags for categorization. Optional.' },
      },
      required: ['title', 'context', 'chosen'],
    },
  },
  {
    name: 'search_decisions',
    description: 'Search past decisions by keyword or tag.',
    input_schema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'Search query' },
      },
      required: ['query'],
    },
  },
]

const HANDLERS: Record<string, ToolHandler> = {
  record_transaction: (input) => {
    const type = input.type as 'entrada' | 'saida'
    const amount = input.amount
    const category = requireText(input, 'category')
    const description = requireText(input, 'description')
    if (!type || typeof amount !== 'number' || amount <= 0 || !category || !description) {
      return fail('type, a positive amount, category, and description are required.')
    }

    const verification = verifyTransaction(type, amount, category, description)
    if (!verification.allowed) return fail(verification.blocked ?? 'transaction blocked by finance guard.')

    const tx = addTransaction(type, amount, category, description)
    recordVerifiedTransaction(type, amount, category)

    const sign = tx.type === 'entrada' ? '+' : '-'
    const warningText = formatVerification(verification)
    const text = `${sign} R$ ${tx.amount.toFixed(2)} (${tx.category}) — ${tx.description} [${tx.id}]`
    return ok(warningText ? `${text}\n${warningText}` : text, tx)
  },
  financial_summary: () => ok(getMonthSummary()),
  log_decision: (input) => {
    const title = requireText(input, 'title')
    const context = requireText(input, 'context')
    const chosen = requireText(input, 'chosen')
    if (!title || !context || !chosen) return fail('title, context, and chosen are required.')
    const d = logDecision(title, context, chosen, optionalText(input, 'alternatives'), optionalStrings(input, 'tags') ?? [])
    return ok(`Decisão registrada: "${d.title}" {${d.id}}`, d)
  },
  search_decisions: (input) => {
    const query = requireText(input, 'query')
    const decisions = query ? searchDecisions(query) : listDecisions()
    return ok(formatDecisionList(decisions), decisions)
  },
}

export const FINANCE_TOOLS = bindTools(SCHEMAS, HANDLERS, ['financial_summary', 'search_decisions'])
