/**
 * DeepSeek official balance adapter.
 *
 * Read-only `GET {base}/user/balance` — the same endpoint behind dsh-tui's
 * built-in `/balance` and this plugin's original implementation. The payload
 * parser stays in `../balance.js` so the two paths cannot drift apart.
 *
 * @module dsh-peak-balance/providers/deepseek
 */

import { parseBalancePayload } from '../balance.js'
import { failSnapshot, okSnapshot } from '../quota.js'
import { bearer, failureReasonOf, fetchJson, trimBase } from './http.js'

/** Adapter id (diagnostics and `/quota`). */
export const ADAPTER_ID = 'deepseek-balance'

/** Pay-as-you-go: a currency balance, debited per token. */
export const BILLING = 'money'

/** Provider routes this adapter claims. */
export const PROVIDER_IDS = Object.freeze(['deepseek-official', 'deepseek'])

/** Base-URL hosts this adapter claims when the route id is unknown. */
export const HOSTS = Object.freeze(['api.deepseek.com'])

/** Base URL used when neither the route profile nor a spec supplies one. */
export const DEFAULT_BASE_URL = 'https://api.deepseek.com'

/**
 * Credential reference used when the route's own configuration does not name one.
 *
 * The official adapter's route is configured by the dsh bundle, whose
 * `apiKeyEnv` is not visible through the settings seam, so the reference the
 * whole ecosystem uses is hard-wired here as a last resort.
 */
export const API_KEY_ENV = 'DEEPSEEK_API_KEY'

/**
 * Collect the account balance.
 *
 * @param options.provider - provider route id.
 * @param options.profile - `{ baseUrl, apiKey }` resolved by the discovery layer.
 * @param options.fetchImpl / options.timeoutMs / options.now - injections.
 * @returns A {@link module:dsh-peak-balance/quota} snapshot.
 */
export async function collect(options = {}) {
  const provider = typeof options.provider === 'string' ? options.provider : ''
  const provenance = { provider, adapter: ADAPTER_ID, at: options.now }
  const apiKey = options.profile?.apiKey
  if (typeof apiKey !== 'string' || apiKey === '') return failSnapshot('no-key', provenance)
  const base = trimBase(options.profile?.baseUrl ?? DEFAULT_BASE_URL)
  const result = await fetchJson(`${base}/user/balance`, {
    headers: bearer(apiKey),
    fetchImpl: options.fetchImpl,
    timeoutMs: options.timeoutMs,
  })
  if (result.ok !== true) {
    return failSnapshot(failureReasonOf(result), { ...provenance, status: result.status })
  }
  const parsed = parseBalancePayload(result.json)
  if (parsed === undefined) return failSnapshot('invalid', provenance)

  // The endpoint may answer in more than one currency at once (a granted CNY
  // balance next to a topped-up USD one). The first entry keeps the canonical
  // `balance` id; the rest get a currency-suffixed id so both remain addressable
  // instead of one silently overwriting the other.
  const meters = parsed.balances.map((entry, index) => ({
    id: index === 0 ? 'balance' : `balance-${String(entry.currency).toUpperCase()}`,
    kind: 'money',
    currency: entry.currency,
    remaining: entry.total,
  }))
  return okSnapshot({ ...provenance, meters, spendCounter: undefined, billing: BILLING })
}
