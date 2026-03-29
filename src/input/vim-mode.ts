/**
 * Vim-style modal editing for command line input.
 *
 * Implements core vim motions and operators for muscle-memory navigation.
 * Designed for single-line command input, not full-text editing.
 */

export type VimMode = 'normal' | 'insert' | 'visual'

export interface VimState {
  /** Current mode */
  mode: VimMode
  /** Pending operator (d, c, y) waiting for motion */
  operator: string | null
  /** Numeric count prefix (e.g., 3w = move 3 words) */
  count: number
  /** Yank register content */
  register: string
  /** Cursor position in the buffer */
  cursor: number
  /** Visual mode start position */
  visualStart: number | null
  /** Input buffer */
  buffer: string
  /** Whether vim mode is enabled globally */
  enabled: boolean
}

export interface VimResult {
  /** Updated state */
  state: VimState
  /** Whether the key was handled */
  handled: boolean
  /** Command to execute (e.g., submit line) */
  command?: 'submit' | 'cancel'
}

/**
 * Create initial vim state.
 */
export function createVimState(enabled = false): VimState {
  return {
    mode: 'insert', // Start in insert mode for familiarity
    operator: null,
    count: 0,
    register: '',
    cursor: 0,
    visualStart: null,
    buffer: '',
    enabled,
  }
}

/**
 * Toggle vim mode on/off.
 */
export function toggleVimMode(state: VimState): VimState {
  return {
    ...state,
    enabled: !state.enabled,
    mode: 'insert', // Always start in insert when toggling
  }
}

/**
 * Set the buffer content (used when syncing with external input).
 */
export function setBuffer(state: VimState, buffer: string, cursor?: number): VimState {
  return {
    ...state,
    buffer,
    cursor: cursor ?? Math.min(state.cursor, buffer.length),
  }
}

/**
 * Enter insert mode.
 */
function enterInsert(state: VimState): VimState {
  return {
    ...state,
    mode: 'insert',
    operator: null,
    count: 0,
  }
}

/**
 * Enter normal mode.
 */
function enterNormal(state: VimState): VimState {
  return {
    ...state,
    mode: 'normal',
    operator: null,
    count: 0,
    visualStart: null,
    // Move cursor back one if at end (vim behavior)
    cursor: state.cursor > 0 && state.cursor >= state.buffer.length
      ? state.cursor - 1
      : state.cursor,
  }
}

/**
 * Check if character is a word character.
 */
function isWordChar(char: string): boolean {
  return /\w/.test(char)
}

/**
 * Find next word start position.
 */
function findNextWord(buffer: string, cursor: number): number {
  let pos = cursor

  // Skip current word (if on a word)
  while (pos < buffer.length && isWordChar(buffer[pos])) {
    pos++
  }

  // Skip non-word characters
  while (pos < buffer.length && !isWordChar(buffer[pos])) {
    pos++
  }

  return Math.min(pos, buffer.length)
}

/**
 * Find previous word start position.
 */
function findPrevWord(buffer: string, cursor: number): number {
  let pos = cursor

  // Move back if at start of word
  if (pos > 0) pos--

  // Skip non-word characters
  while (pos > 0 && !isWordChar(buffer[pos])) {
    pos--
  }

  // Find start of word
  while (pos > 0 && isWordChar(buffer[pos - 1])) {
    pos--
  }

  return Math.max(pos, 0)
}

/**
 * Find end of current word.
 */
function findWordEnd(buffer: string, cursor: number): number {
  let pos = cursor

  // Skip to word if on whitespace
  while (pos < buffer.length && !isWordChar(buffer[pos])) {
    pos++
  }

  // Find end of word
  while (pos < buffer.length - 1 && isWordChar(buffer[pos + 1])) {
    pos++
  }

  return Math.min(pos, buffer.length - 1)
}

/**
 * Execute a motion and return new cursor position.
 */
function executeMotion(
  buffer: string,
  cursor: number,
  motion: string,
  count: number
): number {
  const n = Math.max(1, count)
  let newCursor = cursor

  for (let i = 0; i < n; i++) {
    switch (motion) {
      case 'h': // Left
        newCursor = Math.max(0, newCursor - 1)
        break
      case 'l': // Right
        newCursor = Math.min(buffer.length - 1, newCursor + 1)
        break
      case 'w': // Word forward
        newCursor = findNextWord(buffer, newCursor)
        break
      case 'b': // Word backward
        newCursor = findPrevWord(buffer, newCursor)
        break
      case 'e': // End of word
        newCursor = findWordEnd(buffer, newCursor)
        break
      case '0': // Line start
        newCursor = 0
        break
      case '$': // Line end
        newCursor = Math.max(0, buffer.length - 1)
        break
      case '^': // First non-whitespace
        newCursor = buffer.search(/\S/)
        if (newCursor < 0) newCursor = 0
        break
    }
  }

  return newCursor
}

/**
 * Delete from cursor to target position.
 */
function deleteRange(
  state: VimState,
  start: number,
  end: number
): VimState {
  const [left, right] = start < end ? [start, end] : [end, start]
  const deleted = state.buffer.slice(left, right)
  const newBuffer = state.buffer.slice(0, left) + state.buffer.slice(right)

  return {
    ...state,
    buffer: newBuffer,
    cursor: Math.min(left, newBuffer.length - 1),
    register: deleted,
    operator: null,
    count: 0,
  }
}

/**
 * Yank (copy) from cursor to target position.
 */
function yankRange(
  state: VimState,
  start: number,
  end: number
): VimState {
  const [left, right] = start < end ? [start, end] : [end, start]
  const yanked = state.buffer.slice(left, right)

  return {
    ...state,
    register: yanked,
    operator: null,
    count: 0,
  }
}

/**
 * Process a key in normal mode.
 */
function processNormalKey(state: VimState, key: string): VimResult {
  // Numeric prefix
  if (/^\d$/.test(key) && (state.count > 0 || key !== '0')) {
    return {
      state: { ...state, count: state.count * 10 + parseInt(key) },
      handled: true,
    }
  }

  // Operators waiting for motion
  if (state.operator) {
    const motions = ['h', 'l', 'w', 'b', 'e', '0', '$', '^']
    if (motions.includes(key)) {
      const target = executeMotion(state.buffer, state.cursor, key, state.count)

      switch (state.operator) {
        case 'd':
          return {
            state: deleteRange(state, state.cursor, target + (key === 'e' || key === '$' ? 1 : 0)),
            handled: true,
          }
        case 'c':
          return {
            state: enterInsert(deleteRange(state, state.cursor, target + (key === 'e' || key === '$' ? 1 : 0))),
            handled: true,
          }
        case 'y':
          return {
            state: yankRange(state, state.cursor, target + (key === 'e' || key === '$' ? 1 : 0)),
            handled: true,
          }
      }
    }

    // Double operator (dd, cc, yy) - operate on whole line
    if (key === state.operator) {
      switch (state.operator) {
        case 'd':
          return {
            state: { ...state, buffer: '', cursor: 0, register: state.buffer, operator: null, count: 0 },
            handled: true,
          }
        case 'c':
          return {
            state: enterInsert({ ...state, buffer: '', cursor: 0, register: state.buffer, operator: null, count: 0 }),
            handled: true,
          }
        case 'y':
          return {
            state: { ...state, register: state.buffer, operator: null, count: 0 },
            handled: true,
          }
      }
    }

    // Cancel operator
    return {
      state: { ...state, operator: null, count: 0 },
      handled: true,
    }
  }

  // Mode switches
  switch (key) {
    case 'i': // Insert at cursor
      return { state: enterInsert(state), handled: true }

    case 'I': // Insert at line start
      return { state: enterInsert({ ...state, cursor: 0 }), handled: true }

    case 'a': // Append after cursor
      return {
        state: enterInsert({
          ...state,
          cursor: Math.min(state.cursor + 1, state.buffer.length),
        }),
        handled: true,
      }

    case 'A': // Append at line end
      return {
        state: enterInsert({ ...state, cursor: state.buffer.length }),
        handled: true,
      }

    case 'Escape':
      return { state: enterNormal(state), handled: true }
  }

  // Motions
  const motions = ['h', 'l', 'w', 'b', 'e', '0', '$', '^']
  if (motions.includes(key)) {
    const newCursor = executeMotion(state.buffer, state.cursor, key, state.count)
    return {
      state: { ...state, cursor: newCursor, count: 0 },
      handled: true,
    }
  }

  // Operators
  if (['d', 'c', 'y'].includes(key)) {
    return {
      state: { ...state, operator: key },
      handled: true,
    }
  }

  // Other commands
  switch (key) {
    case 'x': // Delete character under cursor
      if (state.buffer.length === 0) return { state, handled: true }
      return {
        state: deleteRange(state, state.cursor, state.cursor + 1),
        handled: true,
      }

    case 'X': // Delete character before cursor
      if (state.cursor === 0) return { state, handled: true }
      return {
        state: deleteRange(state, state.cursor - 1, state.cursor),
        handled: true,
      }

    case 'p': // Paste after cursor
      if (!state.register) return { state, handled: true }
      const afterCursor = state.cursor + 1
      const newBuffer = state.buffer.slice(0, afterCursor) + state.register + state.buffer.slice(afterCursor)
      return {
        state: { ...state, buffer: newBuffer, cursor: afterCursor + state.register.length - 1 },
        handled: true,
      }

    case 'P': // Paste before cursor
      if (!state.register) return { state, handled: true }
      const beforeBuffer = state.buffer.slice(0, state.cursor) + state.register + state.buffer.slice(state.cursor)
      return {
        state: { ...state, buffer: beforeBuffer, cursor: state.cursor + state.register.length - 1 },
        handled: true,
      }

    case 'u': // Undo (external - just signal)
      return { state, handled: false } // Let external handle

    case 'Enter':
      return { state, handled: true, command: 'submit' }
  }

  return { state, handled: false }
}

/**
 * Process a key in insert mode.
 */
function processInsertKey(state: VimState, key: string): VimResult {
  switch (key) {
    case 'Escape':
      return { state: enterNormal(state), handled: true }

    case 'Enter':
      return { state, handled: true, command: 'submit' }

    default:
      // In insert mode, most keys are passed through
      return { state, handled: false }
  }
}

/**
 * Main key processing function.
 * Returns updated state and whether the key was handled.
 */
export function processKey(state: VimState, key: string): VimResult {
  // If vim mode is disabled, pass through
  if (!state.enabled) {
    return { state, handled: false }
  }

  switch (state.mode) {
    case 'normal':
      return processNormalKey(state, key)
    case 'insert':
      return processInsertKey(state, key)
    case 'visual':
      // Visual mode not fully implemented yet
      return { state: enterNormal(state), handled: true }
    default:
      return { state, handled: false }
  }
}

/**
 * Get mode indicator for status line.
 */
export function getModeIndicator(state: VimState): string {
  if (!state.enabled) return ''

  const indicators: Record<VimMode, string> = {
    normal: '\x1b[1;32m-- NORMAL --\x1b[0m',
    insert: '\x1b[1;34m-- INSERT --\x1b[0m',
    visual: '\x1b[1;35m-- VISUAL --\x1b[0m',
  }

  let indicator = indicators[state.mode]

  // Show pending operator
  if (state.operator) {
    indicator += ` ${state.operator}`
  }

  // Show count
  if (state.count > 0) {
    indicator += ` ${state.count}`
  }

  return indicator
}

/**
 * Get cursor style based on mode.
 */
export function getCursorStyle(state: VimState): 'block' | 'line' {
  if (!state.enabled) return 'line'
  return state.mode === 'insert' ? 'line' : 'block'
}
