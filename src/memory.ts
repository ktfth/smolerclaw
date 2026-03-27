/**
 * Local RAG (Retrieval-Augmented Generation) module.
 *
 * Indexes memos, materials, decisions, and sessions into a local
 * vector store using TF-IDF + BM25 hybrid scoring.
 *
 * Designed for small personal corpora — pure TypeScript, zero external
 * dependencies, works fully offline. The EmbeddingProvider interface
 * allows swapping in neural embeddings (Voyage, OpenAI) later.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { atomicWriteFile } from './vault'

// ─── Types ──────────────────────────────────────────────────

export type ChunkSource = 'memo' | 'material' | 'session' | 'decision'

export interface DocumentChunk {
  id: string
  source: ChunkSource
  sourceId: string
  title: string
  content: string
  tokens: string[]
}

export interface RankedResult {
  chunk: DocumentChunk
  score: number
}

interface StoredIndex {
  chunks: DocumentChunk[]
  idf: Record<string, number>
  avgDocLength: number
  sourceHashes: Record<string, string>
  builtAt: string
  version: number
}

// ─── Constants ──────────────────────────────────────────────

const INDEX_VERSION = 1
const CHUNK_SIZE = 400        // chars per chunk
const CHUNK_OVERLAP = 80      // overlap between chunks
const BM25_K1 = 1.5
const BM25_B = 0.75
const MAX_RESULTS = 10

// Portuguese + English stop words
const STOP_WORDS = new Set([
  // Portuguese
  'a', 'o', 'e', 'de', 'do', 'da', 'em', 'um', 'uma', 'para', 'com',
  'nao', 'que', 'por', 'se', 'na', 'no', 'os', 'as', 'ao', 'ou',
  'foi', 'ser', 'tem', 'seu', 'sua', 'mais', 'como', 'mas', 'dos',
  'das', 'esse', 'essa', 'este', 'esta', 'isso', 'isto', 'ele', 'ela',
  'nos', 'ja', 'ate', 'muito', 'tambem', 'entre', 'quando', 'sobre',
  'mesmo', 'depois', 'sem', 'vai', 'ainda', 'pode', 'aqui', 'so',
  // English
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'shall', 'can', 'to', 'of', 'in', 'for',
  'on', 'with', 'at', 'by', 'from', 'as', 'into', 'through', 'during',
  'before', 'after', 'above', 'below', 'between', 'out', 'off', 'over',
  'under', 'again', 'further', 'then', 'once', 'here', 'there', 'when',
  'where', 'why', 'how', 'all', 'each', 'every', 'both', 'few', 'more',
  'most', 'other', 'some', 'such', 'no', 'nor', 'not', 'only', 'own',
  'same', 'so', 'than', 'too', 'very', 'just', 'because', 'but', 'and',
  'or', 'if', 'while', 'this', 'that', 'these', 'those', 'it', 'its',
])

// ─── Singleton State ────────────────────────────────────────

let _dataDir = ''
let _indexDir = ''
let _chunks: DocumentChunk[] = []
let _idf: Record<string, number> = {}
let _avgDocLength = 0
let _sourceHashes: Record<string, string> = {}
let _initialized = false

const INDEX_FILE = () => join(_indexDir, 'rag-index.json')

// ─── Initialization ─────────────────────────────────────────

export function initMemory(dataDir: string): void {
  _dataDir = dataDir
  _indexDir = join(dataDir, 'rag')
  if (!existsSync(_indexDir)) mkdirSync(_indexDir, { recursive: true })
  loadIndex()
  _initialized = true
}

export function isMemoryInitialized(): boolean {
  return _initialized
}

export function getIndexStats(): { chunks: number; sources: number; builtAt: string | null } {
  return {
    chunks: _chunks.length,
    sources: Object.keys(_sourceHashes).length,
    builtAt: _chunks.length > 0 ? readMeta()?.builtAt ?? null : null,
  }
}

// ─── Indexing ───────────────────────────────────────────────

/**
 * Build or incrementally update the RAG index from local data sources.
 * Returns the number of new/updated chunks.
 */
export function buildIndex(): { indexed: number; skipped: number; total: number } {
  if (!_initialized) throw new Error('Memory not initialized. Call initMemory() first.')
  const sources = collectSources()
  let indexed = 0
  let skipped = 0

  // Detect which sources changed
  const newHashes: Record<string, string> = {}
  const changedSourceIds = new Set<string>()

  for (const [key, content] of Object.entries(sources)) {
    const hash = hashContent(content)
    newHashes[key] = hash
    if (_sourceHashes[key] !== hash) {
      changedSourceIds.add(key)
    }
  }

  // Detect removed sources
  const removedKeys = Object.keys(_sourceHashes).filter((k) => !(k in sources))

  if (changedSourceIds.size === 0 && removedKeys.length === 0) {
    return { indexed: 0, skipped: Object.keys(sources).length, total: _chunks.length }
  }

  // Remove chunks from changed/removed sources
  _chunks = _chunks.filter((c) => {
    const key = `${c.source}:${c.sourceId}`
    return !changedSourceIds.has(key) && !removedKeys.includes(key)
  })

  // Re-chunk changed sources
  for (const key of changedSourceIds) {
    const content = sources[key]
    const colonIdx = key.indexOf(':')
    if (colonIdx === -1) continue
    const source = key.slice(0, colonIdx) as ChunkSource
    const sourceId = key.slice(colonIdx + 1)
    const validSources: ChunkSource[] = ['memo', 'material', 'session', 'decision']
    if (!validSources.includes(source)) continue
    const title = extractTitle(source, sourceId, content)
    const newChunks = chunkText(content, source, sourceId, title)
    _chunks = [..._chunks, ...newChunks]
    indexed++
  }

  skipped = Object.keys(sources).length - indexed

  // Rebuild IDF from all chunks
  rebuildIdf()
  _sourceHashes = newHashes

  // Persist
  saveIndex()

  return { indexed, skipped, total: _chunks.length }
}

// ─── Query ──────────────────────────────────────────────────

/**
 * Query the index and return the top-K most relevant chunks.
 * Uses BM25 + TF-IDF cosine similarity hybrid scoring.
 */
export function queryMemory(query: string, topK: number = 3): RankedResult[] {
  if (_chunks.length === 0) return []

  const queryTokens = tokenize(query)
  if (queryTokens.length === 0) return []

  // Score each chunk
  const scored: RankedResult[] = _chunks.map((chunk) => {
    const bm25 = scoreBM25(queryTokens, chunk)
    const tfidfSim = scoreTFIDFCosine(queryTokens, chunk)

    // Hybrid: weight BM25 (0.6) + TF-IDF cosine (0.4)
    const score = 0.6 * bm25 + 0.4 * tfidfSim
    return { chunk, score }
  })

  // Filter zero-score, sort descending, take top-K
  return scored
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.min(topK, MAX_RESULTS))
}

/**
 * Format query results for display as a tool response.
 */
export function formatQueryResults(results: RankedResult[]): string {
  if (results.length === 0) return 'Nenhum resultado encontrado na memoria local.'

  const lines = results.map((r, i) => {
    const src = sourceLabel(r.chunk.source)
    const score = (r.score * 100).toFixed(1)
    const preview = r.chunk.content.length > 300
      ? r.chunk.content.slice(0, 300).replace(/\n/g, ' ') + '...'
      : r.chunk.content.replace(/\n/g, ' ')
    return `[${i + 1}] ${src}: ${r.chunk.title} (relevancia: ${score}%)\n${preview}`
  })

  return `Resultados da memoria (${results.length}):\n\n${lines.join('\n\n')}`
}

// ─── BM25 Scoring ───────────────────────────────────────────

function scoreBM25(queryTokens: string[], chunk: DocumentChunk): number {
  const docLen = chunk.tokens.length
  if (docLen === 0 || _avgDocLength === 0) return 0

  // Build term frequency map for this chunk
  const tf = new Map<string, number>()
  for (const token of chunk.tokens) {
    tf.set(token, (tf.get(token) ?? 0) + 1)
  }

  let score = 0
  for (const qt of queryTokens) {
    const termFreq = tf.get(qt) ?? 0
    if (termFreq === 0) continue

    const idfVal = _idf[qt] ?? 0
    if (idfVal === 0) continue

    const numerator = termFreq * (BM25_K1 + 1)
    const denominator = termFreq + BM25_K1 * (1 - BM25_B + BM25_B * (docLen / _avgDocLength))
    score += idfVal * (numerator / denominator)
  }

  return score
}

// ─── TF-IDF Cosine Similarity ───────────────────────────────

function scoreTFIDFCosine(queryTokens: string[], chunk: DocumentChunk): number {
  // Build query TF
  const queryTf = new Map<string, number>()
  for (const qt of queryTokens) {
    queryTf.set(qt, (queryTf.get(qt) ?? 0) + 1)
  }

  // Build doc TF
  const docTf = new Map<string, number>()
  for (const token of chunk.tokens) {
    docTf.set(token, (docTf.get(token) ?? 0) + 1)
  }

  // Compute TF-IDF vectors and cosine similarity
  // Only consider terms that appear in either query or doc
  const allTerms = new Set([...queryTokens, ...chunk.tokens])

  let dotProduct = 0
  let queryNorm = 0
  let docNorm = 0

  for (const term of allTerms) {
    const idfVal = _idf[term] ?? 0
    const qTfIdf = (queryTf.get(term) ?? 0) * idfVal
    const dTfIdf = (docTf.get(term) ?? 0) * idfVal

    dotProduct += qTfIdf * dTfIdf
    queryNorm += qTfIdf * qTfIdf
    docNorm += dTfIdf * dTfIdf
  }

  const normProduct = Math.sqrt(queryNorm) * Math.sqrt(docNorm)
  return normProduct > 0 ? dotProduct / normProduct : 0
}

// ─── Text Processing ────────────────────────────────────────

/**
 * Tokenize text: lowercase, remove punctuation, split on whitespace,
 * remove stop words, remove short tokens.
 */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\w\sáéíóúâêîôûãõàèìòùäëïöüç]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 2 && !STOP_WORDS.has(t))
}

/**
 * Split text into overlapping chunks.
 */
function chunkText(
  content: string,
  source: ChunkSource,
  sourceId: string,
  title: string,
): DocumentChunk[] {
  const text = content.trim()
  if (text.length === 0) return []

  // For short texts, single chunk
  if (text.length <= CHUNK_SIZE) {
    return [{
      id: `${source}:${sourceId}:0`,
      source,
      sourceId,
      title,
      content: text,
      tokens: tokenize(text),
    }]
  }

  const chunks: DocumentChunk[] = []
  let offset = 0
  let chunkIdx = 0

  while (offset < text.length) {
    const end = Math.min(offset + CHUNK_SIZE, text.length)
    const slice = text.slice(offset, end)

    chunks.push({
      id: `${source}:${sourceId}:${chunkIdx}`,
      source,
      sourceId,
      title,
      content: slice,
      tokens: tokenize(slice),
    })

    offset += CHUNK_SIZE - CHUNK_OVERLAP
    chunkIdx++
  }

  return chunks
}

// ─── Data Collection ────────────────────────────────────────

/**
 * Collect all indexable text from local data sources.
 * Returns a map of "source:id" → "text content".
 */
function collectSources(): Record<string, string> {
  const sources: Record<string, string> = {}

  // Memos
  const memosFile = join(_dataDir, 'memos.json')
  if (existsSync(memosFile)) {
    try {
      const memos: unknown[] = JSON.parse(readFileSync(memosFile, 'utf-8'))
      if (!Array.isArray(memos)) throw new Error('not an array')
      for (const memo of memos) {
        if (!memo || typeof memo !== 'object') continue
        const m = memo as Record<string, unknown>
        if (typeof m.id !== 'string' || typeof m.content !== 'string') continue
        const tags = Array.isArray(m.tags) && m.tags.length > 0 ? ` [${m.tags.join(', ')}]` : ''
        sources[`memo:${m.id}`] = `${m.content}${tags}`
      }
    } catch { /* skip corrupted file */ }
  }

  // Materials
  const materialsFile = join(_dataDir, 'materials.json')
  if (existsSync(materialsFile)) {
    try {
      const materials: unknown[] = JSON.parse(readFileSync(materialsFile, 'utf-8'))
      if (!Array.isArray(materials)) throw new Error('not an array')
      for (const mat of materials) {
        if (!mat || typeof mat !== 'object') continue
        const m = mat as Record<string, unknown>
        if (typeof m.id !== 'string' || typeof m.title !== 'string' || typeof m.content !== 'string') continue
        const category = typeof m.category === 'string' ? m.category : 'geral'
        const tags = Array.isArray(m.tags) && m.tags.length > 0 ? ` [${m.tags.join(', ')}]` : ''
        sources[`material:${m.id}`] = `${m.title}\n${category}\n${m.content}${tags}`
      }
    } catch { /* skip corrupted file */ }
  }

  // Decisions
  const decisionsFile = join(_dataDir, 'decisions.json')
  if (existsSync(decisionsFile)) {
    try {
      const decisions: unknown[] = JSON.parse(readFileSync(decisionsFile, 'utf-8'))
      if (!Array.isArray(decisions)) throw new Error('not an array')
      for (const dec of decisions) {
        if (!dec || typeof dec !== 'object') continue
        const d = dec as Record<string, unknown>
        if (typeof d.id !== 'string' || typeof d.title !== 'string' || typeof d.context !== 'string' || typeof d.chosen !== 'string') continue
        const parts = [d.title, d.context, `Escolha: ${d.chosen}`]
        if (typeof d.alternatives === 'string') parts.push(`Alternativas: ${d.alternatives}`)
        if (Array.isArray(d.tags) && d.tags.length > 0) parts.push(`[${d.tags.join(', ')}]`)
        sources[`decision:${d.id}`] = parts.join('\n')
      }
    } catch { /* skip corrupted file */ }
  }

  // Sessions — index only assistant messages (they contain the synthesized knowledge)
  const sessionsDir = join(_dataDir, 'sessions')
  if (existsSync(sessionsDir)) {
    try {
      const files = readdirSync(sessionsDir, { withFileTypes: true })
        .filter((d) => d.isFile() && d.name.endsWith('.json') && !d.name.startsWith('.'))
        .map((d) => d.name)
      for (const file of files) {
        const sessionPath = join(sessionsDir, file)
        try {
          const session = JSON.parse(readFileSync(sessionPath, 'utf-8'))
          if (!session || typeof session !== 'object' || !Array.isArray(session.messages)) continue
          const assistantTexts = session.messages
            .filter((m: unknown) => {
              if (!m || typeof m !== 'object') return false
              const msg = m as Record<string, unknown>
              return msg.role === 'assistant' && typeof msg.content === 'string' && (msg.content as string).length > 50
            })
            .map((m: Record<string, unknown>) => m.content as string)
            .join('\n---\n')
          if (assistantTexts.length > 0) {
            sources[`session:${session.id}`] = assistantTexts
          }
        } catch { /* skip corrupted session */ }
      }
    } catch { /* skip if no sessions dir */ }
  }

  return sources
}

// ─── IDF Computation ────────────────────────────────────────

function rebuildIdf(): void {
  const docCount = _chunks.length
  if (docCount === 0) {
    _idf = {}
    _avgDocLength = 0
    return
  }

  // Document frequency: how many chunks contain each term
  const df = new Map<string, number>()
  let totalLength = 0

  for (const chunk of _chunks) {
    const seen = new Set<string>()
    for (const token of chunk.tokens) {
      if (!seen.has(token)) {
        df.set(token, (df.get(token) ?? 0) + 1)
        seen.add(token)
      }
    }
    totalLength += chunk.tokens.length
  }

  _avgDocLength = totalLength / docCount

  // IDF with smoothing: log((N - df + 0.5) / (df + 0.5) + 1)
  const idf: Record<string, number> = {}
  for (const [term, freq] of df) {
    idf[term] = Math.log((docCount - freq + 0.5) / (freq + 0.5) + 1)
  }
  _idf = idf
}

// ─── Persistence ────────────────────────────────────────────

function saveIndex(): void {
  if (!_initialized) return
  const data: StoredIndex = {
    chunks: _chunks,
    idf: _idf,
    avgDocLength: _avgDocLength,
    sourceHashes: _sourceHashes,
    builtAt: new Date().toISOString(),
    version: INDEX_VERSION,
  }
  atomicWriteFile(INDEX_FILE(), JSON.stringify(data))
}

function loadIndex(): void {
  const file = INDEX_FILE()
  if (!existsSync(file)) {
    _chunks = []
    _idf = {}
    _avgDocLength = 0
    _sourceHashes = {}
    return
  }

  try {
    const data: StoredIndex = JSON.parse(readFileSync(file, 'utf-8'))
    if (data.version !== INDEX_VERSION) {
      // Version mismatch — force rebuild
      _chunks = []
      _idf = {}
      _avgDocLength = 0
      _sourceHashes = {}
      return
    }
    _chunks = data.chunks
    _idf = data.idf
    _avgDocLength = data.avgDocLength
    _sourceHashes = data.sourceHashes
  } catch {
    _chunks = []
    _idf = {}
    _avgDocLength = 0
    _sourceHashes = {}
  }
}

function readMeta(): { builtAt: string } | null {
  const file = INDEX_FILE()
  if (!existsSync(file)) return null
  try {
    const data = JSON.parse(readFileSync(file, 'utf-8'))
    return { builtAt: data.builtAt }
  } catch {
    return null
  }
}

// ─── Helpers ────────────────────────────────────────────────

function hashContent(content: string): string {
  return createHash('sha256').update(content).digest('hex').slice(0, 16)
}

function extractTitle(source: ChunkSource, sourceId: string, content: string): string {
  switch (source) {
    case 'material': {
      const firstLine = content.split('\n')[0]
      return firstLine.length > 60 ? firstLine.slice(0, 60) + '...' : firstLine
    }
    case 'memo':
      return content.slice(0, 60).replace(/\n/g, ' ') + (content.length > 60 ? '...' : '')
    case 'decision': {
      const firstLine = content.split('\n')[0]
      return firstLine.length > 60 ? firstLine.slice(0, 60) + '...' : firstLine
    }
    case 'session':
      return `Sessao ${sourceId}`
    default:
      return sourceId
  }
}

function sourceLabel(source: ChunkSource): string {
  switch (source) {
    case 'memo': return 'Memo'
    case 'material': return 'Material'
    case 'session': return 'Sessao'
    case 'decision': return 'Decisao'
    default: return source
  }
}
