import { describe, it, expect } from 'bun:test'
import {
  createVimState,
  toggleVimMode,
  setBuffer,
  processKey,
  getModeIndicator,
  getCursorStyle,
} from '../src/input/vim-mode'

describe('createVimState', () => {
  it('creates initial state in insert mode', () => {
    const state = createVimState()
    expect(state.mode).toBe('insert')
    expect(state.enabled).toBe(false)
    expect(state.buffer).toBe('')
    expect(state.cursor).toBe(0)
  })

  it('respects enabled flag', () => {
    const state = createVimState(true)
    expect(state.enabled).toBe(true)
  })
})

describe('toggleVimMode', () => {
  it('toggles enabled state', () => {
    let state = createVimState(false)
    state = toggleVimMode(state)
    expect(state.enabled).toBe(true)

    state = toggleVimMode(state)
    expect(state.enabled).toBe(false)
  })

  it('resets to insert mode when toggled', () => {
    let state = createVimState(true)
    state = setBuffer(state, 'hello')
    state = processKey(state, 'Escape').state // Enter normal
    expect(state.mode).toBe('normal')

    state = toggleVimMode(state) // Toggle off
    state = toggleVimMode(state) // Toggle on
    expect(state.mode).toBe('insert')
  })
})

describe('setBuffer', () => {
  it('sets buffer content', () => {
    let state = createVimState(true)
    state = setBuffer(state, 'hello world')
    expect(state.buffer).toBe('hello world')
  })

  it('clamps cursor to buffer length', () => {
    let state = createVimState(true)
    state = setBuffer(state, 'hello')
    state = { ...state, cursor: 10 }
    state = setBuffer(state, 'hi')
    expect(state.cursor).toBe(2) // Clamped
  })
})

describe('mode switching', () => {
  it('Escape enters normal mode from insert', () => {
    let state = createVimState(true)
    state = setBuffer(state, 'hello')
    expect(state.mode).toBe('insert')

    const result = processKey(state, 'Escape')
    expect(result.state.mode).toBe('normal')
    expect(result.handled).toBe(true)
  })

  it('i enters insert mode from normal', () => {
    let state = createVimState(true)
    state = setBuffer(state, 'hello')
    state = processKey(state, 'Escape').state

    const result = processKey(state, 'i')
    expect(result.state.mode).toBe('insert')
  })

  it('a enters insert after cursor', () => {
    let state = createVimState(true)
    state = setBuffer(state, 'hello')
    state = processKey(state, 'Escape').state
    state = { ...state, cursor: 2 }

    const result = processKey(state, 'a')
    expect(result.state.mode).toBe('insert')
    expect(result.state.cursor).toBe(3) // After 'l'
  })

  it('A enters insert at end of line', () => {
    let state = createVimState(true)
    state = setBuffer(state, 'hello')
    state = processKey(state, 'Escape').state
    state = { ...state, cursor: 0 }

    const result = processKey(state, 'A')
    expect(result.state.mode).toBe('insert')
    expect(result.state.cursor).toBe(5) // At end
  })

  it('I enters insert at line start', () => {
    let state = createVimState(true)
    state = setBuffer(state, 'hello')
    state = processKey(state, 'Escape').state
    state = { ...state, cursor: 3 }

    const result = processKey(state, 'I')
    expect(result.state.mode).toBe('insert')
    expect(result.state.cursor).toBe(0)
  })
})

describe('basic motions', () => {
  it('h moves left', () => {
    let state = createVimState(true)
    state = setBuffer(state, 'hello')
    state = processKey(state, 'Escape').state
    state = { ...state, cursor: 3 }

    state = processKey(state, 'h').state
    expect(state.cursor).toBe(2)
  })

  it('l moves right', () => {
    let state = createVimState(true)
    state = setBuffer(state, 'hello')
    state = processKey(state, 'Escape').state
    state = { ...state, cursor: 2 }

    state = processKey(state, 'l').state
    expect(state.cursor).toBe(3)
  })

  it('0 moves to line start', () => {
    let state = createVimState(true)
    state = setBuffer(state, 'hello')
    state = processKey(state, 'Escape').state
    state = { ...state, cursor: 3 }

    state = processKey(state, '0').state
    expect(state.cursor).toBe(0)
  })

  it('$ moves to line end', () => {
    let state = createVimState(true)
    state = setBuffer(state, 'hello')
    state = processKey(state, 'Escape').state
    state = { ...state, cursor: 1 }

    state = processKey(state, '$').state
    expect(state.cursor).toBe(4) // Last char index
  })

  it('w moves to next word', () => {
    let state = createVimState(true)
    state = setBuffer(state, 'hello world')
    state = processKey(state, 'Escape').state
    state = { ...state, cursor: 0 }

    state = processKey(state, 'w').state
    expect(state.cursor).toBe(6) // Start of 'world'
  })

  it('b moves to previous word', () => {
    let state = createVimState(true)
    state = setBuffer(state, 'hello world')
    state = processKey(state, 'Escape').state
    state = { ...state, cursor: 8 }

    state = processKey(state, 'b').state
    expect(state.cursor).toBe(6) // Start of 'world'

    state = processKey(state, 'b').state
    expect(state.cursor).toBe(0) // Start of 'hello'
  })
})

describe('count prefix', () => {
  it('applies count to motion', () => {
    let state = createVimState(true)
    state = setBuffer(state, 'hello')
    state = processKey(state, 'Escape').state
    state = { ...state, cursor: 0 }

    // 3l = move right 3 times
    state = processKey(state, '3').state
    expect(state.count).toBe(3)

    state = processKey(state, 'l').state
    expect(state.cursor).toBe(3)
    expect(state.count).toBe(0) // Reset after motion
  })

  it('accumulates multi-digit counts', () => {
    let state = createVimState(true)
    state = setBuffer(state, 'hello')
    state = processKey(state, 'Escape').state

    state = processKey(state, '1').state
    state = processKey(state, '2').state
    expect(state.count).toBe(12)
  })
})

describe('delete operations', () => {
  it('x deletes character under cursor', () => {
    let state = createVimState(true)
    state = setBuffer(state, 'hello')
    state = processKey(state, 'Escape').state
    state = { ...state, cursor: 2 }

    state = processKey(state, 'x').state
    expect(state.buffer).toBe('helo')
    expect(state.register).toBe('l')
  })

  it('dd deletes entire line', () => {
    let state = createVimState(true)
    state = setBuffer(state, 'hello')
    state = processKey(state, 'Escape').state

    state = processKey(state, 'd').state
    state = processKey(state, 'd').state
    expect(state.buffer).toBe('')
    expect(state.register).toBe('hello')
  })

  it('dw deletes word', () => {
    let state = createVimState(true)
    state = setBuffer(state, 'hello world')
    state = processKey(state, 'Escape').state
    state = { ...state, cursor: 0 }

    state = processKey(state, 'd').state
    state = processKey(state, 'w').state
    expect(state.buffer).toBe('world')
  })

  it('d$ deletes to end of line', () => {
    let state = createVimState(true)
    state = setBuffer(state, 'hello world')
    state = processKey(state, 'Escape').state
    state = { ...state, cursor: 6 }

    state = processKey(state, 'd').state
    state = processKey(state, '$').state
    expect(state.buffer).toBe('hello ')
  })
})

describe('change operations', () => {
  it('cc clears line and enters insert', () => {
    let state = createVimState(true)
    state = setBuffer(state, 'hello')
    state = processKey(state, 'Escape').state

    state = processKey(state, 'c').state
    state = processKey(state, 'c').state
    expect(state.buffer).toBe('')
    expect(state.mode).toBe('insert')
    expect(state.register).toBe('hello')
  })

  it('cw changes word', () => {
    let state = createVimState(true)
    state = setBuffer(state, 'hello world')
    state = processKey(state, 'Escape').state
    state = { ...state, cursor: 0 }

    state = processKey(state, 'c').state
    state = processKey(state, 'w').state
    expect(state.buffer).toBe('world')
    expect(state.mode).toBe('insert')
  })
})

describe('yank and paste', () => {
  it('yy yanks entire line', () => {
    let state = createVimState(true)
    state = setBuffer(state, 'hello')
    state = processKey(state, 'Escape').state

    state = processKey(state, 'y').state
    state = processKey(state, 'y').state
    expect(state.register).toBe('hello')
    expect(state.buffer).toBe('hello') // Unchanged
  })

  it('p pastes after cursor', () => {
    let state = createVimState(true)
    state = setBuffer(state, 'heo')
    state = processKey(state, 'Escape').state
    state = { ...state, cursor: 1, register: 'll' }

    state = processKey(state, 'p').state
    expect(state.buffer).toBe('hello')
  })

  it('P pastes before cursor', () => {
    let state = createVimState(true)
    state = setBuffer(state, 'world')
    state = processKey(state, 'Escape').state
    state = { ...state, cursor: 0, register: 'hello ' }

    state = processKey(state, 'P').state
    expect(state.buffer).toBe('hello world')
  })
})

describe('Enter key', () => {
  it('submits in insert mode', () => {
    let state = createVimState(true)
    state = setBuffer(state, 'hello')

    const result = processKey(state, 'Enter')
    expect(result.command).toBe('submit')
  })

  it('submits in normal mode', () => {
    let state = createVimState(true)
    state = setBuffer(state, 'hello')
    state = processKey(state, 'Escape').state

    const result = processKey(state, 'Enter')
    expect(result.command).toBe('submit')
  })
})

describe('disabled mode passthrough', () => {
  it('passes through all keys when disabled', () => {
    let state = createVimState(false)
    state = setBuffer(state, 'hello')

    const result = processKey(state, 'h')
    expect(result.handled).toBe(false)

    const escape = processKey(state, 'Escape')
    expect(escape.handled).toBe(false)
  })
})

describe('getModeIndicator', () => {
  it('returns empty when disabled', () => {
    const state = createVimState(false)
    expect(getModeIndicator(state)).toBe('')
  })

  it('returns mode name when enabled', () => {
    let state = createVimState(true)
    expect(getModeIndicator(state)).toContain('INSERT')

    state = processKey(state, 'Escape').state
    expect(getModeIndicator(state)).toContain('NORMAL')
  })

  it('shows pending operator', () => {
    let state = createVimState(true)
    state = processKey(state, 'Escape').state
    state = processKey(state, 'd').state

    expect(getModeIndicator(state)).toContain('d')
  })

  it('shows count', () => {
    let state = createVimState(true)
    state = processKey(state, 'Escape').state
    state = processKey(state, '3').state

    expect(getModeIndicator(state)).toContain('3')
  })
})

describe('getCursorStyle', () => {
  it('returns line when disabled', () => {
    const state = createVimState(false)
    expect(getCursorStyle(state)).toBe('line')
  })

  it('returns line in insert mode', () => {
    const state = createVimState(true)
    expect(getCursorStyle(state)).toBe('line')
  })

  it('returns block in normal mode', () => {
    let state = createVimState(true)
    state = processKey(state, 'Escape').state
    expect(getCursorStyle(state)).toBe('block')
  })
})

describe('real-world scenarios', () => {
  it('quick word deletion: dw', () => {
    let state = createVimState(true)
    state = setBuffer(state, '/model haiku')
    state = processKey(state, 'Escape').state
    state = { ...state, cursor: 7 } // On 'h' of 'haiku'

    state = processKey(state, 'd').state
    state = processKey(state, 'w').state

    expect(state.buffer).toBe('/model ')
  })

  it('change command argument: f<space>cw', () => {
    let state = createVimState(true)
    state = setBuffer(state, '/model sonnet')
    state = processKey(state, 'Escape').state
    state = { ...state, cursor: 7 } // Start of 'sonnet'

    // cw to change 'sonnet'
    state = processKey(state, 'c').state
    state = processKey(state, 'w').state

    expect(state.buffer).toBe('/model ')
    expect(state.mode).toBe('insert')
    // Now user can type 'haiku'
  })

  it('copy and paste command: yy p', () => {
    let state = createVimState(true)
    state = setBuffer(state, '/commit')
    state = processKey(state, 'Escape').state

    // Yank
    state = processKey(state, 'y').state
    state = processKey(state, 'y').state
    expect(state.register).toBe('/commit')

    // Clear and paste
    state = processKey(state, 'd').state
    state = processKey(state, 'd').state
    expect(state.buffer).toBe('')

    state = processKey(state, 'p').state
    expect(state.buffer).toBe('/commit')
  })
})
