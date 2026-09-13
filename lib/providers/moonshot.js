/**
 * Moonshot / Kimi open-platform balance adapter.
 *
 * `GET {base}/users/me/balance` answers the account's available balance; the
 * international host bills in USD and the CN host in CNY, so the currency is
 * derived from the endpoint rather than assumed.
 *
 * Source: <https://platform.kimi.ai/docs/api/balance>. The `voucher_balance` /
 * `cash_balance` split comes from the same payload (documented by third-party
 * clients); they are surfaced only when non-zero, because an account with a
 * cash balance and no voucher does not need a zero on the line.
 *
 * @module dsh-peak-balance/providers/moonshot
 */

import { failSnapshot, okSnapshot } from '../quota.js'
import { bearer, failureReasonOf, fetchJson, trimBase } from './http.js'

/** Adapter id (diagnostics and `/quota`). */
export const ADAPTER_ID = 'moonshot-balance'

/** Pay-as-you-go: a currency balance (voucher plus cash). */
export const BILLING = 'money'

/** Provider routes this adapter claims (pi-ai ships the first two). */
export const PROVIDER_IDS = Object.freeze(['moonshotai', 'moonshotai-cn', 'moonshot', 'kimi'])

/** Base-URL hosts this adapter claims when the route id is unknown. */
export const HOSTS = Object.freeze(['api.moonshot.cn', 'api.moonshot.ai'])

/** Default endpoint (the CN host, which is where most accounts live). */
export const DEFAULT_BASE_URL = 'https://api.moonshot.cn/v1'

/** Credential reference used when the route configuration names none. */
export const API_KEY_ENV = 'MOONSHOT_API_KEY'

/** A finite number out of an untrusted value, or `undefined`. */
function num(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value.trim())
    return Number.isFinite(parsed) ? parsed : undefined
  }
  return undefined
}

/** The balance's currency, decided by the host the request went to. */
export function currencyOf(baseUrl) {
  return String(baseUrl ?? '').includes('moonshot.cn') ? 'CNY' : 'USD'
}

/** Parse the payload into meters. */
export function parseMoonshot(payload, currency) {
  const data = payload?.data !== null && typeof payload?.data === 'object' ? payload.data : undefined
  if (data === undefined) return undefined
  const available = num(data.available_balance)
  if (available === undefined) return undefined
  const meters = [{ id: 'balance', kind: 'money', currency, remaining: available }]
  const voucher = num(data.voucher_balance)
  if (voucher !== undefined && voucher > 0) {
    meters.push({ id: 'balance-voucher', kind: 'money', currency, remaining: voucher })
  }
  const cash = num(data.cash_balance)
  if (cash !== undefined && cash > 0) {
    meters.push({ id: 'balance-cash', kind: 'money', currency, remaining: cash })
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
  const result = await fetchJson(`${base}/users/me/balance`, {
    headers: bearer(apiKey),
    fetchImpl: options.fetchImpl,
    timeoutMs: options.timeoutMs,
  })
  if (result.ok !== true) return failSnapshot(failureReasonOf(result), { ...provenance, status: result.status })
  const parsed = parseMoonshot(result.json, currencyOf(base))
  if (parsed === undefined) return failSnapshot('invalid', provenance)
  return okSnapshot({ ...provenance, ...parsed, billing: BILLING })
}
