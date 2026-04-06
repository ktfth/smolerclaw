import { existsSync, readFileSync, writeFileSync } from 'node:fs'

const MAX_ENTRIES = 500

/**
 * Input history ring buffer with persistence.
 * Navigate with prev() / next(), persist to disk.
 */
export class InputHistory {
  private entries: string[] = []
  private cursor = -1
  private pending = ''

  constructor(private filePath: string) {
    this.load()
  }

  /**
   * Add an entry to history. Deduplicates consecutive identical entries.
   */
  add(entry: string): void {
    const trimmed = entry.trim()
    if (!trimmed) return

    // Remove duplicate if it's the last entry
    if (this.entries.length > 0 && this.entries[this.entries.length - 1] === trimmed) {
      return
    }

    this.entries.push(trimmed)

    // Evict oldest entries
    if (this.entries.length > MAX_ENTRIES) {
      this.entries = this.entries.slice(-MAX_ENTRIES)
    }

    this.cursor = -1
    this.pending = ''
    this.save()
  }

  /**
   * Navigate backward (Up arrow). Returns the previous entry.
   * On first call, saves the current input as "pending".
   */
  prev(currentInput: string): string | null {
    if (this.entries.length === 0) return null

    if (this.cursor === -1) {
      this.pending = currentInput
      this.cursor = this.entries.length - 1
    } else if (this.cursor > 0) {
      this.cursor--
    } else {
      return this.entries[0] // Already at oldest
    }

    return this.entries[this.cursor]
  }

  /**
   * Navigate forward (Down arrow). Returns the next entry,
   * or the pending input when reaching the end.
   */
  next(): string {
    if (this.cursor === -1) return this.pending

    if (this.cursor < this.entries.length - 1) {
      this.cursor++
      return this.entries[this.cursor]
    }

    // Past the end — return to pending input
    this.cursor = -1
    return this.pending
  }

  /**
   * Reset navigation state (e.g., after submitting).
   */
  reset(): void {
    this.cursor = -1
    this.pending = ''
  }

  /**
   * Get all history entries (most recent last).
   */
  getEntries(): readonly string[] {
    return this.entries
  }

  private load(): void {
    try {
      if (existsSync(this.filePath)) {
        const content = readFileSync(this.filePath, 'utf-8')
        this.entries = content.split('\n').filter(Boolean).slice(-MAX_ENTRIES)
      }
    } catch { /* ignore */ }
  }

  private save(): void {
    try {
      writeFileSync(this.filePath, this.entries.join('\n') + '\n')
    } catch { /* ignore */ }
  }
}
