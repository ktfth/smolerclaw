/**
 * Event Bus — centralized event-driven communication layer.
 *
 * Provides:
 *   - Type-safe event emission and subscription
 *   - Singleton pattern for global access
 *   - Synchronous execution for UI-critical events
 *   - Async support for IO operations
 *   - Global error handling to prevent listener crashes from breaking the main loop
 *
 * Usage:
 *   import { eventBus } from './core/event-bus'
 *   eventBus.on('context:changed', (event) => { ... })
 *   eventBus.emit('context:changed', { currentDir: '/path', timestamp: Date.now() })
 */

import { EventEmitter } from 'node:events'
import type { EventBusEvents } from '../types'

// ─── Types ───────────────────────────────────────────────────

type EventName = keyof EventBusEvents
type EventPayload<E extends EventName> = EventBusEvents[E]
type EventListener<E extends EventName> = (payload: EventPayload<E>) => void | Promise<void>

interface ListenerEntry<E extends EventName> {
  listener: EventListener<E>
  once: boolean
  async: boolean // if true, errors don't propagate
}

interface EventBusOptions {
  /** Maximum listeners per event before warning (default: 20) */
  maxListeners?: number
  /** Enable debug logging (default: process.env.DEBUG) */
  debug?: boolean
}

// ─── Event Bus Implementation ────────────────────────────────

class EventBus {
  private emitter: EventEmitter
  private listeners: Map<EventName, ListenerEntry<EventName>[]> = new Map()
  private debug: boolean
  private errorHandlers: Array<(error: Error, eventName: EventName, payload: unknown) => void> = []

  constructor(options: EventBusOptions = {}) {
    this.emitter = new EventEmitter()
    this.emitter.setMaxListeners(options.maxListeners ?? 20)
    this.debug = options.debug ?? !!process.env.DEBUG
  }

  /**
   * Subscribe to an event. The listener is called synchronously when the event is emitted.
   * Returns an unsubscribe function.
   */
  on<E extends EventName>(
    eventName: E,
    listener: EventListener<E>,
    options: { async?: boolean } = {},
  ): () => void {
    const entry: ListenerEntry<E> = {
      listener,
      once: false,
      async: options.async ?? false,
    }

    const entries = this.listeners.get(eventName) ?? []
    entries.push(entry as ListenerEntry<EventName>)
    this.listeners.set(eventName, entries)

    if (this.debug) {
      console.log(`[event-bus] Registered listener for '${eventName}'`)
    }

    return () => this.off(eventName, listener)
  }

  /**
   * Subscribe to an event once. The listener is removed after the first call.
   * Returns an unsubscribe function.
   */
  once<E extends EventName>(
    eventName: E,
    listener: EventListener<E>,
    options: { async?: boolean } = {},
  ): () => void {
    const entry: ListenerEntry<E> = {
      listener,
      once: true,
      async: options.async ?? false,
    }

    const entries = this.listeners.get(eventName) ?? []
    entries.push(entry as ListenerEntry<EventName>)
    this.listeners.set(eventName, entries)

    if (this.debug) {
      console.log(`[event-bus] Registered once listener for '${eventName}'`)
    }

    return () => this.off(eventName, listener)
  }

  /**
   * Unsubscribe a listener from an event.
   */
  off<E extends EventName>(eventName: E, listener: EventListener<E>): void {
    const entries = this.listeners.get(eventName)
    if (!entries) return

    const filtered = entries.filter((e) => e.listener !== listener)
    if (filtered.length === 0) {
      this.listeners.delete(eventName)
    } else {
      this.listeners.set(eventName, filtered)
    }

    if (this.debug) {
      console.log(`[event-bus] Removed listener from '${eventName}'`)
    }
  }

  /**
   * Emit an event synchronously. All listeners are called in order.
   * Async listeners are fire-and-forget (errors logged but not thrown).
   * Sync listeners' errors are caught and passed to error handlers.
   */
  emit<E extends EventName>(eventName: E, payload: EventPayload<E>): void {
    const entries = this.listeners.get(eventName)
    if (!entries || entries.length === 0) {
      if (this.debug) {
        console.log(`[event-bus] No listeners for '${eventName}'`)
      }
      return
    }

    if (this.debug) {
      console.log(`[event-bus] Emitting '${eventName}' to ${entries.length} listener(s)`)
    }

    const toRemove: ListenerEntry<EventName>[] = []

    for (const entry of entries) {
      try {
        const result = entry.listener(payload)

        // Handle async listeners - fire and forget with error logging
        if (entry.async && result instanceof Promise) {
          result.catch((error) => {
            this.handleError(error, eventName, payload)
          })
        }

        if (entry.once) {
          toRemove.push(entry)
        }
      } catch (error) {
        this.handleError(error instanceof Error ? error : new Error(String(error)), eventName, payload)
      }
    }

    // Remove once listeners
    if (toRemove.length > 0) {
      const remaining = entries.filter((e) => !toRemove.includes(e))
      if (remaining.length === 0) {
        this.listeners.delete(eventName)
      } else {
        this.listeners.set(eventName, remaining)
      }
    }
  }

  /**
   * Emit an event and wait for all async listeners to complete.
   * Use this for events where you need to wait for all handlers.
   */
  async emitAsync<E extends EventName>(eventName: E, payload: EventPayload<E>): Promise<void> {
    const entries = this.listeners.get(eventName)
    if (!entries || entries.length === 0) return

    if (this.debug) {
      console.log(`[event-bus] Emitting async '${eventName}' to ${entries.length} listener(s)`)
    }

    const toRemove: ListenerEntry<EventName>[] = []
    const promises: Promise<void>[] = []

    for (const entry of entries) {
      try {
        const result = entry.listener(payload)
        if (result instanceof Promise) {
          promises.push(
            result.catch((error) => {
              this.handleError(error instanceof Error ? error : new Error(String(error)), eventName, payload)
            }),
          )
        }
        if (entry.once) {
          toRemove.push(entry)
        }
      } catch (error) {
        this.handleError(error instanceof Error ? error : new Error(String(error)), eventName, payload)
      }
    }

    // Wait for all async operations
    await Promise.all(promises)

    // Remove once listeners
    if (toRemove.length > 0) {
      const remaining = entries.filter((e) => !toRemove.includes(e))
      if (remaining.length === 0) {
        this.listeners.delete(eventName)
      } else {
        this.listeners.set(eventName, remaining)
      }
    }
  }

  /**
   * Register a global error handler for listener errors.
   * Prevents crashes when individual listeners fail.
   */
  onError(handler: (error: Error, eventName: EventName, payload: unknown) => void): () => void {
    this.errorHandlers.push(handler)
    return () => {
      const idx = this.errorHandlers.indexOf(handler)
      if (idx >= 0) this.errorHandlers.splice(idx, 1)
    }
  }

  /**
   * Get the number of listeners for an event.
   */
  listenerCount(eventName: EventName): number {
    return this.listeners.get(eventName)?.length ?? 0
  }

  /**
   * Get all registered event names.
   */
  eventNames(): EventName[] {
    return Array.from(this.listeners.keys())
  }

  /**
   * Remove all listeners for a specific event or all events.
   */
  removeAllListeners(eventName?: EventName): void {
    if (eventName) {
      this.listeners.delete(eventName)
    } else {
      this.listeners.clear()
    }

    if (this.debug) {
      console.log(`[event-bus] Removed all listeners${eventName ? ` for '${eventName}'` : ''}`)
    }
  }

  private handleError(error: Error, eventName: EventName, payload: unknown): void {
    // Log the error
    if (this.debug || process.env.DEBUG) {
      console.error(`[event-bus] Error in '${eventName}' listener:`, error.message)
    }

    // Call registered error handlers
    for (const handler of this.errorHandlers) {
      try {
        handler(error, eventName, payload)
      } catch {
        // Error handlers should not throw
      }
    }
  }
}

// ─── Singleton Instance ──────────────────────────────────────

let _instance: EventBus | null = null

/**
 * Get the singleton event bus instance.
 */
export function getEventBus(options?: EventBusOptions): EventBus {
  if (!_instance) {
    _instance = new EventBus(options)
  }
  return _instance
}

/**
 * Default event bus instance for direct import.
 */
export const eventBus = getEventBus()

// ─── Convenience Functions ───────────────────────────────────

/**
 * Subscribe to an event (convenience wrapper).
 */
export function on<E extends EventName>(
  eventName: E,
  listener: EventListener<E>,
  options?: { async?: boolean },
): () => void {
  return eventBus.on(eventName, listener, options)
}

/**
 * Subscribe to an event once (convenience wrapper).
 */
export function once<E extends EventName>(
  eventName: E,
  listener: EventListener<E>,
  options?: { async?: boolean },
): () => void {
  return eventBus.once(eventName, listener, options)
}

/**
 * Emit an event (convenience wrapper).
 */
export function emit<E extends EventName>(eventName: E, payload: EventPayload<E>): void {
  eventBus.emit(eventName, payload)
}

/**
 * Emit an event and wait for all handlers (convenience wrapper).
 */
export async function emitAsync<E extends EventName>(
  eventName: E,
  payload: EventPayload<E>,
): Promise<void> {
  return eventBus.emitAsync(eventName, payload)
}

// ─── Testing Support ─────────────────────────────────────────

/**
 * Reset the singleton instance (for testing).
 */
export function resetEventBus(): void {
  if (_instance) {
    _instance.removeAllListeners()
    _instance = null
  }
}
