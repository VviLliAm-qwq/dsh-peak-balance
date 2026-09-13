/**
 * The one HTTP helper every adapter shares.
 *
 * Adapters differ in URLs and payload shapes only; timeouts, aborts and the
 * network-vs-HTTP classification are identical, and a single implementation is
 * what keeps an adapter from forgetting to clear its timer.
 *
 * Failures are values, never throws — the same discipline `./balance.js`
 * already follows, because a quota probe must never take the session down.
 *
 * @module dsh-peak-balance/providers/http
 */

/** Default per-request timeout. */
export const HTTP_TIMEOUT_MS = 8000

/**
 * Fetch one JSON document.
 *
 * @param url - absolute URL.
 * @param options.headers - request headers (already complete; no merging here).
 * @param options.timeoutMs - override of {@link HTTP_TIMEOUT_MS}.
 * @param options.fetchImpl - injected fetch (tests).
 * @param options.method - HTTP method, default `GET`.
 * @returns `{ ok: true, status, json }`, or
 *   `{ ok: false, reason: 'network' | 'http', status? }`.
 */
export async function fetchJson(url, options = {}) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  if (typeof fetchImpl !== 'function') return { ok: false, reason: 'network' }
  const timeoutMs = typeof options.timeoutMs === 'number' ? options.timeoutMs : HTTP_TIMEOUT_MS
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  if (typeof timer.unref === 'function') timer.unref()
  try {
    const response = await fetchImpl(url, {
      method: typeof options.method === 'string' ? options.method : 'GET',
      headers: options.headers ?? {},
      signal: controller.signal,
    })
    const status = typeof response?.status === 'number' ? response.status : 0
    if (response?.ok !== true) return { ok: false, reason: 'http', status }
    let json
    try {
      json = await response.json()
    } catch {
      return { ok: false, reason: 'invalid', status }
    }
    return { ok: true, status, json }
  } catch {
    return { ok: false, reason: 'network' }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Map one {@link fetchJson} failure onto the quota failure vocabulary.
 *
 * 401/403 is `unauthorized` (a rejected or under-privileged key is the one
 * failure a user can act on), every other status is `http`, and a transport
 * problem is `network`.
 */
export function failureReasonOf(result) {
  if (result?.ok === true) return undefined
  if (result?.reason === 'invalid') return 'invalid'
  if (result?.reason === 'http') {
    return result.status === 401 || result.status === 403 ? 'unauthorized' : 'http'
  }
  return 'network'
}

/** Strip trailing slashes from a base URL. */
export function trimBase(base) {
  return String(base ?? '').replace(/\/+$/, '')
}

/** Bearer authorization header. */
export function bearer(apiKey) {
  return { authorization: `Bearer ${apiKey}` }
}
