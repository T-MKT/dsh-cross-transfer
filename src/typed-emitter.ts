/**
 * Minimal typed event emitter for this plugin. `@deepseek-ai/dsh-typert-protocol`
 * exports no emitter, so the services here share this one.
 *
 * The constraint is self-referential (`Record<keyof Events, unknown[]>`) because a
 * plain `Record<string, unknown[]>` rejects an `interface`-declared event map:
 * interfaces get no implicit index signature.
 */
export type EventMap = Record<string, unknown[]>

export interface TypedEmitter<Events extends Record<keyof Events, unknown[]>> {
  on<K extends keyof Events>(event: K, listener: (...args: Events[K]) => void): () => void
  off<K extends keyof Events>(event: K, listener: (...args: Events[K]) => void): void
  emit<K extends keyof Events>(event: K, ...args: Events[K]): void
  once<K extends keyof Events>(event: K, listener: (...args: Events[K]) => void): () => void
}

export function createTypedEmitter<Events extends Record<keyof Events, unknown[]>>(): TypedEmitter<Events> {
  type AnyListener = (...args: any[]) => void
  const listeners = new Map<keyof Events, Set<AnyListener>>()

  return {
    on(event, listener) {
      let set = listeners.get(event)
      if (!set) {
        set = new Set<AnyListener>()
        listeners.set(event, set)
      }
      set.add(listener as AnyListener)
      return () => {
        set.delete(listener as AnyListener)
      }
    },
    off(event, listener) {
      listeners.get(event)?.delete(listener as AnyListener)
    },
    emit(event, ...args) {
      const set = listeners.get(event)
      if (!set) return
      // Copy first: a listener may unsubscribe itself while being notified.
      for (const listener of Array.from(set)) {
        try {
          listener(...args)
        } catch (error) {
          console.error(`[TypedEmitter] Error in listener for ${String(event)}:`, error)
        }
      }
    },
    once(event, listener) {
      const wrapper = (...args: Events[typeof event]) => {
        this.off(event, wrapper)
        listener(...args)
      }
      this.on(event, wrapper)
      return () => this.off(event, wrapper)
    }
  }
}

export function mixinTypedEmitter<Events extends Record<keyof Events, unknown[]>, T extends object>(
  target: T,
  emitter: TypedEmitter<Events>
): T & TypedEmitter<Events> {
  return Object.assign(target, {
    on: emitter.on.bind(emitter),
    off: emitter.off.bind(emitter),
    emit: emitter.emit.bind(emitter),
    once: emitter.once.bind(emitter)
  })
}
