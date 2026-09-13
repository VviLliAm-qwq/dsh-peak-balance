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

/** Parse the payload into meters. */
export function parseSiliconflow(payload) {
  const data = payload?.data !== null && typeof payload?.data === 'object' ? payload.data : undefined
  if (data === undefined) return undefined
  const balance = num(data.balance)
  const total = num(data.totalBalance)
  const charged = num(data.chargeBalance)
  if (balance === undefined && total === undefined) return undefined
  const meters = []
  // `balance` is the spendable figure and the one the console shows first.
  if (balance !== undefined) meters.push({ id: 'balance', kind: 'money', remaining: balance })
  if (total !== undefined && total !== balance) meters.push({ id: 'balance-total', kind: 'money', remaining: total })
  if (charged !== undefined && charged > 0 && charged !== balance && charged !== total) {
    meters.push({ id: 'balance-charged', kind: 'money', remaining: charged })
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
