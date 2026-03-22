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

const FEEDS: NewsSource[] = [
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
    const title = extractTag(block, 'title')
    const link = extractTag(block, 'link') || extractAtomLink(block)
    const pubDateStr = extractTag(block, 'pubDate') || extractTag(block, 'published') || extractTag(block, 'updated')

    if (title) {
      items.push({
        title: cleanHtml(title),
        link: link || '',
        source,
        category,
        pubDate: pubDateStr ? new Date(pubDateStr) : undefined,
      })
    }

    if (items.length >= 10) break
  }

  // If no <item>, try Atom <entry>
  if (items.length === 0) {
    const entryRegex = /<entry[\s>]([\s\S]*?)<\/entry>/gi
    while ((match = entryRegex.exec(xml)) !== null) {
      const block = match[1]
      const title = extractTag(block, 'title')
      const link = extractAtomLink(block) || extractTag(block, 'link')
      const pubDateStr = extractTag(block, 'published') || extractTag(block, 'updated')

      if (title) {
        items.push({
          title: cleanHtml(title),
          link: link || '',
          source,
          category,
          pubDate: pubDateStr ? new Date(pubDateStr) : undefined,
        })
      }

      if (items.length >= 10) break
    }
  }

  return items
}

function extractTag(xml: string, tag: string): string | null {
  // Handle CDATA
  const cdataRegex = new RegExp(`<${tag}[^>]*>\\s*<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>\\s*</${tag}>`, 'i')
  const cdataMatch = cdataRegex.exec(xml)
  if (cdataMatch) return cdataMatch[1].trim()

  // Plain text
  const regex = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i')
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
  const feeds = categories
    ? FEEDS.filter((f) => categories.includes(f.category))
    : FEEDS

  const results = await Promise.allSettled(
    feeds.map((feed) => fetchFeed(feed, maxPerSource)),
  )

  const allItems: NewsItem[] = []
  const errors: string[] = []

  for (let i = 0; i < results.length; i++) {
    const result = results[i]
    if (result.status === 'fulfilled') {
      allItems.push(...result.value)
    } else {
      errors.push(`${feeds[i].name}: timeout/unreachable`)
    }
  }

  if (allItems.length === 0) {
    return errors.length > 0
      ? `Nenhuma noticia encontrada.\nFalhas: ${errors.join(', ')}`
      : 'Nenhuma noticia encontrada.'
  }

  // Sort by date (newest first), group by category
  allItems.sort((a, b) => {
    const da = a.pubDate?.getTime() || 0
    const db = b.pubDate?.getTime() || 0
    return db - da
  })

  return formatNews(allItems, errors)
}

async function fetchFeed(source: NewsSource, maxItems: number): Promise<NewsItem[]> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 10_000)

  try {
    const resp = await fetch(source.url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'tinyclaw/1.0 (news-radar)',
        'Accept': 'application/rss+xml, application/atom+xml, application/xml, text/xml',
      },
    })
    clearTimeout(timeout)

    if (!resp.ok) return []

    const xml = await resp.text()
    const items = parseRss(xml, source.name, source.category)
    return items.slice(0, maxItems)
  } catch {
    clearTimeout(timeout)
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

  // Group by category
  const grouped = new Map<NewsCategory, NewsItem[]>()
  for (const item of items) {
    const list = grouped.get(item.category) || []
    list.push(item)
    grouped.set(item.category, list)
  }

  const sections: string[] = []
  const categoryOrder: NewsCategory[] = ['finance', 'business', 'tech', 'brazil', 'world']

  for (const cat of categoryOrder) {
    const catItems = grouped.get(cat)
    if (!catItems || catItems.length === 0) continue

    const label = categoryLabels[cat]
    const lines = catItems.slice(0, 8).map((item) => {
      const time = item.pubDate
        ? item.pubDate.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
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
