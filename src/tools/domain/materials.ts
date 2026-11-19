import type Anthropic from '@anthropic-ai/sdk'
import {
  saveMaterial, searchMaterials, listMaterials, deleteMaterial, updateMaterial, formatMaterialList,
} from '../../materials'
import { bindTools, ok, fail, requireText, optionalText, optionalStrings, type ToolHandler } from '../../core/result'

const SCHEMAS: Anthropic.Tool[] = [
  {
    name: 'save_material',
    description:
      'Save reference material to the assistant\'s persistent knowledge base. ' +
      'Materials are categorized documents, guides, procedures, or reference info that persists across sessions. ' +
      'Use when the user says "salva esse material", "guarda essa referencia", "adiciona ao conhecimento", etc. ' +
      'Categories: procedimento, referencia, guia, template, contato, projeto, tecnico, geral.',
    input_schema: {
      type: 'object' as const,
      properties: {
        title: { type: 'string', description: 'Title of the material' },
        content: { type: 'string', description: 'Full content. Use #tags for categorization.' },
        category: {
          type: 'string',
          description: 'Category (e.g. procedimento, referencia, guia, template, contato, projeto, tecnico, geral). Default: geral.',
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional additional tags (without #).',
        },
      },
      required: ['title', 'content'],
    },
  },
  {
    name: 'search_materials',
    description:
      'Search the assistant\'s material knowledge base by keyword, tag (#tag), or category (@category). ' +
      'Use when answering questions that may be covered by saved materials, or when user asks about reference docs.',
    input_schema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'Search query. Use #tag for tag search, @category for category search, or plain text.' },
      },
      required: ['query'],
    },
  },
  {
    name: 'list_materials',
    description: 'List all saved materials, optionally filtered by category.',
    input_schema: {
      type: 'object' as const,
      properties: {
        category: { type: 'string', description: 'Filter by category. Optional.' },
        limit: { type: 'number', description: 'Max results. Default 30.' },
      },
      required: [],
    },
  },
  {
    name: 'update_material',
    description: 'Update an existing material by ID. Can change title, content, category, or tags.',
    input_schema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'Material ID' },
        title: { type: 'string', description: 'New title. Optional.' },
        content: { type: 'string', description: 'New content. Optional.' },
        category: { type: 'string', description: 'New category. Optional.' },
        tags: { type: 'array', items: { type: 'string' }, description: 'New tags. Optional.' },
      },
      required: ['id'],
    },
  },
  {
    name: 'delete_material',
    description: 'Delete a material by ID.',
    input_schema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'Material ID' },
      },
      required: ['id'],
    },
  },
]

const HANDLERS: Record<string, ToolHandler> = {
  save_material: (input) => {
    const title = requireText(input, 'title')
    if (!title) return fail('title is required.')
    const content = requireText(input, 'content')
    if (!content) return fail('content is required.')
    const mat = saveMaterial(title, content, optionalText(input, 'category') ?? 'geral', optionalStrings(input, 'tags') ?? [])
    const tagStr = mat.tags.length > 0 ? ` [${mat.tags.map((t) => '#' + t).join(' ')}]` : ''
    return ok(`Material salvo: "${mat.title}" (${mat.category})${tagStr}  {${mat.id}}`, mat)
  },
  search_materials: (input) => {
    const query = requireText(input, 'query')
    const mats = query ? searchMaterials(query) : listMaterials()
    return ok(formatMaterialList(mats), mats)
  },
  list_materials: (input) => {
    const limit = typeof input.limit === 'number' ? input.limit : 30
    const mats = listMaterials(limit, optionalText(input, 'category'))
    return ok(formatMaterialList(mats), mats)
  },
  update_material: (input) => {
    const id = requireText(input, 'id')
    if (!id) return fail('id is required.')
    const title = optionalText(input, 'title')
    const content = optionalText(input, 'content')
    const category = optionalText(input, 'category')
    const tags = optionalStrings(input, 'tags')
    const mat = updateMaterial(id, {
      ...(title ? { title } : {}),
      ...(content ? { content } : {}),
      ...(category ? { category } : {}),
      ...(tags ? { tags } : {}),
    })
    return mat
      ? ok(`Material atualizado: "${mat.title}" (${mat.category}) {${mat.id}}`, mat)
      : fail(`Material não encontrado: "${id}"`)
  },
  delete_material: (input) => {
    const id = requireText(input, 'id')
    if (!id) return fail('id is required.')
    return deleteMaterial(id) ? ok('Material removido.') : fail(`Material não encontrado: "${id}"`)
  },
}

export const MATERIAL_TOOLS = bindTools(SCHEMAS, HANDLERS, ['search_materials', 'list_materials'])
