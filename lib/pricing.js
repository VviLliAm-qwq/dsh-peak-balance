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

/**
 * Display label per provider route.
 *
 * Providers are named exactly as dsh names their routes, so the history board
 * can attribute a bucket to the account it was spent against.
 */
export const PROVIDER_LABELS = Object.freeze({
  'deepseek-official': 'DeepSeek',
  deepseek: 'DeepSeek',
  commandcode: 'Command Code',
})

/**
 * The unit a provider's figures are denominated in.
 *
 * This is what keeps the history board honest: a CNY estimate from the official
 * API and a credit figure from a subscription are different things, and a board
 * that adds them into one number is worse than one that shows two columns.
 * A provider with no unit is unpriced — its rows show tokens and no money.
 *
 * @returns `{ kind: 'money', currency }` / `{ kind: 'credits' }`, or `undefined`.
 */
export const PROVIDER_UNITS = Object.freeze({
  'deepseek-official': Object.freeze({ kind: 'money', currency: 'CNY' }),
  deepseek: Object.freeze({ kind: 'money', currency: 'CNY' }),
  commandcode: Object.freeze({ kind: 'credits' }),
})

/** Human label for a provider id (`''` = unknown → a neutral placeholder). */
export function providerLabelOf(provider) {
  if (typeof provider !== 'string' || provider === '') return '—'
  return PROVIDER_LABELS[provider] ?? provider
}

/** Unit of a provider id, or `undefined` when this build cannot price it. */
export function providerUnitOf(provider) {
  if (typeof provider !== 'string' || provider === '') return undefined
  return PROVIDER_UNITS[provider]
}

/** Comparable identity of a unit (`money:CNY` / `credits` / `''`). */
export function unitKeyOf(unit) {
  if (unit === null || typeof unit !== 'object') return ''
  return unit.kind === 'money' ? `money:${unit.currency ?? ''}` : unit.kind
}

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
  const custom = rateEntryFor(customRates, id)
  if (custom !== undefined) {
    if (usableTier(custom.idle) && usableTier(custom.peak)) return custom
    // Tolerate a flat entry: same rates in both windows.
    if (usableTier(custom)) return { idle: custom, peak: custom }
  }
  return rateCardFor(model, atMs)
}

/**
 * One custom-rate entry for a base model id, tolerating a null/odd map.
 *
 * @param customRates - the stored map.
 * @param id - base model id.
 */
function rateEntryFor(customRates, id) {
  if (customRates === null || typeof customRates !== 'object') return undefined
  const entry = customRates[id]
  return entry !== null && entry !== undefined && typeof entry === 'object' ? entry : undefined
}

/**
 * Rate card for one history bucket key (`provider/model`).
 *
 * A user may price the same model differently per provider (the same weights
 * through a subscription and through a pay-as-you-go key are not the same
 * deal), so a provider-qualified entry is consulted first and the bare model id
 * second — which is what keeps every rate set before this version working.
 *
 * @param key - bucket key from `./history.js` (`provider/model`, or a bare id).
 * @param atMs - instant for retired-route rerating.
 * @param customRates - the stored custom-rate map.
 * @param provider - provider parsed from the key (`''` when unknown).
 * @param model - model parsed from the key.
 */
export function resolveRateCardForKey(key, atMs = Date.now(), customRates = {}, provider = '', model = key) {
  const qualified = provider === '' ? undefined : rateEntryFor(customRates, `${provider}:${baseModelId(model)}`)
  if (qualified !== undefined) {
    if (usableTier(qualified.idle) && usableTier(qualified.peak)) return qualified
    if (usableTier(qualified)) return { idle: qualified, peak: qualified }
  }
  return resolveRateCard(model, atMs, customRates)
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
  const custom = rateEntryFor(customRates, id)
  const usable = custom !== undefined
    && ((usableTier(custom.idle) && usableTier(custom.peak)) || usableTier(custom))
  if (usable) return 'custom'
  return rateCardFor(model, atMs) === undefined ? 'unknown' : 'builtin'
}

/**
 * Provenance of the rates one bucket key is priced with (see
 * {@link resolveRateCardForKey}).
 */
export function rateSourceForKey(key, customRates = {}, atMs = Date.now(), provider = '', model = key) {
  const qualified = provider === '' ? undefined : rateEntryFor(customRates, `${provider}:${baseModelId(model)}`)
  if (qualified !== undefined && ((usableTier(qualified.idle) && usableTier(qualified.peak)) || usableTier(qualified))) {
    return 'custom'
  }
  return rateSourceOf(model, customRates, atMs)
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

/**
 * Total tokens counted in a bucket pair.
 *
 * Same semantics as `./history.js` `totalTokensOf` and the provider's own
 * `totalTokens`: every reported count is additive (`input + cacheRead +
 * cacheWrite + output`). Cache reads dominate a warm session, so a counter
 * that dropped them under-reported a real turn by orders of magnitude (one
 * sampled turn: 61k instead of 31.3M) and made the `tokens <= 0` guard in
 * {@link estimateCostCny} read a cache-only report as "nothing spent".
 */
export function totalTokens(buckets) {
  const peak = buckets?.peak ?? emptyTotals()
  const idle = buckets?.idle ?? emptyTotals()
  return (
    (peak.input ?? 0) + (peak.cacheRead ?? 0) + (peak.cacheWrite ?? 0) + (peak.output ?? 0) +
    (idle.input ?? 0) + (idle.cacheRead ?? 0) + (idle.cacheWrite ?? 0) + (idle.output ?? 0)
  )
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
