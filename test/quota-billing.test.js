import { test } from 'node:test'
import assert from 'node:assert/strict'

import { BILLING as CC_BILLING, parseCommandCode } from '../lib/providers/commandcode.js'
import { BILLING as DEEPSEEK_BILLING } from '../lib/providers/deepseek.js'
import { BILLING as BILLING_ADAPTER_BILLING } from '../lib/providers/openai-billing.js'
import { parseSpecs } from '../lib/providers/spec.js'
import {
  billingOf,
  inferBilling,
  normalizeBilling,
  okSnapshot,
  percentRemaining,
  percentUsed,
} from '../lib/quota.js'
import {
  choosePartTexts,
  cellWidth,
} from '../lib/view.js'
import {
  formatPercentValue,
  meterPercentText,
  quotaPart,
  buildDisplay,
} from '../lib/display.js'

/* ------------------------------------------------------------- billing */

test('each adapter declares how its provider charges', () => {
  assert.equal(CC_BILLING, 'plan')
  assert.equal(DEEPSEEK_BILLING, 'money')
  // A relay may bill either way, so its own figures decide.
  assert.equal(BILLING_ADAPTER_BILLING, 'auto')
})

test('a spec stanza may declare its billing, defaulting to auto', () => {
  const spec = parseSpecs(JSON.stringify({
    providers: {
      planish: { billing: 'plan', requests: [{ path: '/q', meters: [{ id: 'balance', value: 'total' }] }] },
      moneyish: { requests: [{ path: '/q', meters: [{ id: 'balance', value: 'total' }] }] },
      weird: { billing: 'nonsense', requests: [{ path: '/q', meters: [{ id: 'balance', value: 'total' }] }] },
    },
  }))
  assert.equal(spec.providers.planish.billing, 'plan')
  assert.equal(spec.providers.moneyish.billing, 'auto')
  assert.equal(spec.providers.weird.billing, 'auto')
})

test('normalizeBilling keeps only the two real modes', () => {
  assert.equal(normalizeBilling('money'), 'money')
  assert.equal(normalizeBilling('plan'), 'plan')
  assert.equal(normalizeBilling('auto'), 'auto')
  assert.equal(normalizeBilling('credits'), 'auto')
  assert.equal(normalizeBilling(undefined), 'auto')
})

test('an undeclared provider is inferred from its own figures', () => {
  // Capped windows and no currency balance = a subscription.
  assert.equal(inferBilling({ meters: [{ id: 'window5h', kind: 'credits', used: 1, cap: 14 }] }), 'plan')
  // A currency balance = pay-as-you-go, even when a cap rides along.
  assert.equal(inferBilling({ meters: [{ id: 'balance', kind: 'money', currency: 'USD', remaining: 3 }] }), 'money')
  assert.equal(inferBilling({ meters: [{ id: 'window5h', kind: 'credits', used: 1, cap: 14 }, { id: 'balance', kind: 'money', currency: 'CNY', remaining: 9 }] }), 'money')
  // An unknown shape renders absolute figures rather than inventing a denominator.
  assert.equal(inferBilling({ meters: [{ id: 'custom', kind: 'count', used: 3 }] }), 'money')
  assert.equal(inferBilling(undefined), 'money')
})

test('the user override wins over the declaration, which wins over the data', () => {
  const declared = okSnapshot({ meters: [{ id: 'balance', kind: 'money', currency: 'CNY', remaining: 1 }], billing: 'plan' })
  assert.equal(billingOf(declared, 'auto'), 'plan')
  assert.equal(billingOf(declared, 'money'), 'money')
  const undeclared = okSnapshot({ meters: [{ id: 'window5h', kind: 'credits', used: 1, cap: 4 }] })
  assert.equal(undeclared.billing, 'auto')
  assert.equal(billingOf(undeclared, 'auto'), 'plan')
})

test('the parser passes the plan declaration into the snapshot', () => {
  const parsed = parseCommandCode({
    credits: { credits: { monthlyCredits: 70 }, windowLimits: { fiveHour: { used: 1, cap: 14 } } },
  })
  assert.equal(parsed.meters.length, 2)
  const snapshot = okSnapshot({ ...parsed, billing: CC_BILLING })
  assert.equal(snapshot.billing, 'plan')
})

/* ------------------------------------------------------------ percent */

test('percentages clamp and refuse a missing denominator', () => {
  assert.equal(percentUsed(1, 4), 0.25)
  assert.equal(percentUsed(8, 4), 1)
  assert.equal(percentUsed(-1, 4), 0)
  assert.equal(percentUsed(1, 0), undefined)
  assert.equal(percentUsed(1, undefined), undefined)
  assert.equal(percentRemaining(3, 4), 0.75)
  assert.equal(percentRemaining(9, 4), 1)
  assert.equal(percentRemaining(1, 0), undefined)
})

test('the printed percentage keeps small shares legible', () => {
  assert.equal(formatPercentValue(0.896), '89.6%')
  assert.equal(formatPercentValue(0.0179), '1.79%')
  assert.equal(formatPercentValue(0.0036), '0.36%')
  assert.equal(formatPercentValue(0.00005), '<0.01%')
  assert.equal(formatPercentValue(0), '0%')
  assert.equal(formatPercentValue(undefined), undefined)
})

test('a plan meter reads as a remaining share, with the absolute pair in the full form', () => {
  const meter = { id: 'window5h', kind: 'credits', used: 1, cap: 14 }
  assert.equal(meterPercentText('zh', meter, false), '5h 剩 92.9%(1.00/14.00)')
  assert.equal(meterPercentText('zh', meter, true), '5h 剩 92.9%')
  assert.equal(meterPercentText('en', meter, true), '5h 92.9% left')
  // Nothing to divide by: the caller falls back to absolute figures.
  assert.equal(meterPercentText('zh', { id: 'planRemaining', kind: 'credits', remaining: 69.9 }), undefined)
})

/* -------------------------------------------------------- the parts */

test('a plan quota part carries a compact form, a money one does not', () => {
  const plan = quotaPart('zh', {
    state: 'meter',
    mode: 'plan',
    planName: 'GOAT',
    meter: { id: 'window5h', kind: 'credits', used: 1, cap: 14, resetAt: 3_600_000 },
  }, 0)
  assert.equal(plan.text, '套餐 GOAT · 5h 剩 92.9%(1.00/14.00) · 距重置 1h00m')
  assert.equal(plan.compact, '套餐 GOAT · 5h 剩 92.9% · 距重置 1h00m')

  const money = quotaPart('zh', {
    state: 'meter',
    mode: 'money',
    meter: { id: 'balance', kind: 'money', currency: 'CNY', remaining: 12.34 },
  }, 0)
  assert.equal(money.text, '余额 ¥12.34')
  assert.equal(money.compact, undefined)
})

test('a plan turn leads with its share and rides the raw amount in parentheses', () => {
  const display = buildDisplay({
    atMs: 0,
    lang: 'zh',
    config: { showTurnCost: true },
    lastTurn: { tokens: 150, spend: { value: 0.25, unit: { kind: 'credits' } }, spendExact: true, spendPercent: 0.25 / 14 },
  })
  const turn = display.parts.find(part => part.key === 'turn')
  assert.equal(turn.text, '本轮 1.79%(0.2500)')
  assert.equal(turn.compact, '本轮 1.79%')

  // Without a denominator the figure stays absolute.
  const absolute = buildDisplay({
    atMs: 0,
    lang: 'zh',
    config: { showTurnCost: true },
    lastTurn: { tokens: 150, spend: { value: 0.25, unit: { kind: 'credits' } }, spendExact: false },
  }).parts.find(part => part.key === 'turn')
  assert.equal(absolute.text, '本轮 ≈0.2500 credits')
  assert.equal(absolute.compact, undefined)
})

/* ------------------------------------------------------------- width */

test('cell width counts CJK and emoji as two columns', () => {
  assert.equal(cellWidth('abc'), 3)
  assert.equal(cellWidth('余额'), 4)
  assert.equal(cellWidth('🌊'), 2)
  assert.equal(cellWidth(''), 0)
  assert.equal(cellWidth(undefined), 0)
  assert.equal(cellWidth('5h 剩 92.9%'), 2 + 1 + 2 + 1 + 5)
})

test('a line that does not fit swaps in the compact forms from the right', () => {
  const model = {
    parts: [
      { key: 'phase', text: '谷时·半价', tone: 'idle' },
      { key: 'turn', text: '本轮 1.79%(0.2500)', compact: '本轮 1.79%', tone: 'value' },
      { key: 'quota', text: '套餐 GOAT · 5h 剩 92.9%(1.00/14.00)', compact: '套餐 GOAT · 5h 剩 92.9%', tone: 'value' },
    ],
  }
  // Roomy: everything in full.
  assert.deepEqual(choosePartTexts(model, 200), [
    '谷时·半价',
    '本轮 1.79%(0.2500)',
    '套餐 GOAT · 5h 剩 92.9%(1.00/14.00)',
  ])
  // Narrow: the tail gives up its absolute figures first.
  const narrow = choosePartTexts(model, 50)
  assert.equal(narrow[2], '套餐 GOAT · 5h 剩 92.9%')
  assert.equal(narrow[1], '本轮 1.79%')
  // Unknown width renders in full, exactly as before this feature.
  assert.deepEqual(choosePartTexts(model, undefined), [
    '谷时·半价',
    '本轮 1.79%(0.2500)',
    '套餐 GOAT · 5h 剩 92.9%(1.00/14.00)',
  ])
})
