import { test } from 'node:test'
import assert from 'node:assert/strict'

import { BEIJING_OFFSET_MS, PEAK_WINDOW_TEXT, clockText, isPeak, peakPhase } from '../lib/peak.js'

/** Beijing wall clock -> UTC instant (2026-09-10 is a Thursday). */
function beijing(year, month, day, hour, minute = 0) {
  return Date.UTC(year, month - 1, day, hour, minute) - BEIJING_OFFSET_MS
}

test('clockText pads to HH:MM', () => {
  assert.equal(clockText(9 * 60), '09:00')
  assert.equal(clockText(12 * 60), '12:00')
  assert.equal(clockText(14 * 60 + 5), '14:05')
})

test('peak window text lists both official windows', () => {
  assert.equal(PEAK_WINDOW_TEXT, '09:00-12:00 / 14:00-18:00')
})

test('peak windows include the start and exclude the end', () => {
  const thursday = [2026, 9, 10]
  assert.equal(isPeak(beijing(...thursday, 8, 59)), false)
  assert.equal(isPeak(beijing(...thursday, 9, 0)), true)
  assert.equal(isPeak(beijing(...thursday, 11, 59)), true)
  assert.equal(isPeak(beijing(...thursday, 12, 0)), false)
  assert.equal(isPeak(beijing(...thursday, 13, 59)), false)
  assert.equal(isPeak(beijing(...thursday, 14, 0)), true)
  assert.equal(isPeak(beijing(...thursday, 17, 59)), true)
  assert.equal(isPeak(beijing(...thursday, 18, 0)), false)
  assert.equal(isPeak(beijing(...thursday, 23, 30)), false)
})

test('weekends are off-peak all day', () => {
  // 2026-09-12 is a Saturday, 2026-09-13 a Sunday.
  for (const day of [12, 13]) {
    assert.equal(isPeak(beijing(2026, 9, day, 10)), false)
    assert.equal(isPeak(beijing(2026, 9, day, 15)), false)
  }
})

test('peakPhase counts down to the end of a peak window', () => {
  const at = beijing(2026, 9, 10, 10, 30)
  const phase = peakPhase(at)
  assert.equal(phase.peak, true)
  assert.equal(phase.startAt, beijing(2026, 9, 10, 9, 0))
  assert.equal(phase.endAt, beijing(2026, 9, 10, 12, 0))
  assert.equal(phase.msUntilChange, 90 * 60 * 1000)
})

test('peakPhase counts down to the next window while off-peak on a weekday', () => {
  assert.equal(peakPhase(beijing(2026, 9, 10, 8, 0)).nextChangeAt, beijing(2026, 9, 10, 9, 0))
  assert.equal(peakPhase(beijing(2026, 9, 10, 12, 30)).nextChangeAt, beijing(2026, 9, 10, 14, 0))
  // After the last window of a Thursday comes Friday 09:00.
  assert.equal(peakPhase(beijing(2026, 9, 10, 20, 0)).nextChangeAt, beijing(2026, 9, 11, 9, 0))
})

test('weekend countdown targets Monday 09:00', () => {
  const saturday = beijing(2026, 9, 12, 3, 0)
  const phase = peakPhase(saturday)
  assert.equal(phase.peak, false)
  assert.equal(phase.weekend, true)
  assert.equal(phase.nextChangeAt, beijing(2026, 9, 14, 9, 0))
  assert.equal(phase.msUntilChange, beijing(2026, 9, 14, 9, 0) - saturday)
})

test('a Friday evening countdown skips the weekend to Monday 09:00', () => {
  // 2026-09-11 is a Friday.
  assert.equal(peakPhase(beijing(2026, 9, 11, 19, 30)).nextChangeAt, beijing(2026, 9, 14, 9, 0))
})
