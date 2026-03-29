import { describe, it, expect } from 'bun:test'
import {
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
} from '../src/input/command-palette'

const testItems: PaletteItem[] = [
  {
    id: 'test-1',
    label: 'Test Command One',
    description: 'First test',
    shortcut: '/test1',
    command: '/test1',
    category: 'command',
    icon: '🧪',
  },
  {
    id: 'test-2',
    label: 'Test Command Two',
    description: 'Second test',
    shortcut: '/test2',
    command: '/test2',
    category: 'command',
  },
  {
    id: 'model-fast',
    label: 'Fast Model',
    description: 'Quick responses',
    command: '/model fast',
    category: 'model',
    keywords: ['quick', 'speedy'],
  },
]

describe('createPaletteState', () => {
  it('creates initial closed state', () => {
    const state = createPaletteState()
    expect(state.visible).toBe(false)
    expect(state.query).toBe('')
    expect(state.filteredItems).toEqual([])
    expect(state.selectedIndex).toBe(0)
    expect(state.recentItems).toEqual([])
  })

  it('accepts recent items', () => {
    const state = createPaletteState(['test-1', 'test-2'])
    expect(state.recentItems).toEqual(['test-1', 'test-2'])
  })
})

describe('openPalette', () => {
  it('opens palette with all items', () => {
    const state = createPaletteState()
    const opened = openPalette(state, testItems)

    expect(opened.visible).toBe(true)
    expect(opened.query).toBe('')
    expect(opened.filteredItems.length).toBe(testItems.length)
    expect(opened.selectedIndex).toBe(0)
  })

  it('uses default items when none provided', () => {
    const state = createPaletteState()
    const opened = openPalette(state)

    expect(opened.filteredItems.length).toBe(DEFAULT_PALETTE_ITEMS.length)
  })
})

describe('closePalette', () => {
  it('resets palette state', () => {
    let state = createPaletteState()
    state = openPalette(state, testItems)
    state = updatePaletteQuery(state, 'test', testItems)

    const closed = closePalette(state)

    expect(closed.visible).toBe(false)
    expect(closed.query).toBe('')
    expect(closed.filteredItems).toEqual([])
  })
})

describe('updatePaletteQuery', () => {
  it('filters items by query', () => {
    let state = createPaletteState()
    state = openPalette(state, testItems)
    state = updatePaletteQuery(state, 'one', testItems)

    // "one" matches "Test Command One" - should be in top results
    expect(state.filteredItems.length).toBeGreaterThan(0)
    expect(state.filteredItems[0].item.id).toBe('test-1')
  })

  it('matches keywords', () => {
    let state = createPaletteState()
    state = openPalette(state, testItems)
    state = updatePaletteQuery(state, 'speedy', testItems)

    expect(state.filteredItems.length).toBe(1)
    expect(state.filteredItems[0].item.id).toBe('model-fast')
  })

  it('resets selection when query changes', () => {
    let state = createPaletteState()
    state = openPalette(state, testItems)
    state = nextPaletteItem(state)
    expect(state.selectedIndex).toBe(1)

    state = updatePaletteQuery(state, 'test', testItems)
    expect(state.selectedIndex).toBe(0)
  })

  it('does nothing when palette is closed', () => {
    const state = createPaletteState()
    const updated = updatePaletteQuery(state, 'test', testItems)
    expect(updated).toBe(state)
  })
})

describe('navigation', () => {
  it('nextPaletteItem cycles forward', () => {
    let state = createPaletteState()
    state = openPalette(state, testItems)

    state = nextPaletteItem(state)
    expect(state.selectedIndex).toBe(1)

    state = nextPaletteItem(state)
    expect(state.selectedIndex).toBe(2)

    state = nextPaletteItem(state)
    expect(state.selectedIndex).toBe(0) // Wraps
  })

  it('prevPaletteItem cycles backward', () => {
    let state = createPaletteState()
    state = openPalette(state, testItems)

    state = prevPaletteItem(state)
    expect(state.selectedIndex).toBe(2) // Wraps to end

    state = prevPaletteItem(state)
    expect(state.selectedIndex).toBe(1)
  })

  it('does nothing with no items', () => {
    let state = createPaletteState()
    state = openPalette(state, testItems)
    state = updatePaletteQuery(state, 'xyz', testItems)

    const after = nextPaletteItem(state)
    expect(after.selectedIndex).toBe(0)
  })
})

describe('getSelectedItem', () => {
  it('returns selected item', () => {
    let state = createPaletteState()
    state = openPalette(state, testItems)

    const item = getSelectedItem(state)
    expect(item).not.toBeNull()
    expect(item!.id).toBe(testItems[0].id)
  })

  it('returns null when closed', () => {
    const state = createPaletteState()
    expect(getSelectedItem(state)).toBeNull()
  })

  it('returns null when no items', () => {
    let state = createPaletteState()
    state = openPalette(state, testItems)
    state = updatePaletteQuery(state, 'xyz', testItems)

    expect(getSelectedItem(state)).toBeNull()
  })
})

describe('confirmPalette', () => {
  it('returns selected item with confirmed flag', () => {
    let state = createPaletteState()
    state = openPalette(state, testItems)

    const result = confirmPalette(state)
    expect(result.item).not.toBeNull()
    expect(result.item!.id).toBe(testItems[0].id)
    expect(result.confirmed).toBe(true)
  })
})

describe('cancelPalette', () => {
  it('returns null item with confirmed false', () => {
    const result = cancelPalette()
    expect(result.item).toBeNull()
    expect(result.confirmed).toBe(false)
  })
})

describe('recordPaletteUsage', () => {
  it('adds item to recent list', () => {
    let state = createPaletteState()
    state = recordPaletteUsage(state, 'test-1')

    expect(state.recentItems).toEqual(['test-1'])
  })

  it('moves existing item to front', () => {
    let state = createPaletteState(['test-2', 'test-3'])
    state = recordPaletteUsage(state, 'test-3')

    expect(state.recentItems).toEqual(['test-3', 'test-2'])
  })

  it('limits recent list size', () => {
    let state = createPaletteState()
    for (let i = 0; i < 15; i++) {
      state = recordPaletteUsage(state, `item-${i}`, 5)
    }

    expect(state.recentItems.length).toBe(5)
    expect(state.recentItems[0]).toBe('item-14')
  })
})

describe('recent items prioritization', () => {
  it('boosts recent items in results', () => {
    let state = createPaletteState(['test-2'])
    state = openPalette(state, testItems)
    state = updatePaletteQuery(state, 'test', testItems)

    // test-2 should be first because it's recent
    expect(state.filteredItems[0].item.id).toBe('test-2')
  })
})

describe('renderPaletteItem', () => {
  it('renders with icon and shortcut', () => {
    const item = testItems[0]
    const rendered = renderPaletteItem(item, [], false, '<', '>')

    expect(rendered).toContain('🧪')
    expect(rendered).toContain('Test Command One')
    expect(rendered).toContain('/test1')
  })

  it('highlights matched characters', () => {
    const item = testItems[0]
    const rendered = renderPaletteItem(item, [0, 5], false, '<', '>')

    expect(rendered).toContain('<T>est <C>ommand One')
  })

  it('shows selection indicator', () => {
    const item = testItems[0]
    const selected = renderPaletteItem(item, [], true)
    const unselected = renderPaletteItem(item, [], false)

    expect(selected).toContain('◆')
    expect(unselected).not.toContain('◆')
  })
})

describe('renderPalette', () => {
  it('renders nothing when closed', () => {
    const state = createPaletteState()
    const lines = renderPalette(state)
    expect(lines).toEqual([])
  })

  it('renders with query and items', () => {
    let state = createPaletteState()
    state = openPalette(state, testItems)
    state = updatePaletteQuery(state, 'test', testItems)

    const lines = renderPalette(state, 10, 40)

    expect(lines.length).toBeGreaterThan(0)
    expect(lines.some(l => l.includes('test'))).toBe(true)
    expect(lines.some(l => l.includes('Enter'))).toBe(true) // Hint
  })

  it('shows no matches message', () => {
    let state = createPaletteState()
    state = openPalette(state, testItems)
    state = updatePaletteQuery(state, 'xyz', testItems)

    const lines = renderPalette(state)
    expect(lines.some(l => l.includes('No matches'))).toBe(true)
  })
})

describe('groupByCategory', () => {
  it('groups items by category', () => {
    let state = createPaletteState()
    state = openPalette(state, testItems)

    const groups = groupByCategory(state.filteredItems)

    expect(groups.has('command')).toBe(true)
    expect(groups.has('model')).toBe(true)
    expect(groups.get('command')!.length).toBe(2)
    expect(groups.get('model')!.length).toBe(1)
  })
})

describe('getCategoryLabel', () => {
  it('returns human-readable labels', () => {
    expect(getCategoryLabel('recent')).toBe('Recent')
    expect(getCategoryLabel('model')).toBe('Models')
    expect(getCategoryLabel('command')).toBe('Commands')
  })
})

describe('real-world scenarios', () => {
  it('finds model with "mh" (model haiku)', () => {
    let state = createPaletteState()
    state = openPalette(state)
    state = updatePaletteQuery(state, 'haiku')

    const item = getSelectedItem(state)
    expect(item).not.toBeNull()
    expect(item!.command).toBe('/model haiku')
  })

  it('finds clear with "cl"', () => {
    let state = createPaletteState()
    state = openPalette(state)
    state = updatePaletteQuery(state, 'clear')

    const item = getSelectedItem(state)
    expect(item).not.toBeNull()
    expect(item!.command).toBe('/clear')
  })

  it('quick workflow: open, type, select', () => {
    let state = createPaletteState()

    // Open palette
    state = openPalette(state)
    expect(state.visible).toBe(true)

    // Type query
    state = updatePaletteQuery(state, 'commit')
    expect(state.filteredItems.length).toBeGreaterThan(0)

    // Confirm
    const result = confirmPalette(state)
    expect(result.confirmed).toBe(true)
    expect(result.item?.command).toBe('/commit')
  })
})
