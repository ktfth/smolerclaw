import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  initBookmarks, saveBookmark, updateBookmark, deleteBookmark, getBookmark,
  searchBookmarks, listBookmarks, getBookmarkTags, getBookmarksByDomain,
  getBookmarkCount,
  formatBookmarkList, formatBookmarkDetail, formatBookmarkTags, formatBookmarkDomains,
} from '../src/bookmarks'

const TEST_DIR = join(tmpdir(), `smolerclaw-bookmarks-test-${Date.now()}`)

function cleanup(): void {
  try { rmSync(TEST_DIR, { recursive: true, force: true }) } catch { /* ignore */ }
}

describe('Bookmarks — Init', () => {
  beforeEach(() => {
    cleanup()
    mkdirSync(TEST_DIR, { recursive: true })
    initBookmarks(TEST_DIR)
  })

  afterEach(() => {
    cleanup()
  })

  test('initBookmarks creates data directory', () => {
    expect(existsSync(TEST_DIR)).toBe(true)
  })

  test('bookmarks start empty', () => {
    expect(getBookmarkCount()).toBe(0)
    expect(listBookmarks()).toEqual([])
  })
})

describe('Bookmarks — CRUD', () => {
  beforeEach(() => {
    cleanup()
    mkdirSync(TEST_DIR, { recursive: true })
    initBookmarks(TEST_DIR)
  })

  afterEach(() => {
    cleanup()
  })

  // ─── Create ─────────────────────────────────────────────

  test('saveBookmark creates a bookmark with id', () => {
    const bk = saveBookmark('https://example.com', 'Example')
    expect(bk.id).toBeTruthy()
    expect(bk.id.length).toBe(8)
    expect(bk.url).toBe('https://example.com')
    expect(bk.title).toBe('Example')
  })

  test('saveBookmark extracts domain', () => {
    const bk = saveBookmark('https://www.github.com/ktfth/smolerclaw', 'Smolerclaw')
    expect(bk.domain).toBe('github.com')
  })

  test('saveBookmark strips www from domain', () => {
    const bk = saveBookmark('https://www.example.org/page', 'Test')
    expect(bk.domain).toBe('example.org')
  })

  test('saveBookmark with tags', () => {
    const bk = saveBookmark('https://docs.bun.sh', 'Bun Docs', { tags: ['bun', 'runtime'] })
    expect(bk.tags).toContain('bun')
    expect(bk.tags).toContain('runtime')
  })

  test('saveBookmark auto-extracts hashtags from description', () => {
    const bk = saveBookmark('https://example.com', 'Test', {
      description: 'Great resource for #typescript #testing',
    })
    expect(bk.tags).toContain('typescript')
    expect(bk.tags).toContain('testing')
  })

  test('saveBookmark merges manual tags and hashtags without duplicates', () => {
    const bk = saveBookmark('https://example.com', 'Test', {
      tags: ['typescript'],
      description: 'Great for #typescript #bun',
    })
    expect(bk.tags.filter((t) => t === 'typescript').length).toBe(1)
    expect(bk.tags).toContain('bun')
  })

  test('saveBookmark with description', () => {
    const bk = saveBookmark('https://example.com', 'Test', { description: 'My notes here' })
    expect(bk.description).toBe('My notes here')
  })

  test('saveBookmark trims whitespace', () => {
    const bk = saveBookmark('  https://example.com  ', '  Test  ')
    expect(bk.url).toBe('https://example.com')
    expect(bk.title).toBe('Test')
  })

  test('saveBookmark persists to disk', () => {
    saveBookmark('https://example.com', 'Test')
    const file = join(TEST_DIR, 'bookmarks.json')
    expect(existsSync(file)).toBe(true)
    const data = JSON.parse(readFileSync(file, 'utf-8'))
    expect(data.length).toBe(1)
  })

  test('saveBookmark sets timestamps', () => {
    const bk = saveBookmark('https://example.com', 'Test')
    expect(bk.createdAt).toBeTruthy()
    expect(bk.updatedAt).toBeTruthy()
    expect(bk.createdAt).toBe(bk.updatedAt)
  })

  // ─── Read ───────────────────────────────────────────────

  test('getBookmark returns bookmark by id', () => {
    const bk = saveBookmark('https://example.com', 'Test')
    const found = getBookmark(bk.id)
    expect(found).not.toBeNull()
    expect(found!.url).toBe('https://example.com')
  })

  test('getBookmark returns null for unknown id', () => {
    expect(getBookmark('nonexistent')).toBeNull()
  })

  // ─── Update ─────────────────────────────────────────────

  test('updateBookmark changes title', () => {
    const bk = saveBookmark('https://example.com', 'Old Title')
    const updated = updateBookmark(bk.id, { title: 'New Title' })
    expect(updated).not.toBeNull()
    expect(updated!.title).toBe('New Title')
    expect(updated!.url).toBe('https://example.com') // unchanged
  })

  test('updateBookmark changes url and recalculates domain', () => {
    const bk = saveBookmark('https://example.com', 'Test')
    const updated = updateBookmark(bk.id, { url: 'https://github.com/new' })
    expect(updated!.url).toBe('https://github.com/new')
    expect(updated!.domain).toBe('github.com')
  })

  test('updateBookmark updates updatedAt timestamp', () => {
    const bk = saveBookmark('https://example.com', 'Test')
    const original = bk.updatedAt
    // Slight delay to ensure different timestamp
    const updated = updateBookmark(bk.id, { title: 'Updated' })
    expect(updated!.updatedAt).not.toBe(original)
  })

  test('updateBookmark returns null for unknown id', () => {
    expect(updateBookmark('nonexistent', { title: 'X' })).toBeNull()
  })

  test('updateBookmark preserves tags and adds new hashtags', () => {
    const bk = saveBookmark('https://example.com', 'Test', { tags: ['existing'] })
    const updated = updateBookmark(bk.id, { description: 'Now with #newtag' })
    expect(updated!.tags).toContain('existing')
    expect(updated!.tags).toContain('newtag')
  })

  // ─── Delete ─────────────────────────────────────────────

  test('deleteBookmark removes bookmark', () => {
    const bk = saveBookmark('https://example.com', 'Test')
    expect(deleteBookmark(bk.id)).toBe(true)
    expect(getBookmark(bk.id)).toBeNull()
    expect(getBookmarkCount()).toBe(0)
  })

  test('deleteBookmark returns false for unknown id', () => {
    expect(deleteBookmark('nonexistent')).toBe(false)
  })

  test('deleteBookmark does not affect other bookmarks', () => {
    const bk1 = saveBookmark('https://a.com', 'A')
    const bk2 = saveBookmark('https://b.com', 'B')
    deleteBookmark(bk1.id)
    expect(getBookmarkCount()).toBe(1)
    expect(getBookmark(bk2.id)).not.toBeNull()
  })
})

describe('Bookmarks — Search', () => {
  beforeEach(() => {
    cleanup()
    mkdirSync(TEST_DIR, { recursive: true })
    initBookmarks(TEST_DIR)
    saveBookmark('https://docs.bun.sh', 'Bun Docs', { tags: ['bun', 'runtime'], description: 'Official Bun documentation' })
    saveBookmark('https://github.com/ktfth/smolerclaw', 'Smolerclaw Repo', { tags: ['project', 'ai'] })
    saveBookmark('https://developer.mozilla.org', 'MDN Web Docs', { tags: ['web', 'reference'], description: 'Web APIs reference' })
    saveBookmark('https://github.com/oven-sh/bun', 'Bun Source', { tags: ['bun', 'runtime'] })
  })

  afterEach(() => {
    cleanup()
  })

  test('searchBookmarks by keyword in title', () => {
    const results = searchBookmarks('Bun')
    expect(results.length).toBe(2)
  })

  test('searchBookmarks by keyword in url', () => {
    const results = searchBookmarks('github.com')
    expect(results.length).toBe(2)
  })

  test('searchBookmarks by keyword in description', () => {
    const results = searchBookmarks('documentation')
    expect(results.length).toBe(1)
    expect(results[0].title).toBe('Bun Docs')
  })

  test('searchBookmarks by tag with # prefix', () => {
    const results = searchBookmarks('#runtime')
    expect(results.length).toBe(2)
  })

  test('searchBookmarks by tag partial match', () => {
    const results = searchBookmarks('#run')
    expect(results.length).toBe(2)
  })

  test('searchBookmarks by domain with @ prefix', () => {
    const results = searchBookmarks('@github.com')
    expect(results.length).toBe(2)
  })

  test('searchBookmarks returns all for empty query', () => {
    const results = searchBookmarks('')
    expect(results.length).toBe(4)
  })

  test('searchBookmarks is case-insensitive', () => {
    const results = searchBookmarks('BUN')
    expect(results.length).toBe(2)
  })

  test('searchBookmarks returns empty for no matches', () => {
    const results = searchBookmarks('nonexistent')
    expect(results.length).toBe(0)
  })
})

describe('Bookmarks — List & Tags', () => {
  beforeEach(() => {
    cleanup()
    mkdirSync(TEST_DIR, { recursive: true })
    initBookmarks(TEST_DIR)
    saveBookmark('https://a.com', 'A', { tags: ['web'] })
    saveBookmark('https://b.com', 'B', { tags: ['web', 'api'] })
    saveBookmark('https://c.com', 'C', { tags: ['api', 'docs'] })
  })

  afterEach(() => {
    cleanup()
  })

  test('listBookmarks returns all sorted by updated', () => {
    const all = listBookmarks()
    expect(all.length).toBe(3)
  })

  test('listBookmarks respects limit', () => {
    const limited = listBookmarks(2)
    expect(limited.length).toBe(2)
  })

  test('getBookmarkTags returns tags sorted by count', () => {
    const tags = getBookmarkTags()
    expect(tags[0].tag).toBe('web')
    expect(tags[0].count).toBe(2)
    expect(tags[1].tag).toBe('api')
    expect(tags[1].count).toBe(2)
  })

  test('getBookmarksByDomain groups by domain', () => {
    const domains = getBookmarksByDomain()
    expect(domains.length).toBe(3)
    // Each domain has exactly 1 bookmark
    expect(domains[0].count).toBe(1)
  })

  test('getBookmarkCount returns correct count', () => {
    expect(getBookmarkCount()).toBe(3)
  })
})

describe('Bookmarks — Formatting', () => {
  beforeEach(() => {
    cleanup()
    mkdirSync(TEST_DIR, { recursive: true })
    initBookmarks(TEST_DIR)
  })

  afterEach(() => {
    cleanup()
  })

  test('formatBookmarkList returns "nenhum" for empty list', () => {
    expect(formatBookmarkList([])).toContain('Nenhum')
  })

  test('formatBookmarkList shows bookmark count', () => {
    const bk = saveBookmark('https://example.com', 'Test', { tags: ['web'] })
    const output = formatBookmarkList([bk])
    expect(output).toContain('Bookmarks (1)')
    expect(output).toContain('Test')
    expect(output).toContain('https://example.com')
    expect(output).toContain('#web')
  })

  test('formatBookmarkDetail shows full details', () => {
    const bk = saveBookmark('https://example.com', 'Test', {
      tags: ['web'],
      description: 'A great site',
    })
    const output = formatBookmarkDetail(bk)
    expect(output).toContain('Test')
    expect(output).toContain('https://example.com')
    expect(output).toContain('A great site')
    expect(output).toContain('#web')
    expect(output).toContain('example.com')
  })

  test('formatBookmarkTags shows "nenhuma" for empty', () => {
    expect(formatBookmarkTags()).toContain('Nenhuma')
  })

  test('formatBookmarkTags shows tags with counts', () => {
    saveBookmark('https://a.com', 'A', { tags: ['web'] })
    saveBookmark('https://b.com', 'B', { tags: ['web', 'api'] })
    const output = formatBookmarkTags()
    expect(output).toContain('#web (2)')
    expect(output).toContain('#api (1)')
  })

  test('formatBookmarkDomains shows "nenhum" for empty', () => {
    expect(formatBookmarkDomains()).toContain('Nenhum')
  })

  test('formatBookmarkDomains shows domains with counts', () => {
    saveBookmark('https://github.com/a', 'A')
    saveBookmark('https://github.com/b', 'B')
    saveBookmark('https://example.com', 'C')
    const output = formatBookmarkDomains()
    expect(output).toContain('github.com (2)')
    expect(output).toContain('example.com (1)')
  })
})

describe('Bookmarks — Domain Extraction', () => {
  beforeEach(() => {
    cleanup()
    mkdirSync(TEST_DIR, { recursive: true })
    initBookmarks(TEST_DIR)
  })

  afterEach(() => {
    cleanup()
  })

  test('extracts domain from https URL', () => {
    const bk = saveBookmark('https://docs.bun.sh/api', 'Bun API')
    expect(bk.domain).toBe('docs.bun.sh')
  })

  test('extracts domain from http URL', () => {
    const bk = saveBookmark('http://localhost:3000', 'Local')
    expect(bk.domain).toBe('localhost')
  })

  test('handles URLs without protocol gracefully', () => {
    const bk = saveBookmark('example.com/page', 'No protocol')
    expect(bk.domain).toBe('example.com')
  })

  test('handles invalid URLs gracefully', () => {
    const bk = saveBookmark('not-a-url', 'Invalid')
    expect(bk.domain).toBe('not-a-url')
  })
})
