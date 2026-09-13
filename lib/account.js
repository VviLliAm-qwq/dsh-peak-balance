/**
 * The account layer: one provider in, one quota snapshot out.
 *
 * This is where discovery, adapter selection and credential resolution meet, and
 * where the per-turn spend measurement lives. Both halves are deliberately
 * dependency-injected — the seams arrive as plain candidate lists and the clock
 * and `fetch` are overwritable — so the whole path can be tested without a host.
 *
 * @module dsh-peak-balance/account
 */

import { failSnapshot, spendDelta } from './quota.js'
import { discoverProvider, resolveCredential } from './providers/discovery.js'
import { needsUnofficial, resolveAdapter } from './providers/registry.js'

/** Provider queried when nothing says otherwise (this plugin's original behaviour). */
export const DEFAULT_PROVIDER = 'deepseek-official'

/**
 * Which provider a refresh should ask about.
 *
 * `quotaProvider` may pin one route explicitly, turn the account section off, or
 * stay on `auto` — in which case the provider of the conversation on screen
 * wins, and the historical default (`deepseek-official`) is the last resort so
 * an untouched configuration behaves exactly as before.
 *
 * @param options.provider - provider of the focused conversation, if known.
 * @param options.config - resolved plugin config.
 * @returns `{ enabled, provider, source }`.
 */
export function resolveTarget(options = {}) {
  const setting = typeof options.config?.quotaProvider === 'string' ? options.config.quotaProvider.trim() : 'auto'
  if (setting === 'off') return { enabled: false, provider: '', source: 'off' }
  if (setting !== '' && setting !== 'auto') return { enabled: true, provider: setting, source: 'pinned' }
  const observed = typeof options.provider === 'string' && options.provider !== '' ? options.provider : ''
  if (observed !== '') return { enabled: true, provider: observed, source: 'focus' }
  return { enabled: true, provider: DEFAULT_PROVIDER, source: 'default' }
}

/**
 * Collect one snapshot.
 *
 * Never throws: a refusing seam, an unknown provider or a misbehaving adapter all
 * come back as a failed snapshot with a reason the UI can render.
 *
 * @param options.provider - provider route id.
 * @param options.spec - parsed spec document (`./providers/spec.js`).
 * @param options.config - resolved plugin config.
 * @param options.llmServices / settingsServices / credentialsServices - candidate seams.
 * @param options.fetchImpl / timeoutMs / now - injections.
 */
export async function collectQuota(options = {}) {
  const provider = typeof options.provider === 'string' ? options.provider : ''
  const provenance = { provider, at: options.now }
  if (provider === '') return failSnapshot('unsupported', provenance)
  const config = options.config ?? {}
  const spec = options.spec ?? { apiBases: {}, providers: {} }

  let profile
  try {
    profile = discoverProvider({
      provider,
      llmServices: options.llmServices,
      settingsServices: options.settingsServices,
      spec,
    })
  } catch {
    return failSnapshot('unsupported', provenance)
  }

  const { adapter, reason } = resolveAdapter({
    provider,
    baseUrl: profile.baseUrl,
    spec: profile.stanza,
    declared: profile.declared,
  })
  if (adapter === undefined) return failSnapshot('unsupported', { ...provenance, detail: reason })
  if (needsUnofficial(adapter) && config.allowUnofficialQuota !== true) {
    return failSnapshot('unsupported', { ...provenance, detail: `${adapter.ADAPTER_ID} needs allowUnofficialQuota` })
  }
  if (
    profile.baseUrl === undefined
    && profile.stanza === undefined
    && adapter.DEFAULT_BASE_URL === undefined
  ) {
    // An adapter that ships a canonical endpoint (the official API, Command
    // Code's own host) can run without the configuration naming one; anything
    // else — a relay, a spec-declared provider — needs an endpoint, and an
    // absent one means there is nothing to ask rather than something to guess.
    return failSnapshot('unsupported', { ...provenance, detail: 'no base URL known' })
  }

  let apiKey = ''
  try {
    // A route's own configuration frequently cannot be read back (its
    // `apiKeyEnv` lives in a composition patch, not in the settings document),
    // so an adapter that knows its provider's conventional reference supplies
    // it as the fallback.
    const ref = profile.apiKeyRef ?? adapter.API_KEY_ENV
    apiKey = await resolveCredential(options.credentialsServices, ref, options.env ?? process.env)
  } catch {
    apiKey = ''
  }

  try {
    return await adapter.collect({
      provider,
      profile: { baseUrl: profile.baseUrl, apiKey },
      spec: profile.stanza,
      fetchImpl: options.fetchImpl,
      timeoutMs: options.timeoutMs,
      now: options.now,
      logger: options.log,
    })
  } catch (error) {
    return failSnapshot('network', { ...provenance, detail: error instanceof Error ? error.message : String(error) })
  }
}

/**
 * The per-turn spend measurement.
 *
 * A provider that publishes a monotonic spend counter (Command Code's
 * `usage.totalCredits`, a relay's `total_usage`) lets the plugin show what a turn
 * *actually* drew, instead of an estimate. The counter is read once when the turn
 * starts and once when it ends; the difference is the spend.
 *
 * Two outcomes are deliberately not "a number":
 *
 * - a **zero** difference is usually the provider's accounting lagging a couple
 *   of seconds behind the request, so the caller retries (and may force a
 *   settlement at the end of the retry budget, flagged `exact: false`);
 * - a **negative** difference is a counter that reset (a new billing period, a
 *   rotated account), which is not a refund: the tracker re-baselines and answers
 *   `unknown`.
 */
export function createTurnSpend() {
  let baseline
  let latest

  const clone = counter => (counter === undefined ? undefined : { value: counter.value, unit: counter.unit })

  return {
    /** Capture the counter at the start of a turn. */
    begin(counter) {
      baseline = clone(counter)
      latest = undefined
    },
    /**
     * Compare the counter now against the turn's baseline.
     *
     * @param counter - `{ value, unit }` from a fresh snapshot.
     * @param options.force - settle even when nothing moved (end of the retries).
     * @returns `{ state: 'settled', spent, unit, exact }` | `{ state: 'pending' }`
     *   | `{ state: 'unknown' }` | `{ state: 'none' }`.
     */
    settle(counter, options = {}) {
      if (baseline === undefined || counter === undefined) return { state: 'none' }
      const delta = spendDelta(baseline.value, counter.value)
      if (delta === undefined) {
        baseline = clone(counter)
        latest = undefined
        return { state: 'unknown' }
      }
      if (delta === 0 && options.force !== true) return { state: 'pending' }
      const settled = {
        state: 'settled',
        spent: delta,
        unit: counter.unit ?? baseline.unit,
        exact: delta > 0,
      }
      latest = settled
      baseline = clone(counter)
      return settled
    },
    /** The last settled spend, for the status line. */
    last() {
      return latest
    },
    /** Drop the turn state (conversation switched, or the turn never started). */
    reset() {
      baseline = undefined
      latest = undefined
    },
  }
}
