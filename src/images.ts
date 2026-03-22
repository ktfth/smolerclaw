import { existsSync, readFileSync, statSync } from 'node:fs'
import { extname, resolve } from 'node:path'

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp'])
const MAX_IMAGE_SIZE = 20 * 1024 * 1024 // 20 MB

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
