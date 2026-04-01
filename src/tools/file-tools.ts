/**
 * File tool implementations: read_file, write_file, edit_file
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { atomicWriteFile } from '../vault'
import { UndoStack } from '../undo'
import { guardPath, requireString, MAX_FILE_SIZE } from './security'
import { truncate, formatSize } from './helpers'

export function toolReadFile(input: Record<string, unknown>): string {
  const pathValErr = requireString(input, 'path')
  if (pathValErr) return pathValErr
  const path = resolve(input.path as string)
  const pathErr = guardPath(path)
  if (pathErr) return pathErr
  if (!existsSync(path)) return `Error: file not found: ${path}`

  // Check file size before reading
  const size = statSync(path).size
  if (size > MAX_FILE_SIZE) {
    return `Error: file too large (${formatSize(size)}). Max is ${formatSize(MAX_FILE_SIZE)}.`
  }

  const content = readFileSync(path, 'utf-8')
  const lines = content.split('\n')
  const offset = Math.max(1, (input.offset as number) || 1)
  const limit = Math.min(2000, (input.limit as number) || 500)

  const slice = lines.slice(offset - 1, offset - 1 + limit)
  const numbered = slice.map((l, i) => `${String(offset + i).padStart(4)}  ${l}`)

  let result = numbered.join('\n')
  const remaining = lines.length - (offset - 1 + limit)
  if (remaining > 0) {
    result += `\n... (${remaining} more lines, total ${lines.length})`
  }
  return truncate(result)
}

export function toolWriteFile(input: Record<string, unknown>, undoStack: UndoStack): string {
  const pathValErr = requireString(input, 'path')
  if (pathValErr) return pathValErr
  const path = resolve(input.path as string)
  const pathErr = guardPath(path)
  if (pathErr) return pathErr
  const content = input.content as string
  const existed = existsSync(path)
  undoStack.saveState(path)
  atomicWriteFile(path, content)
  const lines = content.split('\n').length
  return `${existed ? 'Updated' : 'Created'}: ${path} (${lines} lines)`
}

export function toolEditFile(input: Record<string, unknown>, undoStack: UndoStack): string {
  const pathValErr = requireString(input, 'path')
  if (pathValErr) return pathValErr
  const path = resolve(input.path as string)
  const pathErr = guardPath(path)
  if (pathErr) return pathErr
  if (!existsSync(path)) return `Error: file not found: ${path}`

  const content = readFileSync(path, 'utf-8')
  const oldText = input.old_text as string
  const newText = input.new_text as string

  const count = content.split(oldText).length - 1
  if (count === 0) {
    return 'Error: old_text not found in file. Make sure it matches exactly, including whitespace and indentation.'
  }
  if (count > 1) {
    return `Error: old_text found ${count} times. It must be unique. Include more surrounding context.`
  }

  undoStack.saveState(path)
  // Use split/join instead of String.replace to avoid $& back-reference issues
  const updated = content.split(oldText).join(newText)
  atomicWriteFile(path, updated)

  const oldLines = oldText.split('\n').length
  const newLines = newText.split('\n').length
  return `Edited: ${path} (replaced ${oldLines} lines with ${newLines} lines)`
}
