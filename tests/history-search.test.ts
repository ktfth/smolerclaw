import { describe, it, expect } from 'bun:test'
import {
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
} from '../src/input/history-search'

const sampleHistory = [
  '/commit -m "fix bug"',
  '/model haiku',
  '/model sonnet',
  '/sessions',
  '/clear',
  '/commit -m "add feature"',
  '/news tech',
]

describe('createHistorySearch', () => {
  it('creates initial state', () => {
    const state = createHistorySearch('current input')
    expect(state.active).toBe(true)
    expect(state.query).toBe('')
    expect(state.matches).toEqual([])
    expect(state.currentIndex).toBe(0)
    expect(state.originalInput).toBe('current input')
  })
})

describe('updateSearch', () => {
  it('filters history by query', () => {
    const state = createHistorySearch('')
    const updated = updateSearch(state, 'commit', sampleHistory)

    expect(updated.query).toBe('commit')
    expect(updated.matches.length).toBe(2) // Two commit entries
    expect(updated.matches[0].entry).toContain('commit')
  })

  it('returns empty matches for non-matching query', () => {
    const state = createHistorySearch('')
    const updated = updateSearch(state, 'xyz123', sampleHistory)

    expect(updated.matches).toEqual([])
  })

  it('resets currentIndex when query changes', () => {
    let state = createHistorySearch('')
    state = updateSearch(state, 'model', sampleHistory)
    state = nextMatch(state) // Move to index 1
    expect(state.currentIndex).toBe(1)

    state = updateSearch(state, 'models', sampleHistory) // Change query
    expect(state.currentIndex).toBe(0) // Reset
  })

  it('preserves state when inactive', () => {
    const state = { ...createHistorySearch(''), active: false }
    const updated = updateSearch(state, 'test', sampleHistory)
    expect(updated).toBe(state) // Same reference
  })
})

describe('navigation', () => {
  it('nextMatch cycles through matches', () => {
    let state = createHistorySearch('')
    state = updateSearch(state, 'model', sampleHistory)

    expect(state.matches.length).toBe(2)
    expect(state.currentIndex).toBe(0)

    state = nextMatch(state)
    expect(state.currentIndex).toBe(1)

    state = nextMatch(state)
    expect(state.currentIndex).toBe(0) // Wraps around
  })

  it('prevMatch cycles backwards', () => {
    let state = createHistorySearch('')
    state = updateSearch(state, 'model', sampleHistory)

    expect(state.currentIndex).toBe(0)

    state = prevMatch(state)
    expect(state.currentIndex).toBe(1) // Wraps to last

    state = prevMatch(state)
    expect(state.currentIndex).toBe(0)
  })

  it('navigation does nothing with no matches', () => {
    let state = createHistorySearch('')
    state = updateSearch(state, 'xyz', sampleHistory)

    const after = nextMatch(state)
    expect(after.currentIndex).toBe(0)
  })
})

describe('getCurrentMatch', () => {
  it('returns current match', () => {
    let state = createHistorySearch('')
    state = updateSearch(state, 'commit', sampleHistory)

    const match = getCurrentMatch(state)
    expect(match).toContain('commit')
  })

  it('returns null when no matches', () => {
    let state = createHistorySearch('')
    state = updateSearch(state, 'xyz', sampleHistory)

    expect(getCurrentMatch(state)).toBeNull()
  })

  it('returns null when inactive', () => {
    const state = { ...createHistorySearch(''), active: false }
    expect(getCurrentMatch(state)).toBeNull()
  })
})

describe('acceptSearch', () => {
  it('returns selected entry with execute flag', () => {
    let state = createHistorySearch('original')
    state = updateSearch(state, 'model', sampleHistory)

    const result = acceptSearch(state)
    expect(result.selected).toContain('model')
    expect(result.execute).toBe(true)
  })

  it('returns null when no matches', () => {
    let state = createHistorySearch('original')
    state = updateSearch(state, 'xyz', sampleHistory)

    const result = acceptSearch(state)
    expect(result.selected).toBeNull()
    expect(result.execute).toBe(true)
  })
})

describe('cancelSearch', () => {
  it('returns original input without execute', () => {
    let state = createHistorySearch('my original input')
    state = updateSearch(state, 'model', sampleHistory)

    const result = cancelSearch(state)
    expect(result.selected).toBe('my original input')
    expect(result.execute).toBe(false)
  })
})

describe('editSelected', () => {
  it('returns selected entry without execute', () => {
    let state = createHistorySearch('original')
    state = updateSearch(state, 'commit', sampleHistory)

    const result = editSelected(state)
    expect(result.selected).toContain('commit')
    expect(result.execute).toBe(false)
  })

  it('returns original input when no match', () => {
    let state = createHistorySearch('original')
    state = updateSearch(state, 'xyz', sampleHistory)

    const result = editSelected(state)
    expect(result.selected).toBe('original')
    expect(result.execute).toBe(false)
  })
})

describe('formatSearchPrompt', () => {
  it('formats with bash-style prompt', () => {
    let state = createHistorySearch('')
    state = updateSearch(state, 'model', sampleHistory)

    const prompt = formatSearchPrompt(state, '<', '>')
    expect(prompt).toContain("(reverse-i-search)`model':")
    expect(prompt).toContain('model') // highlighted
  })

  it('shows failing state when no matches', () => {
    let state = createHistorySearch('')
    state = updateSearch(state, 'xyz', sampleHistory)

    const prompt = formatSearchPrompt(state)
    expect(prompt).toContain('failing')
  })

  it('returns empty string when inactive', () => {
    const state = { ...createHistorySearch(''), active: false }
    expect(formatSearchPrompt(state)).toBe('')
  })
})

describe('formatSearchStatus', () => {
  it('shows current/total format', () => {
    let state = createHistorySearch('')
    state = updateSearch(state, 'model', sampleHistory)

    expect(formatSearchStatus(state)).toBe('[1/2]')

    state = nextMatch(state)
    expect(formatSearchStatus(state)).toBe('[2/2]')
  })

  it('shows 0/0 when no matches', () => {
    let state = createHistorySearch('')
    state = updateSearch(state, 'xyz', sampleHistory)

    expect(formatSearchStatus(state)).toBe('[0/0]')
  })
})

describe('isSearchFailing', () => {
  it('returns true when query has no matches', () => {
    let state = createHistorySearch('')
    state = updateSearch(state, 'xyz', sampleHistory)

    expect(isSearchFailing(state)).toBe(true)
  })

  it('returns false when matches exist', () => {
    let state = createHistorySearch('')
    state = updateSearch(state, 'model', sampleHistory)

    expect(isSearchFailing(state)).toBe(false)
  })

  it('returns false with empty query', () => {
    const state = createHistorySearch('')
    expect(isSearchFailing(state)).toBe(false)
  })

  it('returns false when inactive', () => {
    let state = createHistorySearch('')
    state = updateSearch(state, 'xyz', sampleHistory)
    state = { ...state, active: false }

    expect(isSearchFailing(state)).toBe(false)
  })
})

describe('real-world scenarios', () => {
  it('finds commit command with partial query', () => {
    let state = createHistorySearch('')
    state = updateSearch(state, 'cmt', sampleHistory)

    const match = getCurrentMatch(state)
    expect(match).toContain('commit')
  })

  it('cycles through model commands', () => {
    let state = createHistorySearch('')
    state = updateSearch(state, '/model', sampleHistory)

    const first = getCurrentMatch(state)
    state = nextMatch(state)
    const second = getCurrentMatch(state)

    expect(first).not.toBe(second)
    expect(first).toContain('model')
    expect(second).toContain('model')
  })

  it('supports edit-then-run workflow', () => {
    let state = createHistorySearch('')
    state = updateSearch(state, 'commit', sampleHistory)

    // User wants to edit before running
    const result = editSelected(state)
    expect(result.selected).toContain('commit')
    expect(result.execute).toBe(false) // Don't run yet
  })
})
