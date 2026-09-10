/**
 * Display model for the status contribution.
 *
 * Pure: everything the view needs (localized text, tones, the warning color)
 * is decided here, so the React component stays a dumb, allocation-light
 * renderer. Balance/usage values are formatted with the formatters, never
 * re-derived in the view.
 *
 * @module dsh-peak-balance/display
 */

import { formatCny, formatDuration } from './format.js'
import { peakPhase } from './peak.js'
import { t } from './i18n.js'

/**
 * The seven selectable warning colors — a fixed palette (not theme tokens) so
 * the flashing frame keeps its identity under every theme.
 */
export const WARN_COLORS = Object.freeze({
  red: Object.freeze({ value: 'red', hex: '#FF4D4F', label: 'Red', zh: '红' }),
  orange: Object.freeze({ value: 'orange', hex: '#FF8C1A', label: 'Orange', zh: '橙' }),
  yellow: Object.freeze({ value: 'yellow', hex: '#FFD21E', label: 'Yellow', zh: '黄' }),
  green: Object.freeze({ value: 'green', hex: '#3DDC84', label: 'Green', zh: '绿' }),
  cyan: Object.freeze({ value: 'cyan', hex: '#22D3EE', label: 'Cyan', zh: '青' }),
  blue: Object.freeze({ value: 'blue', hex: '#4C8DFF', label: 'Blue', zh: '蓝' }),
  purple: Object.freeze({ value: 'purple', hex: '#A45BFF', label: 'Purple', zh: '紫' }),
})

/** Selectable warning colors in display order. */
export const WARN_COLOR_ORDER = Object.freeze(['red', 'orange', 'yellow', 'green', 'cyan', 'blue', 'purple'])

/** Settings-section options for the warning-color field. */
export function warnColorOptions() {
  return WARN_COLOR_ORDER.map(value => {
    const entry = WARN_COLORS[value]
    return { value, label: entry.label, descriptions: { zh: entry.zh, en: entry.label } }
  })
}

/** Hex for a warning-color name; unknown names fall back to red. */
export function warnColorHex(name) {
  return (WARN_COLORS[name] ?? WARN_COLORS.red).hex
}

/** Balance lookup state rendered on the line. */
function balancePart(lang, balance) {
  const label = t(lang, 'balance')
  switch (balance?.state) {
    case 'ok':
      return { key: 'balance', text: `${label} ${formatCny(balance.amount)}`, tone: 'value' }
    case 'loading':
      return { key: 'balance', text: `${label} ${t(lang, 'balanceChecking')}`, tone: 'muted' }
    case 'no-key':
      return { key: 'balance', text: `${label} ${t(lang, 'balanceNoKey')}`, tone: 'muted' }
    case 'unauthorized':
      return { key: 'balance', text: `${label} ${t(lang, 'balanceRejected')}`, tone: 'error' }
    default:
      return { key: 'balance', text: `${label} ${t(lang, 'balanceUnavailable')}`, tone: 'muted' }
  }
}

/** Last-settled-turn cost rendered on the line. */
function turnPart(lang, lastTurn, liveTokens) {
  const label = t(lang, 'turn')
  if (lastTurn === undefined) {
    const tokens = liveTokens ?? 0
    return {
      key: 'turn',
      text: `${label} ${t(lang, 'noTurnYet')}`,
      tone: 'muted',
      tokens,
    }
  }
  if (lastTurn.cost === undefined) {
    return { key: 'turn', text: `${label} ${t(lang, 'unratedModel')}`, tone: 'muted', tokens: lastTurn.tokens }
  }
  return {
    key: 'turn',
    text: `${label} ${formatCny(lastTurn.cost.total)}`,
    tone: 'value',
    tokens: lastTurn.tokens,
  }
}

/**
 * Build the display model.
 *
 * @param options.atMs - instant to render for (clock injection).
 * @param options.lang - `'zh'` / `'en'`.
 * @param options.config - resolved plugin config.
 * @param options.balance - `{ state, amount }` from the balance poller.
 * @param options.lastTurn - settled turn from the tracker, if any.
 * @param options.liveTokens - tokens accumulated in the running turn.
 * @returns `{ peak, weekend, warn, colorHex, parts }`; `parts` are ordered
 *   phase → countdown → balance → turn and carry a tone the view maps to a
 *   theme color.
 */
export function buildDisplay(options) {
  const {
    atMs = Date.now(),
    lang = 'zh',
    config = {},
    balance,
    lastTurn,
    liveTokens,
  } = options ?? {}

  const phase = peakPhase(atMs)
  const peak = phase.peak
  const warn = config.warnOnPeak === true && peak

  const phaseText = peak
    ? `${t(lang, 'peakBadge')} ${t(lang, 'peak')}`
    : phase.weekend
      ? `${t(lang, 'idleBadge')} ${t(lang, 'idleHalf')} · ${t(lang, 'weekend')}`
      : `${t(lang, 'idleBadge')} ${t(lang, 'idleHalf')}`

  const countdown = peak
    ? t(lang, 'countdownToIdle', { d: formatDuration(phase.msUntilChange) })
    : t(lang, 'countdownToPeak', { d: formatDuration(phase.msUntilChange) })

  const parts = [
    { key: 'phase', text: phaseText, tone: peak ? 'peak' : 'idle' },
    { key: 'countdown', text: countdown, tone: 'muted' },
  ]
  if (config.showBalance === true) parts.push(balancePart(lang, balance))
  if (config.showTurnCost === true) parts.push(turnPart(lang, lastTurn, liveTokens))

  return {
    peak,
    weekend: phase.weekend,
    warn,
    colorHex: warnColorHex(config.warnColor),
    nextChangeAt: phase.nextChangeAt,
    msUntilChange: phase.msUntilChange,
    parts,
  }
}
