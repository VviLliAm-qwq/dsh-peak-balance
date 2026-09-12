import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  BEIJING_OFFSET_MINUTES,
  addCounts,
  addDays,
  buildHistoryView,
  cacheHitRate,
  dayKeyOf,
  dayStartMs,
  describeDay,
  emptyCounts,
  foldSessionEvents,
  gridPositionOf,
  intensityThresholds,
  levelOf,
  metricValueOf,
  sameLocalDay,
  stepGrid,
  todayKeyOf,
  totalTokensOf,
  weekGridBounds,
  weekdayIndex,
} from '../lib/history.js'

/** 2026-09-07 12:00 Beijing — a Monday, off-peak (the 09:00-12:00 window ended). */
const MONDAY_NOON = Date.UTC(2026, 8, 7, 4, 0, 0)
/** 2026-09-07 10:00 Beijing — the same Monday, inside the peak window. */
const MONDAY_PEAK = Date.UTC(2026, 8, 7, 2, 0, 0)
/** 2026-09-05 12:00 Beijing — a Saturday (always off-peak). */
const SATURDAY_NOON = Date.UTC(2026, 8, 5, 4, 0, 0)

/** One `assistant/message` usage report. */
function usageEvent(seq, time, usage) {
  return { type: 'assistant/message', seq, time, data: { usage } }
}

/** One `request/header` naming a model. */
function headerEvent(seq, time, model) {
  return { type: 'request/header', seq, time, data: { header: { config: { model } } } }
}

test('day keys follow the fixed Beijing offset', () => {
  assert.equal(BEIJING_OFFSET_MINUTES, 480)
  // 15:59 UTC is 23:59 in Beijing; one minute later the day rolls over.
  assert.equal(dayKeyOf(Date.UTC(2026, 8, 4, 15, 59)), '2026-09-04')
  assert.equal(dayKeyOf(Date.UTC(2026, 8, 4, 16, 0)), '2026-09-05')
  assert.equal(dayKeyOf(Date.UTC(2026, 8, 4, 16, 0), 0), '2026-09-04')
  assert.equal(dayKeyOf(Number.NaN), '1970-01-01')
})

test('local midnight arithmetic is exact across month and DST-free boundaries', () => {
  assert.equal(dayKeyOf(dayStartMs(MONDAY_NOON)), '2026-09-07')
  assert.equal(dayKeyOf(addDays(dayStartMs(MONDAY_NOON), 1)), '2026-09-08')
  assert.equal(dayKeyOf(addDays(dayStartMs(MONDAY_NOON), -7)), '2026-08-31')
  assert.equal(sameLocalDay(MONDAY_PEAK, MONDAY_NOON), true)
  assert.equal(sameLocalDay(MONDAY_NOON, SATURDAY_NOON), false)
  assert.equal(dayStartMs(MONDAY_NOON) % 86_400_000, 16 * 60 * 60 * 1000)
})

test('weekday rows follow the configured week start', () => {
  assert.equal(weekdayIndex(MONDAY_NOON, 'mon'), 0)
  assert.equal(weekdayIndex(MONDAY_NOON, 'sun'), 1)
  assert.equal(weekdayIndex(SATURDAY_NOON, 'mon'), 5)
  assert.equal(weekdayIndex(SATURDAY_NOON, 'sun'), 6)
  assert.equal(weekdayIndex(Date.UTC(2026, 8, 13, 4, 0, 0), 'sun'), 0)
})

test('week grid bounds end on the week containing now', () => {
  const bounds = weekGridBounds(MONDAY_NOON, 26, 'mon')
  assert.equal(bounds.weeks, 26)
  assert.equal(bounds.todayIndex, 0)
  assert.equal(dayKeyOf(bounds.lastWeekStartMs), '2026-09-07')
  assert.equal(dayKeyOf(bounds.firstWeekStartMs), '2026-03-16')
  assert.equal((bounds.lastWeekStartMs - bounds.firstWeekStartMs) / 86_400_000, 25 * 7)

  // A Sunday-start grid opens its week one day earlier.
  const sunday = weekGridBounds(SATURDAY_NOON, 13, 'sun')
  assert.equal(dayKeyOf(sunday.lastWeekStartMs), '2026-08-30')
  assert.equal(sunday.todayIndex, 6)

  // Nonsense spans must not produce an empty grid.
  assert.equal(weekGridBounds(MONDAY_NOON, 0, 'mon').weeks, 1)
  assert.equal(weekGridBounds(MONDAY_NOON, Number.NaN, 'mon').weeks, 26)
})

test('token buckets add up and cache-hit rate uses the disjoint denominator', () => {
  const counts = emptyCounts()
  addCounts(counts, { input: 10, output: 5, cacheRead: 90, cacheWrite: 0, events: 2 })
  addCounts(counts, { input: 1, output: 1, cacheRead: 9, cacheWrite: 5, events: 1 })
  assert.deepEqual(counts, { input: 11, output: 6, cacheRead: 99, cacheWrite: 5, events: 3 })
  assert.equal(totalTokensOf(counts), 121)
  assert.equal(cacheHitRate(counts), 99 / 115)
  assert.equal(cacheHitRate(emptyCounts()), undefined)
  assert.equal(cacheHitRate({ input: 0, cacheRead: 0, cacheWrite: 7 }), 0)
  assert.equal(totalTokensOf(undefined), 0)
  assert.equal(cacheHitRate(undefined), undefined)
})

test('intensity thresholds use the non-zero quartiles', () => {
  const thresholds = intensityThresholds([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
  assert.equal(thresholds.length, 4)
  assert.deepEqual(thresholds, [3, 5, 8, 10])
  assert.deepEqual(intensityThresholds([0, 0]), [0, 0, 0, 0])
  assert.deepEqual(intensityThresholds(undefined), [0, 0, 0, 0])
  assert.equal(levelOf(0, thresholds), 0)
  assert.equal(levelOf(1, thresholds), 1)
  assert.equal(levelOf(3, thresholds), 1)
  assert.equal(levelOf(4, thresholds), 2)
  assert.equal(levelOf(7, thresholds), 3)
  assert.equal(levelOf(10, thresholds), 4)
  assert.equal(levelOf(999, thresholds), 4)
  assert.equal(levelOf(Number.NaN, thresholds), 0)
})

test('foldSessionEvents buckets usage by day, model and price tier', () => {
  const record = foldSessionEvents([
    { type: 'session', id: 's1', createdAt: MONDAY_NOON, delegationDepth: 0 },
    headerEvent(0, MONDAY_NOON, 'deepseek-flash'),
    usageEvent(1, MONDAY_PEAK, { inputTokens: 100, outputTokens: 10, cacheReadTokens: 0 }),
    usageEvent(2, MONDAY_NOON, { inputTokens: 40, outputTokens: 4, cacheReadTokens: 60 }),
    { type: 'assistant/message', seq: 3, time: MONDAY_NOON, data: { usage: null } },
  ])
  assert.equal(record.id, 's1')
  assert.equal(record.subagent, false)
  assert.equal(record.seeded, false)
  assert.equal(record.events, 2)
  assert.equal(record.skipped, 0)
  const days = record.models['deepseek-flash'].days
  assert.deepEqual(Object.keys(days), ['2026-09-07'])
  assert.deepEqual(days['2026-09-07'].peak, { input: 100, output: 10, cacheRead: 0, cacheWrite: 0, events: 1 })
  assert.deepEqual(days['2026-09-07'].idle, { input: 40, output: 4, cacheRead: 60, cacheWrite: 0, events: 1 })
})

test('usage without a request header lands on the unknown model', () => {
  const record = foldSessionEvents([
    { type: 'session', id: 's1', createdAt: MONDAY_NOON },
    usageEvent(0, MONDAY_NOON, { inputTokens: 5 }),
  ])
  assert.ok(record.models['(unknown)'])
  assert.equal(record.events, 1)
})

test('a fork-seeded log drops its inherited prefix (seedLength cut)', () => {
  const events = [
    { type: 'session', id: 'child', createdAt: MONDAY_NOON, parentSession: 'parent', seedLength: 2 },
    headerEvent(0, MONDAY_NOON, 'deepseek-flash'),
    usageEvent(1, MONDAY_NOON, { inputTokens: 1_000 }),
    { type: 'session/end-seed', seq: 2, time: MONDAY_NOON, data: {} },
    usageEvent(3, MONDAY_NOON, { inputTokens: 7 }),
  ]
  const record = foldSessionEvents(events)
  assert.equal(record.seeded, true)
  assert.equal(record.skipped, 1)
  assert.equal(record.events, 1)
  const day = record.models['deepseek-flash'].days['2026-09-07']
  assert.equal(day.idle.input, 7)
})

test('an isSeeded header without a length cuts at the end-seed marker', () => {
  const events = [
    { type: 'session', id: 'child', createdAt: MONDAY_NOON, isSeeded: true },
    usageEvent(0, MONDAY_NOON, { inputTokens: 1_000 }),
    { type: 'session/end-seed', seq: 1, time: MONDAY_NOON, data: {} },
    usageEvent(2, MONDAY_NOON, { inputTokens: 3 }),
  ]
  const record = foldSessionEvents(events)
  assert.equal(record.seeded, true)
  assert.equal(record.skipped, 1)
  assert.equal(record.events, 1)
  assert.equal(record.models['deepseek-flash'], undefined)
  assert.equal(record.models['(unknown)'].days['2026-09-07'].idle.input, 3)
})

test('subagent sessions are flagged from the header', () => {
  assert.equal(foldSessionEvents([{ type: 'session', id: 'a', origin: 'subagent' }]).subagent, true)
  assert.equal(foldSessionEvents([{ type: 'session', id: 'a', delegationDepth: 2 }]).subagent, true)
  assert.equal(foldSessionEvents([{ type: 'session', id: 'a', delegationDepth: 0 }]).subagent, false)
  assert.equal(foldSessionEvents([]).subagent, false)
  assert.equal(foldSessionEvents(undefined).id, '')
})

/** A session record with one usage report. */
function record(id, dayMs, usage, options = {}) {
  const at = options.peak === true ? MONDAY_PEAK : dayMs
  const header = { type: 'session', id, createdAt: dayMs }
  if (options.subagent === true) header.origin = 'subagent'
  const events = [header, headerEvent(0, dayMs, options.model ?? 'deepseek-flash'), usageEvent(1, at, usage)]
  return foldSessionEvents(events)
}

test('buildHistoryView shapes the grid, totals and model table', () => {
  const records = [
    record('a', MONDAY_NOON, { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0 }),
    record('b', MONDAY_NOON, { inputTokens: 0, outputTokens: 500_000, cacheReadTokens: 500_000 }, { peak: false }),
  ]
  const view = buildHistoryView(records, { now: MONDAY_NOON, spanWeeks: 13, weekStart: 'mon' })
  assert.equal(view.spanWeeks, 13)
  assert.equal(view.weeks.length, 13)
  assert.ok(view.weeks.every(week => week.days.length === 7))
  assert.equal(view.totals.sessions, 2)
  assert.equal(view.totals.events, 2)
  assert.equal(view.totals.activeDays, 1)
  assert.equal(view.totals.tokens, 2_000_000)
  assert.equal(view.totals.firstActive, '2026-09-07')
  assert.equal(view.totals.lastActive, '2026-09-07')
  assert.equal(view.totals.bestDay.key, '2026-09-07')
  assert.equal(view.totals.bestDay.value, 2_000_000)
  assert.equal(view.totals.cacheHitRate, 500_000 / 1_500_000)
  assert.equal(view.legend.max, 2_000_000)

  // 1M cache-miss input at 1 元/M, 500k cache-read at 0.02 元/M and 500k
  // output at 4 元/M.
  assert.equal(Number(view.totals.cost.toFixed(6)), 3.01)
  assert.equal(view.totals.costIncomplete, false)
  assert.equal(view.models.length, 1)
  const [model] = view.models
  assert.equal(model.model, 'deepseek-flash')
  assert.equal(model.source, 'builtin')
  assert.equal(model.tokens, 2_000_000)
  assert.equal(model.activeDays, 1)
  assert.equal(model.cacheHitRate, 500_000 / 1_500_000)

  const cell = view.weeks.flatMap(week => week.days).find(day => day.key === '2026-09-07')
  assert.equal(cell.active, true)
  assert.equal(cell.value, 2_000_000)
  assert.equal(cell.future, false)
  const tomorrow = view.weeks.flatMap(week => week.days).find(day => day.key === '2026-09-08')
  assert.equal(tomorrow.future, true)
  assert.equal(tomorrow.value, 0)
  assert.equal(tomorrow.level, 0)
})

test('the metric selects what a cell measures', () => {
  const records = [record('a', MONDAY_NOON, { inputTokens: 1_000, outputTokens: 20, cacheReadTokens: 100 })]
  const at = key => day => day.key === key
  const valueOf = metric => {
    const view = buildHistoryView(records, { now: MONDAY_NOON, spanWeeks: 13, metric })
    return view.weeks.flatMap(week => week.days).find(at('2026-09-07')).value
  }
  assert.equal(valueOf('tokens'), 1_120)
  assert.equal(valueOf('output'), 20)
  assert.equal(valueOf('cacheMiss'), 1_000)
  assert.ok(valueOf('cost') > 0)
  // metricValueOf keeps the same contract for a raw day aggregate.
  const day = { counts: { input: 1, output: 2, cacheRead: 3, cacheWrite: 0, events: 1 }, cost: 9 }
  assert.equal(metricValueOf(day, 'tokens'), 6)
  assert.equal(metricValueOf(day, 'cost'), 9)
  assert.equal(metricValueOf(day, 'output'), 2)
  assert.equal(metricValueOf(day, 'cacheMiss'), 1)
  assert.equal(metricValueOf(undefined, 'tokens'), 0)
})

test('subagent sessions can be excluded from every aggregate', () => {
  const records = [
    record('main', MONDAY_NOON, { inputTokens: 100 }),
    record('child', MONDAY_NOON, { inputTokens: 900 }, { subagent: true }),
  ]
  const withSubs = buildHistoryView(records, { now: MONDAY_NOON, spanWeeks: 13, includeSubagents: true })
  assert.equal(withSubs.totals.tokens, 1_000)
  assert.equal(withSubs.totals.sessions, 2)
  assert.equal(withSubs.totals.subagentSessions, 1)
  assert.equal(withSubs.totals.subagentEvents, 1)
  assert.equal(Number(withSubs.totals.cost.toFixed(6)), 0.001)

  const without = buildHistoryView(records, { now: MONDAY_NOON, spanWeeks: 13, includeSubagents: false })
  assert.equal(without.totals.tokens, 100)
  assert.equal(without.totals.sessions, 1)
  assert.equal(without.totals.subagentSessions, 0)
})

test('custom rates win over the card, and unrated models never invent a price', () => {
  const records = [
    record('a', MONDAY_NOON, { inputTokens: 1_000_000 }, { model: 'deepseek-flash' }),
    record('b', MONDAY_NOON, { inputTokens: 2_000_000 }, { model: 'mystery-model' }),
  ]
  const customRates = {
    'deepseek-flash': {
      idle: { inputHit: 1, inputMiss: 1, output: 1 },
      peak: { inputHit: 2, inputMiss: 2, output: 2 },
    },
  }
  const view = buildHistoryView(records, { now: MONDAY_NOON, spanWeeks: 13, customRates })
  const flash = view.models.find(entry => entry.model === 'deepseek-flash')
  const mystery = view.models.find(entry => entry.model === 'mystery-model')
  assert.equal(flash.source, 'custom')
  // 1M off-peak input at the custom 1 元/M (not the card's 1 元/M peak-split).
  assert.equal(Number(flash.cost.toFixed(6)), 1)
  assert.equal(mystery.source, 'unknown')
  assert.equal(mystery.cost, 0)
  assert.equal(mystery.costIncomplete, true)
  assert.equal(mystery.tokens, 2_000_000)
  assert.equal(view.totals.costIncomplete, true)
  assert.equal(Number(view.totals.cost.toFixed(6)), 1)
})

test('a custom second tier is honored', () => {
  const records = [record('a', MONDAY_NOON, { inputTokens: 1_000_000 }, { peak: true })]
  const customRates = {
    'deepseek-flash': {
      idle: { inputHit: 1, inputMiss: 1, output: 1 },
      peak: { inputHit: 10, inputMiss: 10, output: 10 },
    },
  }
  const view = buildHistoryView(records, { now: MONDAY_PEAK, spanWeeks: 13, customRates })
  assert.equal(Number(view.totals.cost.toFixed(6)), 10)
})

test('describeDay reports the hover card fields', () => {
  const records = [
    record('a', MONDAY_NOON, { inputTokens: 10, outputTokens: 2, cacheReadTokens: 30 }),
    record('child', MONDAY_NOON, { inputTokens: 8 }, { subagent: true }),
  ]
  const view = buildHistoryView(records, { now: MONDAY_NOON, spanWeeks: 13, includeSubagents: true })
  const detail = describeDay(view.days.get('2026-09-07'))
  assert.equal(detail.key, '2026-09-07')
  assert.equal(detail.tokens, 50)
  assert.equal(detail.events, 2)
  assert.equal(detail.sessions, 2)
  assert.equal(detail.subagentEvents, 1)
  assert.equal(detail.subagentShare, 0.5)
  // Both sessions report input, so the child's 8 miss tokens join the denominator.
  assert.equal(detail.cacheHitRate, 30 / 48)
  assert.equal(Number(detail.cost.toFixed(9)), 0.0000266)
  assert.deepEqual(detail.models.map(entry => entry.model).sort(), ['deepseek-flash'])
  assert.equal(describeDay(undefined), undefined)
  assert.equal(describeDay({ key: 'x', counts: emptyCounts(), cost: 0, models: new Map(), sessions: new Set() }), undefined)
})

test('an empty corpus still produces a renderable grid', () => {
  const view = buildHistoryView([], { now: MONDAY_NOON, spanWeeks: 26, weekStart: 'sun' })
  assert.equal(view.totals.tokens, 0)
  assert.equal(view.totals.sessions, 0)
  assert.equal(view.totals.activeDays, 0)
  assert.equal(view.totals.firstActive, undefined)
  assert.equal(view.totals.bestDay, undefined)
  assert.equal(view.totals.costIncomplete, false)
  assert.equal(view.models.length, 0)
  assert.equal(view.weeks.length, 26)
  assert.equal(view.legend.max, 0)
  assert.equal(view.thresholds.every(value => value === 0), true)
  assert.equal(view.weeks.flatMap(week => week.days).every(day => day.level === 0), true)
})

test('malformed records are skipped instead of throwing', () => {
  const view = buildHistoryView([null, 'nope', { id: 'x' }, record('a', MONDAY_NOON, { inputTokens: 5 })], {
    now: MONDAY_NOON,
    spanWeeks: 13,
  })
  assert.equal(view.totals.tokens, 5)
  // `null` and the bare string are dropped; `{ id: 'x' }` counts as a session
  // with no usage, like a stored log whose turns never reported tokens.
  assert.equal(view.totals.sessions, 2)
})

test('month labels mark where a month starts inside the grid', () => {
  const view = buildHistoryView([], { now: MONDAY_NOON, spanWeeks: 26, weekStart: 'mon' })
  const labels = view.weeks.map(week => week.monthLabel).filter(label => label !== undefined)
  assert.ok(labels.length >= 6, `expected month labels, saw ${labels.length}`)
  // Column 0 is labelled with its own first day (the span starts mid-month);
  // every later label marks a real first-of-month inside that column.
  for (const label of labels.slice(1)) assert.match(label, /^\d{4}-\d{2}-01$/)
  assert.equal(labels[0], view.weeks[0].days[0].key)
})

test('gridPositionOf maps a day to its square', () => {
  const view = buildHistoryView([], { now: MONDAY_NOON, spanWeeks: 13, weekStart: 'mon' })
  const today = gridPositionOf(view, '2026-09-07')
  assert.equal(today.column, 12)
  assert.equal(today.row, 0)
  assert.equal(today.day.future, false)
  const nextDay = gridPositionOf(view, '2026-09-08')
  assert.equal(nextDay.column, 12)
  assert.equal(nextDay.row, 1)
  assert.equal(nextDay.day.future, true)
  assert.equal(gridPositionOf(view, '2020-01-01'), undefined)
  assert.equal(gridPositionOf(undefined, '2026-09-07'), undefined)

  // A Sunday-start grid puts the same day on a different row.
  const sunday = buildHistoryView([], { now: MONDAY_NOON, spanWeeks: 13, weekStart: 'sun' })
  assert.equal(gridPositionOf(sunday, '2026-09-07').row, 1)
})

test('stepGrid moves one square and refuses impossible moves', () => {
  const view = buildHistoryView([], { now: MONDAY_NOON, spanWeeks: 13, weekStart: 'mon' })
  // ←/→ are the neighbouring COLUMNS (same weekday, ±7 days).
  assert.equal(stepGrid(view, '2026-09-07', 'left'), '2026-08-31')
  assert.equal(stepGrid(view, '2026-08-31', 'right'), '2026-09-07')
  // ↑/↓ are the neighbouring ROWS (±1 day) inside the column.
  assert.equal(stepGrid(view, '2026-08-31', 'down'), '2026-09-01')
  assert.equal(stepGrid(view, '2026-09-01', 'up'), '2026-08-31')
  // The top row cannot move up; a future square can never be entered.
  assert.equal(stepGrid(view, '2026-09-07', 'up'), '2026-09-07')
  assert.equal(stepGrid(view, '2026-09-07', 'down'), '2026-09-07')
  assert.equal(stepGrid(view, '2026-08-31', 'right'), '2026-09-07')
  // From row 1 of the second-to-last column, "right" would be a future day.
  assert.equal(stepGrid(view, '2026-09-01', 'right'), '2026-09-01')
  // The left edge of the span stops the walk.
  const firstDay = view.weeks[0].days[0].key
  assert.equal(stepGrid(view, firstDay, 'left'), firstDay)
  // Unknown keys and directions are no-ops.
  assert.equal(stepGrid(view, 'nope', 'left'), 'nope')
  assert.equal(stepGrid(view, '2026-09-07', 'sideways'), '2026-09-07')
})

test('todayKeyOf finds the current day inside the grid', () => {
  const view = buildHistoryView([], { now: MONDAY_NOON, spanWeeks: 13, weekStart: 'mon' })
  assert.equal(todayKeyOf(view), '2026-09-07')
  assert.equal(todayKeyOf(undefined), undefined)
})

test('the subagent filter reports what it excluded', () => {
  const records = [
    record('main', MONDAY_NOON, { inputTokens: 100, outputTokens: 10 }),
    record('child', MONDAY_NOON, { inputTokens: 900, outputTokens: 90 }, { subagent: true }),
  ]
  const on = buildHistoryView(records, { now: MONDAY_NOON, spanWeeks: 13, includeSubagents: true })
  assert.deepEqual(on.totals.excluded, { sessions: 0, events: 0, tokens: 0 })
  assert.equal(on.totals.tokens, 1100)
  assert.equal(on.totals.sessions, 2)
  assert.equal(on.totals.subagentEvents, 1)

  const off = buildHistoryView(records, { now: MONDAY_NOON, spanWeeks: 13, includeSubagents: false })
  assert.deepEqual(off.totals.excluded, { sessions: 1, events: 1, tokens: 990 })
  assert.equal(off.totals.tokens, 110)
  assert.equal(off.totals.sessions, 1)
  assert.equal(off.totals.subagentSessions, 0)
  assert.equal(off.models.length, 1)
})
