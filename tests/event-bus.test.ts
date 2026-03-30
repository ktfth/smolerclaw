import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { getEventBus, resetEventBus, on, once, emit, emitAsync } from '../src/core/event-bus'
import type { EventBusEvents } from '../src/types'

describe('event-bus', () => {
  beforeEach(() => {
    resetEventBus()
  })

  afterEach(() => {
    resetEventBus()
  })

  it('creates singleton instance', () => {
    const bus1 = getEventBus()
    const bus2 = getEventBus()
    expect(bus1).toBe(bus2)
  })

  it('subscribes and emits events', () => {
    const bus = getEventBus()
    let called = false
    let payload: unknown = null

    bus.on('task:completed', (evt) => {
      called = true
      payload = evt
    })

    bus.emit('task:completed', {
      taskId: 'test-1',
      result: 'success',
      duration: 100,
    })

    expect(called).toBe(true)
    expect(payload).toBeDefined()
  })

  it('subscribes once and removes listener', () => {
    const bus = getEventBus()
    let count = 0

    bus.once('memo:saved', () => {
      count++
    })

    bus.emit('memo:saved', { memoId: '1', tags: ['test'] })
    bus.emit('memo:saved', { memoId: '2', tags: ['test'] })

    expect(count).toBe(1)
  })

  it('returns unsubscribe function', () => {
    const bus = getEventBus()
    let called = false

    const unsub = bus.on('user:login', () => {
      called = true
    })

    unsub()
    bus.emit('user:login', { userId: '123' })

    expect(called).toBe(false)
  })

  it('supports multiple listeners', () => {
    const bus = getEventBus()
    let count1 = 0
    let count2 = 0

    bus.on('file:changed', () => { count1++ })
    bus.on('file:changed', () => { count2++ })

    bus.emit('file:changed', { path: '/test.ts', timestamp: Date.now() })

    expect(count1).toBe(1)
    expect(count2).toBe(1)
  })

  it('handles listener errors gracefully', () => {
    const bus = getEventBus()
    let errorHandled = false

    bus.onError(() => {
      errorHandled = true
    })

    bus.on('process:spawned', () => {
      throw new Error('listener failed')
    })

    bus.on('process:spawned', () => {
      // This should still be called
    })

    expect(() => {
      bus.emit('process:spawned', { pid: 123, command: 'bun test' })
    }).not.toThrow()

    expect(errorHandled).toBe(true)
  })

  it('removes listener with off()', () => {
    const bus = getEventBus()
    let count = 0

    const listener = () => { count++ }
    bus.on('news:fetched', listener)
    bus.off('news:fetched', listener)

    bus.emit('news:fetched', { category: 'tech', items: [] })
    expect(count).toBe(0)
  })

  it('tracks listener count', () => {
    const bus = getEventBus()

    bus.on('project:created', () => {})
    bus.on('project:created', () => {})

    expect(bus.listenerCount('project:created')).toBe(2)
  })

  it('lists event names', () => {
    const bus = getEventBus()

    bus.on('task:completed', () => {})
    bus.on('memo:saved', () => {})

    const names = bus.eventNames()
    expect(names.length).toBe(2)
    expect(names).toContain('task:completed')
    expect(names).toContain('memo:saved')
  })

  it('removes all listeners', () => {
    const bus = getEventBus()

    bus.on('task:completed', () => {})
    bus.on('memo:saved', () => {})
    bus.removeAllListeners()

    expect(bus.eventNames().length).toBe(0)
  })

  it('removes listeners for specific event', () => {
    const bus = getEventBus()

    bus.on('task:completed', () => {})
    bus.on('memo:saved', () => {})
    bus.removeAllListeners('task:completed')

    const names = bus.eventNames()
    expect(names).toContain('memo:saved')
    expect(names).not.toContain('task:completed')
  })

  it('convenience wrapper on()', () => {
    let called = false

    on('person:added', () => {
      called = true
    })

    emit('person:added', { name: 'Alice', group: 'equipe' })

    expect(called).toBe(true)
  })

  it('convenience wrapper once()', () => {
    let count = 0

    once('decision:logged', () => {
      count++
    })

    emit('decision:logged', { title: 'test', context: 'ctx', chosen: 'option' })
    emit('decision:logged', { title: 'test2', context: 'ctx', chosen: 'option' })

    expect(count).toBe(1)
  })

  describe('async listeners', () => {
    it('supports async listeners', async () => {
      const bus = getEventBus()
      let result: string | null = null

      bus.on('vault:backup', async (evt) => {
        await new Promise((r) => setTimeout(r, 10))
        result = `backed up ${evt.backupId}`
      }, { async: true })

      bus.emitAsync('vault:backup', { backupId: 'bkp-123', timestamp: Date.now() })
      await new Promise((r) => setTimeout(r, 20))

      expect(result).toBe('backed up bkp-123')
    })

    it('waits for all async listeners in emitAsync', async () => {
      const bus = getEventBus()
      const results: number[] = []

      bus.on('timer:tick', async (evt) => {
        await new Promise((r) => setTimeout(r, 5))
        results.push(1)
      }, { async: true })

      bus.on('timer:tick', async (evt) => {
        await new Promise((r) => setTimeout(r, 10))
        results.push(2)
      }, { async: true })

      await bus.emitAsync('timer:tick', { elapsed: 1000 })

      expect(results.length).toBe(2)
      expect(results).toContain(1)
      expect(results).toContain(2)
    })

    it('handles async listener errors', async () => {
      const bus = getEventBus()
      let errorCaught = false

      bus.onError(() => {
        errorCaught = true
      })

      bus.on('monitor:alert', async () => {
        throw new Error('async fail')
      }, { async: true })

      bus.emitAsync('monitor:alert', { severity: 'critical', message: 'high cpu' })
      await new Promise((r) => setTimeout(r, 20))

      expect(errorCaught).toBe(true)
    })
  })

  it('supports multiple error handlers', () => {
    const bus = getEventBus()
    let errorCount = 0

    bus.onError(() => { errorCount++ })
    bus.onError(() => { errorCount++ })

    bus.on('task:completed', () => {
      throw new Error('failed')
    })

    bus.emit('task:completed', { taskId: '1', result: 'fail', duration: 0 })

    expect(errorCount).toBe(2)
  })

  it('error handler can unsubscribe', () => {
    const bus = getEventBus()
    let errorCount = 0

    const unsubscribe = bus.onError(() => {
      errorCount++
    })

    bus.on('news:fetched', () => {
      throw new Error('fetch error')
    })

    bus.emit('news:fetched', { category: 'tech', items: [] })
    expect(errorCount).toBe(1)

    unsubscribe()

    bus.emit('news:fetched', { category: 'tech', items: [] })
    expect(errorCount).toBe(1) // Not incremented
  })
})
