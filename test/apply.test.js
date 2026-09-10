import { test } from 'node:test'
import assert from 'node:assert/strict'

import { Config, SETTINGS_NS, apply, balanceStateOf, sanitizeConfig, settingsSection } from '../lib/index.js'
import { createFakeReact, treeText } from '../test-support/fake-react.js'

/** A Cordis-context stand-in that records everything the plugin touches. */
function makeCtx(options = {}) {
  const services = options.services ?? {}
  const record = {
    settings: [],
    sections: [],
    views: [],
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

/** The three host seams, each recording its registrations. */
function makeServices(record, overrides = {}) {
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
  }
}

const FAKE_SESSION = { id: 'session-1', header: { id: 'session-1' } }

/** Keep balance lookups off the network regardless of the developer's env. */
function withoutApiKey(body) {
  const saved = process.env.DEEPSEEK_API_KEY
  delete process.env.DEEPSEEK_API_KEY
  try {
    body()
  } finally {
    if (saved === undefined) delete process.env.DEEPSEEK_API_KEY
    else process.env.DEEPSEEK_API_KEY = saved
  }
}

test('sanitizeConfig accepts only known keys and types', () => {
  assert.deepEqual(sanitizeConfig(undefined), {
    showBalance: true,
    showTurnCost: true,
    warnOnPeak: false,
    warnColor: 'red',
  })
  assert.deepEqual(sanitizeConfig('nonsense'), {
    showBalance: true,
    showTurnCost: true,
    warnOnPeak: false,
    warnColor: 'red',
  })
  assert.deepEqual(
    sanitizeConfig({ showBalance: false, showTurnCost: 'yes', warnOnPeak: true, warnColor: 'purple', extra: 1 }),
    { showBalance: false, showTurnCost: true, warnOnPeak: true, warnColor: 'purple' },
  )
  assert.equal(sanitizeConfig({ warnColor: 'chartreuse' }).warnColor, 'red')
})

test('balanceStateOf maps every documented failure to a display state', () => {
  assert.deepEqual(balanceStateOf({ ok: true, balances: [{ currency: 'CNY', total: 3 }] }), {
    state: 'ok',
    amount: 3,
  })
  assert.deepEqual(balanceStateOf({ ok: true, balances: [] }), { state: 'error' })
  assert.deepEqual(balanceStateOf({ ok: false, reason: 'no-key' }), { state: 'no-key' })
  assert.deepEqual(balanceStateOf({ ok: false, reason: 'unauthorized' }), { state: 'unauthorized' })
  assert.deepEqual(balanceStateOf({ ok: false, reason: 'network' }), { state: 'error' })
  assert.deepEqual(balanceStateOf(undefined), { state: 'error' })
})

test('the settings card declares exactly the four switches', () => {
  const section = settingsSection()
  assert.equal(section.ns, SETTINGS_NS)
  assert.deepEqual(
    section.fields.map(field => field.path.join('.')),
    ['showBalance', 'showTurnCost', 'warnOnPeak', 'warnColor'],
  )
  const color = section.fields.find(field => field.path[0] === 'warnColor')
  assert.equal(color.kind, 'select')
  assert.equal(color.options.length, 7)
  for (const field of section.fields) {
    assert.equal(typeof field.label, 'string')
    assert.equal(typeof field.descriptions.zh, 'string')
    assert.equal(typeof field.hintDescriptions.en, 'string')
    assert.equal(field.path.length, 1)
  }
  // Every declared field must be writable through the very schema the
  // namespace registers — a card that names a key the schema drops would
  // stage edits that never persist.
  const defaults = { ...Config({}) }
  assert.deepEqual(Object.keys(defaults).sort(), ['showBalance', 'showTurnCost', 'warnColor', 'warnOnPeak'])
  const written = { ...Config({ showBalance: false, showTurnCost: false, warnOnPeak: true, warnColor: 'cyan' }) }
  assert.deepEqual(written, { showBalance: false, showTurnCost: false, warnOnPeak: true, warnColor: 'cyan' })
  assert.throws(() => Config({ warnColor: 'chartreuse' }))
})

test('a host without any seam stays inert and never throws', () => {
  withoutApiKey(() => {
    const ctx = makeCtx()
    assert.doesNotThrow(() => apply(ctx, undefined))
    assert.equal(ctx.__record.settings.length, 0)
    assert.equal(ctx.__record.views.length, 0)
    assert.equal(ctx.__record.listeners.size, 2)
    assert.doesNotThrow(() => ctx.__dispose())
  })
})

test('a throwing service accessor is contained', () => {
  withoutApiKey(() => {
    const ctx = makeCtx({ getThrows: true })
    assert.doesNotThrow(() => apply(ctx, {}))
    assert.ok(ctx.__record.logs.some(([level]) => level === 'warn'))
    assert.doesNotThrow(() => ctx.__dispose())
  })
})

test('garbage configuration cannot break the wiring', () => {
  withoutApiKey(() => {
    const ctx = makeCtx()
    const services = makeServices(ctx.__record)
    ctx.get = (name) => services[name]
    assert.doesNotThrow(() => apply(ctx, { showBalance: 'yes', warnColor: 42, unexpected: {} }))
    assert.equal(ctx.__record.settings.length, 1)
    ctx.__dispose()
  })
})

test('every seam is registered once, with the documented shape', () => {
  withoutApiKey(() => {
    const ctx = makeCtx()
    const services = makeServices(ctx.__record)
    ctx.get = (name) => services[name]

    apply(ctx, undefined)

    assert.equal(ctx.__record.settings.length, 1)
    assert.equal(ctx.__record.settings[0].ns, SETTINGS_NS)
    assert.equal(typeof ctx.__record.settings[0].schema, 'function')

    assert.equal(ctx.__record.sections.length, 1)
    assert.equal(ctx.__record.sections[0].fields.length, 4)

    assert.equal(ctx.__record.views.length, 1)
    const view = ctx.__record.views[0]
    assert.equal(view.key, SETTINGS_NS)
    assert.equal(view.maxRows, 3)
    assert.equal(typeof view.component, 'function')

    ctx.__dispose()
    assert.equal(ctx.__record.sectionDisposed, true)
    assert.equal(ctx.__record.viewDisposed, true)

    // Idempotent teardown.
    assert.doesNotThrow(() => ctx.__dispose())
  })
})

test('a failing settings registration does not stop the other seams', () => {
  withoutApiKey(() => {
    const ctx = makeCtx()
    const services = makeServices(ctx.__record, {
      settings: {
        register() {
          throw new Error('namespace taken')
        },
      },
    })
    ctx.get = (name) => services[name]

    assert.doesNotThrow(() => apply(ctx, undefined))
    assert.equal(ctx.__record.sections.length, 1)
    assert.equal(ctx.__record.views.length, 1)
    assert.ok(ctx.__record.logs.some(([, message]) => /settings register failed/.test(message)))
    ctx.__dispose()
  })
})

test('a refused status registration degrades instead of throwing', () => {
  withoutApiKey(() => {
    const ctx = makeCtx()
    const services = makeServices(ctx.__record, {
      tuiStatus: {
        registerView(descriptor) {
          ctx.__record.views.push(descriptor)
          return undefined
        },
      },
    })
    ctx.get = (name) => services[name]

    assert.doesNotThrow(() => apply(ctx, undefined))
    assert.equal(ctx.__record.views.length, 1)
    assert.ok(ctx.__record.logs.some(([, message]) => /refused/.test(message)))
    ctx.__dispose()
  })
})

test('session events drive the line: model, usage, settled turn', () => {
  withoutApiKey(() => {
    const ctx = makeCtx()
    const services = makeServices(ctx.__record)
    ctx.get = (name) => services[name]
    apply(ctx, undefined)

    const render = () => {
      const harness = createFakeReact()
      const tree = ctx.__record.views[0].component({ React: harness.React, ui: { Box: 'Box', Text: 'Text' } })
      harness.cleanup()
      return treeText(tree)
    }

    ctx.__emit('session/event', FAKE_SESSION, {
      type: 'request/header',
      data: { header: { config: { model: 'deepseek-flash' } } },
    })
    ctx.__emit('session/event', FAKE_SESSION, {
      type: 'assistant/message',
      time: Date.now(),
      data: { usage: { inputTokens: 1_000_000, outputTokens: 0 } },
    })
    ctx.__emit('session/event', FAKE_SESSION, { type: 'turn/end', time: Date.now(), data: { turn: 1 } })

    const text = render()
    // 1M cache-miss input tokens: 1 元 off-peak or 2 元 peak.
    assert.match(text, /¥[12]\.00/)
    assert.match(text, /本轮/)

    ctx.__dispose()
  })
})

test('subagent sessions never touch the displayed turn', () => {
  withoutApiKey(() => {
    const ctx = makeCtx()
    const services = makeServices(ctx.__record)
    ctx.get = (name) => services[name]
    apply(ctx, undefined)

    const child = { id: 'child', header: { id: 'child', origin: 'subagent', delegationDepth: 1 } }
    ctx.__emit('session/event', child, {
      type: 'assistant/message',
      time: Date.now(),
      data: { usage: { inputTokens: 1_000_000, outputTokens: 0 } },
    })
    ctx.__emit('session/event', child, { type: 'turn/end', time: Date.now(), data: { turn: 1 } })

    const harness = createFakeReact()
    const tree = ctx.__record.views[0].component({ React: harness.React, ui: { Box: 'Box', Text: 'Text' } })
    assert.match(treeText(tree), /本轮 —/)
    harness.cleanup()
    ctx.__dispose()
  })
})

test('malformed session events are ignored without throwing', () => {
  withoutApiKey(() => {
    const ctx = makeCtx()
    const services = makeServices(ctx.__record)
    ctx.get = (name) => services[name]
    apply(ctx, undefined)

    assert.doesNotThrow(() => {
      ctx.__emit('session/event', undefined, undefined)
      ctx.__emit('session/event', FAKE_SESSION, { type: 'assistant/message' })
      ctx.__emit('session/event', FAKE_SESSION, { type: 'assistant/message', data: { usage: 'nope' } })
      ctx.__emit('session/event', FAKE_SESSION, { type: 'request/header', data: {} })
      ctx.__emit('session/event', FAKE_SESSION, { type: 'turn/end' })
      ctx.__emit('session/disposed', FAKE_SESSION)
    })
    ctx.__dispose()
  })
})

test('repeated activation is deterministic (no duplicate registrations in one fiber)', () => {
  withoutApiKey(() => {
    const ctx = makeCtx()
    const services = makeServices(ctx.__record)
    ctx.get = (name) => services[name]
    apply(ctx, undefined)
    // A second apply on the same context models a hot reload: the host sees a
    // second activation, and both registrations must be well formed.
    apply(ctx, undefined)
    assert.equal(ctx.__record.settings.length, 2)
    assert.equal(ctx.__record.views.length, 2)
    ctx.__dispose()
  })
})
