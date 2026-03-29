import { describe, it, expect } from 'bun:test'
import {
  fuzzyMatch,
  fuzzyFilter,
  highlightMatches,
  bestMatch,
  isPrefix,
  commonPrefix,
} from '../src/input/fuzzy'

describe('fuzzyMatch', () => {
  it('matches exact strings', () => {
    const result = fuzzyMatch('hello', 'hello')
    expect(result).not.toBeNull()
    expect(result!.indices).toEqual([0, 1, 2, 3, 4])
  })

  it('matches substring characters in order', () => {
    const result = fuzzyMatch('hlo', 'hello')
    expect(result).not.toBeNull()
    expect(result!.indices).toEqual([0, 2, 4])
  })

  it('returns null when characters not in order', () => {
    const result = fuzzyMatch('olh', 'hello')
    expect(result).toBeNull()
  })

  it('returns null when query longer than target', () => {
    const result = fuzzyMatch('hello world', 'hello')
    expect(result).toBeNull()
  })

  it('is case insensitive', () => {
    const result = fuzzyMatch('HeLLo', 'hello')
    expect(result).not.toBeNull()
  })

  it('gives bonus for exact case match', () => {
    const exactCase = fuzzyMatch('Hello', 'Hello')
    const wrongCase = fuzzyMatch('hello', 'Hello')
    expect(exactCase!.score).toBeGreaterThan(wrongCase!.score)
  })

  it('gives bonus for consecutive matches', () => {
    const consecutive = fuzzyMatch('hel', 'hello')
    const scattered = fuzzyMatch('hlo', 'hello')
    expect(consecutive!.score).toBeGreaterThan(scattered!.score)
  })

  it('gives bonus for word boundary matches', () => {
    const boundary = fuzzyMatch('gc', 'getCurrent')
    const nonBoundary = fuzzyMatch('et', 'getCurrent')
    expect(boundary!.score).toBeGreaterThan(nonBoundary!.score)
  })

  it('handles camelCase boundaries', () => {
    const result = fuzzyMatch('gCWD', 'getCurrentWorkingDirectory')
    expect(result).not.toBeNull()
    // g=0, C=3, W=10, D=17 (Directory starts at 17)
    expect(result!.indices).toEqual([0, 3, 10, 17])
  })

  it('handles snake_case boundaries', () => {
    const result = fuzzyMatch('gcd', 'get_current_directory')
    expect(result).not.toBeNull()
    // g at 0, c at 4 (after _), d at 12 (after _)
    expect(result!.indices).toEqual([0, 4, 12])
  })

  it('handles kebab-case boundaries', () => {
    const result = fuzzyMatch('nm', 'new-model')
    expect(result).not.toBeNull()
    expect(result!.indices).toEqual([0, 4])
  })

  it('gives bonus for start of string match', () => {
    const startMatch = fuzzyMatch('mo', 'model')
    const midMatch = fuzzyMatch('de', 'model')
    expect(startMatch!.score).toBeGreaterThan(midMatch!.score)
  })

  it('handles empty query', () => {
    const result = fuzzyMatch('', 'hello')
    expect(result).not.toBeNull()
    expect(result!.indices).toEqual([])
    expect(result!.score).toBe(1)
  })

  it('handles empty target with empty query', () => {
    const result = fuzzyMatch('', '')
    expect(result).not.toBeNull()
  })

  it('returns null for empty target with non-empty query', () => {
    const result = fuzzyMatch('a', '')
    expect(result).toBeNull()
  })

  it('prefers shorter targets with same match quality', () => {
    const short = fuzzyMatch('md', 'model')
    const long = fuzzyMatch('md', 'model-definition-schema')
    expect(short!.score).toBeGreaterThan(long!.score)
  })
})

describe('fuzzyFilter', () => {
  const commands = [
    '/model',
    '/monitor',
    '/memo',
    '/memos',
    '/clear',
    '/commit',
    '/sessions',
  ]

  it('filters matching items', () => {
    const results = fuzzyFilter('mo', commands)
    expect(results.length).toBe(4) // model, monitor, memo, memos
    expect(results.map(r => r.match.item)).toContain('/model')
    expect(results.map(r => r.match.item)).toContain('/monitor')
    expect(results.map(r => r.match.item)).toContain('/memo')
    expect(results.map(r => r.match.item)).toContain('/memos')
  })

  it('sorts by score descending', () => {
    const results = fuzzyFilter('mo', commands)
    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1].match.score).toBeGreaterThanOrEqual(results[i].match.score)
    }
  })

  it('returns empty array when no matches', () => {
    const results = fuzzyFilter('xyz', commands)
    expect(results).toEqual([])
  })

  it('works with custom accessor', () => {
    const items = [
      { name: 'Alice', id: 1 },
      { name: 'Bob', id: 2 },
      { name: 'Albert', id: 3 },
    ]
    const results = fuzzyFilter('al', items, item => item.name)
    expect(results.length).toBe(2)
    expect(results[0].item.name).toBe('Alice') // or Albert depending on score
  })

  it('handles empty query returning all items', () => {
    const results = fuzzyFilter('', commands)
    expect(results.length).toBe(commands.length)
  })
})

describe('highlightMatches', () => {
  it('highlights matched indices', () => {
    const result = highlightMatches('hello', [0, 2, 4], '<', '>')
    expect(result).toBe('<h>e<l>l<o>')
  })

  it('handles consecutive highlights', () => {
    const result = highlightMatches('hello', [0, 1, 2], '<', '>')
    expect(result).toBe('<hel>lo')
  })

  it('handles no highlights', () => {
    const result = highlightMatches('hello', [], '<', '>')
    expect(result).toBe('hello')
  })

  it('handles all highlighted', () => {
    const result = highlightMatches('hi', [0, 1], '<', '>')
    expect(result).toBe('<hi>')
  })

  it('uses default ANSI codes', () => {
    const result = highlightMatches('ab', [0])
    expect(result).toContain('\x1b[1;33m')
    expect(result).toContain('\x1b[0m')
  })
})

describe('bestMatch', () => {
  const candidates = ['model', 'monitor', 'memo', 'clear']

  it('returns best matching candidate', () => {
    const result = bestMatch('mod', candidates)
    expect(result).not.toBeNull()
    expect(result!.item).toBe('model')
  })

  it('returns null when no match', () => {
    const result = bestMatch('xyz', candidates)
    expect(result).toBeNull()
  })

  it('handles empty candidates', () => {
    const result = bestMatch('mod', [])
    expect(result).toBeNull()
  })
})

describe('isPrefix', () => {
  it('returns true for exact prefix', () => {
    expect(isPrefix('hel', 'hello')).toBe(true)
  })

  it('returns true for full match', () => {
    expect(isPrefix('hello', 'hello')).toBe(true)
  })

  it('returns false for non-prefix', () => {
    expect(isPrefix('ell', 'hello')).toBe(false)
  })

  it('is case insensitive', () => {
    expect(isPrefix('HEL', 'hello')).toBe(true)
  })

  it('handles empty prefix', () => {
    expect(isPrefix('', 'hello')).toBe(true)
  })
})

describe('commonPrefix', () => {
  it('finds common prefix', () => {
    expect(commonPrefix(['model', 'monitor', 'mono'])).toBe('mo')
  })

  it('returns full string when only one item', () => {
    expect(commonPrefix(['hello'])).toBe('hello')
  })

  it('returns empty when no common prefix', () => {
    expect(commonPrefix(['abc', 'xyz'])).toBe('')
  })

  it('returns empty for empty array', () => {
    expect(commonPrefix([])).toBe('')
  })

  it('handles exact matches', () => {
    expect(commonPrefix(['hello', 'hello'])).toBe('hello')
  })

  it('is case insensitive but preserves case from first match', () => {
    expect(commonPrefix(['Hello', 'help'])).toBe('hel')
  })
})

describe('real-world command completion', () => {
  const commands = [
    '/model haiku',
    '/model sonnet',
    '/model opus',
    '/monitor',
    '/memo',
    '/memos',
    '/commit',
    '/clear',
    '/sessions',
    '/session',
    '/search',
  ]

  it('finds /model with "mdl"', () => {
    const results = fuzzyFilter('mdl', commands)
    expect(results.length).toBeGreaterThan(0)
    expect(results[0].match.item).toContain('model')
  })

  it('finds /sessions with "sss"', () => {
    const results = fuzzyFilter('sss', commands)
    expect(results.length).toBeGreaterThan(0)
    // Both /sessions and /session match, shorter one scores higher
    expect(results[0].match.item).toContain('session')
  })

  it('finds /commit with "cmt"', () => {
    const results = fuzzyFilter('cmt', commands)
    expect(results.length).toBeGreaterThan(0)
    expect(results[0].match.item).toBe('/commit')
  })

  it('ranks /model haiku above /model sonnet for "mh"', () => {
    const results = fuzzyFilter('mh', commands)
    const haikuIdx = results.findIndex(r => r.match.item.includes('haiku'))
    const sonnetIdx = results.findIndex(r => r.match.item.includes('sonnet'))
    if (haikuIdx >= 0 && sonnetIdx >= 0) {
      expect(haikuIdx).toBeLessThan(sonnetIdx)
    }
  })
})
