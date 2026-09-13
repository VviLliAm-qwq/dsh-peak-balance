/**
 * Number / money / duration formatting for the status line.
 *
 * @module dsh-peak-balance/format
 */

/** Symbols for the currencies the balance endpoint can report. */
const CURRENCY_SYMBOLS = Object.freeze({
  CNY: '¥',
  USD: '$',
  EUR: '€',
  GBP: '£',
  HKD: 'HK$',
  JPY: 'JP¥',
})

/**
 * Format an amount with the symbol of the currency it is actually in.
 *
 * The balance endpoint reports `currency` next to the amount, and the account
 * is not always CNY (an international key answers in USD). Hard-coding `¥`
 * would label a dollar balance as yuan, so an unknown currency falls back to
 * the ISO code rather than inventing a symbol.
 *
 * @param value - amount.
 * @param currency - ISO code (`'CNY'`, `'USD'`, …); absent means CNY, which is
 *   what every internal estimate is denominated in.
 * @returns e.g. `"¥12.34"`, `"$5.00"`, `"12.34 CHF"`, `"—"`.
 */
export function formatMoney(value, currency = 'CNY') {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—'
  const code = typeof currency === 'string' && currency.trim() !== '' ? currency.trim().toUpperCase() : 'CNY'
  const abs = Math.abs(value)
  const decimals = abs >= 1 ? 2 : abs >= 0.01 ? 4 : 6
  const amount = value.toFixed(decimals)
  const symbol = CURRENCY_SYMBOLS[code]
  return symbol === undefined ? `${amount} ${code}` : `${symbol}${amount}`
}

/**
 * Format CNY with a precision that keeps small per-turn amounts readable.
 *
 * @param value - amount in 元.
 * @returns e.g. `"¥12.34"`, `"¥0.0234"`, `"¥0.000123"`, `"¥—"`.
 */
export function formatCny(value) {
  // Kept exactly as before for the history surfaces: an unpriced figure reads
  // as a CNY-shaped blank, not as a bare dash.
  if (typeof value !== 'number' || !Number.isFinite(value)) return '¥—'
  return formatMoney(value, 'CNY')
}

/**
 * A plain amount with a precision that keeps small figures readable.
 *
 * Used for units that have no currency symbol — Command Code credits, quota
 * points, a relay's own counters. The unit word is appended by the caller, which
 * is the layer that knows the language.
 *
 * @returns e.g. `"12.34"`, `"0.0539"`, `"0.000123"`, `"—"`.
 */
export function formatDecimal(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—'
  const abs = Math.abs(value)
  const decimals = abs >= 1 ? 2 : abs >= 0.01 ? 4 : 6
  return value.toFixed(decimals)
}

/**
 * Compact countdown ("1h23m", "23m", "45s").
 *
 * @param ms - milliseconds remaining; negative values clamp to `0s`.
 */
export function formatDuration(ms) {
  const total = Math.max(0, Math.floor(Number.isFinite(ms) ? ms : 0) / 1000)
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = Math.floor(total % 60)
  if (hours > 0) return `${hours}h${String(minutes).padStart(2, '0')}m`
  if (minutes > 0) return `${minutes}m`
  return `${seconds}s`
}

/** Compact token count ("842", "12.3k", "1.2M"). */
export function formatTokens(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '0'
  const abs = Math.abs(value)
  if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (abs >= 1_000) return `${(value / 1_000).toFixed(1)}k`
  return String(Math.round(value))
}

/** Exact token count with thousands separators ("12,345,678"). */
export function formatTokensFull(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '0'
  return Math.round(value).toLocaleString('en-US')
}

/**
 * A ratio as a percentage ("99.3%").
 *
 * @param ratio - `0..1`, or `undefined` when there is no denominator.
 * @param digits - decimal places (default 1).
 */
export function formatPercent(ratio, digits = 1) {
  if (typeof ratio !== 'number' || !Number.isFinite(ratio)) return '—'
  return `${(ratio * 100).toFixed(digits)}%`
}

/** Fixed Beijing wall clock ("09:30") for an instant. */
export function formatBeijingClock(atMs) {
  const shifted = new Date(atMs + 8 * 60 * 60 * 1000)
  return `${String(shifted.getUTCHours()).padStart(2, '0')}:${String(shifted.getUTCMinutes()).padStart(2, '0')}`
}
