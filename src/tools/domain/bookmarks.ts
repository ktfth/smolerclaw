import type Anthropic from '@anthropic-ai/sdk'
import {
  saveBookmark, updateBookmark, deleteBookmark, searchBookmarks, listBookmarks,
  formatBookmarkList, formatBookmarkTags, formatBookmarkDomains,
} from '../../bookmarks'
import { bindTools, ok, fail, requireText, optionalText, optionalStrings, type ToolHandler } from '../../core/result'

const SCHEMAS: Anthropic.Tool[] = [
  {
    name: 'save_bookmark',
    description:
      'Save a URL/link as a bookmark with title and optional tags/description. ' +
      'Use when the user says "salva esse link", "bookmark isso", "guarda essa URL", etc.',
    input_schema: {
      type: 'object' as const,
      properties: {
        url: { type: 'string', description: 'The URL to bookmark' },
        title: { type: 'string', description: 'Title/name for the bookmark' },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional tags for categorization',
        },
        description: {
          type: 'string',
          description: 'Optional description or notes. Use #tags for auto-tagging.',
        },
      },
      required: ['url', 'title'],
    },
  },
  {
    name: 'search_bookmarks',
    description:
      'Search bookmarks by keyword, tag (#tag), or domain (@domain). ' +
      'Use when the user asks "qual era aquele link...", "mostra meus bookmarks de...", etc.',
    input_schema: {
      type: 'object' as const,
      properties: {
        query: {
          type: 'string',
          description: 'Search query. Use #tag for tag search, @domain for domain search, or plain text.',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'list_bookmarks',
    description:
      'List all bookmarks, most recent first. ' +
      'Use when the user says "mostra meus bookmarks", "lista os links salvos", etc.',
    input_schema: {
      type: 'object' as const,
      properties: {
        limit: {
          type: 'number',
          description: 'Max bookmarks to return (default: 20)',
        },
      },
      required: [],
    },
  },
  {
    name: 'delete_bookmark',
    description:
      'Delete a bookmark by its ID. ' +
      'Use when the user says "remove esse bookmark", "apaga esse link", etc.',
    input_schema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'Bookmark ID to delete' },
      },
      required: ['id'],
    },
  },
  {
    name: 'update_bookmark',
    description:
      'Update a bookmark\'s title, URL, tags, or description. ' +
      'Use when the user says "atualiza esse bookmark", "muda o titulo desse link", etc.',
    input_schema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'Bookmark ID to update' },
        url: { type: 'string', description: 'New URL (optional)' },
        title: { type: 'string', description: 'New title (optional)' },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'New tags (optional)',
        },
        description: { type: 'string', description: 'New description (optional)' },
      },
      required: ['id'],
    },
  },
  {
    name: 'bookmark_tags',
    description: 'Show all bookmark tags with counts, or bookmark domains with counts.',
    input_schema: {
      type: 'object' as const,
      properties: {
        view: {
          type: 'string',
          enum: ['tags', 'domains'],
          description: 'View tags or domains (default: tags)',
        },
      },
      required: [],
    },
  },
]

const HANDLERS: Record<string, ToolHandler> = {
  save_bookmark: (input) => {
    const url = requireText(input, 'url')
    const title = requireText(input, 'title')
    if (!url || !title) return fail('url and title are required.')
    const bk = saveBookmark(url, title, {
      tags: optionalStrings(input, 'tags'),
      description: optionalText(input, 'description'),
    })
    const tagStr = bk.tags.length > 0 ? ` [${bk.tags.map((t) => '#' + t).join(' ')}]` : ''
    return ok(`Bookmark salvo: ${bk.title}${tagStr}\n${bk.url}  {${bk.id}}`, bk)
  },
  search_bookmarks: (input) => {
    const query = requireText(input, 'query')
    const found = query ? searchBookmarks(query) : listBookmarks()
    return ok(formatBookmarkList(found), found)
  },
  list_bookmarks: (input) => {
    const found = listBookmarks(typeof input.limit === 'number' ? input.limit : 20)
    return ok(formatBookmarkList(found), found)
  },
  delete_bookmark: (input) => {
    const id = requireText(input, 'id')
    if (!id) return fail('id is required.')
    return deleteBookmark(id) ? ok(`Bookmark {${id}} removido.`) : fail(`Bookmark {${id}} não encontrado.`)
  },
  update_bookmark: (input) => {
    const id = requireText(input, 'id')
    if (!id) return fail('id is required.')
    const updated = updateBookmark(id, {
      url: optionalText(input, 'url'),
      title: optionalText(input, 'title'),
      // A string (even "") is passed through so the description can be cleared.
      description: typeof input.description === 'string' ? input.description : undefined,
      tags: optionalStrings(input, 'tags'),
    })
    return updated
      ? ok(`Bookmark atualizado: ${updated.title}\n${updated.url}  {${updated.id}}`, updated)
      : fail(`Bookmark {${id}} não encontrado.`)
  },
  bookmark_tags: (input) => ok(input.view === 'domains' ? formatBookmarkDomains() : formatBookmarkTags()),
}

export const BOOKMARK_TOOLS = bindTools(SCHEMAS, HANDLERS, ['search_bookmarks', 'list_bookmarks', 'bookmark_tags'])
