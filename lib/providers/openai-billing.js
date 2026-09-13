/**
 * OpenAI-compatible billing adapter — the relay/gateway case.
 *
 * One API, New API and most self-hosted gateways implement the (never
 * officially documented) dashboard billing pair and authenticate it with the
 * relay key itself:
 *
 * | request | meaning of the fields |
 * | --- | --- |
 * | `GET {root}/v1/dashboard/billing/subscription` | `soft_limit_usd` / `hard_limit_usd` = the account's **total grant**, not what is left |
 * | `GET {root}/v1/dashboard/billing/usage` | `total_usage` in **hundredths** of the same unit |
 *
 * The names are inherited from OpenAI's dashboard and are misleading on these
 * relays: One API's `controller/billing.go` answers
 * `soft_limit_usd = hard_limit_usd = system_hard_limit_usd = (remaining + used)`,
 * so the remaining balance is `limit − total_usage / 100`. See {@link parseBilling}.
 *
 * Both figures are in **quota-display units, not necessarily USD**: the relay
 * divides by its own `QuotaPerUnit` only when currency display is enabled, and a
 * site whose display type is CNY (or raw tokens) answers in that unit under the
 * same `_usd` field names. A provider spec may override the currency through its
 * `spendUnit` stanza; USD is only the default.
 *
 * A provider that does not implement the pair answers 404 — which is reported
 * as `unsupported`, not as an error, because "this endpoint does not exist
 * here" is the expected answer for a first-party provider.
 *
 * @module dsh-peak-balance/providers/openai-billing
 */

import { failSnapshot, okSnapshot } from '../quota.js'
import { bearer, failureReasonOf, fetchJson, trimBase } from './http.js'

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
 * The limit fields are read as the relay writes them, which is *not* what their
 * names promise: New API / One API answer `soft = hard = system_hard` holding
 * the **total grant** (`remaining + used`), while `/usage` holds the cumulative
 * consumption. Remaining is therefore derived (`limit − spent`) rather than
 * taken from `soft_limit_usd`; reading that field as "what is left" over-reports
 * by everything already spent and makes `remaining / cap` a constant 100%.
 *
 * One shape does carry a remaining value: a gateway that answers
 * `soft_limit_usd !== hard_limit_usd` is honouring the old OpenAI dashboard
 * convention, so `soft` is the remaining and `hard` the grant.
 *
 * Without a usage figure the remaining balance is unknown — the meter keeps the
 * grant and carries no `remaining`, because any substitute here would be an
 * over-report.
 *
 * @param input.currency - unit the two numbers are in; defaults to `USD`.
 * @returns `{ meters, spendCounter }`; `spendCounter` is the account's
 *   cumulative consumption, which makes per-turn spend measurable on a relay.
 */
export function parseBilling(input = {}) {
  const subscription = input.subscription !== null && typeof input.subscription === 'object' ? input.subscription : undefined
  const usage = input.usage !== null && typeof input.usage === 'object' ? input.usage : undefined
  const currency = typeof input.currency === 'string' && input.currency.trim() !== ''
    ? input.currency.trim().toUpperCase()
    : 'USD'
  const meters = []

  const soft = num(subscription?.soft_limit_usd)
  const hard = num(subscription?.hard_limit_usd)
  const cents = num(usage?.total_usage)
  const spent = cents === undefined ? undefined : cents / 100
  // The one shape that really reports a remaining amount in `soft`.
  const separateRemaining = soft !== undefined && hard !== undefined && soft !== hard
  // Everywhere else both fields hold the same grant; a lone field is read the
  // same way, which at worst under-reports the remaining (never over-reports).
  const limit = separateRemaining ? hard : (hard ?? soft)
  const unlimited = limit !== undefined && limit >= UNLIMITED
  if (!unlimited && (separateRemaining || limit !== undefined)) {
    const remaining = separateRemaining
      ? soft
      : (spent === undefined || limit === undefined ? undefined : limit - spent)
    const cap = limit !== undefined && limit > 0 && limit < UNLIMITED ? limit : undefined
    if (remaining !== undefined || cap !== undefined) {
      meters.push({ id: 'balance', kind: 'money', currency, remaining, cap })
    }
  }

  if (spent !== undefined) {
    // A cumulative figure, not a period one: One API's `/usage` ignores any
    // date range, so calling it "period spend" would mislabel it.
    meters.push({ id: 'lifetimeSpend', kind: 'money', currency, used: spent, label: 'lifetime' })
  }

  return {
    meters,
    spendCounter: spent === undefined
      ? undefined
      : { id: 'billing.total_usage', value: spent, unit: { kind: 'money', currency } },
  }
}

/**
 * The unit a relay's figures are in, from the provider spec.
 *
 * The billing pair speaks the relay's quota-display unit, so a spec that forces
 * this adapter (`adapter: "openai-billing"`) can name it with the same
 * `spendUnit` stanza it already uses for the spend counter. Absent means USD,
 * which is right for the default USD display type only.
 */
export function billingCurrency(spec) {
  const declared = spec?.spendUnit?.currency
  return typeof declared === 'string' && declared.trim() !== '' ? declared.trim().toUpperCase() : 'USD'
}

/**
 * Collect the relay's balance.
 *
 * @param options.profile - `{ baseUrl, apiKey }`.
 * @param options.spec - the provider's spec stanza; its `spendUnit` names the
 *   unit the relay's numbers are in when that is not USD (see {@link billingCurrency}).
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
    currency: billingCurrency(options.spec),
  })
  if (parsed.meters.length === 0 && parsed.spendCounter === undefined) {
    return failSnapshot('invalid', provenance)
  }
  const failures = []
  // A transport failure has no status: naming the reason beats "HTTP undefined".
  const note = result => (typeof result.status === 'number' ? `HTTP ${result.status}` : failureReasonOf(result))
  if (subscriptionResult.ok !== true) failures.push(`subscription: ${note(subscriptionResult)}`)
  if (usageResult.ok !== true) failures.push(`usage: ${note(usageResult)}`)
  return okSnapshot({ ...provenance, ...parsed, billing: BILLING, failures })
}
