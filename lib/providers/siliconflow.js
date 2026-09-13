/**
 * SiliconFlow balance adapter.
 *
 * `GET {base}/user/info` reports the account's balance, its charged part and the
 * total. The figures arrive as **strings** and the API documentation does not
 * state a currency, so the meter deliberately carries none: the line shows the
 * number the provider returned instead of stamping a currency symbol on it.
 *
 * Source: <https://docs.siliconflow.com/en/api-reference/userinfo/get-user-info>.
 *
 * @module dsh-peak-balance/providers/siliconflow
 */

import { failSnapshot, okSnapshot } from '../quota.js'
import { bearer, failureReasonOf, fetchJson, trimBase } from './http.js'

/** Adapter id (diagnostics and `/quota`). */
export const ADAPTER_ID = 'siliconflow-balance'

/** Pay-as-you-go: a currency balance. */
export const BILLING = 'money'

/** Provider routes this adapter claims. */
export const PROVIDER_IDS = Object.freeze(['siliconflow'])

/** Base-URL hosts this adapter claims when the route id is unknown. */
export const HOSTS = Object.freeze(['api.siliconflow.com', 'api.siliconflow.cn'])

/** Default endpoint (the international host). */
export const DEFAULT_BASE_URL = 'https://api.siliconflow.com/v1'

/** Credential reference used when the route configuration names none. */
export const API_KEY_ENV = 'SILICONFLOW_API_KEY'

/** A finite number out of an untrusted value (the API answers in strings). */
function num(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value.trim())
    return Number.isFinite(parsed) ? parsed : undefined
  }
  return undefined
}

/**
 * Parse the payload into meters.
 *
 * `totalBalance` is the headline when the payload carries it: the schema
 * (verified against the provider's own `openapi.yaml`) defines `balance` next to
 * `chargeBalance` and `totalBalance` with the sample `0.88 / 88.00 / 88.88`, so
 * `balance` alone is the promotional part and a recharged account would read
 * near zero. `balance` remains the fallback for a payload that omits the total.
 *
 * The two parts ride along under ids the display layer has no i18n label for, so
 * they carry a short `label` of their own; the amounts stay in the payload's own
 * unit, which the API never names.
 */
export function parseSiliconflow(payload) {
  const data = payload?.data !== null && typeof payload?.data === 'object' ? payload.data : undefined
  if (data === undefined) return undefined
  const balance = num(data.balance)
  const total = num(data.totalBalance)
  const charged = num(data.chargeBalance)
  if (balance === undefined && total === undefined && charged === undefined) return undefined
  const meters = []
  const headline = total ?? balance
  if (headline !== undefined) meters.push({ id: 'balance', kind: 'money', remaining: headline })
  if (total !== undefined && balance !== undefined && balance !== total) {
    meters.push({ id: 'balance-granted', kind: 'money', remaining: balance, label: 'gift' })
  }
  if (charged !== undefined && charged > 0 && charged !== headline && charged !== balance) {
    meters.push({ id: 'balance-charged', kind: 'money', remaining: charged, label: 'recharged' })
  }
  return { meters }
}

/** Collect the balance. */
export async function collect(options = {}) {
  const provider = typeof options.provider === 'string' ? options.provider : ''
  const provenance = { provider, adapter: ADAPTER_ID, at: options.now }
  const apiKey = options.profile?.apiKey
  if (typeof apiKey !== 'string' || apiKey === '') return failSnapshot('no-key', provenance)
  const base = trimBase(options.profile?.baseUrl ?? DEFAULT_BASE_URL)
  const result = await fetchJson(`${base}/user/info`, {
    headers: bearer(apiKey),
    fetchImpl: options.fetchImpl,
    timeoutMs: options.timeoutMs,
  })
  if (result.ok !== true) return failSnapshot(failureReasonOf(result), { ...provenance, status: result.status })
  const parsed = parseSiliconflow(result.json)
  if (parsed === undefined) return failSnapshot('invalid', provenance)
  return okSnapshot({ ...provenance, ...parsed, billing: BILLING })
}
