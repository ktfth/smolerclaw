/**
 * Fuzzy matching algorithm optimized for command-line interfaces.
 *
 * Design principles:
 * - Substring characters must appear in order (not necessarily consecutive)
 * - Consecutive matches score higher (typing flow)
 * - Word boundary matches score higher (camelCase, snake_case, kebab-case)
 * - Start-of-string matches score highest (intent usually starts with first chars)
 * - Case-insensitive by default, exact case match gets bonus
 */

export interface FuzzyMatch {
  /** Original item that matched */
  item: string
  /** Score (higher = better match). 0 means no match. */
  score: number
  /** Indices of matched characters in the item */
  indices: number[]
}

/** Configuration for fuzzy matching behavior */
export interface FuzzyConfig {
  /** Bonus for consecutive character matches */
  consecutiveBonus: number
  /** Bonus for matching at word boundaries (after - _ . or uppercase) */
  wordBoundaryBonus: number
  /** Bonus for matching at start of string */
  startBonus: number
  /** Bonus for exact case match */
  caseSensitiveBonus: number
  /** Penalty per unmatched character between matches */
  gapPenalty: number
}

const DEFAULT_CONFIG: FuzzyConfig = {
  consecutiveBonus: 15,
  wordBoundaryBonus: 30,
  startBonus: 25,
  caseSensitiveBonus: 5,
  gapPenalty: 1,
}

/**
 * Check if a character is a word boundary.
 * Word boundaries: start of string, after - _ . space, or uppercase in camelCase
 */
function isWordBoundary(str: string, index: number): boolean {
  if (index === 0) return true
  const prev = str[index - 1]
  const curr = str[index]
  // After separator
  if (prev === '-' || prev === '_' || prev === '.' || prev === ' ' || prev === '/') {
    return true
  }
  // camelCase boundary (lowercase followed by uppercase)
  if (prev === prev.toLowerCase() && curr === curr.toUpperCase() && curr !== curr.toLowerCase()) {
    return true
  }
  return false
}

/**
 * Calculate fuzzy match score between query and target.
 * Returns null if query doesn't match target.
 */
export function fuzzyMatch(
  query: string,
  target: string,
  config: Partial<FuzzyConfig> = {}
): FuzzyMatch | null {
  const cfg = { ...DEFAULT_CONFIG, ...config }

  if (query.length === 0) {
    return { item: target, score: 1, indices: [] }
  }

  if (query.length > target.length) {
    return null
  }

  const queryLower = query.toLowerCase()
  const targetLower = target.toLowerCase()

  const indices: number[] = []
  let score = 0
  let queryIdx = 0
  let lastMatchIdx = -1

  for (let i = 0; i < target.length && queryIdx < query.length; i++) {
    if (targetLower[i] === queryLower[queryIdx]) {
      indices.push(i)

      // Base score for match
      score += 10

      // Consecutive bonus
      if (lastMatchIdx === i - 1) {
        score += cfg.consecutiveBonus
      }

      // Word boundary bonus
      if (isWordBoundary(target, i)) {
        score += cfg.wordBoundaryBonus
      }

      // Start bonus
      if (i === 0) {
        score += cfg.startBonus
      }

      // Exact case bonus
      if (target[i] === query[queryIdx]) {
        score += cfg.caseSensitiveBonus
      }

      // Gap penalty (characters skipped since last match)
      if (lastMatchIdx >= 0) {
        const gap = i - lastMatchIdx - 1
        score -= gap * cfg.gapPenalty
      }

      lastMatchIdx = i
      queryIdx++
    }
  }

  // All query characters must be found
  if (queryIdx !== query.length) {
    return null
  }

  // Normalize by query length (longer queries that match are better)
  score += query.length * 5

  // Penalty for very long targets with short queries (prefer concise matches)
  const lengthRatio = query.length / target.length
  score = Math.round(score * (0.5 + lengthRatio * 0.5))

  return { item: target, score, indices }
}

/**
 * Filter and sort items by fuzzy match score.
 * Returns items that match, sorted by score (best first).
 */
export function fuzzyFilter<T>(
  query: string,
  items: T[],
  accessor: (item: T) => string = (item) => String(item),
  config: Partial<FuzzyConfig> = {}
): Array<{ item: T; match: FuzzyMatch }> {
  const results: Array<{ item: T; match: FuzzyMatch }> = []

  for (const item of items) {
    const target = accessor(item)
    const match = fuzzyMatch(query, target, config)
    if (match) {
      results.push({ item, match: { ...match, item: target } })
    }
  }

  // Sort by score descending
  results.sort((a, b) => b.match.score - a.match.score)

  return results
}

/**
 * Highlight matched characters in a string for display.
 * Returns the string with ANSI codes to highlight matches.
 */
export function highlightMatches(
  text: string,
  indices: number[],
  highlightStart = '\x1b[1;33m', // Bold yellow
  highlightEnd = '\x1b[0m'
): string {
  if (indices.length === 0) return text

  const indexSet = new Set(indices)
  let result = ''
  let inHighlight = false

  for (let i = 0; i < text.length; i++) {
    const shouldHighlight = indexSet.has(i)

    if (shouldHighlight && !inHighlight) {
      result += highlightStart
      inHighlight = true
    } else if (!shouldHighlight && inHighlight) {
      result += highlightEnd
      inHighlight = false
    }

    result += text[i]
  }

  if (inHighlight) {
    result += highlightEnd
  }

  return result
}

/**
 * Find the best match from a list of candidates.
 * Returns null if no match found.
 */
export function bestMatch(
  query: string,
  candidates: string[],
  config: Partial<FuzzyConfig> = {}
): FuzzyMatch | null {
  let best: FuzzyMatch | null = null

  for (const candidate of candidates) {
    const match = fuzzyMatch(query, candidate, config)
    if (match && (!best || match.score > best.score)) {
      best = match
    }
  }

  return best
}

/**
 * Check if query is a prefix of target (for tab completion).
 * More lenient than fuzzy - characters don't need to be in order.
 */
export function isPrefix(query: string, target: string): boolean {
  return target.toLowerCase().startsWith(query.toLowerCase())
}

/**
 * Find common prefix among multiple strings (for tab completion).
 */
export function commonPrefix(strings: string[]): string {
  if (strings.length === 0) return ''
  if (strings.length === 1) return strings[0]

  let prefix = strings[0]
  for (let i = 1; i < strings.length; i++) {
    while (!strings[i].toLowerCase().startsWith(prefix.toLowerCase())) {
      prefix = prefix.slice(0, -1)
      if (prefix.length === 0) return ''
    }
    // Preserve case from first match
    prefix = strings[i].slice(0, prefix.length)
  }

  return prefix
}
