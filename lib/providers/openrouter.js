/**
 * OpenRouter adapter.
 *
 * Two endpoints, deliberately both: `/credits` reports the account's purchased
 * credits but requires a **management key** (a normal key is refused with 403),
 * while `/key` answers for an ordinary key and carries the key's own usage,
 * limits and rolling windows. Whichever answers contributes meters, so an
 * account with only a normal key still gets a useful line.
 *
 * | request | fields used |
 * | --- | --- |
 * | `GET {base}/credits` | `data.total_credits`, `data.total_usage` (USD) |
 * | `GET {base}/key` | `data.limit`, `data.limit_remaining`, `data.usage`, `data.usage_daily/weekly/monthly` (USD) |
 *
 * Sources: <https://openrouter.ai/docs/api/api-reference/credits/get-remaining-credits>,
 * <https://openrouter.ai/docs/api/api-reference/api-keys/get-current-api-key>.
 *
 * @module dsh-peak-balance/providers/openrouter
 */

import { failSnapshot, okSnapshot } from '../quota.js'
import { bearer, failureReasonOf, fetchJson, trimBase } from './http.js'

/** Adapter id (diagnostics and `/quota`). */
export const ADAPTER_ID = 'openrouter'

/** Prepaid credits: a currency balance plus key-level usage limits. */
export const BILLING = 'money'

/** Provider routes this adapter claims. */
export const PROVIDER_IDS = Object.freeze(['openrouter'])

/** Base-URL hosts this adapter claims when the route id is unknown. */
export const HOSTS = Object.freeze(['openrouter.ai'])

/** Base URL used when neither the route profile nor a spec supplies one. */
export const DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1'

/** Credential reference used when the route configuration names none. */
export const API_KEY_ENV = 'OPENROUTER_API_KEY'

/** A finite number out of an untrusted value, or `undefined`. */
function num(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value.trim())
    return Number.isFinite(parsed) ? parsed : undefined
  }
  return undefined
}

/**
 * Parse the two payloads into meters.
 *
 * @returns `{ meters, spendCounter }`; the counter is the key's cumulative
 *   usage in USD, which is what makes a per-turn figure measurable here.
 */
export function parseOpenRouter(input = {}) {
  const credits = input.credits !== null && typeof input.credits === 'object' ? input.credits : undefined
  const key = input.key !== null && typeof input.key === 'object' ? input.key : undefined
  const meters = []

  const totalCredits = num(credits?.data?.total_credits)
  const totalUsage = num(credits?.data?.total_usage)
  if (totalCredits !== undefined) {
    const remaining = totalUsage === undefined ? undefined : totalCredits - totalUsage
    if (remaining !== undefined) meters.push({ id: 'balance', kind: 'money', currency: 'USD', remaining, cap: totalCredits })
  }

  const keyData = key?.data !== null && typeof key?.data === 'object' ? key.data : undefined
  const limit = num(keyData?.limit)
  const limitRemaining = num(keyData?.limit_remaining)
  if (limitRemaining !== undefined && limit !== undefined) {
    meters.push({ id: 'keyLimit', kind: 'money', currency: 'USD', remaining: limitRemaining, cap: limit })
  }

  for (const [id, field] of [['windowDaily', 'usage_daily'], ['windowWeekly', 'usage_weekly'], ['windowMonthly', 'usage_monthly']]) {
    const used = num(keyData?.[field])
    if (used !== undefined) meters.push({ id, kind: 'money', currency: 'USD', used })
  }

  const usage = num(keyData?.usage)
  if (usage !== undefined) meters.push({ id: 'periodSpend', kind: 'money', currency: 'USD', used: usage })

  return {
    meters,
    spendCounter: usage === undefined
      ? undefined
      : { id: 'key.usage', value: usage, unit: { kind: 'money', currency: 'USD' } },
  }
}

/** Collect the account state. */
export async function collect(options = {}) {
  const provider = typeof options.provider === 'string' ? options.provider : ''
  const provenance = { provider, adapter: ADAPTER_ID, at: options.now }
  const apiKey = options.profile?.apiKey
  if (typeof apiKey !== 'string' || apiKey === '') return failSnapshot('no-key', provenance)
  const base = trimBase(options.profile?.baseUrl ?? DEFAULT_BASE_URL)
  const request = path => fetchJson(`${base}${path}`, {
    headers: bearer(apiKey),
    fetchImpl: options.fetchImpl,
    timeoutMs: options.timeoutMs,
  })

  const [creditsResult, keyResult] = await Promise.all([request('/credits'), request('/key')])
  const failures = []
  if (creditsResult.ok !== true) failures.push(`credits: HTTP ${creditsResult.status ?? failureReasonOf(creditsResult)}`)
  if (keyResult.ok !== true) failures.push(`key: HTTP ${keyResult.status ?? failureReasonOf(keyResult)}`)

  if (creditsResult.ok !== true && keyResult.ok !== true) {
    // A normal key is refused `/credits` with 403 by design; when `/key` also
    // fails, the key itself is the problem, so that status is the honest answer.
    const status = keyResult.status ?? creditsResult.status
    if (status === 401 || status === 403) return failSnapshot('unauthorized', { ...provenance, status, detail: failures.join('; ') })
    if (typeof status === 'number') return failSnapshot('http', { ...provenance, status, detail: failures.join('; ') })
    return failSnapshot('network', { ...provenance, detail: failures.join('; ') })
  }

  const parsed = parseOpenRouter({
    credits: creditsResult.ok === true ? creditsResult.json : undefined,
    key: keyResult.ok === true ? keyResult.json : undefined,
  })
  if (parsed.meters.length === 0 && parsed.spendCounter === undefined) {
    return failSnapshot('invalid', { ...provenance, detail: failures.join('; ') })
  }
  return okSnapshot({ ...provenance, ...parsed, billing: BILLING, failures })
}
