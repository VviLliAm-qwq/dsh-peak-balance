/**
 * DeepSeek balance payload parsing.
 *
 * The request itself lives in `./providers/deepseek.js` (over the shared
 * `./providers/http.js` helper); this module owns the payload contract so the
 * official adapter cannot drift from the documented `balance_infos` shape.
 *
 * @module dsh-peak-balance/balance
 */

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
