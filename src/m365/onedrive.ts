/**
 * M365 OneDrive — file listing and download.
 *
 * Wraps m365 CLI OneDrive commands with caching.
 */

import { executeM365 } from './executor'
import { cacheGet, cacheSet } from './cache'
import type { M365DriveItem, M365Result } from './types'

/**
 * List files in a OneDrive folder.
 */
export async function listFiles(
  folder?: string,
  options: { fresh?: boolean } = {},
): Promise<M365Result<M365DriveItem[]>> {
  const folderPath = folder ?? '/'
  const cacheKey = `onedrive:list:${folderPath}`

  if (!options.fresh) {
    const cached = cacheGet<M365DriveItem[]>(cacheKey)
    if (cached) {
      return { success: true, data: cached, error: null, raw: '', duration: 0 }
    }
  }

  const args = ['onedrive', 'list']
  if (folder) {
    args.push('--folderUrl', folder)
  }

  const result = await executeM365<M365DriveItem[]>(args)

  if (result.success && result.data) {
    cacheSet(cacheKey, result.data, 'files')
  }

  return result
}

/**
 * Get info about a specific file or folder.
 */
export async function getFileInfo(fileUrl: string): Promise<M365Result<M365DriveItem>> {
  return executeM365<M365DriveItem>(['onedrive', 'get', '--webUrl', fileUrl])
}

/**
 * Format file list for TUI display.
 */
export function formatFileList(items: M365DriveItem[]): string {
  if (items.length === 0) return 'No files found.'

  const lines = ['--- OneDrive ---']
  for (const item of items) {
    const icon = item.isFolder ? '[D]' : '[F]'
    const size = item.isFolder ? '' : ` (${formatBytes(item.size)})`
    const date = new Date(item.lastModifiedDateTime).toLocaleDateString('pt-BR', {
      day: '2-digit', month: '2-digit',
    })
    lines.push(`  ${icon} ${item.name}${size} - ${date}`)
  }
  lines.push('----------------')
  return lines.join('\n')
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`
}
