import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Config, SETTINGS_NS, apply, balanceStateOf, forcePeakFromEnv, sanitizeConfig, seamServices, settingsSection } from '../lib/plugin.js'
import { SCENE_ID } from '../lib/history-command.js'
import { CACHE_VERSION } from '../lib/history-scan.js'
import { foldSessionEvents } from '../lib/history.js'
import { createFakeReact, treeText } from '../test-support/fake-react.js'
import { ABSENT_DSH_HOME, ABSENT_FOCUS_FILE, ABSENT_LANG_FILE, ABSENT_STATE_DIR, makeCtx, makeServices, renderLine, withEnv, withoutSecrets } from '../test-support/harness.js'

const FAKE_SESSION = { id: 'session-1', header: { id: 'session-1' } }

/** Every default the sanitizer must produce (schema mirror). */
const EXPECTED_DEFAULTS = {
  showBalance: true,
  showTurnCost: true,
  warnOnPeak: false,
  warnColor: 'red',
  historyMetric: 'tokens',
  historySpanWeeks: '26',
  historyIncludeSubagents: true,
  historyWeekStart: 'mon',
  historyColorScale: 'github',
  historyLayout: 'card',
  historyHoverTokens: true,
  historyHoverCost: true,
  historyHoverCacheHit: true,
  historyHoverModels: true,
}

test('sanitizeConfig accepts only known keys and types', () => {
  assert.deepEqual(sanitizeConfig(undefined), EXPECTED_DEFAULTS)
  assert.deepEqual(sanitizeConfig('nonsense'), EXPECTED_DEFAULTS)
  assert.deepEqual(
    sanitizeConfig({ showBalance: false, showTurnCost: 'yes', warnOnPeak: true, warnColor: 'purple', extra: 1 }),
    { ...EXPECTED_DEFAULTS, showBalance: false, warnOnPeak: true, warnColor: 'purple' },
  )
  assert.equal(sanitizeConfig({ warnColor: 'chartreuse' }).warnColor, 'red')
})

test('sanitizeConfig filters the history selects and booleans', () => {
  assert.deepEqual(
    sanitizeConfig({
      historyMetric: 'cost',
      historySpanWeeks: '53',
      historyWeekStart: 'sun',
      historyColorScale: 'theme',
      historyIncludeSubagents: false,
      historyHoverTokens: false,
      historyHoverCost: 'yes',
    }),
    {
      ...EXPECTED_DEFAULTS,
      historyMetric: 'cost',
      historySpanWeeks: '53',
      historyWeekStart: 'sun',
      historyColorScale: 'theme',
      historyIncludeSubagents: false,
      historyHoverTokens: false,
    },
  )
  const stale = sanitizeConfig({
    historyMetric: 'calories',
    historySpanWeeks: '999',
    historyWeekStart: 'tue',
    historyColorScale: 'neon',
    historyLayout: 'fancy',
  })
  assert.equal(stale.historyMetric, 'tokens')
  assert.equal(stale.historySpanWeeks, '26')
  assert.equal(stale.historyWeekStart, 'mon')
  assert.equal(stale.historyColorScale, 'github')
  assert.equal(stale.historyLayout, 'card')
  assert.equal(sanitizeConfig({ historyLayout: 'plain' }).historyLayout, 'plain')
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
    currency: 'CNY',
  })
  // A non-CNY account keeps its own currency, so the view cannot print ¥ over
  // a dollar figure (`cnyBalance` falls back to the first reported entry).
  assert.deepEqual(balanceStateOf({ ok: true, balances: [{ currency: 'USD', total: 5 }] }), {
    state: 'ok',
    amount: 5,
    currency: 'USD',
  })
  assert.deepEqual(balanceStateOf({ ok: true, balances: [] }), { state: 'error' })
  assert.deepEqual(balanceStateOf({ ok: false, reason: 'no-key' }), { state: 'no-key' })
  assert.deepEqual(balanceStateOf({ ok: false, reason: 'unauthorized' }), { state: 'unauthorized' })
  assert.deepEqual(balanceStateOf({ ok: false, reason: 'network' }), { state: 'error' })
  assert.deepEqual(balanceStateOf(undefined), { state: 'error' })
})

test('the settings card declares the four switches plus the history group', () => {
  const section = settingsSection()
  assert.equal(section.ns, SETTINGS_NS)
  assert.deepEqual(
    section.fields.map(field => field.path.join('.')),
    [
      'showBalance',
      'showTurnCost',
      'warnOnPeak',
      'warnColor',
      'historyMetric',
      'historySpanWeeks',
      'historyIncludeSubagents',
      'historyWeekStart',
      'historyColorScale',
      'historyLayout',
      'historyHoverTokens',
      'historyHoverCost',
      'historyHoverCacheHit',
      'historyHoverModels',
    ],
  )
  assert.deepEqual(section.groups, [
    { id: 'history', title: 'Token history', descriptions: { zh: '历史用量（/th）', en: 'Token history (/th)' } },
  ])
  const color = section.fields.find(field => field.path[0] === 'warnColor')
  assert.equal(color.kind, 'select')
  assert.equal(color.options.length, 7)
  const layout = section.fields.find(field => field.path[0] === 'historyLayout')
  assert.equal(layout.kind, 'select')
  assert.deepEqual(layout.options.map(option => option.value), ['card', 'plain'])
  const grouped = section.fields.filter(field => field.group === 'history')
  assert.equal(grouped.length, 10)
  assert.equal(section.fields.filter(field => field.group === undefined).length, 4)
  for (const field of section.fields) {
    assert.equal(typeof field.label, 'string')
    assert.equal(typeof field.descriptions.zh, 'string')
    assert.equal(typeof field.hintDescriptions.en, 'string')
    assert.equal(field.path.length, 1)
    if (field.group !== undefined) assert.ok(section.groups.some(group => group.id === field.group))
  }
  // Every declared field must be writable through the very schema the
  // namespace registers — a card that names a key the schema drops would
  // stage edits that never persist.
  const defaults = { ...Config({}) }
  assert.deepEqual(Object.keys(defaults).sort(), Object.keys(EXPECTED_DEFAULTS).sort())
  const written = {
    ...Config({
      showBalance: false,
      showTurnCost: false,
      warnOnPeak: true,
      warnColor: 'cyan',
      historyMetric: 'output',
      historySpanWeeks: '13',
      historyIncludeSubagents: false,
      historyWeekStart: 'sun',
      historyColorScale: 'blue',
      historyLayout: 'plain',
      historyHoverTokens: false,
      historyHoverCost: false,
      historyHoverCacheHit: false,
      historyHoverModels: false,
    }),
  }
  assert.deepEqual(written, {
    ...EXPECTED_DEFAULTS,
    showBalance: false,
    showTurnCost: false,
    warnOnPeak: true,
    warnColor: 'cyan',
    historyMetric: 'output',
    historySpanWeeks: '13',
    historyIncludeSubagents: false,
    historyWeekStart: 'sun',
    historyColorScale: 'blue',
    historyLayout: 'plain',
    historyHoverTokens: false,
    historyHoverCost: false,
    historyHoverCacheHit: false,
    historyHoverModels: false,
  })
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
    // Both session streams plus the settings bus (`/lang`); a host that never
    // emits `settings/updated` simply never calls the last one.
    assert.deepEqual(
      [...ctx.__record.listeners.keys()].sort(),
      ['session/disposed', 'session/event', 'settings/updated'],
    )
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
    assert.equal(ctx.__record.sections[0].fields.length, 14)

    assert.equal(ctx.__record.views.length, 1)
    const view = ctx.__record.views[0]
    assert.equal(view.key, SETTINGS_NS)
    assert.equal(view.maxRows, 3)
    assert.equal(typeof view.component, 'function')

    // `/hist`, `/th` and `/tokenhistory` land on the direct registry (the
    // mediated surface refuses an unadmitted activation), the scene is
    // registered once, and the `alt+h` shortcut exists because a bare `/th`
    // cannot survive the host's completion overlay.
    assert.deepEqual(ctx.__record.commands.map(command => command.name), ['th', 'tokenhistory', 'hist'])
    for (const command of ctx.__record.commands) {
      assert.equal(typeof command.handler, 'function')
      assert.equal(typeof command.description, 'string')
      assert.equal(typeof command.descriptions.zh, 'string')
    }
    assert.equal(ctx.__record.scenes.length, 1)
    assert.equal(ctx.__record.scenes[0].id, SCENE_ID)
    assert.equal(typeof ctx.__record.scenes[0].component, 'function')
    assert.deepEqual(ctx.__record.trees.map(tree => tree.root), ['th', 'tokenhistory', 'hist'])
    assert.deepEqual(ctx.__record.shortcuts.map(shortcut => shortcut.combo), ['alt+h'])
    assert.equal(typeof ctx.__record.shortcuts[0].handler, 'function')
    assert.equal(ctx.__record.shortcuts[0].description.length > 0, true)

    ctx.__dispose()
    assert.equal(ctx.__record.sectionDisposed, true)
    assert.equal(ctx.__record.viewDisposed, true)
    assert.equal(ctx.__record.commandDisposed, true)
    assert.equal(ctx.__record.sceneDisposed, true)
    assert.equal(ctx.__record.treeDisposed, true)
    assert.equal(ctx.__record.shortcutDisposed, true)

    // Idempotent teardown.
    assert.doesNotThrow(() => ctx.__dispose())
  })
})

test('the shortcut opens the history scene without typing a command', () => {
  withoutSecrets(() => {
    const ctx = makeCtx()
    const services = makeServices(ctx.__record)
    ctx.get = (name) => services[name]
    apply(ctx, undefined)
    const shortcut = ctx.__record.shortcuts[0]
    assert.ok(shortcut, 'expected the alt+h shortcut')
    shortcut.handler()
    assert.equal(ctx.__record.sceneOpened, SCENE_ID)
    ctx.__dispose()
  })
})

test('a host that refuses the shortcut only logs it', () => {
  withoutSecrets(() => {
    const ctx = makeCtx()
    const services = makeServices(ctx.__record, {
      tuiShortcuts: {
        register() {
          return () => {}
        },
      },
    })
    ctx.get = (name) => services[name]
    assert.doesNotThrow(() => apply(ctx, undefined))
    ctx.__dispose()
  })
})

test('the mediated command surface is preferred and a refusal falls back to the registry', () => {
  withoutSecrets(() => {
    const ctx = makeCtx()
    const mediated = []
    const services = makeServices(ctx.__record, {
      tuiPluginHost: {
        registerCommand(pluginCtx, contributionId, definition) {
          mediated.push({ contributionId, name: definition.name })
          return () => {
            ctx.__record.mediatedDisposed = true
          }
        },
      },
    })
    ctx.get = (name) => services[name]
    apply(ctx, undefined)

    assert.deepEqual(mediated.map(entry => entry.name), ['th', 'tokenhistory', 'hist'])
    assert.deepEqual(mediated.map(entry => entry.contributionId), [
      'com.dsh-tui-ecosystem.dsh-peak-balance.th',
      'com.dsh-tui-ecosystem.dsh-peak-balance.tokenhistory',
      'com.dsh-tui-ecosystem.dsh-peak-balance.hist',
    ])
    assert.equal(ctx.__record.commands.length, 0)
    ctx.__dispose()
    assert.equal(ctx.__record.mediatedDisposed, true)
  })
})

test('a host that refuses the mediated surface still gets every command', () => {
  withoutSecrets(() => {
    const ctx = makeCtx()
    const services = makeServices(ctx.__record, {
      tuiPluginHost: {
        registerCommand() {
          throw new Error('the calling activation has no verified dsh-plugin.json Component identity')
        },
      },
    })
    ctx.get = (name) => services[name]
    apply(ctx, undefined)
    // The unadmitted-activation refusal is expected and must not be a warning.
    assert.deepEqual(ctx.__record.commands.map(command => command.name), ['th', 'tokenhistory', 'hist'])
    assert.equal(
      ctx.__record.logs.some(([, message]) => /no verified dsh-plugin.json/.test(message)),
      false,
    )
    ctx.__dispose()
  })
})

test('/th opens the scene, and /th price manages custom rates', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'dsh-pb-apply-'))
  try {
    await withEnv(
      {
        DEEPSEEK_API_KEY: undefined,
        DSH_TUI_LANG: 'zh',
        DSH_PEAK_BALANCE_FOCUS_FILE: ABSENT_FOCUS_FILE,
        DSH_TUI_STATE_DIR: stateDir,
        DSH_HOME: ABSENT_DSH_HOME,
      },
      async () => {
        const ctx = makeCtx()
        const services = makeServices(ctx.__record)
        ctx.get = (name) => services[name]
        apply(ctx, undefined)

        const th = ctx.__record.commands.find(command => command.name === 'th')
        assert.ok(th)

        const opened = await th.handler({ rawInput: '' })
        assert.deepEqual(opened, { kind: 'success' })
        assert.equal(ctx.__record.sceneOpened, SCENE_ID)

        const listing = await th.handler({ rawInput: ' price ' })
        assert.equal(listing.kind, 'success')
        assert.match(listing.text, /自定义费率/)

        const set = await th.handler({ rawInput: ' price set deepseek-v4.1-flash-expires-on-0910 0.02 1 4 ' })
        assert.equal(set.kind, 'success')
        assert.match(set.text, /deepseek-v4\.1-flash-expires-on-0910/)

        const file = join(stateDir, 'dsh-peak-balance-rates.json')
        assert.equal(existsSync(file), true)
        const stored = JSON.parse(readFileSync(file, 'utf8'))
        assert.equal(stored.version, 1)
        assert.deepEqual(stored.rates['deepseek-v4.1-flash-expires-on-0910'].idle, {
          inputHit: 0.02,
          inputMiss: 1,
          output: 4,
        })
        // The peak tier defaults to twice the off-peak price.
        assert.deepEqual(stored.rates['deepseek-v4.1-flash-expires-on-0910'].peak, {
          inputHit: 0.04,
          inputMiss: 2,
          output: 8,
        })

        const bad = await th.handler({ rawInput: 'price set model abc 1 1' })
        assert.equal(bad.kind, 'error')
        assert.match(bad.text, /价格必须是/)

        const removed = await th.handler({ rawInput: 'price rm deepseek-v4.1-flash-expires-on-0910' })
        assert.equal(removed.kind, 'success')
        assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).rates, {})

        const cleared = await th.handler({ rawInput: 'price clear' })
        assert.equal(cleared.kind, 'success')

        ctx.__dispose()
      },
    )
  } finally {
    // The `/th` handler kicks off a background scan; let it settle so its cache
    // write cannot land after the cleanup.
    await new Promise(resolve => setTimeout(resolve, 100))
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('the history grid is painted from the cache before any scan runs', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'dsh-pb-preload-'))
  try {
    // A cache left by an earlier session, holding one model the price card
    // cannot rate. `/th price` answers from the published view, so it can only
    // name that model when activation already painted the grid — the point of
    // the preload is that opening `/hist` never waits on the scan.
    const day = Date.UTC(2026, 8, 7, 4, 0, 0)
    const record = foldSessionEvents([
      { type: 'session', id: 's1', createdAt: day },
      { type: 'request/header', seq: 0, time: day, data: { header: { config: { model: 'mystery-model-9000' } } } },
      { type: 'assistant/message', seq: 1, time: day, data: { usage: { inputTokens: 100, outputTokens: 10 } } },
    ])
    writeFileSync(
      join(stateDir, 'dsh-peak-balance-history.json'),
      JSON.stringify({
        version: CACHE_VERSION,
        builtAt: day,
        files: { '--w--/s1/session.jsonl.zstd': { size: 1, mtimeMs: 1, record } },
      }),
    )

    await withEnv(
      {
        DEEPSEEK_API_KEY: undefined,
        DSH_TUI_LANG: 'zh',
        DSH_PEAK_BALANCE_FOCUS_FILE: ABSENT_FOCUS_FILE,
        DSH_TUI_STATE_DIR: stateDir,
        DSH_HOME: ABSENT_DSH_HOME,
      },
      async () => {
        const ctx = makeCtx()
        const services = makeServices(ctx.__record)
        ctx.get = (name) => services[name]
        apply(ctx, undefined)

        const th = ctx.__record.commands.find(command => command.name === 'th')
        const listing = await th.handler({ rawInput: ' price ' })
        assert.equal(listing.kind, 'success')
        assert.match(listing.text, /mystery-model-9000/)

        // Activation itself did the preload — that is what this pins. The
        // sessions root is empty here, so anything reading the grid after a
        // completed scan would find nothing at all.
        assert.equal(ctx.__record.logs.some(([, message]) => /history preloaded records=1/.test(message)), true)
        ctx.__dispose()
      },
    )
  } finally {
    // A `/th` handler can kick off a background scan; let it settle so its cache
    // write cannot land after the cleanup.
    await new Promise(resolve => setTimeout(resolve, 100))
    rmSync(stateDir, { recursive: true, force: true })
  }
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

test('a subagent with no known parent never touches the displayed turn', () => {
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

test("a subagent's spend is folded into its parent's running turn", () => {
  withoutSecrets(() => {
    const ctx = makeCtx()
    const services = makeServices(ctx.__record)
    ctx.get = (name) => services[name]
    apply(ctx, undefined)

    const parent = { id: 'parent', header: { id: 'parent' } }
    const child = {
      id: 'child',
      header: { id: 'child', origin: 'subagent', delegationDepth: 1, parentSession: 'parent' },
    }
    const at = Date.now()

    ctx.__emit('session/event', parent, { type: 'turn/start', time: at, data: { turn: 1 } })
    ctx.__emit('session/event', parent, {
      type: 'request/header',
      time: at,
      data: { header: { config: { model: 'deepseek-flash' } } },
    })
    ctx.__emit('session/event', parent, {
      type: 'assistant/message',
      time: at,
      data: { usage: { inputTokens: 500_000, outputTokens: 0 } },
    })
    // The delegated child burns 1M cache-miss tokens on the parent's behalf.
    ctx.__emit('session/event', child, {
      type: 'assistant/message',
      time: at,
      data: { usage: { inputTokens: 1_000_000, outputTokens: 0 } },
    })

    // Live, before the parent settles: 1.5M miss tokens — ¥1.50 off-peak.
    assert.match(renderLine(ctx), /本轮·计费中 ¥(1\.50|3\.00)/)

    ctx.__emit('session/event', parent, { type: 'turn/end', time: at, data: { turn: 1 } })
    const settled = renderLine(ctx)
    assert.match(settled, /本轮 ¥(1\.50|3\.00)/)

    // A background child finishing after the round closed cannot reopen it.
    ctx.__emit('session/event', child, {
      type: 'assistant/message',
      time: at,
      data: { usage: { inputTokens: 9_000_000, outputTokens: 0 } },
    })
    assert.equal(renderLine(ctx), settled)

    ctx.__dispose()
  })
})

test('a report is filed under the tier its request STARTED in', () => {
  withoutSecrets(() => {
    const ctx = makeCtx()
    const services = makeServices(ctx.__record)
    ctx.get = (name) => services[name]
    apply(ctx, undefined)

    const peakAt = Date.UTC(2026, 8, 10, 2, 0) // 2026-09-10 10:00 Beijing: peak
    const idleAt = Date.UTC(2026, 8, 10, 5, 0) // 2026-09-10 13:00 Beijing: off-peak

    ctx.__emit('session/event', FAKE_SESSION, { type: 'turn/start', time: peakAt, data: { turn: 1 } })
    ctx.__emit('session/event', FAKE_SESSION, {
      type: 'request/header',
      time: peakAt,
      data: { header: { config: { model: 'deepseek-flash' } } },
    })
    // The 10:00 request's answer only lands at 13:00 — it ran, and is billed, peak.
    ctx.__emit('session/event', FAKE_SESSION, { type: 'step/start', time: peakAt, data: { turn: 1, step: 1 } })
    ctx.__emit('session/event', FAKE_SESSION, {
      type: 'assistant/message',
      time: idleAt,
      data: { turn: 1, step: 1, usage: { inputTokens: 1_000_000, outputTokens: 0 } },
    })
    // An off-peak request, answered immediately.
    ctx.__emit('session/event', FAKE_SESSION, { type: 'step/start', time: idleAt, data: { turn: 1, step: 2 } })
    ctx.__emit('session/event', FAKE_SESSION, {
      type: 'assistant/message',
      time: idleAt,
      data: { turn: 1, step: 2, usage: { inputTokens: 1_000_000, outputTokens: 0 } },
    })
    ctx.__emit('session/event', FAKE_SESSION, { type: 'turn/end', time: idleAt, data: { turn: 1 } })

    // 1M peak miss (¥2) + 1M off-peak miss (¥1) = ¥3.00, whatever the wall clock.
    assert.match(renderLine(ctx), /本轮 ¥3\.00/)
    ctx.__dispose()
  })
})

test('a round that reported nothing clears the settled figure', () => {
  withoutSecrets(() => {
    const ctx = makeCtx()
    const services = makeServices(ctx.__record)
    ctx.get = (name) => services[name]
    apply(ctx, undefined)

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
    assert.match(renderLine(ctx), /本轮 ¥[12]\.00/)

    // The next round is interrupted before producing an answer: there is no
    // honest figure for it, and the previous round's must not stand in.
    ctx.__emit('session/event', FAKE_SESSION, { type: 'turn/start', time: Date.now(), data: { turn: 2 } })
    ctx.__emit('session/event', FAKE_SESSION, { type: 'turn/end', time: Date.now(), data: { turn: 2 } })
    assert.match(renderLine(ctx), /本轮 —/)

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

test('the language follows the host: startup value, live switch, and the file fallback', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'dsh-pb-lang-'))
  const langFile = join(stateDir, 'lang.json')
  try {
    await withEnv(
      {
        DEEPSEEK_API_KEY: undefined,
        DSH_TUI_LANG: undefined,
        DSH_PEAK_BALANCE_FOCUS_FILE: ABSENT_FOCUS_FILE,
        DSH_PEAK_BALANCE_LANG_FILE: langFile,
        DSH_TUI_STATE_DIR: stateDir,
        DSH_HOME: ABSENT_DSH_HOME,
      },
      async () => {
        const ctx = makeCtx()
        const services = makeServices(ctx.__record)
        ctx.get = (name) => services[name]
        // The host's own settings namespace carries the language `/lang` wrote.
        ctx.__record.settingsValues = { 'dsh-tui': { lang: 'en' } }

        apply(ctx, undefined)
        assert.match(renderLine(ctx), /Balance/)
        assert.equal(ctx.__record.logs.some(([, message]) => /lang=en/.test(message)), true)

        // A live `/lang` lands as a settings commit for the `dsh-tui` namespace.
        ctx.__emit('settings/updated', 'dsh-tui', { lang: 'zh' }, { lang: 'en' }, 'user')
        assert.match(renderLine(ctx), /余额/)
        assert.equal(ctx.__record.logs.some(([, message]) => /language switched en -> zh \(settings\/updated\)/.test(message)), true)

        // Unrelated namespaces and unusable values change nothing.
        ctx.__emit('settings/updated', 'chime', { doneFocus: 'g2' }, {}, 'user')
        ctx.__emit('settings/updated', 'dsh-tui', { lang: 'fr' }, {}, 'user')
        ctx.__emit('settings/updated', 'dsh-tui', undefined, {}, 'user')
        assert.match(renderLine(ctx), /余额/)

        // The 1 s poll catches a host that writes only the preference file.
        services.get = () => undefined
        ctx.__record.settingsValues = undefined
        writeFileSync(langFile, JSON.stringify({ lang: 'en' }))
        await new Promise(resolve => setTimeout(resolve, 1500))
        assert.match(renderLine(ctx), /Balance/)
        ctx.__dispose()
      },
    )
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('the environment pin outranks the host setting', () => {
  withEnv(
    {
      DEEPSEEK_API_KEY: undefined,
      DSH_TUI_LANG: 'zh',
      DSH_PEAK_BALANCE_FOCUS_FILE: ABSENT_FOCUS_FILE,
      DSH_PEAK_BALANCE_LANG_FILE: ABSENT_LANG_FILE,
      DSH_TUI_STATE_DIR: ABSENT_STATE_DIR,
      DSH_HOME: ABSENT_DSH_HOME,
    },
    () => {
      const ctx = makeCtx()
      const services = makeServices(ctx.__record)
      ctx.get = (name) => services[name]
      ctx.__record.settingsValues = { 'dsh-tui': { lang: 'en' } }
      apply(ctx, undefined)
      // dsh-tui pins `DSH_TUI_LANG` the same way, so the plugin must not let
      // the namespace override it.
      assert.match(renderLine(ctx), /余额/)
      ctx.__dispose()
    },
  )
})

test('a host without a settings namespace still follows the persisted file', () => {
  withoutSecrets(() => {
    const ctx = makeCtx()
    const services = makeServices(ctx.__record)
    ctx.get = (name) => (name === 'settings' ? undefined : services[name])
    apply(ctx, undefined)
    // No namespace, no file (ABSENT_LANG_FILE), locale zh → Chinese.
    assert.match(renderLine(ctx), /余额/)
    assert.doesNotThrow(() => ctx.__dispose())
  })
})
