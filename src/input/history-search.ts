/**
 * Reverse incremental history search (Ctrl+R style).
 *
 * Provides bash/zsh-like reverse search through command history.
 * Integrates with the existing InputHistory class via its entries.
 */

import { fuzzyFilter, highlightMatches, type FuzzyMatch } from './fuzzy'

export interface HistorySearchState {
  /** Whether search mode is active */
  active: boolean
  /** Current search query */
  query: string
  /** All matching entries with scores */
  matches: Array<{ entry: string; match: FuzzyMatch }>
  /** Index of currently selected match (0 = best match) */
  currentIndex: number
  /** Original input before search started (to restore on cancel) */
  originalInput: string
}

export interface HistorySearchResult {
  /** The selected entry, or null if cancelled */
  selected: string | null
  /** Whether user wants to execute immediately (Enter vs Esc) */
  execute: boolean
}

/**
 * Create initial search state.
 */
export function createHistorySearch(originalInput: string): HistorySearchState {
  return {
    active: true,
    query: '',
    matches: [],
    currentIndex: 0,
    originalInput,
  }
}

/**
 * Update search with new query or history entries.
 * Returns updated state (immutable).
 */
export function updateSearch(
  state: HistorySearchState,
  query: string,
  historyEntries: string[]
): HistorySearchState {
  if (!state.active) return state

  // Filter history with fuzzy matching
  const matches = fuzzyFilter(query, historyEntries)
    .map(({ item, match }) => ({ entry: item as string, match }))

  return {
    ...state,
    query,
    matches,
    currentIndex: 0, // Reset to best match when query changes
  }
}

/**
 * Navigate to next match (Ctrl+R again).
 */
export function nextMatch(state: HistorySearchState): HistorySearchState {
  if (!state.active || state.matches.length === 0) return state

  const nextIndex = (state.currentIndex + 1) % state.matches.length
  return { ...state, currentIndex: nextIndex }
}

/**
 * Navigate to previous match (Ctrl+S or Shift+Ctrl+R).
 */
export function prevMatch(state: HistorySearchState): HistorySearchState {
  if (!state.active || state.matches.length === 0) return state

  const prevIndex = state.currentIndex === 0
    ? state.matches.length - 1
    : state.currentIndex - 1
  return { ...state, currentIndex: prevIndex }
}

/**
 * Get currently selected entry, or null if no matches.
 */
export function getCurrentMatch(state: HistorySearchState): string | null {
  if (!state.active || state.matches.length === 0) return null
  return state.matches[state.currentIndex]?.entry ?? null
}

/**
 * Accept current selection (Enter).
 */
export function acceptSearch(state: HistorySearchState): HistorySearchResult {
  return {
    selected: getCurrentMatch(state),
    execute: true,
  }
}

/**
 * Cancel search (Esc or Ctrl+G).
 */
export function cancelSearch(state: HistorySearchState): HistorySearchResult {
  return {
    selected: state.originalInput,
    execute: false,
  }
}

/**
 * Exit search mode but keep the selected text for editing (Ctrl+J or Right arrow).
 */
export function editSelected(state: HistorySearchState): HistorySearchResult {
  return {
    selected: getCurrentMatch(state) ?? state.originalInput,
    execute: false,
  }
}

/**
 * Format the search prompt for display.
 * Returns the classic bash-style "(reverse-i-search)`query': result" format.
 */
export function formatSearchPrompt(
  state: HistorySearchState,
  highlightStart = '\x1b[1;33m',
  highlightEnd = '\x1b[0m'
): string {
  if (!state.active) return ''

  const label = state.matches.length === 0 && state.query
    ? '(failing reverse-i-search)'
    : '(reverse-i-search)'

  const match = getCurrentMatch(state)
  const displayMatch = match
    ? highlightMatches(
        match,
        state.matches[state.currentIndex]?.match.indices ?? [],
        highlightStart,
        highlightEnd
      )
    : ''

  return `${label}\`${state.query}': ${displayMatch}`
}

/**
 * Format a compact status indicator for the search.
 */
export function formatSearchStatus(state: HistorySearchState): string {
  if (!state.active) return ''

  const total = state.matches.length
  const current = total > 0 ? state.currentIndex + 1 : 0

  return `[${current}/${total}]`
}

/**
 * Check if search is in "failing" state (no matches for current query).
 */
export function isSearchFailing(state: HistorySearchState): boolean {
  return state.active && state.query.length > 0 && state.matches.length === 0
}
