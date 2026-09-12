/**
 * User-supplied model rates.
 *
 * The embedded rate card (`./pricing.js`) is a snapshot of one pricing page:
 * it cannot know a model DeepSeek never listed there, and it deliberately
 * refuses to guess (an unrated model renders tokens without a CNY figure).
 * `/th price` closes that gap by letting the user set the missing rates; they
 * are stored here and win over the card.
 *
 * Storage is a small plugin-owned JSON file (`~/.dsh-tui/dsh-peak-balance-rates.json`).
 * Every read is defensive — a hand-edited or stale file degrades to "no custom
 * rates", never to a crash or a wrong number.
 *
 * @module dsh-peak-balance/rates
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { baseModelId } from './pricing.js'

/** On-disk shape version; a future migration bumps this. */
export const RATES_VERSION = 1

/** Peak price is exactly double the off-peak price on DeepSeek's own card. */
export const PEAK_MULTIPLIER = 2

/**
 * Default location of the rate file: the ecosystem's TUI state directory.
 *
 * @param env - environment override (`DSH_TUI_STATE_DIR`, used by tests).
 */
export function ratesPath(env = process.env) {
  const dir = typeof env?.DSH_TUI_STATE_DIR === 'string' && env.DSH_TUI_STATE_DIR !== ''
    ? env.DSH_TUI_STATE_DIR
    : join(homedir(), '.dsh-tui')
  return join(dir, 'dsh-peak-balance-rates.json')
}

/** A finite, non-negative price, or `undefined`. */
function price(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return undefined
  return value
}

/** Normalize one rate tier; `undefined` when any of the three prices is invalid. */
export function normalizeTier(raw) {
  if (raw === null || typeof raw !== 'object') return undefined
  const inputHit = price(raw.inputHit)
  const inputMiss = price(raw.inputMiss)
  const output = price(raw.output)
  if (inputHit === undefined || inputMiss === undefined || output === undefined) return undefined
  return { inputHit, inputMiss, output }
}

/**
 * Normalize one stored entry.
 *
 * @param raw - untrusted entry from disk.
 * @param fallbackNow - timestamp used when the entry carries none.
 * @returns `{ idle, peak, updatedAt }`, or `undefined` when unusable.
 */
export function normalizeEntry(raw, fallbackNow = 0) {
  if (raw === null || typeof raw !== 'object') return undefined
  const idle = normalizeTier(raw.idle ?? raw)
  if (idle === undefined) return undefined
  const peak = normalizeTier(raw.peak) ?? {
    inputHit: idle.inputHit * PEAK_MULTIPLIER,
    inputMiss: idle.inputMiss * PEAK_MULTIPLIER,
    output: idle.output * PEAK_MULTIPLIER,
  }
  const updatedAt = typeof raw.updatedAt === 'number' && Number.isFinite(raw.updatedAt) ? raw.updatedAt : fallbackNow
  return { idle, peak, updatedAt }
}

/**
 * Build one entry from `/th price set` numbers.
 *
 * @param spec - `{ hit, miss, out }` plus optional `{ peakHit, peakMiss,
 *   peakOut }`; without explicit peak prices the off-peak price doubles them.
 * @param now - timestamp stamped on the entry.
 * @returns The entry, or `undefined` when a required price is invalid.
 */
export function makeEntry(spec, now = Date.now()) {
  const idle = normalizeTier({ inputHit: spec?.hit, inputMiss: spec?.miss, output: spec?.out })
  if (idle === undefined) return undefined
  const explicit = spec?.peakHit !== undefined || spec?.peakMiss !== undefined || spec?.peakOut !== undefined
  const peak = explicit
    ? normalizeTier({ inputHit: spec?.peakHit, inputMiss: spec?.peakMiss, output: spec?.peakOut })
    : {
        inputHit: idle.inputHit * PEAK_MULTIPLIER,
        inputMiss: idle.inputMiss * PEAK_MULTIPLIER,
        output: idle.output * PEAK_MULTIPLIER,
      }
  if (peak === undefined) return undefined
  return { idle, peak, updatedAt: now }
}

/** Parse a stored document into a normalized rate map; never throws. */
export function parseRates(text, now = 0) {
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    return {}
  }
  if (parsed === null || typeof parsed !== 'object') return {}
  const source = parsed.rates !== null && typeof parsed.rates === 'object' ? parsed.rates : {}
  const out = {}
  for (const [model, raw] of Object.entries(source)) {
    const key = baseModelId(model)
    if (key === '') continue
    const entry = normalizeEntry(raw, now)
    if (entry !== undefined) out[key] = entry
  }
  return out
}

/** Serialize a rate map for disk. */
export function serializeRates(rates, now = Date.now()) {
  const out = {}
  for (const [model, entry] of Object.entries(rates ?? {})) {
    if (entry === null || typeof entry !== 'object') continue
    out[model] = { idle: entry.idle, peak: entry.peak, updatedAt: entry.updatedAt ?? now }
  }
  return `${JSON.stringify({ version: RATES_VERSION, rates: out }, null, 2)}\n`
}

/**
 * Read the rate file.
 *
 * @param options.path - override (tests).
 * @param options.readFile - override (tests).
 * @returns The normalized map; `{}` for a missing, unreadable or corrupt file.
 */
export function readRates(options = {}) {
  const readFile = options.readFile ?? readFileSync
  const file = options.path ?? ratesPath(options.env)
  try {
    return parseRates(readFile(file, 'utf8'), options.now ?? 0)
  } catch {
    return {}
  }
}

/**
 * Write the rate file.
 *
 * @returns `true` on success; `false` when the file could not be written (the
 *   caller keeps operating on the in-memory map and logs once).
 */
export function writeRates(rates, options = {}) {
  const writeFile = options.writeFile ?? writeFileSync
  const file = options.path ?? ratesPath(options.env)
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFile(file, serializeRates(rates, options.now ?? Date.now()))
    return true
  } catch {
    return false
  }
}

/**
 * Set one model's rates (pure: returns a new map).
 *
 * @param rates - current map.
 * @param model - model id as the user typed it (provider prefixes are stripped).
 * @param spec - `makeEntry`'s spec.
 * @returns `{ rates }` with the new entry, or `{ error }` for a bad model/price.
 */
export function withRate(rates, model, spec, now = Date.now()) {
  const key = baseModelId(model)
  if (key === '') return { error: 'model' }
  const entry = makeEntry(spec, now)
  if (entry === undefined) return { error: 'price' }
  return { rates: { ...(rates ?? {}), [key]: entry }, model: key }
}

/** Remove one model's rates (pure). */
export function withoutRate(rates, model) {
  const key = baseModelId(model)
  const next = { ...(rates ?? {}) }
  delete next[key]
  return { rates: next, model: key, removed: (rates ?? {})[key] !== undefined }
}

/** Clear every custom rate (pure). */
export function withoutAllRates() {
  return {}
}

/** Flat, display-ready view of one entry. */
export function describeEntry(entry) {
  if (entry === null || typeof entry !== 'object') return undefined
  return {
    hit: entry.idle?.inputHit,
    miss: entry.idle?.inputMiss,
    out: entry.idle?.output,
    peakHit: entry.peak?.inputHit,
    peakMiss: entry.peak?.inputMiss,
    peakOut: entry.peak?.output,
    updatedAt: entry.updatedAt,
  }
}
