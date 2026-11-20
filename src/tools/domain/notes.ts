import type Anthropic from '@anthropic-ai/sdk'
import {
  addNote, getNote, updateNote, deleteNote, listNotes, searchNotes, noteTags,
  formatNoteList, formatNoteDetail, NOTE_KINDS, type NoteKind,
} from '../../notes'
import { bindTools, ok, fail, requireText, optionalText, optionalStrings, type ToolHandler, type ToolInput } from '../../core/result'

const KIND_PROPERTY = {
  type: 'string',
  enum: [...NOTE_KINDS],
  description: 'memo = free-text note; link = a URL (bookmark); reference = titled reference material (procedure, guide, template...).',
}

const SCHEMAS: Anthropic.Tool[] = [
  {
    name: 'save_note',
    description:
      'Save a note to the personal knowledge base. One store for memos, links and reference material. ' +
      'Use kind "memo" for "anota isso"/"lembra disso", "link" for "salva esse link", ' +
      '"reference" for "guarda esse material/procedimento". #hashtags in the text become tags.',
    input_schema: {
      type: 'object' as const,
      properties: {
        kind: KIND_PROPERTY,
        body: { type: 'string', description: 'Main text: the memo, the link description, or the material content.' },
        title: { type: 'string', description: 'Title. Recommended for links and references.' },
        url: { type: 'string', description: 'URL. Required when kind is "link".' },
        category: { type: 'string', description: 'Category for references (procedimento, guia, template, tecnico, geral...).' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Extra tags (without #).' },
      },
      required: ['kind', 'body'],
    },
  },
  {
    name: 'search_notes',
    description:
      'Search notes. "#tag" matches a tag, "@x" a category or link domain, plain words match title, text and URL. ' +
      'Use for "o que eu anotei sobre...", "qual era aquele link...", or before answering from saved material.',
    input_schema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'Search text, #tag or @category/@domain.' },
        kind: KIND_PROPERTY,
        limit: { type: 'integer', minimum: 1, maximum: 200, description: 'Max results. Default 30.' },
      },
      required: ['query'],
    },
  },
  {
    name: 'list_notes',
    description: 'List the most recently updated notes, optionally filtered by kind or category.',
    input_schema: {
      type: 'object' as const,
      properties: {
        kind: KIND_PROPERTY,
        category: { type: 'string', description: 'Only notes in this category.' },
        limit: { type: 'integer', minimum: 1, maximum: 200, description: 'Max results. Default 30.' },
      },
      required: [],
    },
  },
  {
    name: 'get_note',
    description: 'Show one note in full by its ID.',
    input_schema: {
      type: 'object' as const,
      properties: { id: { type: 'string', description: 'Note ID' } },
      required: ['id'],
    },
  },
  {
    name: 'update_note',
    description: 'Update fields of a note. Omitted fields are kept; an empty string clears url or category.',
    input_schema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'Note ID' },
        body: { type: 'string', description: 'New text' },
        title: { type: 'string', description: 'New title' },
        url: { type: 'string', description: 'New URL' },
        category: { type: 'string', description: 'New category' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Replace the explicit tags.' },
      },
      required: ['id'],
    },
  },
  {
    name: 'delete_note',
    description: 'Delete a note by its ID.',
    input_schema: {
      type: 'object' as const,
      properties: { id: { type: 'string', description: 'Note ID' } },
      required: ['id'],
    },
  },
  {
    name: 'note_tags',
    description: 'List tags with how many notes use each, optionally for one kind.',
    input_schema: {
      type: 'object' as const,
      properties: { kind: KIND_PROPERTY },
      required: [],
    },
  },
]

// The schema enum already constrains kind; this narrows the type.
const kindOf = (input: ToolInput): NoteKind | undefined =>
  NOTE_KINDS.find((k) => k === input.kind)

const limitOf = (input: ToolInput): number | undefined =>
  typeof input.limit === 'number' ? input.limit : undefined

const HANDLERS: Record<string, ToolHandler> = {
  save_note: (input) => {
    const kind = kindOf(input)
    if (!kind) return fail('kind is required.')
    const body = typeof input.body === 'string' ? input.body : ''
    const url = optionalText(input, 'url')
    if (kind === 'link' && !url) return fail('url is required for kind "link".')
    if (kind !== 'link' && !body.trim()) return fail('body is required.')
    const note = addNote({
      kind, body, url,
      title: optionalText(input, 'title'),
      category: optionalText(input, 'category') ?? (kind === 'reference' ? 'geral' : undefined),
      tags: optionalStrings(input, 'tags'),
    })
    const tags = note.tags.length ? ` [${note.tags.map((t) => `#${t}`).join(' ')}]` : ''
    return ok(`Nota salva (${note.kind})${tags}  {${note.id}}`, note)
  },
  search_notes: (input) => {
    const query = requireText(input, 'query') ?? ''
    const notes = searchNotes(query, { kind: kindOf(input), limit: limitOf(input) })
    return ok(formatNoteList(notes), notes)
  },
  list_notes: (input) => {
    const notes = listNotes({ kind: kindOf(input), category: optionalText(input, 'category'), limit: limitOf(input) })
    return ok(formatNoteList(notes), notes)
  },
  get_note: (input) => {
    const id = requireText(input, 'id')
    const note = id ? getNote(id) : null
    return note ? ok(formatNoteDetail(note), note) : fail(`Nota não encontrada: "${id ?? ''}"`)
  },
  update_note: (input) => {
    const id = requireText(input, 'id')
    if (!id) return fail('id is required.')
    const note = updateNote(id, {
      // Strings (even "") pass through so fields can be cleared.
      body: typeof input.body === 'string' ? input.body : undefined,
      title: typeof input.title === 'string' ? input.title : undefined,
      url: typeof input.url === 'string' ? input.url : undefined,
      category: typeof input.category === 'string' ? input.category : undefined,
      tags: optionalStrings(input, 'tags'),
    })
    return note ? ok(`Nota atualizada: {${note.id}}`, note) : fail(`Nota não encontrada: "${id}"`)
  },
  delete_note: (input) => {
    const id = requireText(input, 'id')
    if (!id) return fail('id is required.')
    return deleteNote(id) ? ok(`Nota removida: {${id}}`) : fail(`Nota não encontrada: "${id}"`)
  },
  note_tags: (input) => {
    const tags = noteTags(kindOf(input))
    const text = tags.length ? tags.map((t) => `  #${t.tag} (${t.count})`).join('\n') : 'Nenhuma tag.'
    return ok(text, tags)
  },
}

export const NOTE_TOOLS = bindTools(
  SCHEMAS,
  HANDLERS,
  ['search_notes', 'list_notes', 'get_note', 'note_tags'],
  { destructive: ['delete_note'] },
)
