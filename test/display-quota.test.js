import { test } from 'node:test'
import assert from 'node:assert/strict'

import { buildDisplay, formatMeterAmount, meterText, quotaPart } from '../lib/display.js'

/** Render one part's text, failing loudly when the state produces no part. */
function textOf(quota, lang = 'zh', atMs = 0) {
  const part = quotaPart(lang, quota, atMs)
  assert.notEqual(part, undefined, 'expected the quota part to render')
  return part.text
}

test('a capped meter renders used over cap without repeating the unit', () => {
  const meter = { id: 'window5h', kind: 'credits', used: 0.053855557, cap: 14 }
  assert.equal(meterText('zh', meter), '5h 0.0539/14.00')
  assert.equal(meterText('en', meter), '5h 0.0539/14.00')
})

test('a remaining-only meter is converted when the cap is known', () => {
  const meter = { id: 'windowWeekly', kind: 'credits', remaining: 31, cap: 35 }
  assert.equal(meterText('zh', meter), '周 4.00/35.00')
})

test('a money meter keeps its currency symbol, a plain unit keeps its word', () => {
  assert.equal(meterText('zh', { id: 'balance', kind: 'money', currency: 'USD', remaining: 12.5 }), '余额 $12.50')
  assert.equal(meterText('zh', { id: 'planRemaining', kind: 'credits', remaining: 69.946144443 }), '套餐余量 69.95 credits')
  assert.equal(meterText('zh', { id: 'periodSpend', kind: 'money', currency: 'CNY', used: 3 }), '本期 ¥3.00')
})

test('an unknown meter id falls back to its own label, then to the id', () => {
  assert.equal(meterText('zh', { id: 'custom', label: 'Daily', kind: 'count', used: 3, cap: 10 }), 'Daily 3.00/10.00')
  assert.equal(meterText('zh', { id: 'mystery', kind: 'count', used: 3 }), 'mystery 3.00')
})

test('a cap without a usage figure still shows the shape of the account', () => {
  // A relay answers `/subscription` but not `/usage`: the remaining amount is
  // deliberately left unknown rather than over-reported, so the figure slot
  // says so instead of collapsing to a bare label.
  assert.equal(meterText('zh', { id: 'balance', kind: 'money', currency: 'USD', cap: 20 }), '余额 —/$20.00')
  assert.equal(meterText('zh', { id: 'balance', kind: 'money', currency: 'CNY' }), '余额')
})

test('the split-balance meter ids carry their own localized labels', () => {
  // SiliconFlow reports a promotional balance next to the topped-up one; the
  // adapter labels them in English so they are readable anywhere, and the view
  // localizes them when it can. Those amounts carry no currency (the API never
  // names one), so no symbol is invented for them.
  assert.equal(meterText('zh', { id: 'balance-granted', kind: 'money', remaining: 0.88 }), '赠金 0.8800')
  assert.equal(meterText('en', { id: 'balance-granted', kind: 'money', remaining: 0.88 }), 'gift 0.8800')
  assert.equal(meterText('zh', { id: 'balance-charged', kind: 'money', remaining: 88 }), '充值 88.00')
  assert.equal(meterText('en', { id: 'balance-charged', kind: 'money', remaining: 88 }), 'recharged 88.00')
  // A provider that does name one keeps its symbol.
  assert.equal(meterText('zh', { id: 'balance-granted', kind: 'money', currency: 'USD', remaining: 0.88 }), '赠金 $0.8800')
})

test('an amount formats by unit, with the credit word only where it helps', () => {
  assert.equal(formatMeterAmount('zh', 1.5, { kind: 'money', currency: 'USD' }), '$1.50')
  assert.equal(formatMeterAmount('zh', 0.25, { kind: 'credits' }), '0.2500 credits')
  assert.equal(formatMeterAmount('en', 0.25, { kind: 'credits' }), '0.2500 credits')
  assert.equal(formatMeterAmount('zh', 7, { kind: 'count' }), '7.00')
  assert.equal(formatMeterAmount('zh', undefined, { kind: 'count' }), '—')
})

test('a live meter part carries the plan, the reset countdown and the cap warning', () => {
  const quota = {
    state: 'meter',
    planName: 'GOAT',
    meter: { id: 'window5h', kind: 'credits', used: 1, cap: 14, resetAt: 3_600_000 },
  }
  assert.equal(textOf(quota, 'zh', 0), '套餐 GOAT · 5h 1.00/14.00 · 距重置 1h00m')
  assert.equal(textOf(quota, 'en', 0), 'plan GOAT · 5h 1.00/14.00 · resets in 1h00m')

  const exceeded = quotaPart('zh', { ...quota, meter: { ...quota.meter, exceeded: true } }, 0)
  assert.equal(exceeded.tone, 'error')
  assert.match(exceeded.text, /已打满$/)
})

test('a meter without a plan or a reset time renders just the figure', () => {
  assert.equal(textOf({ state: 'meter', meter: { id: 'balance', kind: 'money', currency: 'CNY', remaining: 12.34 } }), '余额 ¥12.34')
})

test('the failure states reuse the account vocabulary', () => {
  assert.equal(textOf({ state: 'loading' }), '额度 查询中…')
  assert.equal(textOf({ state: 'no-key' }), '额度 未配置密钥')
  assert.equal(quotaPart('zh', { state: 'unauthorized' }).tone, 'error')
  assert.equal(textOf({ state: 'error' }), '额度 暂不可用')
  assert.equal(textOf({ state: 'unsupported' }), '额度 无接口')
  // A pinned provider is named, so "no API" is not mistaken for a silent failure.
  assert.equal(textOf({ state: 'unsupported', pinned: true }), '额度（已指定） 无接口')
})

test('no quota state renders no part at all', () => {
  assert.equal(quotaPart('zh', undefined), undefined)
  assert.equal(quotaPart('zh', null), undefined)
})

test('buildDisplay omits the account part when no quota state is given', () => {
  const display = buildDisplay({ atMs: 0, lang: 'zh', config: { showBalance: true }, quota: undefined })
  assert.deepEqual(display.parts.map(part => part.key), ['phase', 'countdown'])
})

test('a measured spend decorates the turn label and marks an inexact figure', () => {
  const settled = { tokens: 150, model: 'x', turn: 1, spend: { value: 0.25, unit: { kind: 'credits' } }, spendExact: true }
  const display = buildDisplay({ atMs: 0, lang: 'zh', config: { showTurnCost: true }, lastTurn: settled })
  const turn = display.parts.find(part => part.key === 'turn')
  assert.equal(turn.text, '本轮 0.2500 credits')

  const inexact = buildDisplay({
    atMs: 0,
    lang: 'zh',
    config: { showTurnCost: true },
    lastTurn: { ...settled, spendExact: false },
  }).parts.find(part => part.key === 'turn')
  assert.equal(inexact.text, '本轮 ≈0.2500 credits')
})

test('a provider with a spend counter says “live” without calling the model unrated', () => {
  const display = buildDisplay({
    atMs: 0,
    lang: 'zh',
    config: { showTurnCost: true },
    live: { tokens: 150, cost: undefined, measured: true },
  })
  const turn = display.parts.find(part => part.key === 'turn')
  assert.equal(turn.text, '本轮·计费中')
  assert.equal(turn.tone, 'muted')

  const unrated = buildDisplay({
    atMs: 0,
    lang: 'zh',
    config: { showTurnCost: true },
    live: { tokens: 150, cost: undefined },
  }).parts.find(part => part.key === 'turn')
  assert.equal(unrated.text, '本轮·计费中 费率未知')
})
