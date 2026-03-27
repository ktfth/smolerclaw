/**
 * Persistent material system — assistant knowledge base.
 * Materials are categorized, tagged, searchable reference items
 * that persist across sessions and inform the AI's responses.
 */

import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Material } from './types'
import { atomicWriteFile } from './vault'

// ─── Storage ────────────────────────────────────────────────

let _dataDir = ''
let _materials: Material[] = []

const DATA_FILE = () => join(_dataDir, 'materials.json')

function save(): void {
  atomicWriteFile(DATA_FILE(), JSON.stringify(_materials, null, 2))
}

function load(): void {
  const file = DATA_FILE()
  if (!existsSync(file)) {
    _materials = []
    return
  }
  try {
    _materials = JSON.parse(readFileSync(file, 'utf-8'))
  } catch {
    _materials = []
  }
}

// ─── Init ───────────────────────────────────────────────────

export function initMaterials(dataDir: string): void {
  _dataDir = dataDir
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true })
  load()
}

// ─── CRUD ───────────────────────────────────────────────────

export function saveMaterial(
  title: string,
  content: string,
  category: string = 'geral',
  tags: string[] = [],
): Material {
  const now = new Date().toISOString()

  // Auto-extract tags from #hashtags in content
  const hashTags = content.match(/#(\w+)/g)?.map((t) => t.slice(1).toLowerCase()) || []
  const titleTags = title.match(/#(\w+)/g)?.map((t) => t.slice(1).toLowerCase()) || []
  const allTags = [...new Set([...tags.map((t) => t.toLowerCase()), ...hashTags, ...titleTags])]

  const material: Material = {
    id: genId(),
    title: title.trim(),
    content: content.trim(),
    category: category.toLowerCase().trim(),
    tags: allTags,
    createdAt: now,
    updatedAt: now,
  }
  _materials = [..._materials, material]
  save()
  return material
}

export function updateMaterial(
  id: string,
  updates: { title?: string; content?: string; category?: string; tags?: string[] },
): Material | null {
  const found = _materials.find((m) => m.id === id)
  if (!found) return null

  const newContent = updates.content ?? found.content
  const newTitle = updates.title ?? found.title

  // Re-extract tags from updated content
  const hashTags = newContent.match(/#(\w+)/g)?.map((t) => t.slice(1).toLowerCase()) || []
  const titleTags = newTitle.match(/#(\w+)/g)?.map((t) => t.slice(1).toLowerCase()) || []
  const baseTags = updates.tags ?? found.tags
  const allTags = [...new Set([...baseTags.map((t) => t.toLowerCase()), ...hashTags, ...titleTags])]

  _materials = _materials.map((m) =>
    m.id === id
      ? {
          ...m,
          title: newTitle.trim(),
          content: newContent.trim(),
          category: (updates.category ?? m.category).toLowerCase().trim(),
          tags: allTags,
          updatedAt: new Date().toISOString(),
        }
      : m,
  )
  save()
  return _materials.find((m) => m.id === id) || null
}

export function deleteMaterial(id: string): boolean {
  const idx = _materials.findIndex((m) => m.id === id)
  if (idx === -1) return false
  _materials = [..._materials.slice(0, idx), ..._materials.slice(idx + 1)]
  save()
  return true
}

export function getMaterial(id: string): Material | null {
  return _materials.find((m) => m.id === id) || null
}

// ─── Search ─────────────────────────────────────────────────

/**
 * Search materials by keyword, tag, or category.
 * Prefix with # for tag search, @ for category search.
 */
export function searchMaterials(query: string): Material[] {
  const lower = query.toLowerCase().trim()
  if (!lower) return [..._materials]

  const isTagSearch = lower.startsWith('#')
  const isCatSearch = lower.startsWith('@')
  const searchTerm = isTagSearch || isCatSearch ? lower.slice(1) : lower

  return _materials
    .filter((m) => {
      if (isTagSearch) {
        return m.tags.some((t) => t.includes(searchTerm))
      }
      if (isCatSearch) {
        return m.category.includes(searchTerm)
      }
      return (
        m.title.toLowerCase().includes(searchTerm) ||
        m.content.toLowerCase().includes(searchTerm) ||
        m.category.toLowerCase().includes(searchTerm) ||
        m.tags.some((t) => t.includes(searchTerm))
      )
    })
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
}

/**
 * List materials, most recent first.
 */
export function listMaterials(limit = 30, category?: string): Material[] {
  let result = [..._materials]
  if (category) {
    const cat = category.toLowerCase().trim()
    result = result.filter((m) => m.category === cat)
  }
  return result
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
    .slice(0, limit)
}

/**
 * Get all unique categories with count.
 */
export function getMaterialCategories(): Array<{ category: string; count: number }> {
  const catMap = new Map<string, number>()
  for (const mat of _materials) {
    catMap.set(mat.category, (catMap.get(mat.category) || 0) + 1)
  }
  return [...catMap.entries()]
    .map(([category, count]) => ({ category, count }))
    .sort((a, b) => b.count - a.count)
}

/**
 * Build a context summary of all materials for the system prompt.
 * Returns a condensed overview the AI can reference.
 */
export function buildMaterialsContext(): string {
  if (_materials.length === 0) return ''

  const categories = getMaterialCategories()
  const lines = ['--- Materiais do Assistente ---']

  for (const { category } of categories) {
    const items = _materials
      .filter((m) => m.category === category)
      .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())

    lines.push(`\n[${category}]`)
    for (const item of items) {
      const preview = item.content.length > 200
        ? item.content.slice(0, 200).replace(/\n/g, ' ') + '...'
        : item.content.replace(/\n/g, ' ')
      const tags = item.tags.length > 0 ? ` [${item.tags.map((t) => `#${t}`).join(' ')}]` : ''
      lines.push(`  • ${item.title}: ${preview}${tags}`)
    }
  }

  return lines.join('\n')
}

// ─── Formatting ─────────────────────────────────────────────

export function formatMaterialList(materials: Material[]): string {
  if (materials.length === 0) return 'Nenhum material encontrado.'

  const lines = materials.map((m) => {
    const date = new Date(m.updatedAt).toLocaleDateString('pt-BR', {
      day: '2-digit',
      month: '2-digit',
    })
    const tags = m.tags.length > 0 ? ` [${m.tags.map((t) => `#${t}`).join(' ')}]` : ''
    const preview =
      m.content.length > 60 ? m.content.slice(0, 60).replace(/\n/g, ' ') + '...' : m.content.replace(/\n/g, ' ')
    return `  [${date}] (${m.category}) ${m.title} — ${preview}${tags}  {${m.id}}`
  })

  return `Materiais (${materials.length}):\n${lines.join('\n')}`
}

export function formatMaterialDetail(material: Material): string {
  const created = new Date(material.createdAt).toLocaleDateString('pt-BR')
  const updated = new Date(material.updatedAt).toLocaleDateString('pt-BR')
  const tags = material.tags.length > 0 ? `Tags: ${material.tags.map((t) => `#${t}`).join(' ')}` : ''
  const dates = created === updated ? `Criado: ${created}` : `Criado: ${created} | Atualizado: ${updated}`

  return `--- Material {${material.id}} ---\nTitulo: ${material.title}\nCategoria: ${material.category}\n\n${material.content}\n\n${tags}\n${dates}`
}

export function formatMaterialCategories(): string {
  const cats = getMaterialCategories()
  if (cats.length === 0) return 'Nenhuma categoria.'
  const lines = cats.map((c) => `  @${c.category} (${c.count})`)
  return `Categorias:\n${lines.join('\n')}`
}

// ─── Helpers ────────────────────────────────────────────────

function genId(): string {
  return randomUUID().slice(0, 8)
}
