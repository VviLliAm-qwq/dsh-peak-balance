/**
 * DeepSeek peak / off-peak billing windows.
 *
 * Official rule (DeepSeek API docs, "模型 & 价格", verified 2026-09-10):
 * peak hours are Beijing time (UTC+8, no DST) Monday-Friday 09:00-12:00 and
 * 14:00-18:00; every other minute is off-peak, and the off-peak price is half
 * the peak price. Weekends are therefore off-peak for the whole day.
 *
 * Everything here is pure and clock-injected so the windows can be unit
 * tested at fixed instants.
 *
 * @module dsh-peak-balance/peak
 */

/** Fixed Beijing offset in milliseconds (UTC+8, no daylight saving). */
export const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000

const DAY_MS = 24 * 60 * 60 * 1000

/** Peak windows as minutes-of-day pairs, in Beijing local time. */
export const PEAK_WINDOWS = Object.freeze([
  Object.freeze({ startMinutes: 9 * 60, endMinutes: 12 * 60 }),
  Object.freeze({ startMinutes: 14 * 60, endMinutes: 18 * 60 }),
])

/** Human-readable window list ("09:00-12:00 / 14:00-18:00"). */
export const PEAK_WINDOW_TEXT = PEAK_WINDOWS
  .map(window => `${clockText(window.startMinutes)}-${clockText(window.endMinutes)}`)
  .join(' / ')

/** `minutes` past midnight -> `"HH:MM"`. */
export function clockText(minutes) {
  const hour = Math.floor(minutes / 60)
  const minute = minutes % 60
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
}

/** Beijing-local minute of day and weekday (0 = Sunday) for one instant. */
function beijingParts(atMs) {
  const shifted = new Date(atMs + BEIJING_OFFSET_MS)
  return {
    weekday: shifted.getUTCDay(),
    minutes: shifted.getUTCHours() * 60 + shifted.getUTCMinutes(),
    seconds: shifted.getUTCSeconds(),
  }
}

/** Absolute instant of Beijing midnight for the Beijing day containing `atMs`. */
function beijingMidnight(atMs) {
  const shifted = atMs + BEIJING_OFFSET_MS
  const sinceMidnight = ((shifted % DAY_MS) + DAY_MS) % DAY_MS
  return atMs - sinceMidnight
}

/** Beijing midnight of the day `days` after the one containing `atMs`. */
function beijingMidnightOffset(atMs, days) {
  return beijingMidnight(atMs) + days * DAY_MS
}

/** First weekday (Mon-Fri) 09:00 Beijing strictly after `atMs`. */
function nextWeekdayPeakStart(atMs) {
  for (let days = 0; days <= 7; days += 1) {
    const candidate = beijingMidnightOffset(atMs, days) + PEAK_WINDOWS[0].startMinutes * 60 * 1000
    if (candidate <= atMs) continue
    const weekday = beijingParts(candidate).weekday
    if (weekday !== 0 && weekday !== 6) return candidate
  }
  // Unreachable for any real clock (seven consecutive days always contain a
  // weekday); the fallback keeps the function total for malformed inputs.
  return atMs + DAY_MS
}

/** Whether `atMs` falls inside a peak window. */
export function isPeak(atMs = Date.now()) {
  const { weekday, minutes } = beijingParts(atMs)
  if (weekday === 0 || weekday === 6) return false
  return PEAK_WINDOWS.some(window => minutes >= window.startMinutes && minutes < window.endMinutes)
}

/**
 * The billing phase around `atMs`.
 *
 * @param atMs - instant to describe; defaults to now.
 * @returns `peak` for the current window, the window bounds in force, and the
 *   next boundary (the instant the price tier changes).
 */
export function peakPhase(atMs = Date.now()) {
  const { weekday, minutes } = beijingParts(atMs)
  const weekend = weekday === 0 || weekday === 6
  const window = weekend
    ? undefined
    : PEAK_WINDOWS.find(entry => minutes >= entry.startMinutes && minutes < entry.endMinutes)

  if (window !== undefined) {
    const endAt = beijingMidnight(atMs) + window.endMinutes * 60 * 1000
    return {
      peak: true,
      weekend,
      startAt: beijingMidnight(atMs) + window.startMinutes * 60 * 1000,
      endAt,
      nextChangeAt: endAt,
      msUntilChange: Math.max(0, endAt - atMs),
    }
  }

  // Off-peak: the next tier change is the next weekday peak start, unless the
  // same Beijing day still has a peak window ahead.
  let nextChangeAt
  if (!weekend) {
    const upcoming = PEAK_WINDOWS.find(entry => entry.startMinutes > minutes)
    nextChangeAt = upcoming === undefined
      ? nextWeekdayPeakStart(atMs)
      : beijingMidnight(atMs) + upcoming.startMinutes * 60 * 1000
  } else {
    nextChangeAt = nextWeekdayPeakStart(atMs)
  }
  return {
    peak: false,
    weekend,
    startAt: undefined,
    endAt: nextChangeAt,
    nextChangeAt,
    msUntilChange: Math.max(0, nextChangeAt - atMs),
  }
}
