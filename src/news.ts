/**
 * News radar — fetches headlines from RSS feeds and web sources.
 * Categories: business, tech, finance, brazil, world, security (+ custom).
 *
 * Feeds are customizable: default built-in feeds are always available,
 * and users can add/remove custom feeds persisted in the data directory.
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { atomicWriteFile } from './vault'

// ─── RSS Feed Sources ───────────────────────────────────────

export interface NewsSource {
  name: string
  url: string
  category: NewsCategory
  builtin?: boolean
}

export type NewsCategory = 'business' | 'tech' | 'finance' | 'brazil' | 'world' | 'security' | string

const DEFAULT_FEEDS: readonly NewsSource[] = [
  // Business & Economy
  { name: 'InfoMoney', url: 'https://www.infomoney.com.br/feed/', category: 'finance', builtin: true },
  { name: 'Valor Economico', url: 'https://pox.globo.com/rss/valor/', category: 'business', builtin: true },
  { name: 'Bloomberg Linea BR', url: 'https://www.bloomberglinea.com.br/feed/', category: 'finance', builtin: true },

  // Tech
  { name: 'TechCrunch', url: 'https://techcrunch.com/feed/', category: 'tech', builtin: true },
  { name: 'Hacker News (best)', url: 'https://hnrss.org/best', category: 'tech', builtin: true },
  { name: 'The Verge', url: 'https://www.theverge.com/rss/index.xml', category: 'tech', builtin: true },

  // Brazil
  { name: 'G1', url: 'https://g1.globo.com/rss/g1/', category: 'brazil', builtin: true },
  { name: 'Folha', url: 'https://feeds.folha.uol.com.br/folha/cotidiano/rss091.xml', category: 'brazil', builtin: true },

  // World
  { name: 'BBC World', url: 'https://feeds.bbci.co.uk/news/world/rss.xml', category: 'world', builtin: true },
  { name: 'Reuters', url: 'https://www.reutersagency.com/feed/', category: 'world', builtin: true },

  // Cybersecurity
  { name: 'The Hacker News', url: 'https://feeds.feedburner.com/TheHackersNews', category: 'security', builtin: true },
  { name: 'BleepingComputer', url: 'https://www.bleepingcomputer.com/feed/', category: 'security', builtin: true },
  { name: 'Krebs on Security', url: 'https://krebsonsecurity.com/feed/', category: 'security', builtin: true },
]

// ─── Custom Feed Management ─────────────────────────────────

let _dataDir = ''
let _customFeeds: NewsSource[] = []
let _disabledFeeds: Set<string> = new Set()

const CUSTOM_FEEDS_FILE = () => join(_dataDir, 'news-feeds.json')

interface StoredFeedConfig {
  custom: NewsSource[]
  disabled: string[] // URLs of disabled built-in feeds
}

function saveCustomFeeds(): void {
  if (!_dataDir) return
  const data: StoredFeedConfig = {
    custom: _customFeeds,
    disabled: [..._disabledFeeds],
  }
  atomicWriteFile(CUSTOM_FEEDS_FILE(), JSON.stringify(data, null, 2))
}

function loadCustomFeeds(): void {
  if (!_dataDir) return
  const file = CUSTOM_FEEDS_FILE()
  if (!existsSync(file)) {
    _customFeeds = []
    _disabledFeeds = new Set()
    return
  }
  try {
    const data: StoredFeedConfig = JSON.parse(readFileSync(file, 'utf-8'))
    _customFeeds = data.custom || []
    _disabledFeeds = new Set(data.disabled || [])
  } catch {
    _customFeeds = []
    _disabledFeeds = new Set()
  }
}

/**
 * Initialize the news system with a data directory for custom feed persistence.
 */
export function initNews(dataDir: string): void {
  _dataDir = dataDir
  loadCustomFeeds()
}

/**
 * Get all active feeds (built-in not disabled + custom).
 */
function getActiveFeeds(): NewsSource[] {
  const builtins = DEFAULT_FEEDS.filter((f) => !_disabledFeeds.has(f.url))
  return [...builtins, ..._customFeeds]
}

/**
 * Add a custom RSS/Atom feed source.
 */
export function addNewsFeed(name: string, url: string, category: string): NewsSource | string {
  const trimName = name.trim()
  if (!trimName || trimName.length > 100) {
    return 'Error: nome invalido (1-100 caracteres).'
  }
  const trimCat = category.trim().toLowerCase()
  if (!trimCat || trimCat.length > 30) {
    return 'Error: categoria invalida (1-30 caracteres).'
  }
  const trimUrl = url.trim()
  if (!trimUrl.startsWith('http://') && !trimUrl.startsWith('https://')) {
    return 'Error: URL deve comecar com http:// ou https://'
  }
  if (trimUrl.length > 500) {
    return 'Error: URL muito longa (max 500 caracteres).'
  }

  // Check for duplicate URL
  const allFeeds = [...DEFAULT_FEEDS, ..._customFeeds]
  if (allFeeds.some((f) => f.url === trimUrl)) {
    return 'Error: essa URL ja esta cadastrada.'
  }

  const feed: NewsSource = {
    name: trimName,
    url: trimUrl,
    category: trimCat,
  }
  _customFeeds = [..._customFeeds, feed]
  saveCustomFeeds()
  return feed
}

/**
 * Remove a custom feed by name or URL. Cannot remove built-in feeds (use disable instead).
 */
export function removeNewsFeed(nameOrUrl: string): boolean {
  const lower = nameOrUrl.toLowerCase().trim()
  const idx = _customFeeds.findIndex(
    (f) => f.name.toLowerCase() === lower || f.url === nameOrUrl.trim(),
  )
  if (idx === -1) return false
  _customFeeds = [..._customFeeds.slice(0, idx), ..._customFeeds.slice(idx + 1)]
  saveCustomFeeds()
  return true
}

/**
 * Disable a built-in feed (it won't be fetched anymore).
 */
export function disableNewsFeed(nameOrUrl: string): boolean {
  const lower = nameOrUrl.toLowerCase().trim()
  const feed = DEFAULT_FEEDS.find(
    (f) => f.name.toLowerCase() === lower || f.url === nameOrUrl.trim(),
  )
  if (!feed) return false
  if (_disabledFeeds.has(feed.url)) return false // already disabled
  _disabledFeeds = new Set([..._disabledFeeds, feed.url])
  saveCustomFeeds()
  return true
}

/**
 * Re-enable a previously disabled built-in feed.
 */
export function enableNewsFeed(nameOrUrl: string): boolean {
  const lower = nameOrUrl.toLowerCase().trim()
  const feed = DEFAULT_FEEDS.find(
    (f) => f.name.toLowerCase() === lower || f.url === nameOrUrl.trim(),
  )
  if (!feed) return false
  if (!_disabledFeeds.has(feed.url)) return false // not disabled
  _disabledFeeds = new Set([..._disabledFeeds].filter((u) => u !== feed.url))
  saveCustomFeeds()
  return true
}

/**
 * List all feeds (built-in + custom) with their status.
 */
export function listNewsFeeds(): string {
  const lines: string[] = ['Fontes de noticias:']

  lines.push('\n  --- Built-in ---')
  for (const f of DEFAULT_FEEDS) {
    const status = _disabledFeeds.has(f.url) ? ' [DESATIVADO]' : ''
    lines.push(`  (${f.category}) ${f.name}${status} — ${f.url}`)
  }

  if (_customFeeds.length > 0) {
    lines.push('\n  --- Custom ---')
    for (const f of _customFeeds) {
      lines.push(`  (${f.category}) ${f.name} — ${f.url}`)
    }
  }

  lines.push(`\nTotal: ${getActiveFeeds().length} ativas (${DEFAULT_FEEDS.length} built-in, ${_customFeeds.length} custom, ${_disabledFeeds.size} desativadas)`)
  return lines.join('\n')
}

// ─── Constants ──────────────────────────────────────────────

const MAX_BODY_BYTES = 2 * 1024 * 1024  // 2 MB max per feed
const MAX_ITEMS_PER_FEED = 10
const FETCH_TIMEOUT_MS = 10_000

// ─── RSS Parser (minimal, no dependencies) ──────────────────

export interface NewsItem {
  title: string
  link: string
  source: string
  category: NewsCategory
  pubDate?: Date
}

/**
 * Parse RSS/Atom XML to extract news items.
 * Minimal parser — no dependency needed.
 */
function parseRss(xml: string, source: string, category: NewsCategory): NewsItem[] {
  const items: NewsItem[] = []

  // Try RSS <item> format
  const itemRegex = /<item[\s>]([\s\S]*?)<\/item>/gi
  let match: RegExpExecArray | null

  while ((match = itemRegex.exec(xml)) !== null) {
    const block = match[1]
    const item = parseBlock(block, source, category)
    if (item) items.push(item)
    if (items.length >= MAX_ITEMS_PER_FEED) break
  }

  // If no <item>, try Atom <entry>
  if (items.length === 0) {
    const entryRegex = /<entry[\s>]([\s\S]*?)<\/entry>/gi
    while ((match = entryRegex.exec(xml)) !== null) {
      const block = match[1]
      const item = parseBlock(block, source, category)
      if (item) items.push(item)
      if (items.length >= MAX_ITEMS_PER_FEED) break
    }
  }

  return items
}

function parseBlock(block: string, source: string, category: NewsCategory): NewsItem | null {
  const title = extractTag(block, 'title')
  if (!title) return null

  const rawLink = extractTag(block, 'link') || extractAtomLink(block)
  const link = sanitizeLink(rawLink)
  const pubDateStr = extractTag(block, 'pubDate') || extractTag(block, 'published') || extractTag(block, 'updated')

  let pubDate: Date | undefined
  if (pubDateStr) {
    const d = new Date(pubDateStr)
    pubDate = isNaN(d.getTime()) ? undefined : d
  }

  return {
    title: cleanHtml(title),
    link,
    source,
    category,
    pubDate,
  }
}

/**
 * Validate a link is a safe HTTP(S) URL.
 * Rejects javascript:, data:, and other schemes.
 */
function sanitizeLink(link: string | null): string {
  if (!link) return ''
  const trimmed = link.trim()
  if (trimmed.startsWith('https://') || trimmed.startsWith('http://')) {
    return trimmed
  }
  return '' // reject non-HTTP links
}

/**
 * Escape regex special characters in a string.
 */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function extractTag(xml: string, tag: string): string | null {
  const escaped = escapeRegex(tag)

  // Handle CDATA
  const cdataRegex = new RegExp(`<${escaped}[^>]*>\\s*<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>\\s*</${escaped}>`, 'i')
  const cdataMatch = cdataRegex.exec(xml)
  if (cdataMatch) return cdataMatch[1].trim()

  // Plain text
  const regex = new RegExp(`<${escaped}[^>]*>([\\s\\S]*?)</${escaped}>`, 'i')
  const match = regex.exec(xml)
  return match ? match[1].trim() : null
}

/**
 * Decode raw XML bytes using the correct charset.
 * Priority: HTTP Content-Type charset > XML prolog encoding > UTF-8 fallback.
 * Handles ISO-8859-1 / Windows-1252 feeds (common in Brazilian sources).
 */
function decodeXml(raw: Buffer, contentType: string | null): string {
  const encoding = detectEncoding(raw, contentType)
  try {
    return new TextDecoder(encoding).decode(raw)
  } catch {
    // Unknown encoding label — fall back to latin1 then utf-8
    try {
      return new TextDecoder('latin1').decode(raw)
    } catch {
      return new TextDecoder('utf-8', { fatal: false }).decode(raw)
    }
  }
}

function detectEncoding(raw: Buffer, contentType: string | null): string {
  // 1) Check HTTP Content-Type header: charset=xxx
  if (contentType) {
    const match = contentType.match(/charset\s*=\s*["']?([^\s;"']+)/i)
    if (match) return normalizeEncoding(match[1])
  }

  // 2) Check XML prolog: <?xml ... encoding="xxx" ?>
  // Read only the first 200 bytes as ASCII to find the prolog
  const head = raw.subarray(0, 200).toString('ascii')
  const xmlMatch = head.match(/<\?xml[^?]+encoding\s*=\s*["']([^"']+)["']/i)
  if (xmlMatch) return normalizeEncoding(xmlMatch[1])

  // 3) Default to UTF-8
  return 'utf-8'
}

/** Normalize encoding names to labels accepted by TextDecoder. */
function normalizeEncoding(enc: string): string {
  const lower = enc.toLowerCase().replace(/[^a-z0-9]/g, '')
  // Map common aliases
  if (lower === 'iso88591' || lower === 'latin1') return 'iso-8859-1'
  if (lower === 'windows1252' || lower === 'cp1252') return 'windows-1252'
  if (lower === 'utf8') return 'utf-8'
  if (lower === 'usascii' || lower === 'ascii') return 'utf-8'
  // Return as-is for TextDecoder to handle
  return enc.trim().toLowerCase()
}

function extractAtomLink(xml: string): string | null {
  const regex = /<link[^>]+href="([^"]+)"[^>]*\/?>/i
  const match = regex.exec(xml)
  return match ? match[1] : null
}

/** Map of named HTML entities commonly found in RSS feeds. */
const HTML_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  // Portuguese accented vowels
  aacute: 'á', Aacute: 'Á', agrave: 'à', Agrave: 'À',
  atilde: 'ã', Atilde: 'Ã', acirc: 'â', Acirc: 'Â',
  eacute: 'é', Eacute: 'É', egrave: 'è', Egrave: 'È',
  ecirc: 'ê', Ecirc: 'Ê',
  iacute: 'í', Iacute: 'Í',
  oacute: 'ó', Oacute: 'Ó', otilde: 'õ', Otilde: 'Õ',
  ocirc: 'ô', Ocirc: 'Ô',
  uacute: 'ú', Uacute: 'Ú', uuml: 'ü', Uuml: 'Ü',
  ccedil: 'ç', Ccedil: 'Ç',
  ntilde: 'ñ', Ntilde: 'Ñ',
  // Typographic punctuation
  rsquo: '\u2019', lsquo: '\u2018', rdquo: '\u201D', ldquo: '\u201C',
  mdash: '\u2014', ndash: '\u2013', hellip: '\u2026', bull: '\u2022',
  laquo: '\u00AB', raquo: '\u00BB',
  trade: '\u2122', copy: '\u00A9', reg: '\u00AE', euro: '\u20AC',
  pound: '\u00A3', yen: '\u00A5', cent: '\u00A2', deg: '\u00B0',
  middot: '\u00B7', times: '\u00D7', divide: '\u00F7',
}

function cleanHtml(text: string): string {
  return text
    .replace(/<[^>]+>/g, '')
    .replace(/&([a-zA-Z]+);/g, (full, name) => HTML_ENTITIES[name] ?? full)
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .trim()
}

// ─── Public API ─────────────────────────────────────────────

/**
 * Fetch news from all or filtered categories.
 * Returns formatted text output.
 */
/**
 * Fetch news items as structured data (for the interactive picker).
 */
export async function fetchNewsItems(
  categories?: NewsCategory[],
  maxPerSource = 5,
): Promise<{ items: NewsItem[]; errors: string[] }> {
  const cappedMax = Math.max(1, Math.min(maxPerSource, MAX_ITEMS_PER_FEED))

  if (categories && categories.length === 0) {
    return { items: [], errors: [] }
  }

  const active = getActiveFeeds()
  const feeds = categories
    ? active.filter((f) => categories.includes(f.category))
    : active

  const results = await Promise.allSettled(
    feeds.map((feed) => fetchFeed(feed, cappedMax)),
  )

  const items: NewsItem[] = []
  const errors: string[] = []

  for (let i = 0; i < results.length; i++) {
    const result = results[i]
    if (result.status === 'fulfilled') {
      items.push(...result.value)
    } else {
      errors.push(`${feeds[i].name}: ${summarizeError(result.reason)}`)
    }
  }

  items.sort((a, b) => {
    const da = a.pubDate?.getTime() || 0
    const db = b.pubDate?.getTime() || 0
    return db - da
  })

  return { items, errors }
}

/**
 * Fetch news from all or filtered categories.
 * Returns formatted text output (used by tools and briefing).
 */
export async function fetchNews(
  categories?: NewsCategory[],
  maxPerSource = 5,
): Promise<string> {
  if (categories && categories.length === 0) {
    return getNewsCategories()
  }

  const { items, errors } = await fetchNewsItems(categories, maxPerSource)

  if (items.length === 0) {
    return errors.length > 0
      ? `Nenhuma noticia encontrada.\nFalhas: ${errors.join(', ')}`
      : 'Nenhuma noticia encontrada.'
  }

  return formatNews(items, errors)
}

function summarizeError(err: unknown): string {
  if (err instanceof Error) {
    if (err.name === 'AbortError') return 'timeout'
    return err.message.slice(0, 80)
  }
  return 'unreachable'
}

async function fetchFeed(source: NewsSource, maxItems: number): Promise<NewsItem[]> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)

  try {
    const resp = await fetch(source.url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'smolerclaw/1.0 (news-radar)',
        'Accept': 'application/rss+xml, application/atom+xml, application/xml, text/xml',
      },
    })
    clearTimeout(timeout)

    if (!resp.ok) return []

    // Check content-length before reading body
    const contentLength = resp.headers.get('content-length')
    if (contentLength && Number(contentLength) > MAX_BODY_BYTES) {
      return [] // skip oversized feeds
    }

    // Read body with size cap
    const reader = resp.body?.getReader()
    if (!reader) return []

    const chunks: Uint8Array[] = []
    let totalBytes = 0

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      totalBytes += value.byteLength
      if (totalBytes > MAX_BODY_BYTES) {
        reader.cancel()
        return [] // body too large
      }
      chunks.push(value)
    }

    const raw = Buffer.concat(chunks)
    const xml = decodeXml(raw, resp.headers.get('content-type'))
    const items = parseRss(xml, source.name, source.category)
    return items.slice(0, maxItems)
  } catch (err) {
    clearTimeout(timeout)
    // Rethrow so Promise.allSettled captures the error
    throw err
  }
}

function formatNews(items: NewsItem[], errors: string[]): string {
  const categoryLabels: Record<NewsCategory, string> = {
    business: 'Negocios',
    tech: 'Tecnologia',
    finance: 'Financas',
    brazil: 'Brasil',
    world: 'Mundo',
    security: 'Ciberseguranca',
  }

  // Group by category (immutable approach)
  const grouped = new Map<NewsCategory, NewsItem[]>()
  for (const item of items) {
    const existing = grouped.get(item.category) || []
    grouped.set(item.category, [...existing, item])
  }

  const sections: string[] = []
  const categoryOrder: NewsCategory[] = ['finance', 'business', 'tech', 'security', 'brazil', 'world']

  for (const cat of categoryOrder) {
    const catItems = grouped.get(cat)
    if (!catItems || catItems.length === 0) continue

    const label = categoryLabels[cat]
    const lines = catItems.slice(0, 8).map((item) => {
      const time = item.pubDate
        ? item.pubDate.toLocaleTimeString('pt-BR', {
            hour: '2-digit',
            minute: '2-digit',
            timeZone: 'America/Sao_Paulo',
          })
        : ''
      const timeStr = time ? `[${time}]` : ''
      return `  ${timeStr} ${item.title} (${item.source})`
    })

    sections.push(`--- ${label} ---\n${lines.join('\n')}`)
  }

  let output = sections.join('\n\n')

  if (errors.length > 0) {
    output += `\n\n(Fontes indisponiveis: ${errors.join(', ')})`
  }

  return output
}

/**
 * Get list of available categories (including custom).
 */
export function getNewsCategories(): string {
  const active = getActiveFeeds()
  const categories = [...new Set(active.map((f) => f.category))].sort()
  return `Categorias: ${categories.join(', ')}\nUso: /news [categoria]`
}
