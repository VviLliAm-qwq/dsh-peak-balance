/**
 * The provider-neutral quota model.
 *
 * Every adapter — built-in or declared in a spec file — answers with the same
 * shape: a list of *meters* plus, when the provider exposes one, a monotonic
 * spend counter. The status line and the history board only ever read this
 * shape, so adding a provider never touches the display layer.
 *
 * A meter is deliberately dumb: `used` / `cap` / `remaining` / `resetAt` in
 * whatever unit the meter declares (`money`, `credits`, `count`). Nothing here
 * converts between providers: mixing CNY, USD and credits into one total is
 * exactly the arithmetic this model exists to prevent.
 *
 * @module dsh-peak-balance/quota
 */

/**
 * Stable meter ids, in display/rotation order.
 *
 * Adapters must pick ids from this list so a user's `quotaMetric` setting keeps
 * meaning the same thing after switching providers.
 */
export const METER_IDS = Object.freeze([
  'window5h',
  'windowWeekly',
  'windowDaily',
  'windowMonthly',
  'planRemaining',
  'keyLimit',
  'balance',
  'periodSpend',
])

/** Meter ids that describe a rolling/period cap rather than a standing balance. */
const WINDOW_IDS = Object.freeze(['window5h', 'windowWeekly', 'windowDaily', 'windowMonthly', 'planRemaining', 'keyLimit'])

/** Failure reasons an adapter may report; every one maps to a rendered state. */
export const FAILURE_REASONS = Object.freeze([
  'no-key', // no credential resolved for this provider
  'unauthorized', // 401/403 — key rejected (or under-privileged)
  'http', // any other non-2xx
  'network', // transport, timeout or abort
  'invalid', // 2xx but the payload carried nothing usable
  'unsupported', // this provider has no quota interface at all
])

/** `true` when a value is a usable finite number. */
function finite(value) {
  return typeof value === 'number' && Number.isFinite(value)
}

/**
 * How a provider charges, which decides how its figures read.
 *
 * `money` is pay-as-you-go: a currency balance and a per-turn amount. `plan` is
 * a subscription: capped windows, so both the per-turn spend and what is left
 * read better as a share of the cap than as raw credits. `auto` defers to what
 * the snapshot actually contains.
 */
export const BILLING_MODES = Object.freeze(['money', 'plan', 'auto'])

/** Normalize a billing declaration (`'auto'` for anything unrecognized). */
export function normalizeBilling(value) {
  return value === 'money' || value === 'plan' ? value : 'auto'
}

/**
 * What a snapshot's own contents imply about its billing.
 *
 * The fallback for a provider nobody declared: a capped meter with no currency
 * balance is a subscription (nobody caps a prepaid balance in credits), while a
 * currency balance is pay-as-you-go. Deliberately conservative — an unknown
 * shape reads as `money`, which renders absolute figures rather than inventing a
 * denominator.
 */
export function inferBilling(snapshot) {
  const meters = Array.isArray(snapshot?.meters) ? snapshot.meters : []
  const capped = meters.some(meter => finite(meter.cap) && meter.cap > 0)
  const money = meters.some(meter => meter.kind === 'money')
  return capped && !money ? 'plan' : 'money'
}

/**
 * The billing mode to render with.
 *
 * A user override wins; then the provider's own declaration (what its adapter or
 * spec stanza says it is); then the data. That ordering is the point: the kind of
 * readout follows the provider's billing method, not the accident of which meter
 * happened to sort first.
 */
export function billingOf(snapshot, override) {
  if (override === 'money' || override === 'plan') return override
  const declared = normalizeBilling(snapshot?.billing)
  if (declared !== 'auto') return declared
  return inferBilling(snapshot)
}

/** Percentage of a cap consumed, clamped to `0..1`; `undefined` without a cap. */
export function percentUsed(used, cap) {
  if (!finite(used) || !finite(cap) || cap <= 0) return undefined
  return Math.max(0, Math.min(1, used / cap))
}

/** Percentage of a cap still available, clamped to `0..1`; `undefined` without a cap. */
export function percentRemaining(remaining, cap) {
  if (!finite(remaining) || !finite(cap) || cap <= 0) return undefined
  return Math.max(0, Math.min(1, remaining / cap))
}

/** Normalize a `{ kind, currency }` unit, dropping anything unusable. */
export function normalizeUnit(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const kind = raw.kind === 'money' || raw.kind === 'credits' || raw.kind === 'count' ? raw.kind : undefined
  if (kind === undefined) return undefined
  const currency = typeof raw.currency === 'string' && raw.currency !== '' ? raw.currency.toUpperCase() : undefined
  return currency === undefined ? { kind } : { kind, currency }
}

/**
 * Normalize one meter.
 *
 * @returns The meter, or `undefined` when it carries no usable number.
 */
export function normalizeMeter(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const id = typeof raw.id === 'string' && raw.id !== '' ? raw.id : undefined
  if (id === undefined) return undefined
  const meter = { id, kind: raw.kind === 'money' || raw.kind === 'credits' || raw.kind === 'count' ? raw.kind : 'count' }
  if (typeof raw.currency === 'string' && raw.currency !== '') meter.currency = raw.currency.toUpperCase()
  for (const key of ['used', 'cap', 'remaining']) {
    if (finite(raw[key])) meter[key] = raw[key]
  }
  if (finite(raw.resetAt)) meter.resetAt = raw.resetAt
  if (raw.exceeded === true) meter.exceeded = true
  if (typeof raw.note === 'string' && raw.note !== '') meter.note = raw.note
  if (typeof raw.label === 'string' && raw.label !== '') meter.label = raw.label
  if (meter.used === undefined && meter.cap === undefined && meter.remaining === undefined) return undefined
  return meter
}

/**
 * Build a successful snapshot, dropping unusable meters.
 *
 * @param options.provider - provider route id the figures belong to.
 * @param options.adapter - adapter id that produced them (diagnostics).
 * @param options.meters - raw meters; unusable entries are dropped.
 * @param options.spendCounter - `{ id, value }` of a monotonic spend counter.
 * @param options.failures - per-request failure notes (partial reads).
 * @param options.at - capture instant.
 */
export function okSnapshot(options = {}) {
  const meters = []
  for (const raw of Array.isArray(options.meters) ? options.meters : []) {
    const meter = normalizeMeter(raw)
    if (meter !== undefined) meters.push(meter)
  }
  const counter = options.spendCounter
  const counterUnit = counter !== null && typeof counter === 'object' ? normalizeUnit(counter.unit) : undefined
  const spendCounter = counter !== null && typeof counter === 'object' && typeof counter.id === 'string' && finite(counter.value)
    ? { id: counter.id, value: counter.value, ...(counterUnit === undefined ? {} : { unit: counterUnit }) }
    : undefined
  return {
    ok: true,
    provider: typeof options.provider === 'string' ? options.provider : '',
    adapter: typeof options.adapter === 'string' ? options.adapter : '',
    at: finite(options.at) ? options.at : Date.now(),
    meters,
    spendCounter,
    // The subscription's own name (`GOAT`), when the provider has plans at all.
    ...(typeof options.plan === 'string' && options.plan !== '' ? { plan: options.plan } : {}),
    // How this provider charges, as declared by its adapter (`auto` = infer).
    billing: normalizeBilling(options.billing),
    failures: Array.isArray(options.failures) ? options.failures.filter(entry => typeof entry === 'string') : [],
  }
}

/**
 * Build a failed snapshot.
 *
 * @param reason - one of {@link FAILURE_REASONS} (`'invalid'` otherwise).
 * @param options.provider / options.adapter - provenance.
 * @param options.status - HTTP status when there was one.
 * @param options.detail - short diagnostic string (never a secret).
 */
export function failSnapshot(reason, options = {}) {
  const normalized = FAILURE_REASONS.includes(reason) ? reason : 'invalid'
  const snapshot = {
    ok: false,
    reason: normalized,
    provider: typeof options.provider === 'string' ? options.provider : '',
    adapter: typeof options.adapter === 'string' ? options.adapter : '',
    at: finite(options.at) ? options.at : Date.now(),
    failures: [],
  }
  if (finite(options.status)) snapshot.status = options.status
  if (typeof options.detail === 'string' && options.detail !== '') snapshot.detail = options.detail
  return snapshot
}

/** Meters in rotation order (`METER_IDS` first, unknown ids after, stable). */
export function orderedMeters(snapshot) {
  const meters = Array.isArray(snapshot?.meters) ? snapshot.meters : []
  return [...meters].sort((a, b) => {
    const left = METER_IDS.indexOf(a.id)
    const right = METER_IDS.indexOf(b.id)
    return (left === -1 ? METER_IDS.length : left) - (right === -1 ? METER_IDS.length : right)
  })
}

/** Find one meter by id. */
export function meterById(snapshot, id) {
  return orderedMeters(snapshot).find(meter => meter.id === id)
}

/**
 * The meter to show when the user picked nothing specific.
 *
 * Preference: the tightest rolling window the provider reports (a 5-hour cap is
 * what actually stops work), then any other window, then a standing balance,
 * then whatever is left. A meter that is already `exceeded` wins outright, so
 * the reason requests start failing is on screen.
 */
export function primaryMeter(snapshot) {
  const meters = orderedMeters(snapshot)
  if (meters.length === 0) return undefined
  const exceeded = meters.find(meter => meter.exceeded === true)
  if (exceeded !== undefined) return exceeded
  const window = meters.find(meter => WINDOW_IDS.includes(meter.id))
  if (window !== undefined) return window
  const balance = meters.find(meter => meter.id === 'balance')
  return balance ?? meters[0]
}

/**
 * Resolve the meter a rendering pass should show.
 *
 * @param snapshot - the current snapshot (may be a failure).
 * @param metric - the `quotaMetric` setting: a meter id, `'auto'` or `'rotate'`.
 * @param tick - rotation cursor (only read for `'rotate'`).
 * @returns `{ meter, rotating }`; `meter` is `undefined` when nothing is showable.
 */
export function pickMeter(snapshot, metric, tick = 0) {
  const meters = orderedMeters(snapshot)
  if (meters.length === 0) return { meter: undefined, rotating: false }
  if (metric === 'rotate') {
    const index = Number.isInteger(tick) ? Math.abs(tick) % meters.length : 0
    return { meter: meters[index], rotating: true }
  }
  if (typeof metric === 'string' && metric !== '' && metric !== 'auto') {
    const exact = meters.find(meter => meter.id === metric)
    if (exact !== undefined) return { meter: exact, rotating: false }
  }
  return { meter: primaryMeter(snapshot), rotating: false }
}

/**
 * Ratio of a meter's usage, `0..1`, or `undefined` when it has no cap.
 *
 * `used` is preferred; a meter reporting only `remaining` against a `cap` is
 * converted, which is what MiniMax-style "remains" payloads need.
 */
export function meterRatio(meter) {
  if (meter === undefined || meter === null) return undefined
  const cap = finite(meter.cap) ? meter.cap : undefined
  if (cap === undefined || cap <= 0) return undefined
  const used = finite(meter.used) ? meter.used : finite(meter.remaining) ? cap - meter.remaining : undefined
  if (used === undefined) return undefined
  return Math.min(1, Math.max(0, used / cap))
}

/** Remaining amount of a meter, or `undefined` when neither figure allows it. */
export function meterRemaining(meter) {
  if (meter === undefined || meter === null) return undefined
  if (finite(meter.remaining)) return meter.remaining
  if (finite(meter.cap) && finite(meter.used)) return meter.cap - meter.used
  if (meter.id === 'balance' && finite(meter.used)) return meter.used
  return undefined
}

/**
 * Difference between two readings of a monotonic spend counter.
 *
 * A missing reading yields `undefined`; a *negative* difference is not a
 * refund — it is the provider's counter resetting (a new billing period, a
 * rotated account). Reporting it as a negative "cost" would be a lie, so the
 * caller is told "unknown" and re-baselines instead.
 */
export function spendDelta(baseline, current) {
  if (!finite(baseline) || !finite(current)) return undefined
  const delta = current - baseline
  return delta < 0 ? undefined : delta
}

/** The spend-counter value of a snapshot, or `undefined`. */
export function spendCounterOf(snapshot) {
  return snapshot?.ok === true && finite(snapshot.spendCounter?.value) ? snapshot.spendCounter.value : undefined
}
