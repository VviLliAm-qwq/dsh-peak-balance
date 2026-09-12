import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  WARN_COLOR_ORDER,
  buildDisplay,
  warnColorHex,
  warnColorOptions,
} from '../lib/display.js'
import { BEIJING_OFFSET_MS } from '../lib/peak.js'

/** Beijing wall clock -> UTC instant (2026-09-10 is a Thursday). */
function beijing(year, month, day, hour, minute = 0) {
  return Date.UTC(year, month - 1, day, hour, minute) - BEIJING_OFFSET_MS
}

const PEAK_AT = beijing(2026, 9, 10, 10, 30)
const IDLE_AT = beijing(2026, 9, 10, 13, 0)
const WEEKEND_AT = beijing(2026, 9, 12, 13, 0)

const CONFIG = { showBalance: true, showTurnCost: true, warnOnPeak: false, warnColor: 'red' }

const partText = model => model.parts.map(part => `${part.key}:${part.text}`).join(' | ')

test('the line always carries the phase and its countdown', () => {
  const peak = buildDisplay({ atMs: PEAK_AT, lang: 'zh', config: CONFIG })
  assert.equal(peak.peak, true)
  assert.equal(peak.warn, false)
  assert.match(partText(peak), /phase:⚡ 峰时/)
  assert.match(partText(peak), /countdown:距谷时 1h30m/)

  const idle = buildDisplay({ atMs: IDLE_AT, lang: 'zh', config: CONFIG })
  assert.equal(idle.peak, false)
  assert.match(partText(idle), /phase:🌊 谷时·半价/)
  assert.match(partText(idle), /countdown:距峰时 1h00m/)
})

test('weekends are labelled as such', () => {
  const weekend = buildDisplay({ atMs: WEEKEND_AT, lang: 'zh', config: CONFIG })
  assert.equal(weekend.weekend, true)
  assert.match(partText(weekend), /周末/)
})

test('english strings follow the resolved language', () => {
  const model = buildDisplay({ atMs: PEAK_AT, lang: 'en', config: CONFIG })
  assert.match(partText(model), /phase:⚡ Peak/)
  assert.match(partText(model), /off-peak in 1h30m/)
})

test('warning mode only arms during a peak window', () => {
  const armed = buildDisplay({ atMs: PEAK_AT, lang: 'zh', config: { ...CONFIG, warnOnPeak: true } })
  assert.equal(armed.warn, true)
  assert.equal(armed.colorHex, warnColorHex('red'))

  const idle = buildDisplay({ atMs: IDLE_AT, lang: 'zh', config: { ...CONFIG, warnOnPeak: true } })
  assert.equal(idle.warn, false)
})

test('the diagnostic override previews the peak presentation off-peak', () => {
  const forced = buildDisplay({
    atMs: IDLE_AT,
    lang: 'zh',
    config: { ...CONFIG, warnOnPeak: true, warnColor: 'purple' },
    forcePeak: true,
  })
  assert.equal(forced.peak, true)
  assert.equal(forced.warn, true)
  assert.equal(forced.colorHex, warnColorHex('purple'))
  assert.match(partText(forced), /phase:⚡ 峰时/)
  // The countdown still describes the real clock.
  assert.match(partText(forced), /距峰时 1h00m/)
  // Without the override the same instant stays off-peak.
  assert.equal(buildDisplay({ atMs: IDLE_AT, lang: 'zh', config: CONFIG }).peak, false)
})

test('the warning color follows the configured palette entry', () => {  for (const name of WARN_COLOR_ORDER) {
    const model = buildDisplay({ atMs: PEAK_AT, lang: 'zh', config: { ...CONFIG, warnOnPeak: true, warnColor: name } })
    assert.equal(model.colorHex, warnColorHex(name))
    assert.match(model.colorHex, /^#[0-9A-F]{6}$/)
  }
  // An unknown name can never render an unparsable color.
  assert.equal(warnColorHex('chartreuse'), warnColorHex('red'))
})

test('the settings field offers exactly the seven colors', () => {
  const options = warnColorOptions()
  assert.equal(options.length, 7)
  assert.deepEqual(options.map(option => option.value), [...WARN_COLOR_ORDER])
  for (const option of options) {
    assert.equal(typeof option.label, 'string')
    assert.equal(typeof option.descriptions.zh, 'string')
  }
})

test('the two display switches remove their own part only', () => {
  const noBalance = buildDisplay({
    atMs: PEAK_AT,
    lang: 'zh',
    config: { ...CONFIG, showBalance: false },
    balance: { state: 'ok', amount: 12.34 },
    lastTurn: { cost: { total: 0.0234 }, tokens: 100, model: 'deepseek-flash', turn: 1 },
  })
  assert.doesNotMatch(partText(noBalance), /balance:/)
  assert.match(partText(noBalance), /turn:本轮 ¥0.0234/)

  const noTurn = buildDisplay({
    atMs: PEAK_AT,
    lang: 'zh',
    config: { ...CONFIG, showTurnCost: false },
    balance: { state: 'ok', amount: 12.34 },
    lastTurn: { cost: { total: 0.0234 }, tokens: 100, model: 'deepseek-flash', turn: 1 },
  })
  assert.doesNotMatch(partText(noTurn), /turn:/)
  assert.match(partText(noTurn), /balance:余额 ¥12.34/)
})

test('balance states render an honest label instead of a number', () => {
  const cases = [
    [{ state: 'loading' }, /余额 查询中…/, 'muted'],
    [{ state: 'no-key' }, /余额 未配置密钥/, 'muted'],
    [{ state: 'unauthorized' }, /余额 密钥无效/, 'error'],
    [{ state: 'error' }, /余额 暂不可用/, 'muted'],
  ]
  for (const [balance, pattern, tone] of cases) {
    const model = buildDisplay({ atMs: PEAK_AT, lang: 'zh', config: CONFIG, balance })
    const part = model.parts.find(entry => entry.key === 'balance')
    assert.match(part.text, pattern)
    assert.equal(part.tone, tone)
  }
})

test('an unsettled turn shows a dash, an unrated one says so', () => {
  const pending = buildDisplay({ atMs: PEAK_AT, lang: 'zh', config: CONFIG })
  assert.match(pending.parts.find(part => part.key === 'turn').text, /本轮 —/)

  const unrated = buildDisplay({
    atMs: PEAK_AT,
    lang: 'zh',
    config: CONFIG,
    lastTurn: { cost: undefined, tokens: 500, model: 'mystery', turn: 1 },
  })
  assert.match(unrated.parts.find(part => part.key === 'turn').text, /费率未知/)
})

test('the countdown tracks the phase boundary', () => {
  const near = buildDisplay({ atMs: beijing(2026, 9, 10, 11, 59), lang: 'zh', config: CONFIG })
  assert.match(partText(near), /距谷时 1m/)
})

test('a running turn shows its live figure, not the settled one', () => {
  const model = buildDisplay({
    atMs: PEAK_AT,
    lang: 'zh',
    config: CONFIG,
    lastTurn: { cost: { total: 1 }, tokens: 100, model: 'deepseek-flash', turn: 1 },
    live: { tokens: 250_000, cost: { total: 0.5 } },
  })
  const part = model.parts.find(entry => entry.key === 'turn')
  assert.match(part.text, /本轮·计费中 ¥0\.5000/)
  assert.equal(part.live, true)
  assert.equal(part.tokens, 250_000)
})

test('the settled figure returns once the turn closes', () => {
  const model = buildDisplay({
    atMs: PEAK_AT,
    lang: 'zh',
    config: CONFIG,
    lastTurn: { cost: { total: 1 }, tokens: 100, model: 'deepseek-flash', turn: 1 },
    live: { tokens: 0, cost: undefined },
  })
  const part = model.parts.find(entry => entry.key === 'turn')
  assert.match(part.text, /^本轮 ¥1\.00$/)
  assert.equal(part.live, false)
})

test('a live turn on an unrated model says so instead of guessing', () => {
  const model = buildDisplay({ atMs: PEAK_AT, lang: 'zh', config: CONFIG, live: { tokens: 5, cost: undefined } })
  assert.match(model.parts.find(entry => entry.key === 'turn').text, /本轮·计费中 费率未知/)
})

test('the balance is formatted in the currency the endpoint reported', () => {
  const usd = buildDisplay({
    atMs: PEAK_AT,
    lang: 'zh',
    config: CONFIG,
    balance: { state: 'ok', amount: 5, currency: 'USD' },
  })
  assert.match(usd.parts.find(entry => entry.key === 'balance').text, /余额 \$5\.00/)

  const cny = buildDisplay({
    atMs: PEAK_AT,
    lang: 'zh',
    config: CONFIG,
    balance: { state: 'ok', amount: 12.34, currency: 'CNY' },
  })
  assert.match(cny.parts.find(entry => entry.key === 'balance').text, /余额 ¥12\.34/)
})

test('the turn figure sits ahead of the balance so truncation hits the balance first', () => {
  const model = buildDisplay({
    atMs: PEAK_AT,
    lang: 'zh',
    config: CONFIG,
    balance: { state: 'ok', amount: 12.34, currency: 'CNY' },
    lastTurn: { cost: { total: 0.0234 }, tokens: 100, model: 'deepseek-flash', turn: 1 },
  })
  assert.deepEqual(model.parts.map(part => part.key), ['phase', 'countdown', 'turn', 'balance'])
})
