import { test } from 'node:test'
import assert from 'node:assert/strict'

import { Config, SETTINGS_NS, apply, balanceStateOf, forcePeakFromEnv, sanitizeConfig, seamServices, settingsSection } from '../lib/plugin.js'
import { createFakeReact, treeText } from '../test-support/fake-react.js'
import { ABSENT_FOCUS_FILE, makeCtx, makeServices, withoutSecrets } from '../test-support/harness.js'

const FAKE_SESSION = { id: 'session-1', header: { id: 'session-1' } }

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

test('seamServices prefers the strict accessor and falls back to the soft one', () => {
  const strictOnly = { tag: 'strict' }
  const softOnly = { tag: 'soft' }
  const both = [strictOnly, softOnly]

  // Strict answers: it comes first, the soft form is still offered.
  assert.deepEqual(
    seamServices({ get: (name, strict) => (strict === false ? softOnly : strictOnly) }, 'x'),
    both,
  )
  // Only the soft form answers (host hid the provider behind a shadow).
  assert.deepEqual(seamServices({ get: (name, strict) => (strict === false ? softOnly : undefined) }, 'x'), [softOnly])
  // Neither form answers, and a throwing accessor is contained.
  assert.deepEqual(seamServices({ get: () => undefined }, 'x'), [])
  assert.deepEqual(seamServices({ get: () => { throw new Error('nope') } }, 'x'), [])
  // Identical instances are not offered twice.
  assert.deepEqual(seamServices({ get: () => strictOnly }, 'x'), [strictOnly])
})

test('a shadow placeholder that refuses cannot stop the registration', () => {
  withoutSecrets(() => {
    const ctx = makeCtx()
    const record = ctx.__record
    const working = {
      register(section) {
        record.sections.push(section)
        return () => {
          record.sectionDisposed = true
        }
      },
    }
    const shadow = {
      register() {
        throw new Error('dsh-tui: tuiSettingsSections.register requires a live Cordis activation context')
      },
    }
    ctx.get = (name, strict) => {
      if (name !== 'tuiSettingsSections') return undefined
      // The strict form returns the real runtime; the soft form returns the
      // shadow placeholder the host refuses — the plugin must end up using
      // the first and never give up on the second's error.
      return strict === false ? shadow : working
    }

    assert.doesNotThrow(() => apply(ctx, undefined))
    assert.equal(record.sections.length, 1)
    ctx.__dispose()
  })
})

test('the diagnostic peak override is opt-in and off by default', () => {
  assert.equal(forcePeakFromEnv({}), false)
  assert.equal(forcePeakFromEnv({ DSH_PEAK_BALANCE_FORCE_PEAK: '' }), false)
  assert.equal(forcePeakFromEnv({ DSH_PEAK_BALANCE_FORCE_PEAK: '0' }), false)
  assert.equal(forcePeakFromEnv({ DSH_PEAK_BALANCE_FORCE_PEAK: 'no' }), false)
  for (const value of ['1', 'true', 'TRUE', 'yes', 'on', ' 1 ']) {
    assert.equal(forcePeakFromEnv({ DSH_PEAK_BALANCE_FORCE_PEAK: value }), true, value)
  }
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
  // A stale color from a hand-edited document is stored as-is and sanitized at
  // use time, so the namespace still registers (an unavailable card could not
  // be repaired from the UI).
  assert.equal(Config({ warnColor: 'chartreuse' }).warnColor, 'chartreuse')
  assert.equal(sanitizeConfig(Config({ warnColor: 'chartreuse' })).warnColor, 'red')
})

test('a host without any seam stays inert and never throws', () => {
  withoutSecrets(() => {
    const ctx = makeCtx()
    assert.doesNotThrow(() => apply(ctx, undefined))
    assert.equal(ctx.__record.settings.length, 0)
    assert.equal(ctx.__record.views.length, 0)
    assert.equal(ctx.__record.listeners.size, 2)
    assert.doesNotThrow(() => ctx.__dispose())
  })
})

test('a throwing service accessor is contained', () => {
  withoutSecrets(() => {
    const ctx = makeCtx({ getThrows: true })
    assert.doesNotThrow(() => apply(ctx, {}))
    assert.ok(ctx.__record.logs.some(([level]) => level === 'warn'))
    assert.doesNotThrow(() => ctx.__dispose())
  })
})

test('garbage configuration cannot break the wiring', () => {
  withoutSecrets(() => {
    const ctx = makeCtx()
    const services = makeServices(ctx.__record)
    ctx.get = (name) => services[name]
    assert.doesNotThrow(() => apply(ctx, { showBalance: 'yes', warnColor: 42, unexpected: {} }))
    assert.equal(ctx.__record.settings.length, 1)
    ctx.__dispose()
  })
})

test('every seam is registered once, with the documented shape', () => {
  withoutSecrets(() => {
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
  withoutSecrets(() => {
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

test('a single refused status registration keeps retrying instead of giving up', () => {
  withoutSecrets(() => {
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
    // One refusal happens on the first tick, while the seam row is still
    // activating; it must not be treated as final.
    assert.equal(ctx.__record.views.length, 1)
    assert.equal(ctx.__record.logs.some(([, message]) => /refused/.test(message)), false)
    ctx.__dispose()
  })
})

test('a status view that is refused every time eventually degrades with a warning', async () => {
  const saved = process.env.DEEPSEEK_API_KEY
  const savedLang = process.env.DSH_TUI_LANG
  const savedFocus = process.env.DSH_PEAK_BALANCE_FOCUS_FILE
  delete process.env.DEEPSEEK_API_KEY
  process.env.DSH_TUI_LANG = 'zh'
  process.env.DSH_PEAK_BALANCE_FOCUS_FILE = ABSENT_FOCUS_FILE
  try {
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

    apply(ctx, undefined)
    // Five retry ticks at 400 ms each.
    await new Promise(resolve => setTimeout(resolve, 2400))
    assert.ok(ctx.__record.views.length >= 5, `expected repeated attempts, saw ${ctx.__record.views.length}`)
    assert.ok(ctx.__record.logs.some(([, message]) => /refused 5 times/.test(message)))
    ctx.__dispose()
  } finally {
    if (saved === undefined) delete process.env.DEEPSEEK_API_KEY
    else process.env.DEEPSEEK_API_KEY = saved
    if (savedLang === undefined) delete process.env.DSH_TUI_LANG
    else process.env.DSH_TUI_LANG = savedLang
    if (savedFocus === undefined) delete process.env.DSH_PEAK_BALANCE_FOCUS_FILE
    else process.env.DSH_PEAK_BALANCE_FOCUS_FILE = savedFocus
  }
})

test('session events drive the line: model, usage, settled turn', () => {
  withoutSecrets(() => {
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
  withoutSecrets(() => {
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
  withoutSecrets(() => {
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
  withoutSecrets(() => {
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
