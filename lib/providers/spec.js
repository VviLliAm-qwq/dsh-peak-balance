/**
 * Declarative provider specs.
 *
 * Not every deployment can be coded: a relay, a self-hosted gateway or a
 * provider this package ships no adapter for still exposes *some* JSON that
 * carries a number worth showing. A spec says which URL to call and where the
 * numbers live inside the response, so such a provider becomes usable without
 * a code change.
 *
 * Everything here treats the file as untrusted input: a malformed document, a
 * missing field or a broken path degrades to "no spec for that provider" — it
 * never throws and never invents a figure. The file is plugin-owned
 * (`~/.dsh-tui/dsh-peak-balance-providers.json`) and safe to delete.
 *
 * @module dsh-peak-balance/providers/spec
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** On-disk shape version; a future migration bumps this. */
export const SPEC_VERSION = 1

/** Meter kinds the display layer knows how to render. */
export const METER_KINDS = Object.freeze(['money', 'credits', 'count'])

/** Reset-time units a spec may declare. */
export const RESET_UNITS = Object.freeze([
  'ms', // absolute epoch milliseconds
  's', // absolute epoch seconds
  'iso', // ISO-8601 timestamp
  'remainingMs', // milliseconds from now (MiniMax-style countdowns)
  'remainingS', // seconds from now
])

/** Default spec location: the ecosystem's TUI state directory. */
export function specPath(env = process.env) {
  const dir = typeof env?.DSH_TUI_STATE_DIR === 'string' && env.DSH_TUI_STATE_DIR !== ''
    ? env.DSH_TUI_STATE_DIR
    : join(homedir(), '.dsh-tui')
  return join(dir, 'dsh-peak-balance-providers.json')
}

/** A trimmed non-empty string, or `undefined`. */
function text(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

/** A finite number, or `undefined`; numeric strings are accepted (many APIs use them). */
export function numberAt(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value.trim())
    return Number.isFinite(parsed) ? parsed : undefined
  }
  return undefined
}

/**
 * Read one dot-separated path out of a decoded JSON value.
 *
 * Segments are object keys; a numeric segment indexes an array, which is what
 * nested report shapes need (`data.0.results.0.amount`). A missing segment
 * yields `undefined` rather than throwing.
 *
 * @param value - decoded JSON.
 * @param path - `'data.quota'`, `'a.0.b'`, or `undefined`.
 */
export function readPath(value, path) {
  const key = text(path)
  if (key === undefined) return undefined
  let current = value
  for (const segment of key.split('.')) {
    if (current === null || current === undefined) return undefined
    if (Array.isArray(current)) {
      const index = Number(segment)
      if (!Number.isInteger(index) || index < 0) return undefined
      current = current[index]
      continue
    }
    if (typeof current !== 'object') return undefined
    current = current[segment]
  }
  return current
}

/**
 * Normalize a reset instant to epoch milliseconds.
 *
 * @param raw - value read from the payload.
 * @param unit - one of {@link RESET_UNITS}; defaults to `'ms'`.
 * @param now - clock used for the relative units.
 * @returns epoch milliseconds, or `undefined` when unusable.
 */
export function resetInstant(raw, unit = 'ms', now = Date.now()) {
  const value = numberAt(raw)
  switch (unit) {
    case 's':
      return value === undefined ? undefined : value * 1000
    case 'remainingMs':
      return value === undefined ? undefined : now + value
    case 'remainingS':
      return value === undefined ? undefined : now + value * 1000
    case 'iso': {
      if (typeof raw !== 'string') return undefined
      const parsed = Date.parse(raw)
      return Number.isFinite(parsed) ? parsed : undefined
    }
    case 'ms':
    default:
      return value
  }
}

/**
 * Normalize one meter declaration.
 *
 * @param raw - untrusted meter object from the spec file.
 * @returns A declaration the adapter can evaluate, or `undefined` when the
 *   meter names no readable value at all.
 */
export function normalizeMeter(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const id = text(raw.id)
  if (id === undefined) return undefined
  const kind = METER_KINDS.includes(raw.kind) ? raw.kind : 'money'
  const valuePath = text(raw.value)
  const usedPath = text(raw.used ?? raw.usedPath)
  const capPath = text(raw.cap ?? raw.capPath)
  const remainingPath = text(raw.remaining ?? raw.remainingPath)
  if (valuePath === undefined && usedPath === undefined && capPath === undefined && remainingPath === undefined) {
    return undefined
  }
  const currency = text(raw.currency)
  const scale = numberAt(raw.scale)
  const resetUnit = RESET_UNITS.includes(raw.resetUnit) ? raw.resetUnit : 'ms'
  return {
    id,
    kind,
    label: text(raw.label),
    currency: kind === 'money' ? (currency === undefined ? undefined : currency.toUpperCase()) : currency,
    scale: scale === undefined ? 1 : scale,
    valuePath,
    usedPath,
    capPath,
    remainingPath,
    resetPath: text(raw.resetAt ?? raw.resetPath),
    resetUnit,
  }
}

/** Normalize one request declaration (URL path, headers, meters). */
export function normalizeRequest(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const path = text(raw.path)
  if (path === undefined) return undefined
  const method = text(raw.method)
  const headers = {}
  if (raw.headers !== null && typeof raw.headers === 'object' && !Array.isArray(raw.headers)) {
    for (const [name, headerValue] of Object.entries(raw.headers)) {
      const normalized = text(headerValue)
      if (normalized !== undefined) headers[name] = normalized
    }
  }
  const meters = []
  for (const entry of Array.isArray(raw.meters) ? raw.meters : []) {
    const meter = normalizeMeter(entry)
    if (meter !== undefined) meters.push(meter)
  }
  return {
    path,
    method: method === undefined ? 'GET' : method.toUpperCase(),
    headers,
    meters,
  }
}

/** Normalize one provider spec. */
export function normalizeProvider(id, raw) {
  const providerId = text(id)
  if (providerId === undefined) return undefined
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const requests = []
  for (const entry of Array.isArray(raw.requests) ? raw.requests : []) {
    const request = normalizeRequest(entry)
    if (request !== undefined) requests.push(request)
  }
  const auth = raw.auth !== null && typeof raw.auth === 'object' && !Array.isArray(raw.auth) ? raw.auth : {}
  const authKind = text(auth.kind)
  return {
    provider: providerId,
    adapter: text(raw.adapter) ?? 'declared',
    baseUrl: text(raw.baseUrl ?? raw.baseURL),
    apiKeyEnv: text(auth.apiKeyEnv ?? raw.apiKeyEnv),
    authKind: authKind === undefined ? 'bearer' : authKind,
    authHeader: text(auth.header),
    // How this provider bills (`money` / `plan`); `auto` lets the data decide.
    billing: raw.billing === 'money' || raw.billing === 'plan' ? raw.billing : 'auto',
    allowUnofficial: raw.allowUnofficial === true,
    requests,
    spendCounter: text(raw.spendCounter),
    spendUnit: normalizeUnit(raw.spendUnit),
  }
}

/** Normalize a `{ kind, currency }` unit declaration. */
export function normalizeUnit(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const kind = METER_KINDS.includes(raw.kind) ? raw.kind : undefined
  if (kind === undefined) return undefined
  const currency = text(raw.currency)
  return currency === undefined ? { kind } : { kind, currency: currency.toUpperCase() }
}

/**
 * Parse a spec document.
 *
 * @param text_ - raw file contents.
 * @returns `{ version, apiBases, providers, allowUnofficial }`; every field
 *   falls back to an empty/neutral value when the document is unusable.
 */
export function parseSpecs(text_) {
  const empty = { version: SPEC_VERSION, apiBases: {}, providers: {}, allowUnofficial: false }
  let parsed
  try {
    parsed = JSON.parse(String(text_ ?? ''))
  } catch {
    return empty
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return empty
  const apiBases = {}
  if (parsed.apiBases !== null && typeof parsed.apiBases === 'object' && !Array.isArray(parsed.apiBases)) {
    for (const [key, value] of Object.entries(parsed.apiBases)) {
      const url = text(value)
      if (url !== undefined) apiBases[key] = url
    }
  }
  const providers = {}
  if (parsed.providers !== null && typeof parsed.providers === 'object' && !Array.isArray(parsed.providers)) {
    for (const [key, value] of Object.entries(parsed.providers)) {
      const provider = normalizeProvider(key, value)
      if (provider !== undefined && provider.requests.length > 0) providers[key] = provider
    }
  }
  return {
    version: SPEC_VERSION,
    apiBases,
    providers,
    allowUnofficial: parsed.allowUnofficial === true,
  }
}

/**
 * Read the spec file.
 *
 * @param options.path - override (settings + tests).
 * @param options.readFile - override (tests).
 * @param options.env - environment for the default path.
 * @returns The parsed document; an absent or unreadable file reads as empty.
 */
export function readSpecs(options = {}) {
  const readFile = options.readFile ?? readFileSync
  const file = options.path ?? specPath(options.env)
  try {
    return parseSpecs(readFile(file, 'utf8'))
  } catch {
    return parseSpecs('')
  }
}
