import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  failSnapshot,
  normalizeMeter,
  okSnapshot,
  orderedMeters,
  pickMeter,
  primaryMeter,
  spendDelta,
} from '../lib/quota.js'

const METERS = [
  { id: 'balance', kind: 'money', currency: 'USD', remaining: 12.5 },
  { id: 'window5h', kind: 'credits', used: 3, cap: 14, resetAt: 1000 },
  { id: 'windowWeekly', kind: 'credits', used: 3, cap: 35 },
]

test('a meter without any number is dropped', () => {
  assert.equal(normalizeMeter({ id: 'balance', kind: 'money' }), undefined)
  assert.equal(normalizeMeter({ kind: 'money', remaining: 1 }), undefined)
  assert.equal(normalizeMeter(undefined), undefined)
})

test('a snapshot keeps usable meters only and normalizes the counter unit', () => {
  const snapshot = okSnapshot({
    provider: 'commandcode',
    adapter: 'commandcode-plan',
    meters: [...METERS, { id: 'empty', kind: 'money' }, null],
    spendCounter: { id: 'usage.totalCredits', value: 1.5, unit: { kind: 'credits' } },
  })
  assert.equal(snapshot.ok, true)
  assert.equal(snapshot.meters.length, 3)
  assert.deepEqual(snapshot.spendCounter, { id: 'usage.totalCredits', value: 1.5, unit: { kind: 'credits' } })
})

test('a failed snapshot carries a normalized reason and never a meter list', () => {
  const snapshot = failSnapshot('nonsense', { provider: 'x', adapter: 'y', status: 500 })
  assert.equal(snapshot.reason, 'invalid')
  assert.equal(snapshot.status, 500)
  assert.deepEqual(snapshot.meters, undefined)
})

test('meters rotate in the stable id order, unknown ids last', () => {
  const ids = orderedMeters({ meters: [...METERS, { id: 'lifetimeSpend', used: 1 }, { id: 'custom', remaining: 1 }] })
    .map(meter => meter.id)
  assert.deepEqual(ids, ['window5h', 'windowWeekly', 'balance', 'lifetimeSpend', 'custom'])
})

test('the primary meter prefers an exceeded window, then a window, then a balance', () => {
  assert.equal(primaryMeter({ meters: METERS }).id, 'window5h')
  assert.equal(primaryMeter({ meters: [{ id: 'balance', remaining: 1 }, { id: 'windowWeekly', used: 1, cap: 2 }] }).id, 'windowWeekly')
  assert.equal(primaryMeter({ meters: [{ id: 'custom', used: 1 }] }).id, 'custom')
  const exceeded = [{ id: 'balance', remaining: 1 }, { id: 'windowWeekly', used: 35, cap: 35, exceeded: true }]
  assert.equal(primaryMeter({ meters: exceeded }).id, 'windowWeekly')
})

test('an explicit metric wins, an absent one falls back to the primary meter', () => {
  const snapshot = { meters: METERS }
  assert.equal(pickMeter(snapshot, 'balance').meter.id, 'balance')
  assert.equal(pickMeter(snapshot, 'windowMonthly').meter.id, 'window5h')
  assert.equal(pickMeter(snapshot, 'auto').meter.id, 'window5h')
})

test('rotation walks every meter and wraps', () => {
  const snapshot = { meters: METERS }
  const seen = [0, 1, 2, 3].map(tick => pickMeter(snapshot, 'rotate', tick).meter.id)
  assert.deepEqual(seen, ['window5h', 'windowWeekly', 'balance', 'window5h'])
  assert.equal(pickMeter(snapshot, 'rotate', 0).rotating, true)
})

test('an empty snapshot has nothing to pick', () => {
  assert.equal(pickMeter({ meters: [] }, 'auto').meter, undefined)
  assert.equal(primaryMeter({ ok: false, reason: 'network' }), undefined)
})

test('a spend delta ignores a missing reading and refuses to report a rollover as a refund', () => {
  assert.equal(spendDelta(1, 2.5), 1.5)
  assert.equal(spendDelta(2.5, 2.5), 0)
  assert.equal(spendDelta(10, 1), undefined)
  assert.equal(spendDelta(undefined, 1), undefined)
  assert.equal(spendDelta(1, undefined), undefined)
})
