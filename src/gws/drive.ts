/**
 * GWS Drive — file listing and management.
 *
 * Wraps gws CLI Drive commands with caching and typed results.
 * Uses the gws command pattern: gws drive files <method>
 */

import { executeGws } from './executor'
import { gwsCacheGet, gwsCacheSet } from './cache'
import type { GwsDriveFile, GwsResult } from './types'

// ─── Helpers ────────────────────────────────────────────────

function str(val: unknown, fallback = ''): string {
  if (val === undefined || val === null) return fallback
  return String(val)
}

function formatSize(bytes: number): string {
  if (bytes === 0) return '-'
  const units = ['B', 'KB', 'MB', 'GB']
  const exp = Math.floor(Math.log(bytes) / Math.log(1024))
  const size = (bytes / Math.pow(1024, exp)).toFixed(1)
  return `${size} ${units[exp] ?? 'B'}`
}

// ─── Files ──────────────────────────────────────────────────

/**
 * List files in Drive (root or specific folder).
 */
export async function listDriveFiles(
  folderId?: string,
  options: { fresh?: boolean } = {},
): Promise<GwsResult<GwsDriveFile[]>> {
  const cacheKey = `drive:files:${folderId ?? 'root'}`

  if (!options.fresh) {
    const cached = gwsCacheGet<GwsDriveFile[]>(cacheKey)
    if (cached) {
      return { success: true, data: cached, error: null, raw: '', duration: 0 }
    }
  }

  const query = folderId
    ? `'${folderId}' in parents and trashed = false`
    : `'root' in parents and trashed = false`

  const result = await executeGws<Record<string, unknown>>([
    'drive', 'files', 'list',
    '--params', JSON.stringify({
      q: query,
      pageSize: 30,
      fields: 'files(id,name,mimeType,size,modifiedTime,webViewLink,parents)',
      orderBy: 'modifiedTime desc',
    }),
  ])

  if (!result.success) {
    return result as unknown as GwsResult<GwsDriveFile[]>
  }

  const items = result.data && typeof result.data === 'object' && 'files' in result.data
    ? (result.data as Record<string, unknown>).files as unknown[]
    : Array.isArray(result.data) ? result.data : []

  const files: GwsDriveFile[] = (items ?? []).map((raw: unknown) => {
    const r = raw as Record<string, unknown>
    return {
      id: str(r.id),
      name: str(r.name, '(unnamed)'),
      mimeType: str(r.mimeType),
      size: typeof r.size === 'number' ? r.size : parseInt(str(r.size, '0'), 10),
      modifiedTime: str(r.modifiedTime),
      webViewLink: str(r.webViewLink),
      parents: Array.isArray(r.parents) ? r.parents.map(String) : [],
    }
  })

  gwsCacheSet(cacheKey, files, 'drive')
  return { success: true, data: files, error: null, raw: result.raw, duration: result.duration }
}

/**
 * Search files in Drive by name.
 */
export async function searchDriveFiles(
  query: string,
): Promise<GwsResult<GwsDriveFile[]>> {
  const result = await executeGws<Record<string, unknown>>([
    'drive', 'files', 'list',
    '--params', JSON.stringify({
      q: `name contains '${query.replace(/'/g, "\\'")}' and trashed = false`,
      pageSize: 20,
      fields: 'files(id,name,mimeType,size,modifiedTime,webViewLink,parents)',
      orderBy: 'modifiedTime desc',
    }),
  ])

  if (!result.success) {
    return result as unknown as GwsResult<GwsDriveFile[]>
  }

  const items = result.data && typeof result.data === 'object' && 'files' in result.data
    ? (result.data as Record<string, unknown>).files as unknown[]
    : Array.isArray(result.data) ? result.data : []

  const files: GwsDriveFile[] = (items ?? []).map((raw: unknown) => {
    const r = raw as Record<string, unknown>
    return {
      id: str(r.id),
      name: str(r.name, '(unnamed)'),
      mimeType: str(r.mimeType),
      size: typeof r.size === 'number' ? r.size : parseInt(str(r.size, '0'), 10),
      modifiedTime: str(r.modifiedTime),
      webViewLink: str(r.webViewLink),
      parents: Array.isArray(r.parents) ? r.parents.map(String) : [],
    }
  })

  return { success: true, data: files, error: null, raw: result.raw, duration: result.duration }
}

/**
 * Format file list for TUI display.
 */
export function formatDriveFileList(files: GwsDriveFile[]): string {
  if (files.length === 0) return 'Nenhum arquivo encontrado.'

  const lines = ['--- Drive ---']
  for (const file of files) {
    const isFolder = file.mimeType === 'application/vnd.google-apps.folder'
    const icon = isFolder ? '[D]' : '[F]'
    const size = isFolder ? '' : ` (${formatSize(file.size)})`
    const date = file.modifiedTime
      ? new Date(file.modifiedTime).toLocaleDateString('pt-BR', {
          day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
        })
      : ''
    lines.push(`  ${icon} ${file.name}${size}  ${date}`)
  }
  lines.push('--------------------')
  return lines.join('\n')
}
