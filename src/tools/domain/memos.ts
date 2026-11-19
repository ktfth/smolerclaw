import type Anthropic from '@anthropic-ai/sdk'
import { saveMemo, searchMemos, listMemos, formatMemoList } from '../../memos'
import { bindTools, ok, fail, requireText, optionalStrings, type ToolHandler } from '../../core/result'

const SCHEMAS: Anthropic.Tool[] = [
  {
    name: 'save_memo',
    description:
      'Save a note/memo to the user\'s personal knowledge base. ' +
      'Use #hashtags in the content to auto-tag. ' +
      'Use when the user says "anota", "lembra disso", "salva isso", or shares important information.',
    input_schema: {
      type: 'object' as const,
      properties: {
        content: { type: 'string', description: 'The memo content. Use #tags for categorization.' },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional additional tags (without #). Auto-extracted #tags from content are always included.',
        },
      },
      required: ['content'],
    },
  },
  {
    name: 'search_memos',
    description:
      'Search the user\'s memos by keyword or tag. ' +
      'Use #tag to search by tag only. Use plain text for content search. ' +
      'Use when the user asks "o que eu anotei sobre...", "qual era aquela nota...", etc.',
    input_schema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'Search query. Use #tag for tag search, or plain text for content search.' },
      },
      required: ['query'],
    },
  },
]

const HANDLERS: Record<string, ToolHandler> = {
  save_memo: (input) => {
    const content = requireText(input, 'content')
    if (!content) return fail('content is required.')
    const memo = saveMemo(content, optionalStrings(input, 'tags') ?? [])
    const tagStr = memo.tags.length > 0 ? ` [${memo.tags.map((t) => '#' + t).join(' ')}]` : ''
    return ok(`Memo salvo${tagStr}  {${memo.id}}`, memo)
  },
  search_memos: (input) => {
    const query = requireText(input, 'query')
    const memos = query ? searchMemos(query) : listMemos()
    return ok(formatMemoList(memos), memos)
  },
}

export const MEMO_TOOLS = bindTools(SCHEMAS, HANDLERS, ['search_memos'])
