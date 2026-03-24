/**
 * News radar — fetches headlines from RSS feeds and web sources.
 * Categories: business, tech, finance, brazil, world.
 */

// ─── RSS Feed Sources ───────────────────────────────────────

interface NewsSource {
  name: string
  url: string
  category: NewsCategory
}

export type NewsCategory = 'business' | 'tech' | 'finance' | 'brazil' | 'world'

const FEEDS: readonly NewsSource[] = [
  // Business & Economy
  { name: 'InfoMoney', url: 'https://www.infomoney.com.br/feed/', category: 'finance' },
  { name: 'Valor Economico', url: 'https://pox.globo.com/rss/valor/', category: 'business' },
  { name: 'Bloomberg Linea BR', url: 'https://www.bloomberglinea.com.br/feed/', category: 'finance' },

  // Tech
  { name: 'TechCrunch', url: 'https://techcrunch.com/feed/', category: 'tech' },
  { name: 'Hacker News (best)', url: 'https://hnrss.org/best', category: 'tech' },
  { name: 'The Verge', url: 'https://www.theverge.com/rss/index.xml', category: 'tech' },

  // Brazil
  { name: 'G1', url: 'https://g1.globo.com/rss/g1/', category: 'brazil' },
  { name: 'Folha', url: 'https://feeds.folha.uol.com.br/folha/cotidiano/rss091.xml', category: 'brazil' },

  // World
  { name: 'BBC World', url: 'https://feeds.bbci.co.uk/news/world/rss.xml', category: 'world' },
  { name: 'Reuters', url: 'https://www.reutersagency.com/feed/', category: 'world' },
]

// ─── Constants ──────────────────────────────────────────────

const MAX_BODY_BYTES = 2 * 1024 * 1024  // 2 MB max per feed
const MAX_ITEMS_PER_FEED = 10
const FETCH_TIMEOUT_MS = 10_000

// ─── RSS Parser (minimal, no dependencies) ──────────────────

interface NewsItem {
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

function extractAtomLink(xml: string): string | null {
  const regex = /<link[^>]+href="([^"]+)"[^>]*\/?>/i
  const match = regex.exec(xml)
  return match ? match[1] : null
}

function cleanHtml(text: string): string {
  return text
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .trim()
}

// ─── Public API ─────────────────────────────────────────────

/**
 * Fetch news from all or filtered categories.
 * Returns formatted text output.
 */
export async function fetchNews(
  categories?: NewsCategory[],
  maxPerSource = 5,
): Promise<string> {
  // Validate maxPerSource
  const cappedMax = Math.max(1, Math.min(maxPerSource, MAX_ITEMS_PER_FEED))

  // Guard against empty categories array
  if (categories && categories.length === 0) {
    return getNewsCategories()
  }

  const feeds = categories
    ? FEEDS.filter((f) => categories.includes(f.category))
    : FEEDS

  const results = await Promise.allSettled(
    feeds.map((feed) => fetchFeed(feed, cappedMax)),
  )

  const allItems: NewsItem[] = []
  const errors: string[] = []

  for (let i = 0; i < results.length; i++) {
    const result = results[i]
    if (result.status === 'fulfilled') {
      allItems.push(...result.value)
    } else {
      errors.push(`${feeds[i].name}: ${summarizeError(result.reason)}`)
    }
  }

  if (allItems.length === 0) {
    return errors.length > 0
      ? `Nenhuma noticia encontrada.\nFalhas: ${errors.join(', ')}`
      : 'Nenhuma noticia encontrada.'
  }

  // Sort by date (newest first)
  allItems.sort((a, b) => {
    const da = a.pubDate?.getTime() || 0
    const db = b.pubDate?.getTime() || 0
    return db - da
  })

  return formatNews(allItems, errors)
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

    const xml = new TextDecoder().decode(Buffer.concat(chunks))
    const items = parseRss(xml, source.name, source.category)
    return items.slice(0, maxItems)
  } catch (err) {
    clearTimeout(timeout)
    // Log errors for debugging but don't crash
    if (process.env.DEBUG) {
      console.error(`[news] ${source.name}: ${err instanceof Error ? err.message : err}`)
    }
    return []
  }
}

function formatNews(items: NewsItem[], errors: string[]): string {
  const categoryLabels: Record<NewsCategory, string> = {
    business: 'Negocios',
    tech: 'Tecnologia',
    finance: 'Financas',
    brazil: 'Brasil',
    world: 'Mundo',
  }

  // Group by category (immutable approach)
  const grouped = new Map<NewsCategory, NewsItem[]>()
  for (const item of items) {
    const existing = grouped.get(item.category) || []
    grouped.set(item.category, [...existing, item])
  }

  const sections: string[] = []
  const categoryOrder: NewsCategory[] = ['finance', 'business', 'tech', 'brazil', 'world']

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
 * Get list of available categories.
 */
export function getNewsCategories(): string {
  return 'Categorias: business, tech, finance, brazil, world\nUso: /news [categoria]'
}
