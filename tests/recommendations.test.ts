import { describe, test, expect, beforeEach } from 'bun:test'
import {
  initRecommendations, addContent, rateContent, markConsumed, removeContent,
  searchContent, listContent, getRecommendations, getStats,
  formatContentList, formatRecommendations, formatStats,
} from '../src/recommendations'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

describe('recommendations', () => {
  beforeEach(() => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'smolerclaw-rec-'))
    initRecommendations(tmpDir)
  })

  // ─── addContent ───────────────────────────────────────────

  test('addContent creates a content item', () => {
    const item = addContent('music', 'Chill Beats', 'Lo-Fi Girl')
    expect(item.id).toBeTruthy()
    expect(item.type).toBe('music')
    expect(item.title).toBe('Chill Beats')
    expect(item.creator).toBe('Lo-Fi Girl')
    expect(item.rating).toBeNull()
    expect(item.timesConsumed).toBe(0)
    expect(item.timesRecommended).toBe(0)
  })

  test('addContent stores tags and moods', () => {
    const item = addContent('movie', 'Inception', 'Christopher Nolan', ['sci-fi', 'thriller'], ['inspirar'])
    expect(item.tags).toContain('sci-fi')
    expect(item.tags).toContain('thriller')
    expect(item.moods).toContain('inspirar')
  })

  test('addContent stores URL', () => {
    const item = addContent('video', 'Tutorial', 'Channel', [], [], 'https://youtube.com/watch?v=abc')
    expect(item.url).toBe('https://youtube.com/watch?v=abc')
  })

  test('addContent lowercases tags', () => {
    const item = addContent('music', 'Track', 'Artist', ['Lo-Fi', 'JAZZ'])
    expect(item.tags).toEqual(['lo-fi', 'jazz'])
  })

  // ─── rateContent ──────────────────────────────────────────

  test('rateContent updates rating', () => {
    const item = addContent('music', 'Song', 'Artist')
    const rated = rateContent(item.id, 4)
    expect(rated?.rating).toBe(4)
  })

  test('rateContent clamps to 1-5', () => {
    const item = addContent('music', 'Song', 'Artist')
    expect(rateContent(item.id, 0)?.rating).toBe(1)
    expect(rateContent(item.id, 10)?.rating).toBe(5)
  })

  test('rateContent returns null for unknown id', () => {
    expect(rateContent('nonexistent', 3)).toBeNull()
  })

  // ─── markConsumed ─────────────────────────────────────────

  test('markConsumed increments counter', () => {
    const item = addContent('movie', 'Film', 'Director')
    markConsumed(item.id)
    const updated = markConsumed(item.id)
    expect(updated?.timesConsumed).toBe(2)
  })

  test('markConsumed returns null for unknown id', () => {
    expect(markConsumed('nonexistent')).toBeNull()
  })

  // ─── removeContent ────────────────────────────────────────

  test('removeContent removes item', () => {
    const item = addContent('video', 'Vid', 'Channel')
    expect(removeContent(item.id)).toBe(true)
    expect(listContent().length).toBe(0)
  })

  test('removeContent returns false for unknown id', () => {
    expect(removeContent('nonexistent')).toBe(false)
  })

  // ─── searchContent ────────────────────────────────────────

  test('searchContent by title', () => {
    addContent('music', 'Jazz Night', 'Miles Davis')
    addContent('music', 'Rock Anthem', 'Queen')
    const results = searchContent('jazz')
    expect(results.length).toBe(1)
    expect(results[0].title).toBe('Jazz Night')
  })

  test('searchContent by creator', () => {
    addContent('movie', 'Interstellar', 'Christopher Nolan')
    addContent('movie', 'Tenet', 'Christopher Nolan')
    addContent('movie', 'Parasite', 'Bong Joon-ho')
    const results = searchContent('nolan')
    expect(results.length).toBe(2)
  })

  test('searchContent by tag', () => {
    addContent('music', 'Track 1', 'Artist', ['lo-fi'])
    addContent('music', 'Track 2', 'Artist', ['jazz'])
    addContent('music', 'Track 3', 'Artist', ['lo-fi', 'chill'])
    const results = searchContent('#lo-fi')
    expect(results.length).toBe(2)
  })

  test('searchContent empty returns all', () => {
    addContent('music', 'A', 'X')
    addContent('video', 'B', 'Y')
    expect(searchContent('').length).toBe(2)
  })

  // ─── listContent ──────────────────────────────────────────

  test('listContent returns all by default', () => {
    addContent('music', 'M', 'A')
    addContent('video', 'V', 'B')
    addContent('movie', 'F', 'C')
    expect(listContent().length).toBe(3)
  })

  test('listContent filters by type', () => {
    addContent('music', 'M1', 'A')
    addContent('music', 'M2', 'B')
    addContent('video', 'V1', 'C')
    expect(listContent('music').length).toBe(2)
    expect(listContent('video').length).toBe(1)
  })

  test('listContent respects limit', () => {
    for (let i = 0; i < 10; i++) addContent('music', `Track ${i}`, 'Artist')
    expect(listContent(undefined, 3).length).toBe(3)
  })

  // ─── getRecommendations ───────────────────────────────────

  test('getRecommendations returns empty for empty catalog', () => {
    expect(getRecommendations().length).toBe(0)
  })

  test('getRecommendations returns items', () => {
    addContent('music', 'Song 1', 'Artist', [], ['relaxar'])
    addContent('video', 'Video 1', 'Channel', [], ['energizar'])
    const recs = getRecommendations()
    expect(recs.length).toBe(2)
    expect(recs[0].score).toBeGreaterThan(0)
    expect(recs[0].reason).toBeTruthy()
  })

  test('getRecommendations filters by mood', () => {
    addContent('music', 'Chill', 'A', [], ['relaxar'])
    addContent('music', 'Pump', 'B', [], ['energizar'])
    const recs = getRecommendations('relaxar')
    // Both items may be returned, but the one with matching mood should score higher
    expect(recs[0].item.title).toBe('Chill')
  })

  test('getRecommendations filters by type', () => {
    addContent('music', 'Song', 'A')
    addContent('video', 'Vid', 'B')
    const recs = getRecommendations(undefined, 'music')
    expect(recs.length).toBe(1)
    expect(recs[0].item.type).toBe('music')
  })

  test('getRecommendations respects limit', () => {
    for (let i = 0; i < 10; i++) addContent('music', `Track ${i}`, 'Artist')
    expect(getRecommendations(undefined, undefined, 3).length).toBe(3)
  })

  test('getRecommendations favors highly rated items', () => {
    const low = addContent('music', 'Meh Song', 'A')
    const high = addContent('music', 'Great Song', 'B')
    rateContent(low.id, 2)
    rateContent(high.id, 5)
    // Mark both as consumed so novelty doesn't dominate
    markConsumed(low.id)
    markConsumed(high.id)
    const recs = getRecommendations()
    expect(recs[0].item.title).toBe('Great Song')
  })

  test('getRecommendations increments timesRecommended', () => {
    const item = addContent('music', 'Song', 'Artist')
    getRecommendations()
    const updated = listContent()
    expect(updated[0].timesRecommended).toBe(1)
  })

  // ─── getStats ─────────────────────────────────────────────

  test('getStats returns correct counts', () => {
    addContent('music', 'M', 'A', [], ['relaxar'])
    addContent('video', 'V', 'B', [], ['energizar', 'focar'])
    addContent('movie', 'F', 'C', [], ['relaxar'])
    const stats = getStats()
    expect(stats.total).toBe(3)
    expect(stats.byType.music).toBe(1)
    expect(stats.byType.video).toBe(1)
    expect(stats.byType.movie).toBe(1)
    expect(stats.byMood.relaxar).toBe(2)
    expect(stats.byMood.energizar).toBe(1)
    expect(stats.byMood.focar).toBe(1)
  })

  test('getStats computes average rating', () => {
    const a = addContent('music', 'A', 'X')
    const b = addContent('music', 'B', 'Y')
    rateContent(a.id, 4)
    rateContent(b.id, 2)
    expect(getStats().avgRating).toBe(3)
  })

  test('getStats avgRating null when no ratings', () => {
    addContent('music', 'A', 'X')
    expect(getStats().avgRating).toBeNull()
  })

  // ─── Formatting ───────────────────────────────────────────

  test('formatContentList shows items', () => {
    addContent('music', 'Jazz Night', 'Miles', ['jazz'])
    const text = formatContentList(listContent())
    expect(text).toContain('Jazz Night')
    expect(text).toContain('Miles')
    expect(text).toContain('#jazz')
    expect(text).toContain('[M]')
  })

  test('formatContentList empty', () => {
    expect(formatContentList([])).toContain('Nenhum conteudo')
  })

  test('formatRecommendations shows recommendations', () => {
    addContent('video', 'Cool Video', 'Creator', [], ['relaxar'])
    const recs = getRecommendations('relaxar')
    const text = formatRecommendations(recs, 'relaxar')
    expect(text).toContain('Cool Video')
    expect(text).toContain('relaxar')
  })

  test('formatRecommendations empty with mood', () => {
    const text = formatRecommendations([], 'focar')
    expect(text).toContain('focar')
    expect(text).toContain('Nenhuma recomendacao')
  })

  test('formatStats shows stats', () => {
    addContent('music', 'M', 'A', [], ['relaxar'])
    const text = formatStats(getStats())
    expect(text).toContain('1 itens')
    expect(text).toContain('Musicas: 1')
    expect(text).toContain('Relaxar: 1')
  })
})
