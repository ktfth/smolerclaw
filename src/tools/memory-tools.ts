/**
 * Memory/RAG tool schemas and execution.
 */
import type Anthropic from '@anthropic-ai/sdk'
import {
  queryMemory, buildIndex, getIndexStats, formatQueryResults,
  isMemoryInitialized,
} from '../memory'

export const MEMORY_TOOLS: Anthropic.Tool[] = [
  {
    name: 'recall_memory',
    description:
      'Search the local RAG memory index for relevant information from memos, materials, decisions, and past sessions. ' +
      'Use when the user asks "o que eu sei sobre...", "lembra de...", "busca na memoria...", or needs context from past interactions. ' +
      'Returns the top 3 most relevant text fragments.',
    input_schema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'Natural language query to search the memory index' },
        top_k: { type: 'number', description: 'Number of results to return. Default 3, max 10.' },
      },
      required: ['query'],
    },
  },
  {
    name: 'index_memory',
    description:
      'Build or update the local RAG memory index. Indexes memos, materials, decisions, and sessions. ' +
      'Incremental — only re-indexes changed data. Use when the user says "atualiza a memoria", "reindexa", or after adding many new items.',
    input_schema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  },
  {
    name: 'memory_status',
    description: 'Show stats about the local RAG memory index: number of indexed chunks, sources, and last build time.',
    input_schema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  },
]

export function executeMemoryTool(
  name: string,
  input: Record<string, unknown>,
): string | null {
  switch (name) {
    case 'recall_memory': {
      if (!isMemoryInitialized()) return 'Error: memory not initialized. Run /indexar first.'
      const query = input.query as string
      if (!query?.trim()) return 'Error: query is required.'
      const topK = Math.min(Math.max((input.top_k as number) || 3, 1), 10)
      const results = queryMemory(query, topK)
      return formatQueryResults(results)
    }
    case 'index_memory': {
      if (!isMemoryInitialized()) return 'Error: memory not initialized.'
      const stats = buildIndex()
      return `Indexacao concluida: ${stats.indexed} fonte(s) indexada(s), ${stats.skipped} sem alteracao. Total: ${stats.total} chunks.`
    }
    case 'memory_status': {
      if (!isMemoryInitialized()) return 'Memory: nao inicializada.'
      const stats = getIndexStats()
      const builtStr = stats.builtAt
        ? new Date(stats.builtAt).toLocaleString('pt-BR')
        : 'nunca'
      return `Memory RAG Index:\n  Chunks: ${stats.chunks}\n  Fontes: ${stats.sources}\n  Ultima indexacao: ${builtStr}`
    }
    default:
      return null
  }
}
