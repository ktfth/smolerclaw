/**
 * Advanced ANSI Table Rendering — Dynamic, aligned tables for terminal display.
 *
 * Features:
 *   - Auto-sizing columns based on terminal width
 *   - Unicode box-drawing characters
 *   - Cell alignment (left, center, right)
 *   - Color support per cell
 *   - Header styling
 *   - Row striping
 */

import { A, C, stripAnsi, visibleLength } from '../ansi'

// ─── Types ────────────────────────────────────────────────────

export type CellAlign = 'left' | 'center' | 'right'

export interface TableColumn {
  header: string
  key: string
  width?: number        // Fixed width (overrides auto)
  minWidth?: number     // Minimum width
  maxWidth?: number     // Maximum width
  align?: CellAlign
  headerAlign?: CellAlign
  color?: string        // Default color for cells in this column
  headerColor?: string  // Header-specific color
}

export interface TableCell {
  value: string
  color?: string
  align?: CellAlign
  span?: number         // Column span (for merged cells)
}

export interface TableRow {
  cells: (string | TableCell)[]
  isHeader?: boolean
  isSeparator?: boolean
  color?: string        // Row-level color
}

export interface TableOptions {
  columns: TableColumn[]
  rows: TableRow[]
  maxWidth?: number           // Maximum table width (default: terminal width)
  border?: 'single' | 'double' | 'rounded' | 'none' | 'ascii'
  headerStyle?: 'bold' | 'inverse' | 'underline' | 'none'
  stripeRows?: boolean        // Alternate row colors
  padding?: number            // Cell padding (default: 1)
  compact?: boolean           // Minimal spacing
}

// ─── Border Characters ────────────────────────────────────────

const BORDERS = {
  single: {
    topLeft: '┌', topRight: '┐', bottomLeft: '└', bottomRight: '┘',
    horizontal: '─', vertical: '│',
    leftT: '├', rightT: '┤', topT: '┬', bottomT: '┴', cross: '┼',
  },
  double: {
    topLeft: '╔', topRight: '╗', bottomLeft: '╚', bottomRight: '╝',
    horizontal: '═', vertical: '║',
    leftT: '╠', rightT: '╣', topT: '╦', bottomT: '╩', cross: '╬',
  },
  rounded: {
    topLeft: '╭', topRight: '╮', bottomLeft: '╰', bottomRight: '╯',
    horizontal: '─', vertical: '│',
    leftT: '├', rightT: '┤', topT: '┬', bottomT: '┴', cross: '┼',
  },
  ascii: {
    topLeft: '+', topRight: '+', bottomLeft: '+', bottomRight: '+',
    horizontal: '-', vertical: '|',
    leftT: '+', rightT: '+', topT: '+', bottomT: '+', cross: '+',
  },
  none: {
    topLeft: '', topRight: '', bottomLeft: '', bottomRight: '',
    horizontal: '', vertical: ' ',
    leftT: '', rightT: '', topT: '', bottomT: '', cross: '',
  },
}

// ─── Table Rendering ──────────────────────────────────────────

/**
 * Render a table to an array of strings.
 */
export function renderTable(options: TableOptions): string[] {
  const {
    columns,
    rows,
    maxWidth = process.stdout.columns || 80,
    border = 'single',
    headerStyle = 'bold',
    stripeRows = false,
    padding = 1,
    compact = false,
  } = options

  const b = BORDERS[border]
  const hasBorder = border !== 'none'
  const cellPadding = compact ? 0 : padding

  // Calculate column widths
  const widths = calculateColumnWidths(columns, rows, maxWidth, hasBorder, cellPadding)

  const lines: string[] = []

  // Top border
  if (hasBorder) {
    lines.push(renderBorderLine(widths, b.topLeft, b.horizontal, b.topT, b.topRight, cellPadding))
  }

  // Header row
  const headerCells = columns.map((col) => ({
    value: col.header,
    color: col.headerColor || C.heading,
    align: col.headerAlign || 'center',
  }))
  lines.push(renderRow(headerCells, widths, columns, b.vertical, cellPadding, headerStyle, hasBorder))

  // Header separator
  if (hasBorder) {
    lines.push(renderBorderLine(widths, b.leftT, b.horizontal, b.cross, b.rightT, cellPadding))
  }

  // Data rows
  let rowIdx = 0
  for (const row of rows) {
    if (row.isSeparator) {
      if (hasBorder) {
        lines.push(renderBorderLine(widths, b.leftT, b.horizontal, b.cross, b.rightT, cellPadding))
      }
      continue
    }

    const cells = row.cells.map((cell, i) => {
      if (typeof cell === 'string') {
        return {
          value: cell,
          color: row.color || columns[i]?.color,
          align: columns[i]?.align || 'left',
        }
      }
      return {
        value: cell.value,
        color: cell.color || row.color || columns[i]?.color,
        align: cell.align || columns[i]?.align || 'left',
      }
    })

    // Stripe odd rows
    const stripeColor = stripeRows && rowIdx % 2 === 1 ? A.dim : ''

    lines.push(renderRow(cells, widths, columns, b.vertical, cellPadding, 'none', hasBorder, stripeColor))
    rowIdx++
  }

  // Bottom border
  if (hasBorder) {
    lines.push(renderBorderLine(widths, b.bottomLeft, b.horizontal, b.bottomT, b.bottomRight, cellPadding))
  }

  return lines
}

/**
 * Calculate column widths dynamically.
 */
function calculateColumnWidths(
  columns: TableColumn[],
  rows: TableRow[],
  maxWidth: number,
  hasBorder: boolean,
  padding: number,
): number[] {
  const borderOverhead = hasBorder ? columns.length + 1 : 0
  const paddingOverhead = columns.length * padding * 2
  const availableWidth = maxWidth - borderOverhead - paddingOverhead

  // First pass: calculate content widths
  const contentWidths = columns.map((col, i) => {
    // Start with header width
    let maxContent = visibleLength(col.header)

    // Check all row cells
    for (const row of rows) {
      if (row.isSeparator) continue
      const cell = row.cells[i]
      if (!cell) continue
      const val = typeof cell === 'string' ? cell : cell.value
      maxContent = Math.max(maxContent, visibleLength(val))
    }

    return maxContent
  })

  // Apply min/max constraints
  const constrainedWidths = columns.map((col, i) => {
    let w = col.width ?? contentWidths[i]
    if (col.minWidth) w = Math.max(w, col.minWidth)
    if (col.maxWidth) w = Math.min(w, col.maxWidth)
    return w
  })

  // Check if we need to shrink columns
  const totalWidth = constrainedWidths.reduce((a, b) => a + b, 0)
  if (totalWidth <= availableWidth) {
    return constrainedWidths
  }

  // Proportionally shrink columns that don't have fixed widths
  const fixedWidth = columns.reduce((sum, col, i) => {
    return sum + (col.width ? constrainedWidths[i] : 0)
  }, 0)

  const flexColumns = columns.filter((col) => !col.width)
  const flexTotal = constrainedWidths
    .filter((_, i) => !columns[i].width)
    .reduce((a, b) => a + b, 0)

  const flexAvailable = availableWidth - fixedWidth

  return constrainedWidths.map((w, i) => {
    if (columns[i].width) return w
    const ratio = w / flexTotal
    const newWidth = Math.floor(flexAvailable * ratio)
    return Math.max(columns[i].minWidth || 3, newWidth)
  })
}

/**
 * Render a border line.
 */
function renderBorderLine(
  widths: number[],
  left: string,
  fill: string,
  sep: string,
  right: string,
  padding: number,
): string {
  const paddedFill = fill.repeat(padding)
  const segments = widths.map((w) => paddedFill + fill.repeat(w) + paddedFill)
  return `${A.dim}${left}${segments.join(sep)}${right}${A.reset}`
}

/**
 * Render a data row.
 */
function renderRow(
  cells: Array<{ value: string; color?: string; align?: CellAlign }>,
  widths: number[],
  columns: TableColumn[],
  separator: string,
  padding: number,
  style: 'bold' | 'inverse' | 'underline' | 'none',
  hasBorder: boolean,
  stripeColor: string = '',
): string {
  const paddingStr = ' '.repeat(padding)

  const segments = cells.map((cell, i) => {
    const width = widths[i] || 10
    const aligned = alignText(cell.value, width, cell.align || 'left')

    let colored = aligned
    if (cell.color) {
      colored = `${cell.color}${aligned}${A.reset}`
    }
    if (stripeColor) {
      colored = `${stripeColor}${colored}`
    }

    return `${paddingStr}${colored}${paddingStr}`
  })

  let line = segments.join(`${A.dim}${separator}${A.reset}`)

  if (hasBorder) {
    line = `${A.dim}${separator}${A.reset}${line}${A.dim}${separator}${A.reset}`
  }

  // Apply header style
  if (style === 'bold') {
    return `${A.bold}${line}${A.reset}`
  } else if (style === 'inverse') {
    return `${A.inv}${line}${A.reset}`
  } else if (style === 'underline') {
    return `${A.underline}${line}${A.reset}`
  }

  return line
}

/**
 * Align text within a fixed width.
 */
function alignText(text: string, width: number, align: CellAlign): string {
  const plainLen = visibleLength(text)

  if (plainLen >= width) {
    return truncateWithEllipsis(text, width)
  }

  const diff = width - plainLen

  switch (align) {
    case 'center': {
      const left = Math.floor(diff / 2)
      const right = diff - left
      return ' '.repeat(left) + text + ' '.repeat(right)
    }
    case 'right':
      return ' '.repeat(diff) + text
    case 'left':
    default:
      return text + ' '.repeat(diff)
  }
}

/**
 * Truncate text with ellipsis if too long.
 */
function truncateWithEllipsis(text: string, maxWidth: number): string {
  if (maxWidth < 3) return text.slice(0, maxWidth)

  const plain = stripAnsi(text)
  if (plain.length <= maxWidth) return text

  // For ANSI-containing text, we need to be careful
  // Just use plain text truncation for now
  return plain.slice(0, maxWidth - 1) + '…'
}

// ─── Quick Table Builders ─────────────────────────────────────

/**
 * Create a simple table from object array.
 */
export function quickTable<T extends Record<string, unknown>>(
  data: T[],
  columnDefs: Array<{ key: keyof T; header: string; width?: number; align?: CellAlign }>,
  options: Partial<TableOptions> = {},
): string[] {
  const columns: TableColumn[] = columnDefs.map((def) => ({
    header: def.header,
    key: String(def.key),
    width: def.width,
    align: def.align,
  }))

  const rows: TableRow[] = data.map((item) => ({
    cells: columnDefs.map((def) => String(item[def.key] ?? '')),
  }))

  return renderTable({
    columns,
    rows,
    ...options,
  })
}

/**
 * Create a key-value table (2 columns).
 */
export function kvTable(
  items: Array<{ key: string; value: string; valueColor?: string }>,
  options: { keyWidth?: number; maxWidth?: number } = {},
): string[] {
  const { keyWidth = 15, maxWidth = 50 } = options

  const columns: TableColumn[] = [
    { header: 'Campo', key: 'key', width: keyWidth, align: 'right', color: A.dim },
    { header: 'Valor', key: 'value', align: 'left' },
  ]

  const rows: TableRow[] = items.map((item) => ({
    cells: [
      { value: item.key, color: A.dim },
      { value: item.value, color: item.valueColor },
    ],
  }))

  return renderTable({
    columns,
    rows,
    maxWidth,
    border: 'none',
    headerStyle: 'none',
    padding: 1,
  })
}

/**
 * Create a simple list with bullets.
 */
export function bulletList(
  items: string[],
  options: { bullet?: string; color?: string; indent?: number } = {},
): string[] {
  const { bullet = '•', color = A.dim, indent = 2 } = options
  const pad = ' '.repeat(indent)

  return items.map((item) => `${pad}${color}${bullet}${A.reset} ${item}`)
}

// ─── ADR / Decision Table ─────────────────────────────────────

export interface ADREntry {
  id: string
  title: string
  status: 'accepted' | 'rejected' | 'proposed' | 'deprecated'
  date: string
  tags?: string[]
}

/**
 * Render an ADR (Architecture Decision Record) table.
 */
export function renderADRTable(
  entries: ADREntry[],
  maxWidth: number = 80,
): string[] {
  const statusColors: Record<string, string> = {
    accepted: A.fg(114),
    rejected: A.fg(196),
    proposed: A.fg(220),
    deprecated: A.dim,
  }

  const columns: TableColumn[] = [
    { header: 'ID', key: 'id', width: 6, align: 'left' },
    { header: 'Title', key: 'title', minWidth: 20, align: 'left' },
    { header: 'Status', key: 'status', width: 12, align: 'center' },
    { header: 'Date', key: 'date', width: 10, align: 'right', color: A.dim },
  ]

  const rows: TableRow[] = entries.map((entry) => ({
    cells: [
      { value: entry.id, color: A.dim },
      { value: entry.title },
      { value: entry.status, color: statusColors[entry.status] || '' },
      { value: entry.date },
    ],
  }))

  return renderTable({
    columns,
    rows,
    maxWidth,
    border: 'rounded',
    headerStyle: 'bold',
    stripeRows: true,
  })
}

// ─── Financial Summary Table ──────────────────────────────────

export interface FinancialEntry {
  category: string
  income: number
  expense: number
  balance: number
}

/**
 * Render a financial summary table.
 */
export function renderFinancialTable(
  entries: FinancialEntry[],
  maxWidth: number = 70,
): string[] {
  const formatCurrency = (n: number): string => {
    const sign = n >= 0 ? '' : '-'
    return `${sign}R$ ${Math.abs(n).toFixed(2)}`
  }

  const columns: TableColumn[] = [
    { header: 'Categoria', key: 'category', minWidth: 15, align: 'left' },
    { header: 'Receita', key: 'income', width: 12, align: 'right', color: A.fg(114) },
    { header: 'Despesa', key: 'expense', width: 12, align: 'right', color: A.fg(196) },
    { header: 'Saldo', key: 'balance', width: 12, align: 'right' },
  ]

  const rows: TableRow[] = entries.map((entry) => ({
    cells: [
      { value: entry.category },
      { value: formatCurrency(entry.income), color: A.fg(114) },
      { value: formatCurrency(entry.expense), color: A.fg(196) },
      { value: formatCurrency(entry.balance), color: entry.balance >= 0 ? A.fg(114) : A.fg(196) },
    ],
  }))

  // Add total row
  const totals = entries.reduce(
    (acc, e) => ({
      income: acc.income + e.income,
      expense: acc.expense + e.expense,
      balance: acc.balance + e.balance,
    }),
    { income: 0, expense: 0, balance: 0 },
  )

  rows.push({ cells: [], isSeparator: true })
  rows.push({
    cells: [
      { value: 'TOTAL', color: A.bold },
      { value: formatCurrency(totals.income), color: `${A.bold}${A.fg(114)}` },
      { value: formatCurrency(totals.expense), color: `${A.bold}${A.fg(196)}` },
      { value: formatCurrency(totals.balance), color: `${A.bold}${totals.balance >= 0 ? A.fg(114) : A.fg(196)}` },
    ],
  })

  return renderTable({
    columns,
    rows,
    maxWidth,
    border: 'single',
    headerStyle: 'bold',
  })
}

// ─── Project Summary Table ────────────────────────────────────

export interface ProjectEntry {
  name: string
  status: string
  hoursThisWeek: number
  hoursTotal: number
  deadline?: string
}

/**
 * Render a project summary table.
 */
export function renderProjectTable(
  entries: ProjectEntry[],
  maxWidth: number = 80,
): string[] {
  const statusColors: Record<string, string> = {
    active: A.fg(114),
    paused: A.fg(220),
    completed: A.dim,
    overdue: A.fg(196),
  }

  const columns: TableColumn[] = [
    { header: 'Projeto', key: 'name', minWidth: 15, align: 'left' },
    { header: 'Status', key: 'status', width: 10, align: 'center' },
    { header: 'Semana', key: 'hoursThisWeek', width: 8, align: 'right', color: A.dim },
    { header: 'Total', key: 'hoursTotal', width: 8, align: 'right' },
    { header: 'Prazo', key: 'deadline', width: 12, align: 'right', color: A.dim },
  ]

  const rows: TableRow[] = entries.map((entry) => ({
    cells: [
      { value: entry.name },
      { value: entry.status, color: statusColors[entry.status.toLowerCase()] || '' },
      { value: `${entry.hoursThisWeek}h` },
      { value: `${entry.hoursTotal}h` },
      { value: entry.deadline || '—' },
    ],
  }))

  return renderTable({
    columns,
    rows,
    maxWidth,
    border: 'rounded',
    headerStyle: 'bold',
    stripeRows: true,
  })
}
