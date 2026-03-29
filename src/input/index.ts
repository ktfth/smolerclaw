/**
 * Input handling module - ergonomic command line interaction.
 *
 * This module provides muscle-memory-friendly input patterns:
 * - Fuzzy matching for fast command discovery
 * - Ctrl+R reverse history search (bash/zsh style)
 * - Command palette (VS Code style Ctrl+P)
 * - Vim modal editing for power users
 */

// Fuzzy matching
export {
  fuzzyMatch,
  fuzzyFilter,
  highlightMatches,
  bestMatch,
  isPrefix,
  commonPrefix,
  type FuzzyMatch,
  type FuzzyConfig,
} from './fuzzy'

// History search (Ctrl+R)
export {
  createHistorySearch,
  updateSearch,
  nextMatch,
  prevMatch,
  getCurrentMatch,
  acceptSearch,
  cancelSearch,
  editSelected,
  formatSearchPrompt,
  formatSearchStatus,
  isSearchFailing,
  type HistorySearchState,
  type HistorySearchResult,
} from './history-search'

// Command palette (Ctrl+P)
export {
  createPaletteState,
  openPalette,
  closePalette,
  updatePaletteQuery,
  nextPaletteItem,
  prevPaletteItem,
  getSelectedItem,
  confirmPalette,
  cancelPalette,
  recordPaletteUsage,
  renderPaletteItem,
  renderPalette,
  groupByCategory,
  getCategoryLabel,
  DEFAULT_PALETTE_ITEMS,
  type PaletteItem,
  type PaletteState,
  type PaletteResult,
  type PaletteCategory,
} from './command-palette'

// Vim mode
export {
  createVimState,
  toggleVimMode,
  setBuffer,
  processKey,
  getModeIndicator,
  getCursorStyle,
  type VimState,
  type VimMode,
  type VimResult,
} from './vim-mode'
