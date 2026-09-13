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

import { formatCny, formatDecimal, formatDuration, formatMoney } from './format.js'
import { peakPhase } from './peak.js'
import { percentRemaining } from './quota.js'
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

/**
 * Localized label for a meter id.
 *
 * Meter ids are the provider-neutral vocabulary (`./quota.js`): the same `5h`
 * label means the same thing on Command Code, on a relay and in a spec file.
 * A meter carrying its own label falls back to it only for an id this build does
 * not know.
 */
function meterLabel(lang, meter) {
  switch (meter.id) {
    case 'window5h': return t(lang, 'meterWindow5h')
    case 'windowWeekly': return t(lang, 'meterWindowWeekly')
    case 'windowDaily': return t(lang, 'meterWindowDaily')
    case 'windowMonthly': return t(lang, 'meterWindowMonthly')
    case 'planRemaining': return t(lang, 'meterPlanRemaining')
    case 'keyLimit': return t(lang, 'meterKeyLimit')
    case 'periodSpend': return t(lang, 'meterPeriodSpend')
    case 'balance': return t(lang, 'meterBalance')
    default: return typeof meter.label === 'string' && meter.label !== '' ? meter.label : meter.id
  }
}

/** One amount in its meter's unit, including the symbol or unit word. */
export function formatMeterAmount(lang, value, unit) {
  if (unit?.kind === 'money') return formatMoney(value, unit.currency)
  const amount = formatDecimal(value)
  return unit?.kind === 'credits' ? `${amount} ${t(lang, 'creditsUnit')}` : amount
}

/** One amount without its unit word — used inside parentheses. */
function bareAmount(value, unit) {
  return unit?.kind === 'money' ? formatMoney(value, unit.currency) : formatDecimal(value)
}

/**
 * A ratio rendered as a percentage.
 *
 * The precision follows the magnitude instead of being fixed: a subscription
 * turn typically consumes a fraction of a percent, so two decimals below 10%
 * keep the figure from moving in visible steps, while a remaining share near
 * 100% needs no more than one. Anything below the smallest printable step says
 * so rather than rounding to a flat zero (`<0.01%`), and a true zero stays `0%`.
 */
export function formatPercentValue(ratio) {
  if (typeof ratio !== 'number' || !Number.isFinite(ratio)) return undefined
  const percent = ratio * 100
  if (percent <= 0) return '0%'
  if (percent < 0.01) return '<0.01%'
  return `${percent < 10 ? percent.toFixed(2) : percent.toFixed(1)}%`
}

/** A meter's remaining share of its cap, or `undefined`. */
export function meterRemainingPercent(meter) {
  const cap = typeof meter?.cap === 'number' && meter.cap > 0 ? meter.cap : undefined
  if (cap === undefined) return undefined
  const remaining = typeof meter.remaining === 'number'
    ? meter.remaining
    : typeof meter.used === 'number' ? cap - meter.used : undefined
  return percentRemaining(remaining, cap)
}

/** One meter rendered as `label used/cap` or `label amount`. */
export function meterText(lang, meter) {
  const label = meterLabel(lang, meter)
  const cap = typeof meter.cap === 'number' && meter.cap > 0 ? meter.cap : undefined
  const used = typeof meter.used === 'number'
    ? meter.used
    : cap !== undefined && typeof meter.remaining === 'number'
      ? cap - meter.remaining
      : undefined
  const unit = { kind: meter.kind, currency: meter.currency }
  if (cap !== undefined && used !== undefined) {
    // A capped meter is the only case where the ratio is the interesting part,
    // and it is also the only one where dropping the unit word stays readable.
    return `${label} ${bareAmount(used, unit)}/${bareAmount(cap, unit)}`
  }
  const amount = typeof meter.remaining === 'number' ? meter.remaining : used
  if (amount === undefined) return label
  return `${label} ${formatMeterAmount(lang, amount, unit)}`
}

/**
 * One capped meter rendered as a percentage.
 *
 * A subscription is priced in windows, so "how much is left of the thing that
 * will actually stop me" is a share, not an absolute. The full form keeps the
 * absolute pair in parentheses; the compact form drops it, which is what a
 * narrow terminal falls back to (see `./view.js`).
 *
 * @param compact - whether to drop the parenthetical absolute figures.
 * @returns The text, or `undefined` when the meter has no cap to divide by.
 */
export function meterPercentText(lang, meter, compact = false) {
  const percent = meterRemainingPercent(meter)
  if (percent === undefined) return undefined
  const share = t(lang, 'quotaRemainingPct', { p: formatPercentValue(percent) })
  const label = meterLabel(lang, meter)
  if (compact) return `${label} ${share}`
  const cap = meter.cap
  const used = typeof meter.used === 'number' ? meter.used : cap - (typeof meter.remaining === 'number' ? meter.remaining : 0)
  const unit = { kind: meter.kind, currency: meter.currency }
  return `${label} ${share}(${bareAmount(used, unit)}/${bareAmount(cap, unit)})`
}

/**
 * The account-side part: a provider's quota meter, or the state of the read.
 *
 * `quota` is built by the plugin from a snapshot plus the user's choices, so
 * this function owns only the rendering:
 *
 * - `{ state: 'meter', meter, planName? }` — a live figure;
 * - `{ state: 'unsupported' }` — the provider has no quota interface (shown only
 *   when the user pinned that provider, otherwise the part is omitted entirely);
 * - the failure states reuse the balance vocabulary so a rejected key reads the
 *   same way it always has.
 *
 * @param atMs - instant to compute the reset countdown against.
 */
export function quotaPart(lang, quota, atMs = Date.now()) {
  if (quota === undefined || quota === null) return undefined
  const label = t(lang, 'quota')
  switch (quota.state) {
    case 'meter': {
      /**
       * Render the part, optionally in its narrow form.
       *
       * In `plan` mode the meter reads as a remaining share; the compact form
       * drops the absolute pair, which is what a narrow terminal shows.
       */
      const build = compact => {
        const pieces = []
        if (typeof quota.planName === 'string' && quota.planName !== '') {
          pieces.push(t(lang, 'planLabel', { name: quota.planName }))
        }
        const share = quota.mode === 'plan' ? meterPercentText(lang, quota.meter, compact) : undefined
        pieces.push(share ?? meterText(lang, quota.meter))
        if (typeof quota.meter?.resetAt === 'number') {
          pieces.push(t(lang, 'quotaReset', { d: formatDuration(quota.meter.resetAt - atMs) }))
        }
        if (quota.meter?.exceeded === true) pieces.push(t(lang, 'quotaExceeded'))
        return pieces.join(' · ')
      }
      const text = build(false)
      const compact = build(true)
      return {
        key: 'quota',
        text,
        ...(compact === text ? {} : { compact }),
        tone: quota.meter?.exceeded === true ? 'error' : 'value',
        provider: quota.provider,
      }
    }
    case 'loading':
      return { key: 'quota', text: `${label} ${t(lang, 'balanceChecking')}`, tone: 'muted' }
    case 'no-key':
      return { key: 'quota', text: `${label} ${t(lang, 'balanceNoKey')}`, tone: 'muted' }
    case 'unauthorized':
      return { key: 'quota', text: `${label} ${t(lang, 'balanceRejected')}`, tone: 'error' }
    case 'unsupported':
      return {
        key: 'quota',
        text: `${quota.pinned === true ? t(lang, 'quotaPinned') : label} ${t(lang, 'quotaUnsupported')}`,
        tone: 'muted',
      }
    default:
      return { key: 'quota', text: `${label} ${t(lang, 'balanceUnavailable')}`, tone: 'muted' }
  }
}

/**
 * Balance lookup state rendered on the line.
 *
 * The amount is formatted in the currency the endpoint reported, so a
 * non-CNY account is not labelled with a yuan sign.
 */
function balancePart(lang, balance) {
  const label = t(lang, 'balance')
  switch (balance?.state) {
    case 'ok':
      return { key: 'balance', text: `${label} ${formatMoney(balance.amount, balance.currency)}`, tone: 'value' }
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

/**
 * Turn cost rendered on the line.
 *
 * A running turn wins: its figure is live (the host republishes on every usage
 * report), which is what "this turn" means while the model is still answering.
 * The settled figure is what remains once the turn closes — never a stand-in
 * for a turn that has already started.
 *
 * @param live - `{ tokens, cost }` of the running turn; `tokens > 0` means a
 *   turn is in flight.
 */
function turnPart(lang, lastTurn, live) {
  const label = t(lang, 'turn')
  if (live !== undefined && live.tokens > 0) {
    // A provider with a spend counter has no figure until the turn settles, so
    // the live label stands alone rather than claiming the model is unrated.
    const text = live.cost === undefined
      ? (live.measured === true ? t(lang, 'turnLive') : `${t(lang, 'turnLive')} ${t(lang, 'unratedModel')}`)
      : `${t(lang, 'turnLive')} ${formatCny(live.cost.total)}`
    return {
      key: 'turn',
      text,
      tone: live.cost === undefined ? 'muted' : 'value',
      tokens: live.tokens,
      live: true,
    }
  }
  if (lastTurn === undefined) {
    return { key: 'turn', text: `${label} ${t(lang, 'noTurnYet')}`, tone: 'muted', tokens: 0, live: false }
  }
  // A measured spend (a provider's own counter difference) outranks the
  // estimate: it is the provider's number, not this plugin's arithmetic.
  if (lastTurn.spend !== undefined) {
    const prefix = lastTurn.spendExact === false ? t(lang, 'turnSpendApprox') : ''
    const amount = formatMeterAmount(lang, lastTurn.spend.value, lastTurn.spend.unit)
    // On a subscription the interesting figure is the share of the cap this turn
    // drew, so the percentage leads and the raw amount rides in parentheses —
    // the narrow form keeps only the share.
    const share = formatPercentValue(lastTurn.spendPercent)
    if (share !== undefined) {
      return {
        key: 'turn',
        text: `${label} ${prefix}${share}(${bareAmount(lastTurn.spend.value, lastTurn.spend.unit)})`,
        compact: `${label} ${prefix}${share}`,
        tone: 'value',
        tokens: lastTurn.tokens,
        live: false,
      }
    }
    return { key: 'turn', text: `${label} ${prefix}${amount}`, tone: 'value', tokens: lastTurn.tokens, live: false }
  }
  if (lastTurn.cost === undefined) {
    return { key: 'turn', text: `${label} ${t(lang, 'unratedModel')}`, tone: 'muted', tokens: lastTurn.tokens, live: false }
  }
  return {
    key: 'turn',
    text: `${label} ${formatCny(lastTurn.cost.total)}`,
    tone: 'value',
    tokens: lastTurn.tokens,
    live: false,
  }
}

/**
 * Build the display model.
 *
 * @param options.atMs - instant to render for (clock injection).
 * @param options.lang - `'zh'` / `'en'`.
 * @param options.config - resolved plugin config.
 * @param options.balance - `{ state, amount, currency }` from the balance poller.
 * @param options.lastTurn - settled turn from the tracker, if any.
 * @param options.live - `{ tokens, cost }` of the running turn, if any.
 * @param options.forcePeak - diagnostic override (`DSH_PEAK_BALANCE_FORCE_PEAK`)
 *   that renders the peak presentation outside a peak window, so the warning
 *   frame can be previewed without waiting for 09:00.
 * @returns `{ peak, weekend, warn, colorHex, parts }`; `parts` are ordered
 *   phase → countdown → turn → balance and carry a tone the view maps to a
 *   theme color. The turn figure sits ahead of the balance because a narrow
 *   terminal truncates the tail, and the per-turn cost is the figure that
 *   changes while the user watches.
 */
export function buildDisplay(options) {
  const {
    atMs = Date.now(),
    lang = 'zh',
    config = {},
    balance,
    quota,
    lastTurn,
    live,
    forcePeak = false,
  } = options ?? {}

  const phase = peakPhase(atMs)
  const peak = phase.peak || forcePeak === true
  const warn = config.warnOnPeak === true && peak

  const phaseText = peak
    ? `${t(lang, 'peakBadge')} ${t(lang, 'peak')}`
    : phase.weekend
      ? `${t(lang, 'idleBadge')} ${t(lang, 'idleHalf')} · ${t(lang, 'weekend')}`
      : `${t(lang, 'idleBadge')} ${t(lang, 'idleHalf')}`

  // The countdown always describes the real clock — the diagnostic override
  // only changes how the current window is presented.
  const countdown = phase.peak
    ? t(lang, 'countdownToIdle', { d: formatDuration(phase.msUntilChange) })
    : t(lang, 'countdownToPeak', { d: formatDuration(phase.msUntilChange) })

  const parts = [
    { key: 'phase', text: phaseText, tone: peak ? 'peak' : 'idle' },
    { key: 'countdown', text: countdown, tone: 'muted' },
  ]
  if (config.showTurnCost === true) parts.push(turnPart(lang, lastTurn, live))
  if (config.showBalance === true) {
    // The account part is either the provider-neutral quota meter (the generic
    // path) or the legacy balance state object, which older callers still pass.
    // An undefined `quota` means "this provider has nothing to show" and must
    // not fall back to the legacy renderer with an empty state.
    const account = quota !== undefined
      ? quotaPart(lang, quota, atMs)
      : balance === undefined ? undefined : balancePart(lang, balance)
    if (account !== undefined) parts.push(account)
  }

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
