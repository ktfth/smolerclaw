import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import type { Session, Message } from './types'

export class SessionManager {
  private sessionsDir: string
  private current: Session

  constructor(dataDir: string) {
    this.sessionsDir = join(dataDir, 'sessions')
    if (!existsSync(this.sessionsDir)) {
      mkdirSync(this.sessionsDir, { recursive: true })
    }
    this.current = this.loadOrCreate('default')
  }

  get session(): Session {
    return this.current
  }

  get messages(): Message[] {
    return this.current.messages
  }

  addMessage(message: Message): void {
    this.current.messages.push(message)
    this.current.updated = Date.now()
    this.save()
  }

  trimHistory(maxHistory: number): void {
    if (this.current.messages.length > maxHistory) {
      this.current.messages = this.current.messages.slice(-maxHistory)
      this.save()
    }
  }

  clear(): void {
    this.current.messages = []
    this.current.updated = Date.now()
    this.save()
  }

  /**
   * Remove the last N messages and persist. Returns removed messages.
   */
  popMessages(count: number): Message[] {
    const removed = this.current.messages.splice(-count, count)
    this.current.updated = Date.now()
    this.save()
    return removed
  }

  switchTo(name: string): Session {
    this.current = this.loadOrCreate(name)
    return this.current
  }

  list(): string[] {
    if (!existsSync(this.sessionsDir)) return []
    return readdirSync(this.sessionsDir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => f.replace('.json', ''))
  }

  getInfo(name: string): { messageCount: number; updated: number } | null {
    const path = join(this.sessionsDir, `${name}.json`)
    if (!existsSync(path)) return null
    try {
      const data: Session = JSON.parse(readFileSync(path, 'utf-8'))
      return { messageCount: data.messages.length, updated: data.updated }
    } catch {
      return null
    }
  }

  delete(name: string): boolean {
    const path = join(this.sessionsDir, `${name}.json`)
    if (existsSync(path)) {
      unlinkSync(path)
      return true
    }
    return false
  }

  /**
   * Fork the current session into a new one with a different name.
   * Copies all messages. Returns the new session.
   */
  fork(newName: string): Session {
    const forked: Session = {
      id: crypto.randomUUID(),
      name: newName,
      messages: [...this.current.messages],
      created: Date.now(),
      updated: Date.now(),
    }
    const path = join(this.sessionsDir, `${newName}.json`)
    writeFileSync(path, JSON.stringify(forked, null, 2))
    this.current = forked
    return forked
  }

  private loadOrCreate(name: string): Session {
    const path = join(this.sessionsDir, `${name}.json`)
    if (existsSync(path)) {
      try {
        return JSON.parse(readFileSync(path, 'utf-8'))
      } catch {
        // Corrupted session file — start fresh
      }
    }
    const session: Session = {
      id: crypto.randomUUID(),
      name,
      messages: [],
      created: Date.now(),
      updated: Date.now(),
    }
    writeFileSync(path, JSON.stringify(session, null, 2))
    return session
  }

  private save(): void {
    const path = join(this.sessionsDir, `${this.current.name}.json`)
    writeFileSync(path, JSON.stringify(this.current, null, 2))
  }
}
