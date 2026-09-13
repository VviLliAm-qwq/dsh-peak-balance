import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  failSnapshot,
  meterById,
  meterRatio,
  meterRemaining,
  normalizeMeter,
  okSnapshot,
  orderedMeters,
  pickMeter,
  primaryMeter,
  spendCounterOf,
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
  assert.equal(spendCounterOf(snapshot), 1.5)
})

test('a failed snapshot carries a normalized reason and never a meter list', () => {
  const snapshot = failSnapshot('nonsense', { provider: 'x', adapter: 'y', status: 500 })
  assert.equal(snapshot.reason, 'invalid')
  assert.equal(snapshot.status, 500)
  assert.deepEqual(snapshot.meters, undefined)
  assert.equal(spendCounterOf(snapshot), undefined)
})

test('meters rotate in the stable id order, unknown ids last', () => {
  const ids = orderedMeters({ meters: [...METERS, { id: 'custom', remaining: 1 }] }).map(meter => meter.id)
  assert.deepEqual(ids, ['window5h', 'windowWeekly', 'balance', 'custom'])
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

test('a meter ratio needs a cap and accepts a remaining-only reading', () => {
  assert.equal(meterRatio(meterById({ meters: METERS }, 'window5h')), 3 / 14)
  assert.equal(meterRatio({ id: 'window5h', cap: 10, remaining: 4 }), 0.6)
  assert.equal(meterRatio({ id: 'balance', remaining: 4 }), undefined)
  assert.equal(meterRatio(undefined), undefined)
})

test('a remaining amount is derived from cap and used when only those exist', () => {
  assert.equal(meterRemaining({ id: 'window5h', used: 3, cap: 10 }), 7)
  assert.equal(meterRemaining({ id: 'balance', remaining: 4 }), 4)
  assert.equal(meterRemaining({ id: 'periodSpend', used: 4 }), undefined)
})

test('a spend delta ignores a missing reading and refuses to report a rollover as a refund', () => {
  assert.equal(spendDelta(1, 2.5), 1.5)
  assert.equal(spendDelta(2.5, 2.5), 0)
  assert.equal(spendDelta(10, 1), undefined)
  assert.equal(spendDelta(undefined, 1), undefined)
  assert.equal(spendDelta(1, undefined), undefined)
})
