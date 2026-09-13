/**
 * OpenAI-compatible billing adapter — the relay/gateway case.
 *
 * One API, New API and most self-hosted gateways implement the (never
 * officially documented) dashboard billing pair and authenticate it with the
 * relay key itself:
 *
 * | request | meaning of the fields |
 * | --- | --- |
 * | `GET {root}/v1/dashboard/billing/subscription` | `soft_limit_usd` = remaining, `hard_limit_usd` = remaining + used |
 * | `GET {root}/v1/dashboard/billing/usage` | `total_usage` in **cents** |
 *
 * Both figures are USD; the conversion from the gateway's internal quota points
 * (1 USD = 500,000) happens server-side, so nothing here needs the ratio.
 *
 * A provider that does not implement the pair answers 404 — which is reported
 * as `unsupported`, not as an error, because "this endpoint does not exist
 * here" is the expected answer for a first-party provider.
 *
 * @module dsh-peak-balance/providers/openai-billing
 */

import { failSnapshot, okSnapshot } from '../quota.js'
import { bearer, fetchJson, trimBase } from './http.js'

/** Adapter id (diagnostics and `/quota`). */
export const ADAPTER_ID = 'openai-billing'

/** A relay may bill either way, so its own figures decide. */
export const BILLING = 'auto'

/** Provider routes this adapter claims outright. */
export const PROVIDER_IDS = Object.freeze([])

/** Hosts known to implement the pair (claimed when the route id is unknown). */
export const HOSTS = Object.freeze([])

/** The infinite-quota sentinel One API/New API return for unlimited tokens. */
const UNLIMITED = 100_000_000

/** A finite number, or `undefined`. */
function num(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value.trim())
    return Number.isFinite(parsed) ? parsed : undefined
  }
  return undefined
}

/**
 * The two billing URLs for one configured base URL.
 *
 * A route's base URL is stored either as the API root (`https://host`) or as
 * the versioned root (`https://host/v1`); both spellings are common and the
 * billing pair always lives under `/v1`, so the `/v1` suffix is normalized away
 * before it is appended.
 */
export function billingUrls(base) {
  const root = trimBase(base)
  const stripped = root.endsWith('/v1') ? root.slice(0, -3) : root
  return {
    subscription: `${stripped}/v1/dashboard/billing/subscription`,
    usage: `${stripped}/v1/dashboard/billing/usage`,
  }
}

/**
 * Parse the two payloads into meters.
 *
 * @returns `{ meters, spendCounter }`; `spendCounter` is the account's used
 *   total in USD, which makes per-turn spend measurable on a relay.
 */
export function parseBilling(input = {}) {
  const subscription = input.subscription !== null && typeof input.subscription === 'object' ? input.subscription : undefined
  const usage = input.usage !== null && typeof input.usage === 'object' ? input.usage : undefined
  const meters = []

  const remaining = num(subscription?.soft_limit_usd)
  const total = num(subscription?.hard_limit_usd)
  const unlimited = remaining !== undefined && remaining >= UNLIMITED
  if (remaining !== undefined && !unlimited) {
    const cap = total !== undefined && total > 0 && total < UNLIMITED ? total : undefined
    meters.push({ id: 'balance', kind: 'money', currency: 'USD', remaining, cap })
  }

  const cents = num(usage?.total_usage)
  const spent = cents === undefined ? undefined : cents / 100
  if (spent !== undefined) {
    meters.push({ id: 'periodSpend', kind: 'money', currency: 'USD', used: spent })
  }

  return {
    meters,
    spendCounter: spent === undefined
      ? undefined
      : { id: 'billing.total_usage', value: spent, unit: { kind: 'money', currency: 'USD' } },
  }
}

/**
 * Collect the relay's balance.
 *
 * @param options.profile - `{ baseUrl, apiKey }`.
 */
export async function collect(options = {}) {
  const provider = typeof options.provider === 'string' ? options.provider : ''
  const provenance = { provider, adapter: ADAPTER_ID, at: options.now }
  const apiKey = options.profile?.apiKey
  if (typeof apiKey !== 'string' || apiKey === '') return failSnapshot('no-key', provenance)
  const urls = billingUrls(options.profile?.baseUrl ?? '')
  if (urls.subscription.startsWith('/v1')) return failSnapshot('unsupported', provenance)

  const request = url => fetchJson(url, {
    headers: bearer(apiKey),
    fetchImpl: options.fetchImpl,
    timeoutMs: options.timeoutMs,
  })
  const [subscriptionResult, usageResult] = await Promise.all([request(urls.subscription), request(urls.usage)])

  if (subscriptionResult.ok !== true && usageResult.ok !== true) {
    // 404 from both is the honest "no billing pair here" answer.
    const statuses = [subscriptionResult.status, usageResult.status].filter(status => typeof status === 'number')
    const missing = statuses.length === 2 && statuses.every(status => status === 404 || status === 405)
    const status = subscriptionResult.status ?? usageResult.status
    if (missing) return failSnapshot('unsupported', { ...provenance, status })
    if (status === 401 || status === 403) return failSnapshot('unauthorized', { ...provenance, status })
    if (typeof status === 'number') return failSnapshot('http', { ...provenance, status })
    return failSnapshot('network', provenance)
  }

  const parsed = parseBilling({
    subscription: subscriptionResult.ok === true ? subscriptionResult.json : undefined,
    usage: usageResult.ok === true ? usageResult.json : undefined,
  })
  if (parsed.meters.length === 0 && parsed.spendCounter === undefined) {
    return failSnapshot('invalid', provenance)
  }
  const failures = []
  if (subscriptionResult.ok !== true) failures.push(`subscription: HTTP ${subscriptionResult.status}`)
  if (usageResult.ok !== true) failures.push(`usage: HTTP ${usageResult.status}`)
  return okSnapshot({ ...provenance, ...parsed, billing: BILLING, failures })
}
