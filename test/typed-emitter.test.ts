import { describe, it, expect, vi } from 'vitest'
import { createTypedEmitter, mixinTypedEmitter } from '../src/typed-emitter.js'

type Events = {
  message: [string]
  count: [number, number]
}

describe('TypedEmitter', () => {
  describe('createTypedEmitter', () => {
    it('on registers a listener and emit delivers the emitted arguments', () => {
      const emitter = createTypedEmitter<Events>()
      const fn = vi.fn()
      emitter.on('message', fn)
      emitter.emit('message', 'hello')
      expect(fn).toHaveBeenCalledTimes(1)
      expect(fn).toHaveBeenCalledWith('hello')
    })

    it('on returns a cancel function that stops further delivery', () => {
      const emitter = createTypedEmitter<Events>()
      const fn = vi.fn()
      const cancel = emitter.on('message', fn)

      emitter.emit('message', 'first')
      cancel()
      emitter.emit('message', 'second')

      expect(fn).toHaveBeenCalledTimes(1)
      expect(fn).toHaveBeenCalledWith('first')
    })

    it('supports multiple listeners on the same event with correct arguments', () => {
      const emitter = createTypedEmitter<Events>()
      const a = vi.fn()
      const b = vi.fn()
      emitter.on('count', a)
      emitter.on('count', b)
      emitter.emit('count', 1, 2)
      expect(a).toHaveBeenCalledTimes(1)
      expect(a).toHaveBeenCalledWith(1, 2)
      expect(b).toHaveBeenCalledTimes(1)
      expect(b).toHaveBeenCalledWith(1, 2)
    })

    it('off removes only the specified listener and does not throw for unregistered ones', () => {
      const emitter = createTypedEmitter<Events>()
      const keep = vi.fn()
      const remove = vi.fn()
      const stranger = vi.fn()

      emitter.on('message', keep)
      emitter.on('message', remove)
      emitter.off('message', remove)

      expect(() => emitter.off('message', stranger)).not.toThrow()
      expect(() => emitter.off('message', remove)).not.toThrow()
      expect(() => emitter.off('unknown' as keyof Events, stranger)).not.toThrow()

      emitter.emit('message', 'x')
      expect(keep).toHaveBeenCalledTimes(1)
      expect(remove).not.toHaveBeenCalled()
    })

    it('once fires exactly once and is auto-removed on the second emit', () => {
      const emitter = createTypedEmitter<Events>()
      const fn = vi.fn()
      emitter.once('message', fn)
      emitter.emit('message', 'a')
      emitter.emit('message', 'b')
      expect(fn).toHaveBeenCalledTimes(1)
      expect(fn).toHaveBeenCalledWith('a')
    })

    it('once also returns a cancel function that prevents the call entirely', () => {
      const emitter = createTypedEmitter<Events>()
      const fn = vi.fn()
      const cancel = emitter.once('message', fn)
      cancel()
      emitter.emit('message', 'a')
      expect(fn).not.toHaveBeenCalled()
    })

    it('a throwing listener does not prevent other listeners from running', () => {
      const emitter = createTypedEmitter<Events>()
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
      const bad = vi.fn(() => { throw new Error('boom') })
      const good = vi.fn()

      emitter.on('message', bad)
      emitter.on('message', good)
      emitter.emit('message', 'x')

      expect(bad).toHaveBeenCalledTimes(1)
      expect(good).toHaveBeenCalledTimes(1)
      spy.mockRestore()
    })

    it('emit on an event with no listeners is a no-op and does not throw', () => {
      const emitter = createTypedEmitter<Events>()
      expect(() => emitter.emit('message', 'quiet')).not.toThrow()
      expect(() => emitter.emit('count', 1, 2)).not.toThrow()
    })

    it('calling on twice with the same listener registers it only once (Set semantics)', () => {
      const emitter = createTypedEmitter<Events>()
      const fn = vi.fn()
      emitter.on('message', fn)
      emitter.on('message', fn)
      emitter.emit('message', 'x')
      expect(fn).toHaveBeenCalledTimes(1)
    })
  })

  describe('mixinTypedEmitter', () => {
    it('mixes on/off/emit/once onto the target and preserves original properties', () => {
      const emitter = createTypedEmitter<Events>()
      const target: { id: string } = { id: 'device-1' }
      const mixed = mixinTypedEmitter(target, emitter)

      expect(mixed).toBe(target)
      expect(mixed.id).toBe('device-1')
      expect(typeof mixed.on).toBe('function')
      expect(typeof mixed.off).toBe('function')
      expect(typeof mixed.emit).toBe('function')
      expect(typeof mixed.once).toBe('function')
    })

    it('mixed-in methods behave like the underlying emitter (on/off/emit/once)', () => {
      const emitter = createTypedEmitter<Events>()
      const mixed = mixinTypedEmitter({ name: 'plug' }, emitter)

      const kept = vi.fn()
      const cancelled = vi.fn()
      const oneShot = vi.fn()

      mixed.on('message', kept)
      const cancel = mixed.on('message', cancelled)
      cancel()
      mixed.once('count', oneShot)

      mixed.emit('message', 'via-mixin')
      mixed.emit('count', 3, 4)
      mixed.emit('count', 5, 6)

      expect(kept).toHaveBeenCalledTimes(1)
      expect(kept).toHaveBeenCalledWith('via-mixin')
      expect(cancelled).not.toHaveBeenCalled()
      expect(oneShot).toHaveBeenCalledTimes(1)
      expect(oneShot).toHaveBeenCalledWith(3, 4)

      mixed.off('message', kept)
      mixed.emit('message', 'after-off')
      expect(kept).toHaveBeenCalledTimes(1)
    })
  })
})
