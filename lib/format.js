/**
 * Number / money / duration formatting for the status line.
 *
 * @module dsh-peak-balance/format
 */

/**
 * Format CNY with a precision that keeps small per-turn amounts readable.
 *
 * @param value - amount in 元.
 * @returns e.g. `"¥12.34"`, `"¥0.0234"`, `"¥0.000123"`.
 */
export function formatCny(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '¥—'
  const abs = Math.abs(value)
  const decimals = abs >= 1 ? 2 : abs >= 0.01 ? 4 : 6
  return `¥${value.toFixed(decimals)}`
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

/** Fixed Beijing wall clock ("09:30") for an instant. */
export function formatBeijingClock(atMs) {
  const shifted = new Date(atMs + 8 * 60 * 60 * 1000)
  return `${String(shifted.getUTCHours()).padStart(2, '0')}:${String(shifted.getUTCMinutes()).padStart(2, '0')}`
}
