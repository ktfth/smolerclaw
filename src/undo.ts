import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname, basename } from 'node:path'

const MAX_UNDO_ENTRIES = 50

interface UndoEntry {
  path: string
  content: string  // original content before change
  timestamp: number
  existed: boolean // false if file was newly created
}

/**
 * Tracks file changes for undo support.
 * Stores original content before each write/edit in memory.
 */
export class UndoStack {
  private entries: UndoEntry[] = []

  /**
   * Save the current state of a file before modifying it.
   * Call this BEFORE writing/editing.
   */
  saveState(filePath: string): void {
    const existed = existsSync(filePath)
    const content = existed ? readFileSync(filePath, 'utf-8') : ''

    this.entries.push({
      path: filePath,
      content,
      timestamp: Date.now(),
      existed,
    })

    // Cap the stack
    if (this.entries.length > MAX_UNDO_ENTRIES) {
      this.entries = this.entries.slice(-MAX_UNDO_ENTRIES)
    }
  }

  /**
   * Undo the last file change. Restores original content.
   * Returns description of what was undone, or null if stack is empty.
   */
  undo(): string | null {
    const entry = this.entries.pop()
    if (!entry) return null

    if (!entry.existed) {
      // File was newly created — we could delete it, but safer to leave it
      // and just report. Deleting is destructive.
      return `Undo: ${basename(entry.path)} was a new file. Remove it manually if needed.`
    }

    writeFileSync(entry.path, entry.content)
    const lines = entry.content.split('\n').length
    return `Undo: restored ${basename(entry.path)} (${lines} lines, from ${formatAge(entry.timestamp)})`
  }

  /**
   * Get the stack size.
   */
  get size(): number {
    return this.entries.length
  }

  /**
   * Peek at what would be undone.
   */
  peek(): string | null {
    if (this.entries.length === 0) return null
    const entry = this.entries[this.entries.length - 1]
    return `${basename(entry.path)} (${formatAge(entry.timestamp)})`
  }
}

function formatAge(timestamp: number): string {
  const seconds = Math.floor((Date.now() - timestamp) / 1000)
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  return `${Math.floor(minutes / 60)}h ago`
}
