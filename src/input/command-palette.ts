/**
 * Command Palette (Ctrl+P style) - VS Code-inspired quick command access.
 *
 * Provides fuzzy-searchable command list with categories, shortcuts,
 * and recent items prioritization.
 */

import { fuzzyFilter, highlightMatches, type FuzzyMatch } from './fuzzy'

export type PaletteCategory = 'command' | 'session' | 'model' | 'recent' | 'action'

export interface PaletteItem {
  /** Unique identifier */
  id: string
  /** Display label */
  label: string
  /** Optional description (shown dimmed) */
  description?: string
  /** Keyboard shortcut hint */
  shortcut?: string
  /** Command to execute (e.g., '/model haiku') */
  command?: string
  /** Category for grouping */
  category: PaletteCategory
  /** Action to execute (alternative to command) */
  action?: () => void | Promise<void>
  /** Icon/emoji prefix */
  icon?: string
  /** Keywords for better matching */
  keywords?: string[]
}

export interface PaletteState {
  /** Whether palette is visible */
  visible: boolean
  /** Current search query */
  query: string
  /** Filtered items with match info */
  filteredItems: Array<{ item: PaletteItem; match: FuzzyMatch }>
  /** Currently selected index */
  selectedIndex: number
  /** Recent items (IDs) for prioritization */
  recentItems: string[]
}

export interface PaletteResult {
  /** Selected item, or null if cancelled */
  item: PaletteItem | null
  /** Whether user pressed Enter (vs Esc) */
  confirmed: boolean
}

/**
 * Default command palette items.
 * These can be extended with registerPaletteItems().
 */
export const DEFAULT_PALETTE_ITEMS: PaletteItem[] = [
  // Models
  {
    id: 'model-haiku',
    label: 'Model: Haiku',
    description: 'Fast, cost-effective',
    shortcut: '/model haiku',
    command: '/model haiku',
    category: 'model',
    icon: '🐦',
    keywords: ['fast', 'cheap', 'quick'],
  },
  {
    id: 'model-sonnet',
    label: 'Model: Sonnet',
    description: 'Balanced performance',
    shortcut: '/model sonnet',
    command: '/model sonnet',
    category: 'model',
    icon: '📝',
    keywords: ['balanced', 'default'],
  },
  {
    id: 'model-opus',
    label: 'Model: Opus',
    description: 'Most capable',
    shortcut: '/model opus',
    command: '/model opus',
    category: 'model',
    icon: '🎭',
    keywords: ['best', 'powerful', 'smart'],
  },

  // Session Management
  {
    id: 'session-new',
    label: 'New Session',
    description: 'Start fresh conversation',
    shortcut: '/new',
    command: '/new',
    category: 'session',
    icon: '✨',
    keywords: ['create', 'fresh', 'start'],
  },
  {
    id: 'session-load',
    label: 'Load Session...',
    description: 'Open previous conversation',
    shortcut: '/sessions',
    command: '/sessions',
    category: 'session',
    icon: '📂',
    keywords: ['open', 'previous', 'history'],
  },
  {
    id: 'session-fork',
    label: 'Fork Session',
    description: 'Branch from current point',
    shortcut: '/fork',
    command: '/fork',
    category: 'session',
    icon: '🔀',
    keywords: ['branch', 'duplicate', 'copy'],
  },

  // Actions
  {
    id: 'action-clear',
    label: 'Clear Screen',
    description: 'Clear message history',
    shortcut: '/clear',
    command: '/clear',
    category: 'action',
    icon: '🧹',
    keywords: ['clean', 'reset'],
  },
  {
    id: 'action-commit',
    label: 'Git Commit',
    description: 'Commit with AI message',
    shortcut: '/commit',
    command: '/commit',
    category: 'action',
    icon: '📦',
    keywords: ['git', 'save', 'version'],
  },
  {
    id: 'action-undo',
    label: 'Undo Last Action',
    description: 'Revert previous change',
    shortcut: '/undo',
    command: '/undo',
    category: 'action',
    icon: '↩️',
    keywords: ['revert', 'back'],
  },
  {
    id: 'action-retry',
    label: 'Retry Last Message',
    description: 'Regenerate response',
    shortcut: '/retry',
    command: '/retry',
    category: 'action',
    icon: '🔄',
    keywords: ['again', 'regenerate'],
  },
  {
    id: 'action-copy',
    label: 'Copy Last Response',
    description: 'Copy to clipboard',
    shortcut: '/copy',
    command: '/copy',
    category: 'action',
    icon: '📋',
    keywords: ['clipboard'],
  },

  // Commands
  {
    id: 'cmd-briefing',
    label: 'Daily Briefing',
    description: 'Overview of your day',
    shortcut: '/briefing',
    command: '/briefing',
    category: 'command',
    icon: '📊',
    keywords: ['summary', 'overview', 'today'],
  },
  {
    id: 'cmd-news',
    label: 'News Feed',
    description: 'Read latest news',
    shortcut: '/news',
    command: '/news',
    category: 'command',
    icon: '📰',
    keywords: ['headlines', 'articles'],
  },
  {
    id: 'cmd-tasks',
    label: 'Task List',
    description: 'View pending tasks',
    shortcut: '/tasks',
    command: '/tasks',
    category: 'command',
    icon: '✅',
    keywords: ['todo', 'pending'],
  },
  {
    id: 'cmd-people',
    label: 'Contacts',
    description: 'Manage people & teams',
    shortcut: '/people',
    command: '/people',
    category: 'command',
    icon: '👥',
    keywords: ['contacts', 'team', 'family'],
  },
  {
    id: 'cmd-projects',
    label: 'Projects',
    description: 'Manage projects',
    shortcut: '/projects',
    command: '/projects',
    category: 'command',
    icon: '📁',
    keywords: ['work', 'portfolio'],
  },
  {
    id: 'cmd-memos',
    label: 'Memos',
    description: 'Quick notes & memos',
    shortcut: '/memos',
    command: '/memos',
    category: 'command',
    icon: '📝',
    keywords: ['notes', 'scratch'],
  },
  {
    id: 'cmd-dashboard',
    label: 'Dashboard',
    description: 'Visual overview',
    shortcut: '/dashboard',
    command: '/dashboard',
    category: 'command',
    icon: '📈',
    keywords: ['overview', 'stats'],
  },
  {
    id: 'cmd-pomodoro',
    label: 'Pomodoro Timer',
    description: 'Focus timer',
    shortcut: '/pomodoro',
    command: '/pomodoro start',
    category: 'command',
    icon: '🍅',
    keywords: ['focus', 'timer', 'productivity'],
  },
  {
    id: 'cmd-vault',
    label: 'Vault Status',
    description: 'Check backup status',
    shortcut: '/vault',
    command: '/vault',
    category: 'command',
    icon: '🔐',
    keywords: ['backup', 'storage'],
  },
  {
    id: 'cmd-help',
    label: 'Help',
    description: 'Show all commands',
    shortcut: '/help',
    command: '/help',
    category: 'command',
    icon: '❓',
    keywords: ['commands', 'manual'],
  },
  {
    id: 'cmd-exit',
    label: 'Exit',
    description: 'Close application',
    shortcut: '/exit',
    command: '/exit',
    category: 'command',
    icon: '🚪',
    keywords: ['quit', 'close'],
  },
]

/**
 * Create initial palette state.
 */
export function createPaletteState(recentItems: string[] = []): PaletteState {
  return {
    visible: false,
    query: '',
    filteredItems: [],
    selectedIndex: 0,
    recentItems,
  }
}

/**
 * Open the command palette.
 */
export function openPalette(
  state: PaletteState,
  items: PaletteItem[] = DEFAULT_PALETTE_ITEMS
): PaletteState {
  const initialFiltered = filterPaletteItems('', items, state.recentItems)
  return {
    ...state,
    visible: true,
    query: '',
    filteredItems: initialFiltered,
    selectedIndex: 0,
  }
}

/**
 * Close the command palette.
 */
export function closePalette(state: PaletteState): PaletteState {
  return {
    ...state,
    visible: false,
    query: '',
    filteredItems: [],
    selectedIndex: 0,
  }
}

/**
 * Filter palette items by query with fuzzy matching.
 * Recent items get a score boost.
 */
function filterPaletteItems(
  query: string,
  items: PaletteItem[],
  recentItems: string[]
): Array<{ item: PaletteItem; match: FuzzyMatch }> {
  const recentSet = new Set(recentItems)

  // Create searchable text for each item
  const searchableItems = items.map(item => {
    const searchText = [
      item.label,
      item.description || '',
      item.shortcut || '',
      ...(item.keywords || []),
    ].join(' ')
    return { item, searchText }
  })

  // Filter with fuzzy matching
  const filtered = fuzzyFilter(query, searchableItems, s => s.searchText)

  // Boost recent items
  const boosted = filtered.map(({ item: wrapper, match }) => {
    const isRecent = recentSet.has(wrapper.item.id)
    const boostedScore = isRecent ? match.score + 100 : match.score
    return {
      item: wrapper.item,
      match: { ...match, score: boostedScore, item: wrapper.item.label },
    }
  })

  // Sort by boosted score
  boosted.sort((a, b) => b.match.score - a.match.score)

  return boosted
}

/**
 * Update palette with new query.
 */
export function updatePaletteQuery(
  state: PaletteState,
  query: string,
  items: PaletteItem[] = DEFAULT_PALETTE_ITEMS
): PaletteState {
  if (!state.visible) return state

  const filtered = filterPaletteItems(query, items, state.recentItems)
  return {
    ...state,
    query,
    filteredItems: filtered,
    selectedIndex: 0,
  }
}

/**
 * Navigate to next item.
 */
export function nextPaletteItem(state: PaletteState): PaletteState {
  if (!state.visible || state.filteredItems.length === 0) return state

  const nextIndex = (state.selectedIndex + 1) % state.filteredItems.length
  return { ...state, selectedIndex: nextIndex }
}

/**
 * Navigate to previous item.
 */
export function prevPaletteItem(state: PaletteState): PaletteState {
  if (!state.visible || state.filteredItems.length === 0) return state

  const prevIndex = state.selectedIndex === 0
    ? state.filteredItems.length - 1
    : state.selectedIndex - 1
  return { ...state, selectedIndex: prevIndex }
}

/**
 * Get currently selected item.
 */
export function getSelectedItem(state: PaletteState): PaletteItem | null {
  if (!state.visible || state.filteredItems.length === 0) return null
  return state.filteredItems[state.selectedIndex]?.item ?? null
}

/**
 * Confirm selection (Enter).
 */
export function confirmPalette(state: PaletteState): PaletteResult {
  const item = getSelectedItem(state)
  return { item, confirmed: true }
}

/**
 * Cancel palette (Esc).
 */
export function cancelPalette(): PaletteResult {
  return { item: null, confirmed: false }
}

/**
 * Record item usage for "recent" prioritization.
 */
export function recordPaletteUsage(
  state: PaletteState,
  itemId: string,
  maxRecent = 10
): PaletteState {
  // Remove if already present, add to front
  const filtered = state.recentItems.filter(id => id !== itemId)
  const updated = [itemId, ...filtered].slice(0, maxRecent)
  return { ...state, recentItems: updated }
}

/**
 * Render a single palette item for display.
 */
export function renderPaletteItem(
  item: PaletteItem,
  matchIndices: number[],
  isSelected: boolean,
  highlightStart = '\x1b[1;33m',
  highlightEnd = '\x1b[0m'
): string {
  const icon = item.icon ? `${item.icon} ` : ''
  const label = highlightMatches(item.label, matchIndices, highlightStart, highlightEnd)
  const desc = item.description ? ` \x1b[2m${item.description}\x1b[0m` : ''
  const shortcut = item.shortcut ? ` \x1b[36m${item.shortcut}\x1b[0m` : ''

  const prefix = isSelected ? '\x1b[7m◆\x1b[0m ' : '  '

  return `${prefix}${icon}${label}${desc}${shortcut}`
}

/**
 * Render the complete palette view.
 */
export function renderPalette(
  state: PaletteState,
  maxVisible = 10,
  width = 50
): string[] {
  if (!state.visible) return []

  const lines: string[] = []

  // Header
  const border = '─'.repeat(width - 2)
  lines.push(`┌${border}┐`)
  lines.push(`│ > ${state.query.padEnd(width - 6)}│`)
  lines.push(`├${border}┤`)

  // Items
  const start = Math.max(0, state.selectedIndex - Math.floor(maxVisible / 2))
  const end = Math.min(state.filteredItems.length, start + maxVisible)
  const visibleItems = state.filteredItems.slice(start, end)

  if (visibleItems.length === 0) {
    lines.push(`│ ${'No matches found'.padEnd(width - 4)} │`)
  } else {
    for (let i = 0; i < visibleItems.length; i++) {
      const { item, match } = visibleItems[i]
      const isSelected = start + i === state.selectedIndex
      const rendered = renderPaletteItem(item, match.indices, isSelected)
      // Truncate to fit
      const truncated = rendered.length > width - 4
        ? rendered.slice(0, width - 7) + '...'
        : rendered
      lines.push(`│ ${truncated.padEnd(width - 4)} │`)
    }
  }

  // Footer
  lines.push(`├${border}┤`)
  const hint = '↑↓ navigate  Enter select  Esc cancel'
  lines.push(`│ \x1b[2m${hint.padEnd(width - 4)}\x1b[0m │`)
  lines.push(`└${border}┘`)

  return lines
}

/**
 * Group palette items by category for display.
 */
export function groupByCategory(
  items: Array<{ item: PaletteItem; match: FuzzyMatch }>
): Map<PaletteCategory, Array<{ item: PaletteItem; match: FuzzyMatch }>> {
  const groups = new Map<PaletteCategory, Array<{ item: PaletteItem; match: FuzzyMatch }>>()

  for (const entry of items) {
    const category = entry.item.category
    if (!groups.has(category)) {
      groups.set(category, [])
    }
    groups.get(category)!.push(entry)
  }

  return groups
}

/**
 * Get category display name.
 */
export function getCategoryLabel(category: PaletteCategory): string {
  const labels: Record<PaletteCategory, string> = {
    recent: 'Recent',
    model: 'Models',
    session: 'Sessions',
    action: 'Actions',
    command: 'Commands',
  }
  return labels[category]
}
