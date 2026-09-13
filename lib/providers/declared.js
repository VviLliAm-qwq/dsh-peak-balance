/**
 * Spec-driven adapter — the catch-all.
 *
 * Reads one provider entry from the declarative spec file
 * (`~/.dsh-tui/dsh-peak-balance-providers.json`), calls the URLs it names and
 * pulls meters out of the responses through dot paths. This is what makes the
 * plugin extensible without a release: a relay nobody shipped an adapter for is
 * still one JSON stanza away.
 *
 * @module dsh-peak-balance/providers/declared
 */

import { failSnapshot, okSnapshot } from '../quota.js'
import { fetchJson, trimBase } from './http.js'
import { readPath, resetInstant } from './spec.js'

/** Adapter id (diagnostics and `/quota`). */
export const ADAPTER_ID = 'declared'

/** Evaluate one meter declaration against one decoded response. */
export function evaluateMeter(meter, payload, now) {
  const scale = typeof meter.scale === 'number' && Number.isFinite(meter.scale) ? meter.scale : 1
  const read = path => {
    if (path === undefined) return undefined
    const value = readPath(payload, path)
    if (typeof value === 'number' && Number.isFinite(value)) return value * scale
    if (typeof value === 'string' && value.trim() !== '') {
      const parsed = Number(value.trim())
      return Number.isFinite(parsed) ? parsed * scale : undefined
    }
    return undefined
  }
  const used = read(meter.usedPath)
  const cap = read(meter.capPath)
  const remaining = read(meter.remainingPath)
  const value = read(meter.valuePath)
  const raw = { id: meter.id, kind: meter.kind, currency: meter.currency, used, cap, remaining }
  // A single `value` path is the common short form: it says "here is the number
  // this meter is about" and its meaning follows the id.
  if (value !== undefined && used === undefined && cap === undefined && remaining === undefined) {
    if (meter.id === 'balance' || meter.id === 'planRemaining') raw.remaining = value
    else raw.used = value
  }
  if (meter.id === 'balance' && raw.remaining === undefined && used !== undefined) {
    // A provider that reports a consumed amount against a known cap.
    raw.remaining = cap === undefined ? used : cap - used
  }
  if (meter.resetPath !== undefined) {
    const instant = resetInstant(readPath(payload, meter.resetPath), meter.resetUnit, now)
    if (instant !== undefined) raw.resetAt = instant
  }
  if (meter.label !== undefined) raw.label = meter.label
  return raw
}

/**
 * Collect from a declared provider.
 *
 * Requests answer independently: one failing URL is recorded in `failures`
 * while the rest still contribute meters, and only a total failure becomes a
 * failed snapshot.
 *
 * @param options.provider - provider route id.
 * @param options.profile - `{ baseUrl, apiKey }` resolved by discovery.
 * @param options.spec - normalized provider spec (`./spec.js`).
 */
export async function collect(options = {}) {
  const provider = typeof options.provider === 'string' ? options.provider : ''
  const provenance = { provider, adapter: ADAPTER_ID, at: options.now }
  const spec = options.spec
  if (spec === undefined || !Array.isArray(spec.requests) || spec.requests.length === 0) {
    return failSnapshot('unsupported', provenance)
  }
  const base = trimBase(options.profile?.baseUrl ?? spec.baseUrl ?? '')
  if (base === '') return failSnapshot('unsupported', provenance)
  const apiKey = options.profile?.apiKey
  if (spec.authKind !== 'none' && (typeof apiKey !== 'string' || apiKey === '')) {
    return failSnapshot('no-key', provenance)
  }
  const now = typeof options.now === 'number' ? options.now : Date.now()

  const headers = {}
  if (spec.authKind === 'bearer') headers.authorization = `Bearer ${apiKey}`
  else if (spec.authKind === 'header') headers[spec.authHeader ?? 'authorization'] = apiKey
  else if (spec.authKind === 'x-api-key') headers['x-api-key'] = apiKey

  const results = await Promise.all(spec.requests.map(request => fetchJson(`${base}${request.path}`, {
    method: request.method,
    headers: { ...headers, ...request.headers },
    fetchImpl: options.fetchImpl,
    timeoutMs: options.timeoutMs,
  })))

  const failures = []
  const meters = []
  let counterValue
  results.forEach((result, index) => {
    const request = spec.requests[index]
    if (result.ok !== true) {
      failures.push(`${request.path}: ${result.status === undefined ? result.reason : `HTTP ${result.status}`}`)
      return
    }
    for (const meter of request.meters) {
      meters.push(evaluateMeter(meter, result.json, now))
    }
    if (spec.spendCounter !== undefined && counterValue === undefined) {
      const raw = readPath(result.json, spec.spendCounter)
      const numeric = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : undefined
      if (typeof numeric === 'number' && Number.isFinite(numeric)) counterValue = numeric
    }
  })
  const counterUnit = counterValue === undefined ? undefined : spec.spendUnit ?? unitOfPath(meters, spec)
  const snapshot = okSnapshot({
    ...provenance,
    meters,
    spendCounter: counterValue === undefined ? undefined : { id: spec.spendCounter, value: counterValue, unit: counterUnit },
    billing: spec.billing ?? 'auto',
    failures,
  })
  // A 200 whose paths all miss is not a success: normalization drops every
  // unusable meter, and "no readable number" must read as invalid rather than
  // as a provider that happens to have nothing to show.
  if (snapshot.meters.length === 0 && snapshot.spendCounter === undefined) {
    const first = results.find(result => result.ok !== true)
    if (first === undefined) return failSnapshot('invalid', { ...provenance, detail: failures.join('; ') })
    const status = first.status
    if (status === 401 || status === 403) return failSnapshot('unauthorized', { ...provenance, status, detail: failures.join('; ') })
    if (typeof status === 'number') return failSnapshot('http', { ...provenance, status, detail: failures.join('; ') })
    return failSnapshot('network', { ...provenance, detail: failures.join('; ') })
  }
  return snapshot
}

/**
 * Unit for a spend counter that declared none.
 *
 * The counter is usually the same number as one of the meters (a relay's
 * `used_quota` feeds both the period-spend meter and the counter), so the
 * meter's unit is inherited. `usedPath` is preserved on each evaluated meter
 * for exactly this lookup.
 */
function unitOfPath(meters, spec) {
  for (const request of spec.requests) {
    for (const meter of request.meters) {
      if (meter.usedPath !== undefined && meter.usedPath === spec.spendCounter) {
        return { kind: meter.kind, currency: meter.currency }
      }
    }
  }
  return undefined
}
