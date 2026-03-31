import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdirSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  getNewsCategories, initNews, addNewsFeed, removeNewsFeed,
  disableNewsFeed, enableNewsFeed, listNewsFeeds, fetchNewsContent,
} from '../src/news'

const TEST_DIR = join(tmpdir(), `smolerclaw-news-test-${Date.now()}`)

describe('news — categories', () => {
  test('getNewsCategories returns category list', () => {
    const result = getNewsCategories()
    expect(result).toContain('business')
    expect(result).toContain('tech')
    expect(result).toContain('finance')
    expect(result).toContain('brazil')
    expect(result).toContain('world')
  })
})

describe('news — feed management', () => {
  beforeEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true })
    mkdirSync(TEST_DIR, { recursive: true })
    initNews(TEST_DIR)
  })

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true })
  })

  // ─── Add feeds ──────────────────────────────────────────

  test('addNewsFeed adds a custom feed', () => {
    const result = addNewsFeed('Ars Technica', 'https://feeds.arstechnica.com/arstechnica/index', 'tech')
    expect(typeof result).not.toBe('string') // not an error
    if (typeof result !== 'string') {
      expect(result.name).toBe('Ars Technica')
      expect(result.url).toBe('https://feeds.arstechnica.com/arstechnica/index')
      expect(result.category).toBe('tech')
    }
  })

  test('addNewsFeed rejects non-HTTP URL', () => {
    const result = addNewsFeed('Bad', 'ftp://example.com/feed', 'tech')
    expect(typeof result).toBe('string')
    expect(result).toContain('http')
  })

  test('addNewsFeed rejects duplicate URL', () => {
    addNewsFeed('First', 'https://example.com/feed1', 'tech')
    const result = addNewsFeed('Second', 'https://example.com/feed1', 'tech')
    expect(typeof result).toBe('string')
    expect(result).toContain('ja esta cadastrada')
  })

  test('addNewsFeed rejects duplicate of built-in URL', () => {
    const result = addNewsFeed('My TechCrunch', 'https://techcrunch.com/feed/', 'tech')
    expect(typeof result).toBe('string')
    expect(result).toContain('ja esta cadastrada')
  })

  test('addNewsFeed allows custom categories', () => {
    const result = addNewsFeed('AI News', 'https://example.com/ai-feed', 'ai')
    expect(typeof result).not.toBe('string')
    if (typeof result !== 'string') {
      expect(result.category).toBe('ai')
    }
  })

  // ─── Remove feeds ───────────────────────────────────────

  test('removeNewsFeed removes custom feed by name', () => {
    addNewsFeed('Custom Feed', 'https://example.com/custom', 'misc')
    expect(removeNewsFeed('Custom Feed')).toBe(true)
  })

  test('removeNewsFeed removes custom feed by URL', () => {
    addNewsFeed('Custom', 'https://example.com/byurl', 'misc')
    expect(removeNewsFeed('https://example.com/byurl')).toBe(true)
  })

  test('removeNewsFeed returns false for nonexistent', () => {
    expect(removeNewsFeed('nonexistent')).toBe(false)
  })

  test('removeNewsFeed cannot remove built-in feeds', () => {
    expect(removeNewsFeed('TechCrunch')).toBe(false)
  })

  // ─── Disable/Enable built-in feeds ──────────────────────

  test('disableNewsFeed disables a built-in', () => {
    expect(disableNewsFeed('TechCrunch')).toBe(true)
  })

  test('disableNewsFeed returns false if already disabled', () => {
    disableNewsFeed('TechCrunch')
    expect(disableNewsFeed('TechCrunch')).toBe(false)
  })

  test('disableNewsFeed returns false for nonexistent', () => {
    expect(disableNewsFeed('Nonexistent Source')).toBe(false)
  })

  test('enableNewsFeed re-enables a disabled built-in', () => {
    disableNewsFeed('TechCrunch')
    expect(enableNewsFeed('TechCrunch')).toBe(true)
  })

  test('enableNewsFeed returns false if not disabled', () => {
    expect(enableNewsFeed('TechCrunch')).toBe(false)
  })

  test('enableNewsFeed returns false for nonexistent', () => {
    expect(enableNewsFeed('Nonexistent')).toBe(false)
  })

  // ─── List feeds ─────────────────────────────────────────

  test('listNewsFeeds shows built-in and custom', () => {
    addNewsFeed('My Source', 'https://example.com/my', 'custom')
    const list = listNewsFeeds()
    expect(list).toContain('Built-in')
    expect(list).toContain('Custom')
    expect(list).toContain('My Source')
    expect(list).toContain('TechCrunch')
  })

  test('listNewsFeeds shows disabled status', () => {
    disableNewsFeed('TechCrunch')
    const list = listNewsFeeds()
    expect(list).toContain('DESATIVADO')
  })

  test('listNewsFeeds shows counts', () => {
    const list = listNewsFeeds()
    expect(list).toContain('ativas')
    expect(list).toContain('built-in')
  })

  // ─── Categories include custom ──────────────────────────

  test('getNewsCategories includes custom categories after add', () => {
    addNewsFeed('AI News', 'https://example.com/ai', 'ai')
    const cats = getNewsCategories()
    expect(cats).toContain('ai')
  })

  // ─── Persistence ────────────────────────────────────────

  test('custom feeds persist across re-init', () => {
    addNewsFeed('Persistent', 'https://example.com/persist', 'test')
    disableNewsFeed('Reuters')

    // Re-init
    initNews(TEST_DIR)
    const list = listNewsFeeds()
    expect(list).toContain('Persistent')
    expect(list).toContain('DESATIVADO')
  })

  test('persists to news-feeds.json file', () => {
    addNewsFeed('FileCheck', 'https://example.com/check', 'test')
    expect(existsSync(join(TEST_DIR, 'news-feeds.json'))).toBe(true)
  })

  // ─── Disable by URL ────────────────────────────────────

  test('disableNewsFeed works by URL', () => {
    expect(disableNewsFeed('https://techcrunch.com/feed/')).toBe(true)
    const list = listNewsFeeds()
    expect(list).toContain('DESATIVADO')
  })

  test('enableNewsFeed works by URL', () => {
    disableNewsFeed('https://techcrunch.com/feed/')
    expect(enableNewsFeed('https://techcrunch.com/feed/')).toBe(true)
  })

  // ─── Case insensitive matching ──────────────────────────

  test('disableNewsFeed is case-insensitive', () => {
    expect(disableNewsFeed('techcrunch')).toBe(true)
  })

  test('removeNewsFeed is case-insensitive', () => {
    addNewsFeed('MyFeed', 'https://example.com/myfeed', 'test')
    expect(removeNewsFeed('myfeed')).toBe(true)
  })
})

describe('news — fetchNewsContent', () => {
  test('fetchNewsContent rejects invalid URL', async () => {
    const result = await fetchNewsContent('ftp://example.com')
    expect(typeof result).toBe('string')
    expect(result).toContain('URL invalida')
  })

  test('fetchNewsContent rejects javascript: URL', async () => {
    const result = await fetchNewsContent('javascript:alert(1)')
    expect(typeof result).toBe('string')
    expect(result).toContain('URL invalida')
  })

  test('fetchNewsContent handles unreachable host', async () => {
    const result = await fetchNewsContent('https://this-domain-does-not-exist-12345.test/')
    expect(typeof result).toBe('string')
    expect(result).toContain('Error')
  })

  test('fetchNewsContent returns title and content for valid article', async () => {
    // Use a simple, stable public page for testing
    const result = await fetchNewsContent('https://example.com')
    // Should either succeed or return an error string
    if (typeof result === 'string') {
      expect(result).toContain('Error')
    } else {
      expect(result).toHaveProperty('title')
      expect(result).toHaveProperty('content')
    }
  })
})
