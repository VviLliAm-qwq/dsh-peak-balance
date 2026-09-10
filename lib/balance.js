/**
 * DeepSeek account balance lookup.
 *
 * Read-only official endpoint `GET https://api.deepseek.com/user/balance`
 * (the same one behind the TUI's `/balance` command). The key never leaves
 * this process except in the request header, is never logged, and is never
 * persisted by this plugin.
 *
 * @module dsh-peak-balance/balance
 */

/** Official balance endpoint. */
export const BALANCE_ENDPOINT = 'https://api.deepseek.com/user/balance'

/** Default request timeout in milliseconds. */
export const BALANCE_TIMEOUT_MS = 8000

/**
 * Query the DeepSeek account balance.
 *
 * @param apiKey - `DEEPSEEK_API_KEY` value; an empty string short-circuits.
 * @param options - `fetchImpl` / `baseUrl` / `timeoutMs` overrides (tests).
 * @returns A discriminated result; failures are values, never throws.
 */
export async function fetchBalance(apiKey, options = {}) {
  if (typeof apiKey !== 'string' || apiKey === '') return { ok: false, reason: 'no-key' }
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  if (typeof fetchImpl !== 'function') return { ok: false, reason: 'network' }
  const baseUrl = options.baseUrl
  const endpoint = baseUrl === undefined
    ? BALANCE_ENDPOINT
    : `${String(baseUrl).replace(/\/+$/, '')}/user/balance`
  const timeoutMs = options.timeoutMs ?? BALANCE_TIMEOUT_MS
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  if (typeof timer.unref === 'function') timer.unref()
  try {
    const response = await fetchImpl(endpoint, {
      headers: { authorization: `Bearer ${apiKey}` },
      signal: controller.signal,
    })
    if (response.status === 401 || response.status === 403) {
      return { ok: false, reason: 'unauthorized', status: response.status }
    }
    if (!response.ok) return { ok: false, reason: 'http', status: response.status }
    const payload = await response.json().catch(() => undefined)
    const parsed = parseBalancePayload(payload)
    return parsed ?? { ok: false, reason: 'invalid' }
  } catch {
    return { ok: false, reason: 'network' }
  } finally {
    clearTimeout(timer)
  }
}

/** Parse the documented `balance_infos` payload; `undefined` when malformed. */
export function parseBalancePayload(payload) {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return undefined
  const infos = payload.balance_infos
  if (!Array.isArray(infos)) return undefined
  const balances = []
  for (const raw of infos) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined
    const currency = raw.currency
    const total = parseAmount(raw.total_balance)
    const granted = parseAmount(raw.granted_balance)
    const toppedUp = parseAmount(raw.topped_up_balance)
    if (typeof currency !== 'string' || currency === '' || total === undefined || granted === undefined || toppedUp === undefined) {
      return undefined
    }
    balances.push({ currency, total, granted, toppedUp })
  }
  return { ok: true, isAvailable: payload.is_available === true, balances }
}

function parseAmount(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

/** The CNY balance out of a successful result, or `undefined`. */
export function cnyBalance(result) {
  if (result?.ok !== true) return undefined
  const cny = result.balances.find(entry => String(entry.currency).toUpperCase() === 'CNY')
  return cny ?? result.balances[0]
}
