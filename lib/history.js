/**
 * Pure token-history aggregation behind the `/th` scene.
 *
 * Everything the scene renders (the day grid, the totals, the per-model table)
 * is decided here from plain session records, so the React side stays a dumb
 * renderer and every number can be unit tested at fixed instants.
 *
 * A session record is the reduced form of one stored session log (see
 * `./history-scan.js`): `{ id, subagent, models: { <model>: { days: { <day>:
 * { peak: counts, idle: counts } } } } }`. Usage is bucketed by the event's own
 * timestamp, so a day that straddles a peak boundary is priced correctly.
 *
 * @module dsh-peak-balance/history
 */

import {
  bucketCostCny,
  providerLabelOf,
  providerUnitOf,
  rateSourceForKey,
  rateSourceOf,
  resolveRateCard,
  resolveRateCardForKey,
  unitKeyOf,
} from './pricing.js'
import { isPeak } from './peak.js'
import { normalizeUsage } from './tracker.js'

/** Fixed Beijing offset in minutes (UTC+8, no daylight saving). */
export const BEIJING_OFFSET_MINUTES = 480

const DAY_MS = 24 * 60 * 60 * 1000

/** Model id used when a session's usage arrived before any `request/header`. */
export const UNKNOWN_MODEL = '(unknown)'

/** Selectable grid metrics, in settings order. */
export const METRIC_ORDER = Object.freeze(['tokens', 'cost', 'output', 'cacheMiss'])

/** Selectable spans, as strings (the settings seam stores select values as text). */
export const SPAN_WEEKS_ORDER = Object.freeze(['13', '26', '53'])

/** Selectable week starts. */
export const WEEK_START_ORDER = Object.freeze(['mon', 'sun'])

/** Selectable color scales for the grid. */
export const COLOR_SCALE_ORDER = Object.freeze(['github', 'blue', 'theme'])

/**
 * Selectable scene layouts.
 *
 * `card` frames the scene in a rounded box with section separators; `plain`
 * drops the chrome and spends those two rows and four columns on content. The
 * card degrades to plain by itself when the terminal cannot hold it, so the
 * setting is a preference rather than a hard mode.
 */
export const LAYOUT_ORDER = Object.freeze(['card', 'plain'])

/** A fresh token bucket. `events` counts provider usage reports, not tokens. */
export function emptyCounts() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, events: 0 }
}

/** Fold `source` counts into `target` (in place) and return `target`. */
export function addCounts(target, source) {
  target.input += source?.input ?? 0
  target.output += source?.output ?? 0
  target.cacheRead += source?.cacheRead ?? 0
  target.cacheWrite += source?.cacheWrite ?? 0
  target.events += source?.events ?? 0
  return target
}

/** All provider-reported tokens in a bucket (`totalTokens` semantics). */
export function totalTokensOf(counts) {
  if (counts === null || typeof counts !== 'object') return 0
  return (counts.input ?? 0) + (counts.output ?? 0) + (counts.cacheRead ?? 0) + (counts.cacheWrite ?? 0)
}

/**
 * Cache-hit rate of a bucket: `cacheRead / (cacheMissInput + cacheRead + cacheWrite)`.
 *
 * The three input-side figures the provider reports are disjoint, and a cache
 * write rides the miss-priced input, so it shares the denominator with the
 * miss (this is the same arithmetic the host uses for its own session view).
 *
 * @returns A ratio in `[0, 1]`, or `undefined` when the bucket has no input.
 */
export function cacheHitRate(counts) {
  if (counts === null || typeof counts !== 'object') return undefined
  const miss = Math.max(0, counts.input ?? 0)
  const hit = Math.max(0, counts.cacheRead ?? 0)
  const write = Math.max(0, counts.cacheWrite ?? 0)
  const denominator = miss + hit + write
  if (denominator <= 0) return undefined
  return hit / denominator
}

/** `'YYYY-MM-DD'` day key for an instant in a fixed-offset timezone. */
export function dayKeyOf(atMs, offsetMinutes = BEIJING_OFFSET_MINUTES) {
  const ms = Number.isFinite(atMs) ? atMs : 0
  return new Date(ms + offsetMinutes * 60 * 1000).toISOString().slice(0, 10)
}

/** Instant of local midnight for the local day containing `atMs`. */
export function dayStartMs(atMs, offsetMinutes = BEIJING_OFFSET_MINUTES) {
  const offsetMs = offsetMinutes * 60 * 1000
  const shifted = (Number.isFinite(atMs) ? atMs : 0) + offsetMs
  return Math.floor(shifted / DAY_MS) * DAY_MS - offsetMs
}

/** Add `days` calendar days to a local-midnight instant. */
export function addDays(atMs, days) {
  return atMs + days * DAY_MS
}

/**
 * Row index of an instant's day, relative to the configured week start.
 *
 * @param weekStart - `'mon'` (default) or `'sun'`.
 * @returns `0` for the week's first day through `6` for its last.
 */
export function weekdayIndex(atMs, weekStart = 'mon', offsetMinutes = BEIJING_OFFSET_MINUTES) {
  const jsDay = new Date(dayStartMs(atMs, offsetMinutes) + offsetMinutes * 60 * 1000).getUTCDay()
  const start = weekStart === 'sun' ? 0 : 1
  return (jsDay - start + 7) % 7
}

/** Whether two instants fall on the same local day. */
export function sameLocalDay(a, b, offsetMinutes = BEIJING_OFFSET_MINUTES) {
  return dayKeyOf(a, offsetMinutes) === dayKeyOf(b, offsetMinutes)
}

/**
 * Geometric bounds of the grid.
 *
 * The last column is the week containing `now`; the first is `spanWeeks - 1`
 * columns earlier, so the grid always ends on the current week like GitHub's.
 *
 * @param now - reference instant.
 * @param spanWeeks - number of week columns.
 * @param weekStart - `'mon'` or `'sun'`.
 * @returns `{ weeks, firstWeekStartMs, lastWeekStartMs, todayStartMs, todayIndex }`.
 */
export function weekGridBounds(now, spanWeeks = 26, weekStart = 'mon') {
  const weeks = Math.max(1, Math.floor(Number.isFinite(spanWeeks) ? spanWeeks : 26))
  const todayIndex = weekdayIndex(now, weekStart)
  const todayStartMs = dayStartMs(now)
  const lastWeekStartMs = addDays(todayStartMs, -todayIndex)
  const firstWeekStartMs = addDays(lastWeekStartMs, -(weeks - 1) * 7)
  return { weeks, firstWeekStartMs, lastWeekStartMs, todayStartMs, todayIndex }
}

/** The metric value one day contributes to the grid. */
export function metricValueOf(day, metric = 'tokens') {
  if (day === undefined || day === null) return 0
  switch (metric) {
    case 'cost':
      return day.cost ?? 0
    case 'output':
      return day.counts?.output ?? 0
    case 'cacheMiss':
      return day.counts?.input ?? 0
    default:
      return totalTokensOf(day.counts)
  }
}

/**
 * Four ascending intensity thresholds (quartiles of the non-zero values).
 *
 * Quantiles rather than fixed buckets: cache-heavy days dwarf ordinary ones, so
 * a linear scale would leave every ordinary day in the first color.
 *
 * @param values - every day value in the visible grid (zeros included).
 * @returns Four ascending numbers; all zero when the span has no activity.
 */
export function intensityThresholds(values) {
  const nonZero = (Array.isArray(values) ? values : [])
    .filter(value => typeof value === 'number' && Number.isFinite(value) && value > 0)
    .sort((a, b) => a - b)
  if (nonZero.length === 0) return [0, 0, 0, 0]
  const quantile = p => nonZero[Math.min(nonZero.length - 1, Math.max(0, Math.ceil(p * nonZero.length) - 1))]
  return [quantile(0.25), quantile(0.5), quantile(0.75), quantile(0.95)]
}

/** Intensity level `0..4` of one day value under {@link intensityThresholds}. */
export function levelOf(value, thresholds) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return 0
  const [t1, t2, t3, t4] = thresholds ?? [0, 0, 0, 0]
  if (value <= t1) return 1
  if (value <= t2) return 2
  if (value <= t3) return 3
  return t4 >= 0 ? 4 : 4
}

/** Model id of a `request/header` event's config, or `''`. */
export function modelOfHeader(event) {
  const model = event?.data?.header?.config?.model
  return typeof model === 'string' && model !== '' ? model : ''
}

/**
 * Provider route of a `request/header` event's config, or `''`.
 *
 * The host fills `config.provider` for every route it can serve (the official
 * API, a pi-ai catalog provider, a hand-declared gateway), which is what makes
 * "which account did this spend come from?" answerable from the logs alone.
 */
export function providerOfHeader(event) {
  const provider = event?.data?.header?.config?.provider
  return typeof provider === 'string' && provider !== '' ? provider : ''
}

/**
 * Bucket key of one (provider, model) pair.
 *
 * Buckets are keyed by `provider/model` rather than by model alone, because the
 * same weights bought through a subscription and through a pay-as-you-go key
 * are two different accounts with two different units — adding them into one row
 * would produce a number in no unit at all. A request whose provider the host
 * never named keeps the bare model id (every pre-0.4.0 record looks like that).
 */
export function bucketKeyOf(provider, model) {
  const id = typeof model === 'string' && model !== '' ? model : UNKNOWN_MODEL
  return typeof provider === 'string' && provider !== '' ? `${provider}/${id}` : id
}

/** Split a bucket key back into `{ provider, model }`. */
export function splitBucketKey(key) {
  const text = typeof key === 'string' ? key : ''
  const slash = text.indexOf('/')
  if (slash <= 0) return { provider: '', model: text }
  return { provider: text.slice(0, slash), model: text.slice(slash + 1) }
}

/** The model bucket of one record, created on first use. */
function modelBucket(record, model) {
  const existing = record.models[model]
  if (existing !== undefined) return existing
  const created = { days: {} }
  record.models[model] = created
  return created
}

/** The `{ peak, idle }` tier pair of one model/day, created on first use. */
function tierBucket(modelEntry, dayKey) {
  const existing = modelEntry.days[dayKey]
  if (existing !== undefined) return existing
  const created = { peak: emptyCounts(), idle: emptyCounts() }
  modelEntry.days[dayKey] = created
  return created
}

/**
 * Reduce one stored session log's events to a session record.
 *
 * Fork-seeded logs physically carry their parent's event prefix; those events
 * must not be counted again. The header's `seedLength` is the exact cut (the
 * first `session/end-seed` event sits on it); a header that only marks
 * `isSeeded` falls back to that marker's position.
 *
 * @param events - parsed log events, in seq order.
 * @returns `{ id, subagent, seeded, createdAt, lastTime, models, events, skipped }`.
 */
export function foldSessionEvents(events) {
  const list = Array.isArray(events) ? events : []
  const header = list.find(event => event?.type === 'session')
  const id = typeof header?.id === 'string' ? header.id : ''
  const subagent = header?.origin === 'subagent'
    || (typeof header?.delegationDepth === 'number' && header.delegationDepth > 0)
  const rawSeedLength = header?.seedLength
  const seedLength = typeof rawSeedLength === 'number' && Number.isFinite(rawSeedLength) && rawSeedLength > 0
    ? Math.floor(rawSeedLength)
    : 0
  const seedCutIndex = seedLength === 0 && header?.isSeeded === true
    ? list.findIndex(event => event?.type === 'session/end-seed')
    : -1
  const createdAt = typeof header?.createdAt === 'number' ? header.createdAt : 0
  const record = {
    id,
    subagent,
    seeded: seedLength > 0 || header?.isSeeded === true,
    createdAt,
    lastTime: createdAt,
    models: {},
    events: 0,
    skipped: 0,
  }

  let model = ''
  let provider = ''
  for (let index = 0; index < list.length; index += 1) {
    const event = list[index]
    const type = event?.type
    if (type === 'request/header') {
      const next = modelOfHeader(event)
      if (next !== '') model = next
      const nextProvider = providerOfHeader(event)
      // A header without a provider must not erase the one an earlier header
      // named: the two fields come from the same config object, but only the
      // provider is new here.
      if (nextProvider !== '') provider = nextProvider
      continue
    }
    if (type !== 'assistant/message') continue
    if (seedLength > 0 && typeof event.seq === 'number' && event.seq < seedLength) {
      record.skipped += 1
      continue
    }
    if (seedCutIndex >= 0 && index <= seedCutIndex) {
      record.skipped += 1
      continue
    }
    const counts = normalizeUsage(event?.data?.usage)
    if (counts === undefined) continue
    const atMs = typeof event.time === 'number' ? event.time : createdAt
    counts.events = 1
    const tiers = tierBucket(modelBucket(record, bucketKeyOf(provider, model)), dayKeyOf(atMs))
    addCounts(isPeak(atMs) ? tiers.peak : tiers.idle, counts)
    record.events += 1
    if (atMs > record.lastTime) record.lastTime = atMs
  }
  return record
}

/**
 * Grid position of one day key.
 *
 * @param view - a {@link buildHistoryView} result.
 * @param dayKey - `'YYYY-MM-DD'`.
 * @returns `{ column, row, day }`, or `undefined` when the key is not in the grid.
 */
export function gridPositionOf(view, dayKey) {
  for (const week of view?.weeks ?? []) {
    for (const day of week.days) {
      if (day.key === dayKey) return { column: week.index, row: day.row, day }
    }
  }
  return undefined
}

/** The day at one grid coordinate, when it exists. */
function dayAt(view, column, row) {
  const week = view?.weeks?.[column]
  if (week === undefined) return undefined
  return week.days.find(day => day.row === row)
}

/**
 * Move one SQUARE in a direction, the way the grid is drawn.
 *
 * The user's contract is spatial, not calendar: `←`/`→` step one week
 * (the same weekday, the neighbouring column) and `↑`/`↓` step one day
 * (the neighbouring row inside the same column). A move that would leave the
 * grid or land on a day that has not happened yet is refused, so the selection
 * simply stops at the edge instead of wrapping around.
 *
 * @param view - a {@link buildHistoryView} result.
 * @param dayKey - currently selected day.
 * @param direction - `'up'` / `'down'` / `'left'` / `'right'`.
 * @returns The next day key, or `dayKey` when the move is not allowed.
 */
export function stepGrid(view, dayKey, direction) {
  const position = gridPositionOf(view, dayKey)
  if (position === undefined) return dayKey
  const target = {
    up: { column: position.column, row: position.row - 1 },
    down: { column: position.column, row: position.row + 1 },
    left: { column: position.column - 1, row: position.row },
    right: { column: position.column + 1, row: position.row },
  }[direction]
  if (target === undefined) return dayKey
  const day = dayAt(view, target.column, target.row)
  if (day === undefined || day.future === true) return dayKey
  return day.key
}

/**
 * The day key of "today" inside the grid, or the last past day when today is
 * somehow absent (an edge case that only a doctored view can produce).
 */
export function todayKeyOf(view) {
  const flat = (view?.weeks ?? []).flatMap(week => week.days)
  const today = flat.find(day => day.atMs === view?.bounds?.todayStartMs && day.future !== true)
  if (today !== undefined) return today.key
  return flat.filter(day => day.future !== true).slice(-1)[0]?.key
}

/** A fresh per-day aggregate. */
function emptyDay(dayKey) {
  return {
    key: dayKey,
    counts: emptyCounts(),
    cost: 0,
    costIncomplete: false,
    subagentEvents: 0,
    models: new Map(),
    sessions: new Set(),
  }
}

/** Fold a record's `{ peak, idle }` pair into one counts object. */
function combineTiers(tiers) {
  const combined = emptyCounts()
  addCounts(combined, tiers?.peak)
  addCounts(combined, tiers?.idle)
  return combined
}

/** The per-model counts of one day aggregate, created on first use. */
function dayModelCounts(day, model) {
  const existing = day.models.get(model)
  if (existing !== undefined) return existing
  const created = emptyCounts()
  day.models.set(model, created)
  return created
}

/**
 * Plain, serializable detail for one day (the grid's hover card).
 *
 * @param day - a `days` entry from {@link buildHistoryView}, or `undefined`.
 * @returns `undefined` for a day with no usage at all.
 */
export function describeDay(day) {
  if (day === undefined || day === null) return undefined
  const tokens = totalTokensOf(day.counts)
  if (tokens <= 0 && day.counts.events <= 0) return undefined
  const models = [...day.models.entries()]
    .map(([model, counts]) => ({ model, counts, tokens: totalTokensOf(counts) }))
    .sort((a, b) => b.tokens - a.tokens)
  return {
    key: day.key,
    counts: day.counts,
    tokens,
    cost: day.cost,
    costIncomplete: day.costIncomplete,
    cacheHitRate: cacheHitRate(day.counts),
    events: day.counts.events,
    sessions: day.sessions.size,
    subagentEvents: day.subagentEvents,
    subagentShare: day.counts.events > 0 ? day.subagentEvents / day.counts.events : undefined,
    models,
  }
}

/**
 * Build the whole scene view model.
 *
 * @param records - session records from `./history-scan.js`.
 * @param options.now - reference instant (clock injection).
 * @param options.spanWeeks - week columns (`13` / `26` / `53`).
 * @param options.weekStart - `'mon'` / `'sun'`.
 * @param options.metric - `'tokens'` / `'cost'` / `'output'` / `'cacheMiss'`.
 * @param options.includeSubagents - whether subagent sessions count.
 * @param options.customRates - `{ [model]: { idle, peak } }` overrides.
 * @param options.lang - `'zh'` / `'en'` (month labels only).
 * @returns The view model consumed by `./history-view.js`.
 */
export function buildHistoryView(records, options = {}) {
  const {
    now = Date.now(),
    spanWeeks = 26,
    weekStart = 'mon',
    metric = 'tokens',
    includeSubagents = true,
    customRates = {},
    providerFilter = 'all',
  } = options

  const days = new Map()
  const models = new Map()
  /** Per-provider subtotals: the numbers that must never be added together. */
  const providerRows = new Map()
  /**
   * Every provider present in the selected records, filter or not.
   *
   * The filter key needs the full list to cycle through, and a filter that hides
   * its own alternatives is a trap: once you select one provider, the others
   * must still be reachable.
   */
  const allProviders = new Set()
  let sessions = 0
  let subagentSessions = 0
  let skippedEvents = 0
  /**
   * What the subagent filter dropped.
   *
   * Reported instead of silently discarded: "the grid got smaller" is not a
   * visible answer to pressing the switch, and the user asked exactly for the
   * excluded volume to be spelled out.
   */
  const excluded = { sessions: 0, events: 0, tokens: 0 }

  /** One provider's subtotal, created on first use. */
  const providerRow = provider => {
    let row = providerRows.get(provider)
    if (row === undefined) {
      row = {
        id: provider,
        label: providerLabelOf(provider),
        unit: providerUnitOf(provider),
        counts: emptyCounts(),
        cost: 0,
        costIncomplete: false,
        models: 0,
      }
      providerRows.set(provider, row)
    }
    return row
  }

  for (const record of records ?? []) {
    if (record === null || typeof record !== 'object') continue
    if (includeSubagents !== true && record.subagent === true) {
      excluded.sessions += 1
      for (const entry of Object.values(record.models ?? {})) {
        for (const tiers of Object.values(entry?.days ?? {})) {
          const combined = combineTiers(tiers)
          excluded.events += combined.events
          excluded.tokens += totalTokensOf(combined)
        }
      }
      continue
    }
    sessions += 1
    if (record.subagent === true) subagentSessions += 1
    skippedEvents += record.skipped ?? 0
    const sessionId = typeof record.id === 'string' && record.id !== '' ? record.id : `anon-${sessions}`
    for (const [key, entry] of Object.entries(record.models ?? {})) {
      const { provider, model } = splitBucketKey(key)
      allProviders.add(provider)
      if (providerFilter !== 'all' && provider !== providerFilter) continue
      const source = rateSourceForKey(key, customRates, now, provider, model)
      const card = resolveRateCardForKey(key, now, customRates, provider, model)
      const subtotal = providerRow(provider)
      let modelEntry = models.get(key)
      if (modelEntry === undefined) {
        modelEntry = {
          key,
          provider,
          providerLabel: providerLabelOf(provider),
          model,
          unit: providerUnitOf(provider),
          source,
          counts: emptyCounts(),
          cost: 0,
          costIncomplete: false,
          days: new Set(),
        }
        models.set(key, modelEntry)
        subtotal.models += 1
      }
      for (const [dayKey, tiers] of Object.entries(entry?.days ?? {})) {
        const combined = combineTiers(tiers)
        if (combined.events <= 0 && totalTokensOf(combined) <= 0) continue
        let day = days.get(dayKey)
        if (day === undefined) {
          day = emptyDay(dayKey)
          days.set(dayKey, day)
        }
        addCounts(day.counts, combined)
        day.sessions.add(sessionId)
        if (record.subagent === true) day.subagentEvents += combined.events
        addCounts(dayModelCounts(day, key), combined)
        addCounts(modelEntry.counts, combined)
        addCounts(subtotal.counts, combined)
        modelEntry.days.add(dayKey)
        if (card === undefined) {
          day.costIncomplete = true
          modelEntry.costIncomplete = true
          subtotal.costIncomplete = true
        } else {
          const cost = bucketCostCny(tiers?.peak, card.peak) + bucketCostCny(tiers?.idle, card.idle)
          day.cost += cost
          modelEntry.cost += cost
          subtotal.cost += cost
        }
      }
    }
  }

  // A cost column is only meaningful in one unit. When the selected providers
  // disagree (CNY next to credits), the board falls back to tokens and says so,
  // rather than printing a sum of two different things.
  const units = new Set()
  for (const row of providerRows.values()) {
    if (row.unit !== undefined) units.add(unitKeyOf(row.unit))
  }
  const mixedUnits = units.size > 1
  const effectiveMetric = metric === 'cost' && mixedUnits ? 'tokens' : metric
  const metricFallback = effectiveMetric !== metric

  const bounds = weekGridBounds(now, spanWeeks, weekStart)
  const keys = []
  for (let index = 0; index < bounds.weeks * 7; index += 1) {
    keys.push(dayKeyOf(addDays(bounds.firstWeekStartMs, index)))
  }

  const gridDays = keys.map((key, index) => {
    const atMs = addDays(bounds.firstWeekStartMs, index)
    const day = days.get(key)
    return {
      key,
      atMs,
      future: atMs > bounds.todayStartMs,
      value: day === undefined ? 0 : metricValueOf(day, effectiveMetric),
      active: day !== undefined,
    }
  })
  const thresholds = intensityThresholds(gridDays.map(entry => (entry.future ? 0 : entry.value)))
  for (const entry of gridDays) {
    entry.level = entry.future ? 0 : levelOf(entry.value, thresholds)
  }

  const weeks = []
  for (let column = 0; column < bounds.weeks; column += 1) {
    const slice = gridDays.slice(column * 7, column * 7 + 7)
    const days7 = []
    let firstOfMonth
    for (let row = 0; row < 7; row += 1) {
      const entry = slice[row]
      if (entry === undefined) continue
      days7.push({ ...entry, row })
      if (entry.key.endsWith('-01')) firstOfMonth = entry.key
    }
    const firstKey = slice[0]?.key ?? ''
    const previousKey = column === 0 ? undefined : gridDays[column * 7 - 1]?.key
    const monthLabel = column === 0
      ? firstKey
      : firstOfMonth !== undefined && previousKey !== undefined && previousKey.slice(0, 7) !== firstOfMonth.slice(0, 7)
        ? firstOfMonth
        : undefined
    weeks.push({ index: column, monthLabel, days: days7 })
  }

  const modelRows = [...models.values()]
    .sort((a, b) => totalTokensOf(b.counts) - totalTokensOf(a.counts) || a.key.localeCompare(b.key))
    .map(entry => ({
      key: entry.key,
      provider: entry.provider,
      providerLabel: entry.providerLabel,
      model: entry.model,
      unit: entry.unit,
      source: entry.source,
      counts: entry.counts,
      tokens: totalTokensOf(entry.counts),
      cost: entry.cost,
      costIncomplete: entry.costIncomplete,
      cacheHitRate: cacheHitRate(entry.counts),
      activeDays: entry.days.size,
    }))

  const providers = [...providerRows.values()]
    .sort((a, b) => totalTokensOf(b.counts) - totalTokensOf(a.counts) || a.label.localeCompare(b.label))
    .map(row => ({
      id: row.id,
      label: row.label,
      unit: row.unit,
      counts: row.counts,
      tokens: totalTokensOf(row.counts),
      cost: row.cost,
      costIncomplete: row.costIncomplete,
      models: row.models,
      cacheHitRate: cacheHitRate(row.counts),
    }))
  const costUnit = units.size === 1 ? [...units][0] : undefined

  const totals = emptyCounts()
  let totalCost = 0
  let costIncomplete = false
  let firstActive
  let lastActive
  let bestDay
  const allDays = [...days.values()]
  for (const day of allDays) {
    const tokens = totalTokensOf(day.counts)
    if (tokens <= 0) continue
    addCounts(totals, day.counts)
    totalCost += day.cost
    if (day.costIncomplete) costIncomplete = true
    if (firstActive === undefined || day.key < firstActive) firstActive = day.key
    if (lastActive === undefined || day.key > lastActive) lastActive = day.key
    const value = metricValueOf(day, effectiveMetric)
    if (bestDay === undefined || value > bestDay.value) bestDay = { key: day.key, value }
  }

  return {
    generatedAt: now,
    metric: effectiveMetric,
    requestedMetric: metric,
    metricFallback,
    mixedUnits,
    costUnit,
    spanWeeks: bounds.weeks,
    weekStart,
    includeSubagents: includeSubagents === true,
    providerFilter,
    /** Provider ids available to the filter, in stable order. */
    allProviders: [...allProviders].sort(),
    bounds,
    weeks,
    thresholds,
    legend: { min: 0, max: gridDays.reduce((max, entry) => (entry.future ? max : Math.max(max, entry.value)), 0) },
    totals: {
      counts: totals,
      tokens: totalTokensOf(totals),
      cost: totalCost,
      costIncomplete,
      cacheHitRate: cacheHitRate(totals),
      sessions,
      subagentSessions,
      subagentEvents: allDays.reduce((sum, day) => sum + day.subagentEvents, 0),
      events: totals.events,
      activeDays: allDays.filter(day => totalTokensOf(day.counts) > 0).length,
      firstActive,
      lastActive,
      bestDay,
      skippedEvents,
      excluded: { ...excluded },
    },
    days,
    models: modelRows,
    providers,
  }
}
