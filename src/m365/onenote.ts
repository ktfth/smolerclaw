/**
 * M365 OneNote — notebooks and pages.
 *
 * Wraps m365 CLI OneNote commands with caching.
 */

import { executeM365 } from './executor'
import { cacheGet, cacheSet } from './cache'
import type { M365Notebook, M365OneNotePage, M365Result } from './types'

/**
 * List OneNote notebooks.
 */
export async function listNotebooks(
  options: { fresh?: boolean } = {},
): Promise<M365Result<M365Notebook[]>> {
  const cacheKey = 'onenote:notebooks'

  if (!options.fresh) {
    const cached = cacheGet<M365Notebook[]>(cacheKey)
    if (cached) {
      return { success: true, data: cached, error: null, raw: '', duration: 0 }
    }
  }

  const result = await executeM365<M365Notebook[]>(['onenote', 'notebook', 'list'])

  if (result.success && result.data) {
    cacheSet(cacheKey, result.data, 'onenote')
  }

  return result
}

/**
 * List pages in a OneNote notebook.
 */
export async function listPages(
  notebookName: string,
  options: { fresh?: boolean } = {},
): Promise<M365Result<M365OneNotePage[]>> {
  const cacheKey = `onenote:pages:${notebookName}`

  if (!options.fresh) {
    const cached = cacheGet<M365OneNotePage[]>(cacheKey)
    if (cached) {
      return { success: true, data: cached, error: null, raw: '', duration: 0 }
    }
  }

  const result = await executeM365<M365OneNotePage[]>([
    'onenote', 'page', 'list',
    '--name', notebookName,
  ])

  if (result.success && result.data) {
    cacheSet(cacheKey, result.data, 'onenote')
  }

  return result
}

/**
 * Format notebook list for TUI display.
 */
export function formatNotebookList(notebooks: M365Notebook[]): string {
  if (notebooks.length === 0) return 'No notebooks found.'

  const lines = ['--- OneNote ---']
  for (const nb of notebooks) {
    const shared = nb.isShared ? ' (shared)' : ''
    const date = new Date(nb.lastModifiedDateTime).toLocaleDateString('pt-BR', {
      day: '2-digit', month: '2-digit',
    })
    lines.push(`  ${nb.displayName}${shared} - ${date}`)
  }
  lines.push('---------------')
  return lines.join('\n')
}

/**
 * Format page list for TUI display.
 */
export function formatPageList(pages: M365OneNotePage[]): string {
  if (pages.length === 0) return 'No pages found.'

  const lines = ['--- Pages ---']
  for (const page of pages) {
    const date = new Date(page.lastModifiedDateTime).toLocaleDateString('pt-BR', {
      day: '2-digit', month: '2-digit',
    })
    lines.push(`  ${page.title} - ${date}`)
  }
  lines.push('-------------')
  return lines.join('\n')
}
