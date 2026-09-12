import { test } from 'node:test'
import assert from 'node:assert/strict'

import { BEIJING_OFFSET_MS } from '../lib/peak.js'
import { addToBucket, createTracker, normalizeUsage } from '../lib/tracker.js'

/** Beijing wall clock -> UTC instant (2026-09-10 is a Thursday). */
function beijing(year, month, day, hour, minute = 0) {
  return Date.UTC(year, month - 1, day, hour, minute) - BEIJING_OFFSET_MS
}

test('normalizeUsage accepts camelCase, snake_case and bare names', () => {
  assert.deepEqual(
    normalizeUsage({ inputTokens: 10, outputTokens: 2, cacheReadTokens: 4, cacheWriteTokens: 1 }),
    { input: 10, output: 2, cacheRead: 4, cacheWrite: 1 },
  )
  assert.deepEqual(
    normalizeUsage({ input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 4 }),
    { input: 10, output: 2, cacheRead: 4, cacheWrite: 0 },
  )
  assert.equal(normalizeUsage({}), undefined)
  assert.equal(normalizeUsage(undefined), undefined)
  assert.equal(normalizeUsage({ inputTokens: 'ten' }), undefined)
  assert.equal(normalizeUsage({ inputTokens: -5 }), undefined)
})

test('a turn is bucketed by the timestamp of its own reports', () => {
  const tracker = createTracker()
  tracker.setModel('deepseek-flash')
  // Morning peak report, then an off-peak report in the same turn.
  tracker.onUsage({ inputTokens: 1_000_000 }, beijing(2026, 9, 10, 10, 0))
  tracker.onUsage({ inputTokens: 1_000_000 }, beijing(2026, 9, 10, 13, 0))
  const snapshot = tracker.snapshot()
  assert.equal(snapshot.turn.peak.input, 1_000_000)
  assert.equal(snapshot.turn.idle.input, 1_000_000)
})

test('endTurn settles the cost and resets the running turn', () => {
  const tracker = createTracker()
  tracker.setModel('deepseek-flash')
  tracker.onUsage({ inputTokens: 1_000_000, outputTokens: 0 }, beijing(2026, 9, 10, 10, 0))
  const settled = tracker.endTurn(beijing(2026, 9, 10, 10, 5))
  assert.equal(settled.cost.total, 2) // 1M miss tokens at the peak rate
  assert.equal(settled.tokens, 1_000_000)
  assert.equal(tracker.turnTokens(), 0)
  assert.equal(tracker.lastTurn().cost.total, 2)
})

test('a turn with no token report is not recorded', () => {
  const tracker = createTracker()
  assert.equal(tracker.endTurn(), undefined)
  assert.equal(tracker.lastTurn(), undefined)
})

test('a later empty turn clears the figure instead of leaving the old one', () => {
  const tracker = createTracker()
  tracker.setModel('deepseek-flash')
  tracker.onUsage({ inputTokens: 1_000_000 }, beijing(2026, 9, 10, 13, 0))
  assert.equal(tracker.endTurn(beijing(2026, 9, 10, 13, 1)).cost.total, 1)

  // The next round was interrupted before it produced anything. Leaving the
  // settled figure in place put the PREVIOUS round's cost on a line labelled
  // "this turn"; about 2.5% of real turns end with no report at all.
  assert.equal(tracker.endTurn(beijing(2026, 9, 10, 13, 2)), undefined)
  assert.equal(tracker.lastTurn(), undefined)
})

test('a new turn drops whatever an abandoned turn left in the bucket', () => {
  const tracker = createTracker()
  tracker.setModel('deepseek-flash')
  // A round that never emitted `turn/end` (aborted): its tokens must not be
  // settled into the next round.
  tracker.onUsage({ inputTokens: 1_000_000 }, beijing(2026, 9, 10, 13, 0))
  tracker.beginTurn()
  assert.equal(tracker.turnTokens(), 0)
  assert.equal(tracker.endTurn(beijing(2026, 9, 10, 13, 5)), undefined)
})

test('the running turn is priced with its own model, not a later header', () => {
  const tracker = createTracker()
  tracker.setModel('deepseek-flash')
  tracker.onUsage({ inputTokens: 1_000_000 }, beijing(2026, 9, 10, 13, 0))
  // A `/model` switch mid-turn rewrites the header; the turn still ran on flash.
  tracker.setModel('mystery-model')
  const settled = tracker.endTurn(beijing(2026, 9, 10, 13, 1))
  assert.equal(settled.model, 'deepseek-flash')
  assert.equal(settled.cost.total, 1)
})

test('the running-turn token count includes cache reads', () => {
  const tracker = createTracker()
  tracker.onUsage(
    { inputTokens: 1_000, outputTokens: 2_000, cacheReadTokens: 30_000_000 },
    beijing(2026, 9, 10, 13, 0),
  )
  assert.equal(tracker.turnTokens(), 30_003_000)
})

test('reset clears the running turn model and instant too', () => {
  const tracker = createTracker()
  tracker.setModel('deepseek-flash')
  tracker.onUsage({ inputTokens: 10 }, beijing(2026, 9, 10, 13, 0))
  tracker.reset()
  assert.equal(tracker.snapshot().turnModel, '')
  assert.equal(tracker.snapshot().turnAt, undefined)
})

test('an unrated model keeps token counts but drops the money figure', () => {
  const tracker = createTracker()
  tracker.setModel('some-other-model')
  tracker.onUsage({ inputTokens: 500 }, beijing(2026, 9, 10, 10, 0))
  const settled = tracker.endTurn(beijing(2026, 9, 10, 10, 1))
  assert.equal(settled.cost, undefined)
  assert.equal(settled.tokens, 500)
})

test('session totals accumulate across turns', () => {
  const tracker = createTracker()
  tracker.setModel('deepseek-flash')
  tracker.onUsage({ inputTokens: 1_000_000 }, beijing(2026, 9, 10, 10, 0))
  tracker.endTurn(beijing(2026, 9, 10, 10, 1))
  tracker.onUsage({ inputTokens: 1_000_000 }, beijing(2026, 9, 10, 13, 0))
  tracker.endTurn(beijing(2026, 9, 10, 13, 1))
  // 2 元 peak + 1 元 idle.
  assert.equal(tracker.sessionCost(beijing(2026, 9, 10, 13, 2)).total, 3)
})

test('reset clears everything', () => {
  const tracker = createTracker()
  tracker.setModel('deepseek-flash')
  tracker.onUsage({ inputTokens: 10 }, beijing(2026, 9, 10, 10, 0))
  tracker.reset()
  assert.equal(tracker.model, '')
  assert.equal(tracker.turnTokens(), 0)
  assert.equal(tracker.lastTurn(), undefined)
})

test('addToBucket sums counts in place', () => {
  const bucket = { input: 1, output: 0, cacheRead: 0, cacheWrite: 0 }
  addToBucket(bucket, { input: 2, output: 3, cacheRead: 4, cacheWrite: 5 })
  assert.deepEqual(bucket, { input: 3, output: 3, cacheRead: 4, cacheWrite: 5 })
})

test('the settled turn honours custom rates', () => {
  const tracker = createTracker()
  tracker.setModel('mystery-model')
  // An unrated model reports no cost at all…
  tracker.onUsage({ inputTokens: 1_000_000 }, beijing(2026, 9, 10, 13, 0))
  assert.equal(tracker.endTurn(beijing(2026, 9, 10, 13, 0)).cost, undefined)

  // …until the user supplies the rate for it (off-peak 2 元 per 1M miss).
  const customRates = {
    'mystery-model': {
      idle: { inputHit: 1, inputMiss: 2, output: 3 },
      peak: { inputHit: 4, inputMiss: 8, output: 16 },
    },
  }
  tracker.onUsage({ inputTokens: 1_000_000 }, beijing(2026, 9, 10, 13, 0))
  assert.equal(tracker.endTurn(beijing(2026, 9, 10, 13, 0), customRates).cost.total, 2)
  // The first turn's tokens still count in the session total: 2M at 2 元/M.
  assert.equal(tracker.sessionCost(beijing(2026, 9, 10, 13, 0), customRates).total, 4)
})
