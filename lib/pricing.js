/**
 * DeepSeek rate card and CNY cost estimation.
 *
 * Source: DeepSeek API docs, "模型 & 价格" — verified 2026-09-10:
 * https://api-docs.deepseek.com/zh-cn/quick_start/pricing
 *
 * | model            | bucket   | input (cache hit) | input (cache miss) | output |
 * | ---------------- | -------- | ----------------- | ------------------ | ------ |
 * | deepseek-flash   | off-peak | 0.02              | 1                  | 4      |
 * | deepseek-flash   | peak     | 0.04              | 2                  | 8      |
 * | deepseek-v4-pro  | off-peak | 0.15              | 4.5                | 13.5   |
 * | deepseek-v4-pro  | peak     | 0.30              | 9.0                | 27.0   |
 *
 * All figures are CNY per million tokens. The two legacy Flash ids
 * (`deepseek-v4-flash`, `deepseek-v4-flash-vision-exp`) are served by
 * DeepSeek-V4.1-Flash and billed at the Flash rates.
 *
 * Costs are an ESTIMATE built from provider-reported token usage: the API
 * returns tokens, never money, and the balance is debited on DeepSeek's side.
 *
 *   cost = inputMissTokens × miss rate
 *        + cacheReadTokens × hit rate
 *        + outputTokens    × output rate
 *
 * where the provider reports the cache-miss input, the cache-hit input and the
 * output as three **disjoint** counts (see {@link bucketCostCny}).
 *
 * @module dsh-peak-balance/pricing
 */

/** Provenance of the embedded rate card, surfaced in the README and logs. */
export const PRICE_CARD_SOURCE = Object.freeze({
  label: 'DeepSeek API docs — 模型 & 价格',
  url: 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing',
  verifiedAt: '2026-09-10',
})

/** 元 per million tokens for one billing tier. */
function rates(inputHit, inputMiss, output) {
  return Object.freeze({ inputHit, inputMiss, output })
}

/** DeepSeek-V4.1-Flash (`deepseek-flash`), since 2026-09-10 12:00 Beijing. */
export const FLASH_RATES = Object.freeze({
  idle: rates(0.02, 1, 4),
  peak: rates(0.04, 2, 8),
})

/** DeepSeek-V4-Pro-0813 (`deepseek-v4-pro`). */
export const PRO_RATES = Object.freeze({
  idle: rates(0.15, 4.5, 13.5),
  peak: rates(0.30, 9, 27),
})

/**
 * Instant `deepseek-v4-pro` requests start being served — and billed — as
 * V4.1-Flash: 2026-09-14 12:00 Beijing (04:00 UTC). Official footnote (2).
 */
export const PRO_ROUTES_TO_FLASH_AT = Date.UTC(2026, 8, 14, 4, 0, 0)

/**
 * Model-id prefix routes, longest prefix first. `routedTo` switches a retired
 * route to the live model's rates from a fixed instant on — the API keeps
 * accepting the old id, so pricing it with the stale card would overstate the
 * bill.
 */
const MODEL_ROUTES = Object.freeze([
  Object.freeze({ prefix: 'deepseek-v4-flash-vision-exp', rates: FLASH_RATES }),
  Object.freeze({ prefix: 'deepseek-v4-flash', rates: FLASH_RATES }),
  Object.freeze({ prefix: 'deepseek-flash', rates: FLASH_RATES }),
  Object.freeze({
    prefix: 'deepseek-v4-pro',
    rates: PRO_RATES,
    routedTo: Object.freeze({ at: PRO_ROUTES_TO_FLASH_AT, rates: FLASH_RATES }),
  }),
])

/** One token bucket: provider-reported counts for a single price tier. */
export function emptyTotals() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
}

/** A fresh peak/idle bucket pair. */
export function emptyBuckets() {
  return { peak: emptyTotals(), idle: emptyTotals() }
}

/** Strip a provider prefix ("deepseek-official/deepseek-flash" -> "deepseek-flash"). */
export function baseModelId(model) {
  if (typeof model !== 'string') return ''
  const trimmed = model.trim().toLowerCase()
  const slash = trimmed.lastIndexOf('/')
  return slash === -1 ? trimmed : trimmed.slice(slash + 1)
}

/**
 * Rate card for a model id, or `undefined` for a model this card does not
 * price (the caller then shows tokens without a CNY figure rather than a
 * wrong number).
 *
 * @param model - API model id, with or without a provider prefix.
 * @param atMs - instant the request ran; decides retired-route rerating.
 */
export function rateCardFor(model, atMs = Date.now()) {
  const id = baseModelId(model)
  if (id === '') return undefined
  let best
  let bestLength = 0
  for (const route of MODEL_ROUTES) {
    if (!id.startsWith(route.prefix) || route.prefix.length <= bestLength) continue
    best = route
    bestLength = route.prefix.length
  }
  if (best === undefined) return undefined
  if (best.routedTo !== undefined && atMs >= best.routedTo.at) return best.routedTo.rates
  return best.rates
}

/** Whether one tier object carries three usable prices. */
function usableTier(tier) {
  if (tier === null || typeof tier !== 'object') return false
  return ['inputHit', 'inputMiss', 'output'].every(
    key => typeof tier[key] === 'number' && Number.isFinite(tier[key]) && tier[key] >= 0,
  )
}

/**
 * Rate card for a model id, honoring user-supplied rates first.
 *
 * Custom rates win over the built-in card, because the built-in card is a
 * snapshot: a model it does not list (or lists only by prefix) can be priced
 * exactly by hand. Both layers keep the same `{ idle, peak }` shape, and a
 * custom entry that is not actually usable is ignored rather than allowed to
 * produce a NaN price.
 *
 * @param model - API model id, with or without a provider prefix.
 * @param atMs - instant the request ran; decides retired-route rerating.
 * @param customRates - `{ [baseModelId]: { idle, peak } }` from `./rates.js`.
 * @returns The tier pair, or `undefined` when nothing prices this model.
 */
export function resolveRateCard(model, atMs = Date.now(), customRates = {}) {
  const id = baseModelId(model)
  if (id === '') return undefined
  const custom = customRates === null || typeof customRates !== 'object' ? undefined : customRates[id]
  if (custom !== null && custom !== undefined && typeof custom === 'object') {
    if (usableTier(custom.idle) && usableTier(custom.peak)) return custom
    // Tolerate a flat entry: same rates in both windows.
    if (usableTier(custom)) return { idle: custom, peak: custom }
  }
  return rateCardFor(model, atMs)
}

/**
 * Provenance of the rates a model is priced with.
 *
 * @returns `'custom'` (user-supplied), `'builtin'` (embedded rate card) or
 *   `'unknown'` — the caller shows tokens without a CNY figure, never a guess.
 */
export function rateSourceOf(model, customRates = {}, atMs = Date.now()) {
  const id = baseModelId(model)
  if (id === '') return 'unknown'
  const custom = customRates === null || typeof customRates !== 'object' ? undefined : customRates[id]
  const usable = custom !== null && custom !== undefined && typeof custom === 'object'
    && ((usableTier(custom.idle) && usableTier(custom.peak)) || usableTier(custom))
  if (usable) return 'custom'
  return rateCardFor(model, atMs) === undefined ? 'unknown' : 'builtin'
}

/**
 * Cost in 元 of one bucket under one tier's rates (per-million scaling applied).
 *
 * Field semantics, verified against a real session log (2026-09-10) and the
 * host's own arithmetic: the three input-side figures are **disjoint** —
 * `input` is the prompt that missed the cache, `cacheRead` is the prompt served
 * from cache, `cacheWrite` rides the miss-priced input and is not billed
 * again. The provider's `totalTokens` equals `input + cacheRead + output` for
 * exactly that reason, and dsh-tui computes its cache-hit rate as
 * `cacheRead / (input + cacheRead + cacheWrite)`.
 *
 * A formula that treats `cacheRead` as a subset of `input` (clamping one to the
 * other) therefore under-prices every cached turn.
 */
export function bucketCostCny(bucket, tier) {
  if (bucket === undefined || tier === undefined) return 0
  const input = Math.max(0, bucket.input ?? 0)
  const output = Math.max(0, bucket.output ?? 0)
  const cacheRead = Math.max(0, bucket.cacheRead ?? 0)
  return (
    input * tier.inputMiss + cacheRead * tier.inputHit + output * tier.output
  ) / 1_000_000
}

/** Total tokens counted in a bucket pair. */
export function totalTokens(buckets) {
  const peak = buckets?.peak ?? emptyTotals()
  const idle = buckets?.idle ?? emptyTotals()
  return (peak.input ?? 0) + (peak.output ?? 0) + (idle.input ?? 0) + (idle.output ?? 0)
}

/**
 * Estimate the CNY cost of a peak/idle bucket pair.
 *
 * Each bucket is priced with its own tier, so a session that spans the
 * 09:00/12:00 or 14:00/18:00 boundary never prices the whole session at the
 * current window.
 *
 * @param buckets - token counts split by the tier each request ran in.
 * @param model - API model id the requests used.
 * @param atMs - used only to decide retired-route rerating.
 * @param customRates - optional user-supplied rates that win over the card.
 * @returns `{ total, peak, idle, tokens }` in 元, or `undefined` when the model
 *   is unrated or nothing has been spent yet.
 */
export function estimateCostCny(buckets, model, atMs = Date.now(), customRates = undefined) {
  const card = resolveRateCard(model, atMs, customRates)
  if (card === undefined) return undefined
  const tokens = totalTokens(buckets)
  if (tokens <= 0) return undefined
  const peak = bucketCostCny(buckets?.peak ?? emptyTotals(), card.peak)
  const idle = bucketCostCny(buckets?.idle ?? emptyTotals(), card.idle)
  return { total: peak + idle, peak, idle, tokens }
}
