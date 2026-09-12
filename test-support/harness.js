/**
 * Shared harness for the plugin's wiring tests.
 *
 * `makeCtx` is a Cordis-context stand-in that records every seam the plugin
 * touches, `makeServices` wires the host seams it registers into, and
 * `withoutSecrets` pins the environment so a developer's own API key, UI
 * language or session marker can never steer an assertion.
 */

import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createFakeReact, treeText } from './fake-react.js'

const here = dirname(fileURLToPath(import.meta.url))

/**
 * A marker path that does not exist, so the fallback focus source stays silent
 * unless a test opts into it — never the developer's real `~/.dsh-tui/resume.txt`.
 */
export const ABSENT_FOCUS_FILE = join(here, 'no-such-focus-marker.txt')

/** Marker fixture naming {@link FIXTURE_SESSION_ID}. */
export const FOCUS_FIXTURE = join(here, 'focus-marker.txt')

/** Marker fixture as the host leaves it after `/new`: present but empty. */
export const CLEARED_FOCUS_FIXTURE = join(here, 'focus-marker-cleared.txt')

/** Session id stored in {@link FOCUS_FIXTURE}. */
export const FIXTURE_SESSION_ID = 'session-focused'

/** A Cordis-context stand-in that records everything the plugin touches. */
export function makeCtx(options = {}) {
  const services = options.services ?? {}
  const record = {
    settings: [],
    sections: [],
    views: [],
    decisions: [],
    listeners: new Map(),
    cleanups: [],
    logs: [],
  }
  const ctx = {
    logger: {
      info: message => record.logs.push(['info', message]),
      warn: message => record.logs.push(['warn', message]),
      debug: () => {},
    },
    get(name) {
      if (options.getThrows === true) throw new Error('get exploded')
      return services[name]
    },
    on(event, handler) {
      const list = record.listeners.get(event) ?? []
      list.push(handler)
      record.listeners.set(event, list)
      return ctx
    },
    effect(callback) {
      const result = callback()
      if (result !== null && typeof result === 'object' && typeof result.next === 'function') {
        const step = result.next()
        const disposer = step.value
        record.cleanups.push(() => {
          if (typeof disposer === 'function') disposer()
          result.next()
        })
      } else if (typeof result === 'function') {
        record.cleanups.push(result)
      }
      return ctx
    },
  }
  ctx.__record = record
  ctx.__emit = (event, ...args) => {
    for (const handler of record.listeners.get(event) ?? []) handler(...args)
  }
  ctx.__dispose = () => {
    for (const cleanup of record.cleanups) cleanup()
  }
  return ctx
}

/**
 * The host seams, each recording its registrations.
 *
 * `tuiPluginHost` models the mediated DecisionEvents surface: a subscription
 * lands in `record.decisions` and can be fired from a test.
 */
export function makeServices(record, overrides = {}) {
  return {
    settings: {
      register(ns, schema) {
        record.settings.push({ ns, schema })
        return {
          get: () => ({}),
          watch: () => () => {},
        }
      },
      ...overrides.settings,
    },
    tuiSettingsSections: {
      register(section) {
        record.sections.push(section)
        return () => {
          record.sectionDisposed = true
        }
      },
      ...overrides.tuiSettingsSections,
    },
    tuiStatus: {
      registerView(descriptor) {
        record.views.push(descriptor)
        return () => {
          record.viewDisposed = true
        }
      },
      ...overrides.tuiStatus,
    },
    tuiPluginHost: {
      subscribeDecision(pluginCtx, event, listener, options) {
        record.decisions.push({ pluginCtx, event, listener, options })
        return () => {
          record.decisionDisposed = true
        }
      },
      ...overrides.tuiPluginHost,
    },
  }
}

/**
 * Run `body` with an explicit environment (restored afterwards).
 *
 * An async body is awaited before the environment is restored, so a test that
 * has to let the plugin's own timer tick can still rely on the pinning.
 */
export function withEnv(overrides, body) {
  const saved = new Map()
  for (const [key, value] of Object.entries(overrides)) {
    saved.set(key, process.env[key])
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  const restore = () => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
  let result
  try {
    result = body()
  } catch (error) {
    restore()
    throw error
  }
  if (result !== null && typeof result === 'object' && typeof result.then === 'function') {
    return result.then(
      value => {
        restore()
        return value
      },
      error => {
        restore()
        throw error
      },
    )
  }
  restore()
  return result
}

/**
 * Pin everything that could reach outside the test process: the DeepSeek key
 * (balance lookups), the UI language and the focused-session marker.
 */
export function withoutSecrets(body) {
  withEnv(
    {
      DEEPSEEK_API_KEY: undefined,
      DSH_TUI_LANG: 'zh',
      DSH_PEAK_BALANCE_FOCUS_FILE: ABSENT_FOCUS_FILE,
    },
    body,
  )
}

/** Render the registered status view and flatten it to text. */
export function renderLine(ctx) {
  const view = ctx.__record.views[0]
  if (view === undefined) throw new Error('no status view was registered')
  const harness = createFakeReact()
  const tree = view.component({ React: harness.React, ui: { Box: 'Box', Text: 'Text' } })
  harness.cleanup()
  return treeText(tree)
}
