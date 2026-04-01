import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { getEventBus, resetEventBus, on, once, emit, emitAsync } from '../src/core/event-bus'

describe('event-bus', () => {
  beforeEach(() => {
    resetEventBus()
  })

  afterEach(() => {
    resetEventBus()
  })

  // ─── Singleton ─────────────────────────────────────────────

  describe('singleton pattern', () => {
    it('returns the same instance on repeated calls', () => {
      const bus1 = getEventBus()
      const bus2 = getEventBus()
      expect(bus1).toBe(bus2)
    })

    it('returns a fresh instance after reset', () => {
      const bus1 = getEventBus()
      resetEventBus()
      const bus2 = getEventBus()
      expect(bus1).not.toBe(bus2)
    })

    it('resetEventBus clears all listeners from the old instance', () => {
      const bus = getEventBus()
      bus.on('task:completed', () => {})
      expect(bus.listenerCount('task:completed')).toBe(1)

      resetEventBus()
      // After reset, the old bus should have had removeAllListeners called
      expect(bus.listenerCount('task:completed')).toBe(0)
    })

    it('resetEventBus is safe to call when no instance exists', () => {
      resetEventBus() // first reset (from beforeEach)
      expect(() => resetEventBus()).not.toThrow() // second reset, no instance
    })
  })

  // ─── on() / emit() ────────────────────────────────────────

  describe('on and emit', () => {
    it('subscribes and receives the emitted payload', () => {
      const bus = getEventBus()
      let received: unknown = null

      bus.on('task:completed', (evt) => {
        received = evt
      })

      const payload = {
        taskId: 'test-1',
        taskType: 'user_task' as const,
        success: true,
        duration: 100,
        timestamp: Date.now(),
      }
      bus.emit('task:completed', payload)

      expect(received).toEqual(payload)
    })

    it('calls listeners in registration order', () => {
      const bus = getEventBus()
      const order: number[] = []

      bus.on('context:changed', () => { order.push(1) })
      bus.on('context:changed', () => { order.push(2) })
      bus.on('context:changed', () => { order.push(3) })

      bus.emit('context:changed', {
        currentDir: '/tmp',
        timestamp: Date.now(),
      })

      expect(order).toEqual([1, 2, 3])
    })

    it('supports multiple listeners on the same event', () => {
      const bus = getEventBus()
      let count1 = 0
      let count2 = 0

      bus.on('file:saved', () => { count1++ })
      bus.on('file:saved', () => { count2++ })

      bus.emit('file:saved', {
        filePath: '/test.ts',
        size: 42,
        isTracked: true,
        timestamp: Date.now(),
      })

      expect(count1).toBe(1)
      expect(count2).toBe(1)
    })

    it('returns an unsubscribe function from on()', () => {
      const bus = getEventBus()
      let called = false

      const unsub = bus.on('status:update', () => {
        called = true
      })

      unsub()
      bus.emit('status:update', {
        source: 'test',
        message: 'hi',
        level: 'info',
        timestamp: Date.now(),
      })

      expect(called).toBe(false)
    })

    it('does not call other listeners when one is unsubscribed', () => {
      const bus = getEventBus()
      let calledA = false
      let calledB = false

      const unsubA = bus.on('context:changed', () => { calledA = true })
      bus.on('context:changed', () => { calledB = true })

      unsubA()
      bus.emit('context:changed', { currentDir: '/x', timestamp: Date.now() })

      expect(calledA).toBe(false)
      expect(calledB).toBe(true)
    })
  })

  // ─── once() ───────────────────────────────────────────────

  describe('once', () => {
    it('fires the listener only once', () => {
      const bus = getEventBus()
      let count = 0

      bus.once('telemetry:alert', () => { count++ })

      const payload = {
        alertType: 'cost_warning' as const,
        message: 'test',
        timestamp: Date.now(),
      }
      bus.emit('telemetry:alert', payload)
      bus.emit('telemetry:alert', payload)
      bus.emit('telemetry:alert', payload)

      expect(count).toBe(1)
    })

    it('removes itself from listener list after firing', () => {
      const bus = getEventBus()

      bus.once('session:changed', () => {})

      expect(bus.listenerCount('session:changed')).toBe(1)

      bus.emit('session:changed', {
        currentSession: 'abc',
        timestamp: Date.now(),
      })

      expect(bus.listenerCount('session:changed')).toBe(0)
    })

    it('returns an unsubscribe function that prevents the listener from firing', () => {
      const bus = getEventBus()
      let called = false

      const unsub = bus.once('task:completed', () => { called = true })
      unsub()

      bus.emit('task:completed', {
        taskId: 'x',
        taskType: 'backup' as const,
        success: true,
        timestamp: Date.now(),
      })

      expect(called).toBe(false)
    })

    it('does not remove other listeners after once fires', () => {
      const bus = getEventBus()
      let permanentCount = 0

      bus.on('context:changed', () => { permanentCount++ })
      bus.once('context:changed', () => {})

      const payload = { currentDir: '/a', timestamp: Date.now() }
      bus.emit('context:changed', payload)
      bus.emit('context:changed', payload)

      expect(permanentCount).toBe(2)
    })

    it('handles multiple once listeners on the same event', () => {
      const bus = getEventBus()
      let countA = 0
      let countB = 0

      bus.once('file:saved', () => { countA++ })
      bus.once('file:saved', () => { countB++ })

      const payload = {
        filePath: '/x',
        size: 1,
        isTracked: false,
        timestamp: Date.now(),
      }
      bus.emit('file:saved', payload)
      bus.emit('file:saved', payload)

      expect(countA).toBe(1)
      expect(countB).toBe(1)
      expect(bus.listenerCount('file:saved')).toBe(0)
    })
  })

  // ─── off() ────────────────────────────────────────────────

  describe('off', () => {
    it('removes a specific listener by reference', () => {
      const bus = getEventBus()
      let count = 0

      const listener = () => { count++ }
      bus.on('context:changed', listener)
      bus.off('context:changed', listener)

      bus.emit('context:changed', { currentDir: '/x', timestamp: Date.now() })

      expect(count).toBe(0)
    })

    it('does nothing when event has no listeners', () => {
      const bus = getEventBus()
      const listener = () => {}

      // Should not throw when removing from non-existent event
      expect(() => bus.off('task:completed', listener)).not.toThrow()
    })

    it('does nothing when listener is not registered', () => {
      const bus = getEventBus()
      const listenerA = () => {}
      const listenerB = () => {}

      bus.on('context:changed', listenerA)

      // Removing a different listener should not affect listenerA
      bus.off('context:changed', listenerB)

      expect(bus.listenerCount('context:changed')).toBe(1)
    })

    it('cleans up the event key when the last listener is removed', () => {
      const bus = getEventBus()
      const listener = () => {}

      bus.on('session:changed', listener)
      expect(bus.eventNames()).toContain('session:changed')

      bus.off('session:changed', listener)
      expect(bus.eventNames()).not.toContain('session:changed')
    })

    it('keeps remaining listeners when one is removed', () => {
      const bus = getEventBus()
      let calledA = false
      let calledB = false
      const listenerA = () => { calledA = true }
      const listenerB = () => { calledB = true }

      bus.on('telemetry:alert', listenerA)
      bus.on('telemetry:alert', listenerB)

      bus.off('telemetry:alert', listenerA)
      bus.emit('telemetry:alert', {
        alertType: 'error_rate' as const,
        message: 'test',
        timestamp: Date.now(),
      })

      expect(calledA).toBe(false)
      expect(calledB).toBe(true)
    })
  })

  // ─── emit edge cases ─────────────────────────────────────

  describe('emit edge cases', () => {
    it('does not throw when emitting with no listeners', () => {
      const bus = getEventBus()

      expect(() => {
        bus.emit('task:completed', {
          taskId: 'x',
          taskType: 'backup' as const,
          success: true,
          timestamp: Date.now(),
        })
      }).not.toThrow()
    })

    it('continues calling remaining listeners when one throws', () => {
      const bus = getEventBus()
      let secondCalled = false

      bus.on('status:update', () => {
        throw new Error('boom')
      })
      bus.on('status:update', () => {
        secondCalled = true
      })

      bus.emit('status:update', {
        source: 'test',
        message: 'msg',
        level: 'info',
        timestamp: Date.now(),
      })

      expect(secondCalled).toBe(true)
    })

    it('wraps non-Error throws into Error objects for error handlers', () => {
      const bus = getEventBus()
      let capturedError: Error | null = null

      bus.onError((err) => { capturedError = err })

      bus.on('context:changed', () => {
        throw 'string error' // eslint-disable-line no-throw-literal
      })

      bus.emit('context:changed', { currentDir: '/x', timestamp: Date.now() })

      expect(capturedError).toBeInstanceOf(Error)
      expect(capturedError!.message).toBe('string error')
    })

    it('handles async listener errors in fire-and-forget emit()', async () => {
      const bus = getEventBus()
      let errorCaught = false

      bus.onError(() => {
        errorCaught = true
      })

      bus.on('file:saved', async () => {
        throw new Error('async fire-and-forget fail')
      }, { async: true })

      // emit() (not emitAsync) - the async listener runs fire-and-forget
      bus.emit('file:saved', {
        filePath: '/a.ts',
        size: 10,
        isTracked: false,
        timestamp: Date.now(),
      })

      // Wait for the promise rejection to be caught
      await new Promise((r) => setTimeout(r, 50))

      expect(errorCaught).toBe(true)
    })
  })

  // ─── emitAsync ────────────────────────────────────────────

  describe('emitAsync', () => {
    it('waits for all async listeners to complete', async () => {
      const bus = getEventBus()
      const results: string[] = []

      bus.on('context:changed', async () => {
        await new Promise((r) => setTimeout(r, 10))
        results.push('slow')
      }, { async: true })

      bus.on('context:changed', async () => {
        results.push('fast')
      }, { async: true })

      await bus.emitAsync('context:changed', {
        currentDir: '/test',
        timestamp: Date.now(),
      })

      expect(results).toContain('slow')
      expect(results).toContain('fast')
      expect(results.length).toBe(2)
    })

    it('returns immediately when there are no listeners', async () => {
      const bus = getEventBus()

      // Should resolve without error
      await expect(
        bus.emitAsync('task:completed', {
          taskId: 'x',
          taskType: 'backup' as const,
          success: true,
          timestamp: Date.now(),
        }),
      ).resolves.toBeUndefined()
    })

    it('handles errors from async listeners without crashing', async () => {
      const bus = getEventBus()
      let errorCaught = false

      bus.onError(() => { errorCaught = true })

      bus.on('session:changed', async () => {
        throw new Error('async error')
      }, { async: true })

      await bus.emitAsync('session:changed', {
        currentSession: 'test',
        timestamp: Date.now(),
      })

      expect(errorCaught).toBe(true)
    })

    it('wraps non-Error async rejections into Error objects', async () => {
      const bus = getEventBus()
      let capturedError: Error | null = null

      bus.onError((err) => { capturedError = err })

      bus.on('telemetry:alert', async () => {
        throw 42 // eslint-disable-line no-throw-literal
      }, { async: true })

      await bus.emitAsync('telemetry:alert', {
        alertType: 'token_limit' as const,
        message: 'test',
        timestamp: Date.now(),
      })

      expect(capturedError).toBeInstanceOf(Error)
      expect(capturedError!.message).toBe('42')
    })

    it('handles sync listener throwing inside emitAsync', async () => {
      const bus = getEventBus()
      let errorCaught = false

      bus.onError(() => { errorCaught = true })

      // Sync listener that throws (no async option)
      bus.on('context:changed', () => {
        throw new Error('sync error in emitAsync')
      })

      await bus.emitAsync('context:changed', {
        currentDir: '/test',
        timestamp: Date.now(),
      })

      expect(errorCaught).toBe(true)
    })

    it('removes once listeners after emitAsync', async () => {
      const bus = getEventBus()
      let count = 0

      bus.once('file:saved', async () => {
        await new Promise((r) => setTimeout(r, 5))
        count++
      }, { async: true })

      const payload = {
        filePath: '/x.ts',
        size: 10,
        isTracked: false,
        timestamp: Date.now(),
      }

      await bus.emitAsync('file:saved', payload)
      await bus.emitAsync('file:saved', payload)

      expect(count).toBe(1)
      expect(bus.listenerCount('file:saved')).toBe(0)
    })
  })

  // ─── Error handling ───────────────────────────────────────

  describe('error handling', () => {
    it('calls all registered error handlers when a listener throws', () => {
      const bus = getEventBus()
      let errorCount = 0

      bus.onError(() => { errorCount++ })
      bus.onError(() => { errorCount++ })

      bus.on('task:completed', () => {
        throw new Error('failed')
      })

      bus.emit('task:completed', {
        taskId: '1',
        taskType: 'user_task' as const,
        success: false,
        duration: 0,
        timestamp: Date.now(),
      })

      expect(errorCount).toBe(2)
    })

    it('onError returns an unsubscribe function', () => {
      const bus = getEventBus()
      let errorCount = 0

      const unsub = bus.onError(() => { errorCount++ })

      bus.on('context:changed', () => { throw new Error('err') })

      bus.emit('context:changed', { currentDir: '/a', timestamp: Date.now() })
      expect(errorCount).toBe(1)

      unsub()

      bus.emit('context:changed', { currentDir: '/b', timestamp: Date.now() })
      expect(errorCount).toBe(1) // not incremented after unsubscribe
    })

    it('does not crash if an error handler itself throws', () => {
      const bus = getEventBus()

      bus.onError(() => {
        throw new Error('error handler exploded')
      })

      bus.on('status:update', () => {
        throw new Error('listener error')
      })

      expect(() => {
        bus.emit('status:update', {
          source: 'test',
          message: 'msg',
          level: 'error',
          timestamp: Date.now(),
        })
      }).not.toThrow()
    })

    it('passes correct error, eventName, and payload to error handlers', () => {
      const bus = getEventBus()
      let capturedError: Error | null = null
      let capturedEvent: string | null = null
      let capturedPayload: unknown = null

      bus.onError((err, eventName, payload) => {
        capturedError = err
        capturedEvent = eventName
        capturedPayload = payload
      })

      const sentPayload = {
        currentDir: '/test',
        timestamp: 123,
      }

      bus.on('context:changed', () => {
        throw new Error('specific error')
      })

      bus.emit('context:changed', sentPayload)

      expect(capturedError!.message).toBe('specific error')
      expect(capturedEvent).toBe('context:changed')
      expect(capturedPayload).toEqual(sentPayload)
    })

    it('handles error gracefully when no error handlers are registered', () => {
      const bus = getEventBus()

      bus.on('task:completed', () => {
        throw new Error('unhandled listener error')
      })

      // Should not throw even without error handlers
      expect(() => {
        bus.emit('task:completed', {
          taskId: 'x',
          taskType: 'backup' as const,
          success: false,
          timestamp: Date.now(),
        })
      }).not.toThrow()
    })
  })

  // ─── listenerCount / eventNames / removeAllListeners ──────

  describe('listenerCount', () => {
    it('returns 0 for events with no listeners', () => {
      const bus = getEventBus()
      expect(bus.listenerCount('task:completed')).toBe(0)
    })

    it('counts listeners correctly after adding and removing', () => {
      const bus = getEventBus()
      const listenerA = () => {}
      const listenerB = () => {}

      bus.on('context:changed', listenerA)
      bus.on('context:changed', listenerB)
      expect(bus.listenerCount('context:changed')).toBe(2)

      bus.off('context:changed', listenerA)
      expect(bus.listenerCount('context:changed')).toBe(1)
    })

    it('decrements after once listener fires', () => {
      const bus = getEventBus()

      bus.once('session:changed', () => {})
      bus.on('session:changed', () => {})
      expect(bus.listenerCount('session:changed')).toBe(2)

      bus.emit('session:changed', { currentSession: 'a', timestamp: Date.now() })
      expect(bus.listenerCount('session:changed')).toBe(1)
    })
  })

  describe('eventNames', () => {
    it('returns empty array when no listeners are registered', () => {
      const bus = getEventBus()
      expect(bus.eventNames()).toEqual([])
    })

    it('returns all event names with active listeners', () => {
      const bus = getEventBus()

      bus.on('task:completed', () => {})
      bus.on('context:changed', () => {})
      bus.on('file:saved', () => {})

      const names = bus.eventNames()
      expect(names.length).toBe(3)
      expect(names).toContain('task:completed')
      expect(names).toContain('context:changed')
      expect(names).toContain('file:saved')
    })

    it('does not include events whose listeners have all been removed', () => {
      const bus = getEventBus()
      const listener = () => {}

      bus.on('context:changed', listener)
      bus.off('context:changed', listener)

      expect(bus.eventNames()).not.toContain('context:changed')
    })
  })

  describe('removeAllListeners', () => {
    it('removes all listeners for all events when called without args', () => {
      const bus = getEventBus()

      bus.on('task:completed', () => {})
      bus.on('context:changed', () => {})
      bus.on('file:saved', () => {})

      bus.removeAllListeners()

      expect(bus.eventNames().length).toBe(0)
      expect(bus.listenerCount('task:completed')).toBe(0)
      expect(bus.listenerCount('context:changed')).toBe(0)
    })

    it('removes listeners for a specific event only', () => {
      const bus = getEventBus()

      bus.on('task:completed', () => {})
      bus.on('context:changed', () => {})

      bus.removeAllListeners('task:completed')

      expect(bus.eventNames()).toContain('context:changed')
      expect(bus.eventNames()).not.toContain('task:completed')
    })

    it('is safe to call when no listeners exist', () => {
      const bus = getEventBus()
      expect(() => bus.removeAllListeners()).not.toThrow()
      expect(() => bus.removeAllListeners('task:completed')).not.toThrow()
    })
  })

  // ─── Convenience wrappers ─────────────────────────────────

  describe('convenience wrappers', () => {
    it('on() wrapper subscribes and emits via the singleton', () => {
      let called = false

      on('context:changed', () => { called = true })
      emit('context:changed', { currentDir: '/test', timestamp: Date.now() })

      expect(called).toBe(true)
    })

    it('once() wrapper fires only once via the singleton', () => {
      let count = 0

      once('task:completed', () => { count++ })

      const payload = {
        taskId: '1',
        taskType: 'user_task' as const,
        success: true,
        timestamp: Date.now(),
      }
      emit('task:completed', payload)
      emit('task:completed', payload)

      expect(count).toBe(1)
    })

    it('emitAsync() wrapper awaits all handlers', async () => {
      let asyncDone = false

      on('file:saved', async () => {
        await new Promise((r) => setTimeout(r, 10))
        asyncDone = true
      }, { async: true })

      await emitAsync('file:saved', {
        filePath: '/z.ts',
        size: 5,
        isTracked: true,
        timestamp: Date.now(),
      })

      expect(asyncDone).toBe(true)
    })
  })

  // ─── Constructor options ──────────────────────────────────

  describe('constructor options', () => {
    it('accepts custom maxListeners', () => {
      resetEventBus()
      const bus = getEventBus({ maxListeners: 5 })
      // If the option is respected, we should be able to use the bus without issues
      expect(bus).toBeDefined()
    })

    it('accepts debug option', () => {
      resetEventBus()
      const bus = getEventBus({ debug: true })
      // Debug mode should not break any functionality
      let called = false
      bus.on('context:changed', () => { called = true })
      bus.emit('context:changed', { currentDir: '/x', timestamp: Date.now() })
      expect(called).toBe(true)
    })

    it('debug mode logs emit with no listeners', () => {
      resetEventBus()
      const bus = getEventBus({ debug: true })

      // Should not throw when emitting to no listeners in debug mode
      expect(() => {
        bus.emit('task:completed', {
          taskId: 'x',
          taskType: 'backup' as const,
          success: true,
          timestamp: Date.now(),
        })
      }).not.toThrow()
    })

    it('debug mode logs on() registration', () => {
      resetEventBus()
      const bus = getEventBus({ debug: true })

      expect(() => {
        bus.on('context:changed', () => {})
      }).not.toThrow()
    })

    it('debug mode logs once() registration', () => {
      resetEventBus()
      const bus = getEventBus({ debug: true })

      expect(() => {
        bus.once('context:changed', () => {})
      }).not.toThrow()
    })

    it('debug mode logs off()', () => {
      resetEventBus()
      const bus = getEventBus({ debug: true })
      const listener = () => {}

      bus.on('context:changed', listener)
      expect(() => {
        bus.off('context:changed', listener)
      }).not.toThrow()
    })

    it('debug mode logs removeAllListeners', () => {
      resetEventBus()
      const bus = getEventBus({ debug: true })

      bus.on('context:changed', () => {})
      expect(() => bus.removeAllListeners('context:changed')).not.toThrow()
      expect(() => bus.removeAllListeners()).not.toThrow()
    })

    it('debug mode logs emit with listeners', () => {
      resetEventBus()
      const bus = getEventBus({ debug: true })

      bus.on('context:changed', () => {})
      expect(() => {
        bus.emit('context:changed', { currentDir: '/x', timestamp: Date.now() })
      }).not.toThrow()
    })

    it('debug mode logs emitAsync with listeners', async () => {
      resetEventBus()
      const bus = getEventBus({ debug: true })

      bus.on('context:changed', async () => {}, { async: true })

      await expect(
        bus.emitAsync('context:changed', { currentDir: '/x', timestamp: Date.now() }),
      ).resolves.toBeUndefined()
    })
  })

  // ─── Mixed once + on interactions ─────────────────────────

  describe('mixed once and on interactions', () => {
    it('once listener interleaved with permanent listeners', () => {
      const bus = getEventBus()
      const order: string[] = []

      bus.on('context:changed', () => { order.push('permanent-1') })
      bus.once('context:changed', () => { order.push('once') })
      bus.on('context:changed', () => { order.push('permanent-2') })

      const payload = { currentDir: '/x', timestamp: Date.now() }
      bus.emit('context:changed', payload)

      expect(order).toEqual(['permanent-1', 'once', 'permanent-2'])

      order.length = 0
      bus.emit('context:changed', payload)

      // Once listener should be gone
      expect(order).toEqual(['permanent-1', 'permanent-2'])
    })
  })

  // ─── Async once in emitAsync ──────────────────────────────

  describe('async once in emitAsync', () => {
    it('once listener with async option is removed after emitAsync', async () => {
      const bus = getEventBus()
      let count = 0

      bus.once('status:update', async () => {
        await new Promise((r) => setTimeout(r, 5))
        count++
      }, { async: true })

      const payload = {
        source: 'test',
        message: 'x',
        level: 'info' as const,
        timestamp: Date.now(),
      }

      await bus.emitAsync('status:update', payload)
      await bus.emitAsync('status:update', payload)

      expect(count).toBe(1)
    })
  })

  // ─── Stress / boundary cases ──────────────────────────────

  describe('boundary cases', () => {
    it('handles rapid subscribe/unsubscribe cycles', () => {
      const bus = getEventBus()
      let count = 0

      for (let i = 0; i < 50; i++) {
        const unsub = bus.on('context:changed', () => { count++ })
        unsub()
      }

      bus.emit('context:changed', { currentDir: '/x', timestamp: Date.now() })
      expect(count).toBe(0)
      expect(bus.listenerCount('context:changed')).toBe(0)
    })

    it('handles many listeners on the same event', () => {
      const bus = getEventBus()
      let total = 0

      for (let i = 0; i < 20; i++) {
        bus.on('file:saved', () => { total++ })
      }

      bus.emit('file:saved', {
        filePath: '/x.ts',
        size: 1,
        isTracked: false,
        timestamp: Date.now(),
      })

      expect(total).toBe(20)
    })

    it('handles multiple different events independently', () => {
      const bus = getEventBus()
      let aCount = 0
      let bCount = 0

      bus.on('context:changed', () => { aCount++ })
      bus.on('task:completed', () => { bCount++ })

      bus.emit('context:changed', { currentDir: '/x', timestamp: Date.now() })

      expect(aCount).toBe(1)
      expect(bCount).toBe(0)
    })
  })
})
