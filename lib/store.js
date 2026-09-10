/**
 * Minimal observable store shared by the plugin's wiring and its status view.
 *
 * Referentially stable snapshots: `get()` returns the same object until `set()`
 * replaces it, which is what the view's `useState` + subscription needs.
 *
 * @module dsh-peak-balance/store
 */

/**
 * Create one store.
 *
 * @param initial - first snapshot (may be `undefined`).
 * @returns `{ get, set, subscribe }`; listener failures never propagate into
 *   the emitter (a broken view must not break the plugin's own tick).
 */
export function createStore(initial) {
  let snapshot = initial
  const listeners = new Set()
  return {
    /** Current snapshot (stable between writes). */
    get() {
      return snapshot
    },
    /** Replace the snapshot and notify listeners. */
    set(next) {
      snapshot = next
      for (const listener of [...listeners]) {
        try {
          listener()
        } catch {
          // Isolated on purpose: the emitter is the plugin's timer path.
        }
      }
    },
    /** Subscribe; returns the unsubscribe disposer. */
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}
