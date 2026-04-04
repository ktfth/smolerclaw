/**
 * Content recommendation engine for mind decompression.
 * Suggests videos, movies, and music based on user mood, context,
 * past ratings, and current work patterns.
 */

import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { atomicWriteFile } from './vault'

// ─── Types ──────────────────────────────────────────────────

export type ContentType = 'video' | 'movie' | 'music'
export type Mood = 'relaxar' | 'energizar' | 'focar' | 'inspirar' | 'descontrair'

export interface ContentItem {
  id: string
  type: ContentType
  title: string
  /** Artist, director, or channel */
  creator: string
  /** Genre tags (e.g. "lo-fi", "comedia", "documentario") */
  tags: string[]
  /** Moods this content fits */
  moods: Mood[]
  /** Optional URL (YouTube, Spotify, etc.) */
  url?: string
  /** User rating 1-5, null if unrated */
  rating: number | null
  /** How many times recommended */
  timesRecommended: number
  /** How many times consumed (user marked as watched/listened) */
  timesConsumed: number
  createdAt: string
  updatedAt: string
}

export interface Recommendation {
  item: ContentItem
  reason: string
  score: number
}

// ─── Storage ────────────────────────────────────────────────

let _dataDir = ''
let _items: ContentItem[] = []

const DATA_FILE = () => join(_dataDir, 'recommendations.json')

function save(): void {
  atomicWriteFile(DATA_FILE(), JSON.stringify(_items, null, 2))
}

function load(): void {
  const file = DATA_FILE()
  if (!existsSync(file)) {
    _items = []
    return
  }
  try {
    const data = JSON.parse(readFileSync(file, 'utf-8'))
    if (!Array.isArray(data)) {
      _items = []
      return
    }
    _items = data
  } catch {
    _items = []
  }
}

// ─── Init ───────────────────────────────────────────────────

export function initRecommendations(dataDir: string): void {
  _dataDir = dataDir
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true })
  load()
}

// ─── CRUD ───────────────────────────────────────────────────

export function addContent(
  type: ContentType,
  title: string,
  creator: string,
  tags: string[] = [],
  moods: Mood[] = [],
  url?: string,
): ContentItem {
  const now = new Date().toISOString()
  const item: ContentItem = {
    id: randomUUID().slice(0, 8),
    type,
    title: title.trim(),
    creator: creator.trim(),
    tags: tags.map((t) => t.toLowerCase()),
    moods,
    url: url?.trim() || undefined,
    rating: null,
    timesRecommended: 0,
    timesConsumed: 0,
    createdAt: now,
    updatedAt: now,
  }
  _items = [..._items, item]
  save()
  return item
}

export function rateContent(id: string, rating: number): ContentItem | null {
  const clamped = Math.max(1, Math.min(5, Math.round(rating)))
  const found = _items.find((i) => i.id === id)
  if (!found) return null
  _items = _items.map((i) =>
    i.id === id
      ? { ...i, rating: clamped, updatedAt: new Date().toISOString() }
      : i,
  )
  save()
  return _items.find((i) => i.id === id) || null
}

export function markConsumed(id: string): ContentItem | null {
  const found = _items.find((i) => i.id === id)
  if (!found) return null
  _items = _items.map((i) =>
    i.id === id
      ? { ...i, timesConsumed: i.timesConsumed + 1, updatedAt: new Date().toISOString() }
      : i,
  )
  save()
  return _items.find((i) => i.id === id) || null
}

export function removeContent(id: string): boolean {
  const idx = _items.findIndex((i) => i.id === id)
  if (idx === -1) return false
  _items = [..._items.slice(0, idx), ..._items.slice(idx + 1)]
  save()
  return true
}

// ─── Search & Filter ────────────────────────────────────────

export function searchContent(query: string): ContentItem[] {
  const lower = query.toLowerCase().trim()
  if (!lower) return [..._items]

  const isTagSearch = lower.startsWith('#')
  const term = isTagSearch ? lower.slice(1) : lower

  return _items.filter((i) => {
    if (isTagSearch) {
      return i.tags.some((t) => t.includes(term))
    }
    return (
      i.title.toLowerCase().includes(term) ||
      i.creator.toLowerCase().includes(term) ||
      i.tags.some((t) => t.includes(term)) ||
      i.type === term
    )
  })
}

export function listContent(type?: ContentType, limit = 20): ContentItem[] {
  const filtered = type ? _items.filter((i) => i.type === type) : [..._items]
  return filtered
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
    .slice(0, limit)
}

// ─── Recommendation Engine ──────────────────────────────────

/**
 * Generate content recommendations based on mood, type preference,
 * past ratings, and freshness. The algorithm scores each item and
 * returns the top N sorted by score.
 */
export function getRecommendations(
  mood?: Mood,
  type?: ContentType,
  limit = 5,
): Recommendation[] {
  if (_items.length === 0) return []

  const candidates = _items
    .filter((i) => !type || i.type === type)

  const scored: Recommendation[] = candidates.map((item) => {
    let score = 0
    const reasons: string[] = []

    // Mood match (strong signal)
    if (mood && item.moods.includes(mood)) {
      score += 30
      reasons.push(`combina com mood "${mood}"`)
    }

    // High rating boost
    if (item.rating !== null) {
      score += item.rating * 5
      if (item.rating >= 4) {
        reasons.push(`avaliado ${item.rating}/5`)
      }
    }

    // Freshness: recently added items get a boost
    const ageMs = Date.now() - new Date(item.createdAt).getTime()
    const ageDays = ageMs / (1000 * 60 * 60 * 24)
    if (ageDays < 7) {
      score += 10
      reasons.push('adicionado recentemente')
    }

    // Novelty: items not consumed much get a boost
    if (item.timesConsumed === 0) {
      score += 15
      reasons.push('ainda nao consumido')
    } else if (item.timesConsumed < 3) {
      score += 5
    }

    // Variety: less recommended items get a boost
    if (item.timesRecommended < 2) {
      score += 8
    }

    // Default reason if nothing specific
    if (reasons.length === 0) {
      reasons.push('item do seu catalogo')
    }

    return {
      item,
      reason: reasons.join(', '),
      score,
    }
  })

  // Sort by score descending, take top N
  const top = scored
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)

  // Mark as recommended
  const recommendedIds = new Set(top.map((r) => r.item.id))
  _items = _items.map((i) =>
    recommendedIds.has(i.id)
      ? { ...i, timesRecommended: i.timesRecommended + 1 }
      : i,
  )
  save()

  return top
}

// ─── Stats ──────────────────────────────────────────────────

export interface RecommendationStats {
  total: number
  byType: Record<ContentType, number>
  byMood: Record<Mood, number>
  avgRating: number | null
  topRated: ContentItem[]
  mostConsumed: ContentItem[]
}

export function getStats(): RecommendationStats {
  const byType = _items.reduce(
    (acc, item) => ({ ...acc, [item.type]: acc[item.type] + 1 }),
    { video: 0, movie: 0, music: 0 } as Record<ContentType, number>,
  )

  const byMood = _items.reduce(
    (acc, item) => item.moods.reduce(
      (a, mood) => ({ ...a, [mood]: a[mood] + 1 }),
      acc,
    ),
    { relaxar: 0, energizar: 0, focar: 0, inspirar: 0, descontrair: 0 } as Record<Mood, number>,
  )

  const ratings = _items.filter((i) => i.rating !== null)
  const ratingSum = ratings.reduce((sum, i) => sum + (i.rating || 0), 0)
  const ratingCount = ratings.length

  const topRated = [..._items]
    .filter((i) => i.rating !== null)
    .sort((a, b) => (b.rating || 0) - (a.rating || 0))
    .slice(0, 5)

  const mostConsumed = [..._items]
    .filter((i) => i.timesConsumed > 0)
    .sort((a, b) => b.timesConsumed - a.timesConsumed)
    .slice(0, 5)

  return {
    total: _items.length,
    byType,
    byMood,
    avgRating: ratingCount > 0 ? Math.round((ratingSum / ratingCount) * 10) / 10 : null,
    topRated,
    mostConsumed,
  }
}

// ─── Formatting ─────────────────────────────────────────────

const TYPE_EMOJI: Record<ContentType, string> = {
  video: '[V]',
  movie: '[F]',
  music: '[M]',
}

export function formatContentList(items: ContentItem[]): string {
  if (items.length === 0) return 'Nenhum conteudo no catalogo.'

  const lines = items.map((i) => {
    const stars = i.rating !== null ? ` ${'*'.repeat(i.rating)}` : ''
    const tags = i.tags.length > 0 ? ` [${i.tags.map((t) => '#' + t).join(' ')}]` : ''
    const url = i.url ? ` -> ${i.url}` : ''
    return `  ${TYPE_EMOJI[i.type]} ${i.title} — ${i.creator}${stars}${tags}${url}  {${i.id}}`
  })

  return `Catalogo (${items.length}):\n${lines.join('\n')}`
}

export function formatRecommendations(recs: Recommendation[], mood?: Mood): string {
  if (recs.length === 0) {
    return mood
      ? `Nenhuma recomendacao encontrada para mood "${mood}". Adicione conteudo ao catalogo primeiro.`
      : 'Nenhuma recomendacao disponivel. Adicione conteudo ao catalogo primeiro.'
  }

  const header = mood
    ? `Recomendacoes para "${mood}" (${recs.length}):`
    : `Recomendacoes (${recs.length}):`

  const lines = recs.map((r, idx) => {
    const i = r.item
    const stars = i.rating !== null ? ` ${'*'.repeat(i.rating)}` : ''
    const url = i.url ? `\n     -> ${i.url}` : ''
    return `  ${idx + 1}. ${TYPE_EMOJI[i.type]} ${i.title} — ${i.creator}${stars}\n     ${r.reason}${url}  {${i.id}}`
  })

  return `${header}\n${lines.join('\n')}`
}

export function formatStats(stats: RecommendationStats): string {
  const lines: string[] = [
    `Catalogo: ${stats.total} itens`,
    `  Videos: ${stats.byType.video} | Filmes: ${stats.byType.movie} | Musicas: ${stats.byType.music}`,
    '',
    'Moods:',
    `  Relaxar: ${stats.byMood.relaxar} | Energizar: ${stats.byMood.energizar} | Focar: ${stats.byMood.focar}`,
    `  Inspirar: ${stats.byMood.inspirar} | Descontrair: ${stats.byMood.descontrair}`,
  ]

  if (stats.avgRating !== null) {
    lines.push('', `Avaliacao media: ${stats.avgRating}/5`)
  }

  if (stats.topRated.length > 0) {
    lines.push('', 'Top avaliados:')
    for (const i of stats.topRated) {
      lines.push(`  ${TYPE_EMOJI[i.type]} ${i.title} — ${'*'.repeat(i.rating || 0)}`)
    }
  }

  if (stats.mostConsumed.length > 0) {
    lines.push('', 'Mais consumidos:')
    for (const i of stats.mostConsumed) {
      lines.push(`  ${TYPE_EMOJI[i.type]} ${i.title} (${i.timesConsumed}x)`)
    }
  }

  return lines.join('\n')
}
