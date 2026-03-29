import { existsSync, readFileSync, statSync } from 'node:fs'
import { basename, extname, resolve } from 'node:path'
import type { MessageFile } from './types'

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp'])
const MAX_IMAGE_SIZE = 20 * 1024 * 1024 // 20 MB

const TEXT_EXTENSIONS = new Set([
  '.txt', '.md', '.markdown', '.json', '.jsonl', '.csv', '.tsv',
  '.xml', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf',
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.rb', '.go', '.rs', '.java', '.kt', '.c', '.cpp', '.h', '.hpp', '.cs',
  '.html', '.htm', '.css', '.scss', '.sass', '.less',
  '.sql', '.sh', '.bash', '.zsh', '.ps1', '.bat', '.cmd',
  '.env', '.gitignore', '.dockerignore', '.editorconfig',
  '.log', '.diff', '.patch',
  '.vue', '.svelte', '.astro',
])
const MAX_FILE_SIZE = 1 * 1024 * 1024 // 1 MB

export interface ImageAttachment {
  path: string
  mediaType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'
  base64: string
}

/**
 * Extract image file paths from user input text.
 * Returns the cleaned text (paths removed) and extracted images.
 */
export function extractImages(input: string): { text: string; images: ImageAttachment[] } {
  const images: ImageAttachment[] = []
  const words = input.split(/\s+/)
  const textParts: string[] = []

  for (const word of words) {
    const cleaned = word.replace(/^["']|["']$/g, '') // strip quotes
    const ext = extname(cleaned).toLowerCase()

    if (IMAGE_EXTENSIONS.has(ext)) {
      const fullPath = resolve(cleaned)
      if (existsSync(fullPath)) {
        try {
          const size = statSync(fullPath).size
          if (size > MAX_IMAGE_SIZE) {
            textParts.push(`[image too large: ${cleaned}]`)
            continue
          }

          const data = readFileSync(fullPath)
          const base64 = data.toString('base64')
          const mediaType = extToMediaType(ext)

          images.push({ path: fullPath, mediaType, base64 })
          textParts.push(`[image: ${cleaned}]`)
        } catch {
          textParts.push(word) // keep original if we can't read it
        }
      } else {
        textParts.push(word) // not a valid path, keep as text
      }
    } else {
      textParts.push(word)
    }
  }

  return {
    text: textParts.join(' '),
    images,
  }
}

function extToMediaType(ext: string): ImageAttachment['mediaType'] {
  switch (ext) {
    case '.png': return 'image/png'
    case '.jpg':
    case '.jpeg': return 'image/jpeg'
    case '.gif': return 'image/gif'
    case '.webp': return 'image/webp'
    default: return 'image/png'
  }
}

/**
 * Extract file paths from user input text and read their contents.
 * Supports text-based files (code, config, docs, logs, etc.).
 * Returns cleaned text (paths removed) and extracted file contents.
 */
export function extractFiles(input: string): { text: string; files: MessageFile[] } {
  const files: MessageFile[] = []
  const words = input.split(/\s+/)
  const textParts: string[] = []

  for (const word of words) {
    const cleaned = word.replace(/^["']|["']$/g, '')
    const ext = extname(cleaned).toLowerCase()

    // Skip image extensions (handled by extractImages)
    if (IMAGE_EXTENSIONS.has(ext)) {
      textParts.push(word)
      continue
    }

    // Check if it looks like a file path (has extension or path separators)
    const looksLikePath = TEXT_EXTENSIONS.has(ext) ||
      (cleaned.includes('/') || cleaned.includes('\\')) && ext.length > 0

    if (!looksLikePath) {
      textParts.push(word)
      continue
    }

    const fullPath = resolve(cleaned)
    if (!existsSync(fullPath)) {
      textParts.push(word)
      continue
    }

    try {
      const stat = statSync(fullPath)
      if (!stat.isFile()) {
        textParts.push(word)
        continue
      }
      if (stat.size > MAX_FILE_SIZE) {
        textParts.push(`[file too large: ${cleaned} (${(stat.size / 1024).toFixed(0)}KB)]`)
        continue
      }
      if (stat.size === 0) {
        textParts.push(`[empty file: ${cleaned}]`)
        continue
      }

      const content = readFileSync(fullPath, 'utf-8')
      const name = basename(fullPath)
      files.push({ path: fullPath, name, content, size: stat.size })
      textParts.push(`[file: ${name}]`)
    } catch {
      textParts.push(word)
    }
  }

  return { text: textParts.join(' '), files }
}
