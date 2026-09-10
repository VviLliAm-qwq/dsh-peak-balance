/**
 * A dependency-free stand-in for the host React instance.
 *
 * The status view is a pure function of its props, so its element tree can be
 * asserted without a renderer: hooks return stable values, effects run once
 * (so subscriptions are real), and `createElement` produces inspectable
 * `{ type, props, children }` nodes.
 */

/** Create one fake React instance; hook state is per instance. */
export function createFakeReact() {
  const state = []
  const effects = []
  let cursor = 0
  const React = {
    createElement(type, props, ...children) {
      return { type, props: props ?? {}, children: children.flat() }
    },
    useState(initial) {
      const index = cursor
      cursor += 1
      if (!(index in state)) state[index] = typeof initial === 'function' ? initial() : initial
      return [state[index], next => {
        state[index] = typeof next === 'function' ? next(state[index]) : next
      }]
    },
    useEffect(callback) {
      const index = cursor
      cursor += 1
      if (!(index in effects)) effects[index] = callback()
    },
  }
  return {
    React,
    /** Reset the hook cursor between renders of the same instance. */
    beginRender() {
      cursor = 0
    },
    /** Run every recorded effect cleanup. */
    cleanup() {
      for (const dispose of effects) {
        if (typeof dispose === 'function') dispose()
      }
    },
  }
}

/** Flatten an element tree into its concatenated text, for assertions. */
export function treeText(node) {
  if (node === null || node === undefined || node === false) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(treeText).join('')
  return (node.children ?? []).map(treeText).join('')
}

/** Find every node whose `type` matches, depth-first. */
export function findNodes(node, type) {
  const out = []
  const walk = current => {
    if (current === null || current === undefined || typeof current !== 'object') return
    if (Array.isArray(current)) {
      for (const child of current) walk(child)
      return
    }
    if (current.type === type) out.push(current)
    for (const child of current.children ?? []) walk(child)
  }
  walk(node)
  return out
}
