/**
 * Adapter selection.
 *
 * One question: given a provider route (and whatever the discovery layer could
 * learn about it), which adapter should ask for its quota — or is the honest
 * answer "this provider has no quota interface"?
 *
 * Selection order, most specific first:
 *
 * 1. an explicit `adapter` in the provider's spec (a user overriding the guess),
 * 2. a built-in adapter that claims the route **by id**,
 * 3. a built-in adapter that claims the route **by base-URL host**,
 * 4. any provider with a spec stanza (`declared`),
 * 5. `openai-billing`, but only for a **hand-declared** route — the seam's own
 *    `declared: true` flag means "a gateway or self-hosted server the adapter
 *    ships nothing about", which is precisely the relay case; a first-party
 *    catalog route is not probed with a relay-only endpoint,
 * 6. otherwise `unsupported`.
 *
 * @module dsh-peak-balance/providers/registry
 */

import * as commandcode from './commandcode.js'
import * as declared from './declared.js'
import * as deepseek from './deepseek.js'
import * as moonshot from './moonshot.js'
import * as openaiBilling from './openai-billing.js'
import * as openrouter from './openrouter.js'
import * as siliconflow from './siliconflow.js'

/**
 * Every built-in adapter, in declaration order.
 *
 * Order matters only among adapters that claim by host: the more specific a
 * provider's own API is, the earlier it sits. `declared` is last because it is
 * the catch-all a spec file opts into.
 */
export const ADAPTERS = Object.freeze([
  deepseek,
  commandcode,
  openrouter,
  moonshot,
  siliconflow,
  openaiBilling,
  declared,
])

/** Adapter id → module. */
const BY_ID = new Map(ADAPTERS.map(adapter => [adapter.ADAPTER_ID, adapter]))

/** Whether one adapter claims the route by provider id. */
function claimsProvider(adapter, provider) {
  return Array.isArray(adapter.PROVIDER_IDS) && adapter.PROVIDER_IDS.includes(provider)
}

/** Whether one adapter claims the route by base-URL host. */
function claimsHost(adapter, baseUrl) {
  if (typeof baseUrl !== 'string' || baseUrl === '') return false
  if (!Array.isArray(adapter.HOSTS) || adapter.HOSTS.length === 0) return false
  return adapter.HOSTS.some(host => baseUrl.includes(host))
}

/**
 * Pick the adapter for one provider.
 *
 * @param options.provider - provider route id.
 * @param options.baseUrl - resolved base URL (may be empty).
 * @param options.spec - the provider's spec stanza (`./spec.js`), if any.
 * @param options.declared - seam flag: the route exists only because
 *   configuration declared it (a gateway / self-hosted server).
 * @param options.allowBuiltinUnofficial - whether adapters that rely on
 *   undocumented endpoints may run (see the `allowUnofficialQuota` setting).
 * @returns `{ adapter, reason }` — `reason` explains the choice for `/quota`.
 */
export function resolveAdapter(options = {}) {
  const provider = typeof options.provider === 'string' ? options.provider : ''
  const baseUrl = typeof options.baseUrl === 'string' ? options.baseUrl : ''
  const spec = options.spec

  const forced = spec?.adapter
  if (typeof forced === 'string' && forced !== '' && forced !== 'declared') {
    const adapter = BY_ID.get(forced)
    if (adapter !== undefined) return { adapter, reason: `spec override -> ${forced}` }
  }

  for (const adapter of ADAPTERS) {
    if (adapter.ADAPTER_ID === declared.ADAPTER_ID) continue
    if (claimsProvider(adapter, provider)) return { adapter, reason: `provider id ${provider}` }
  }
  for (const adapter of ADAPTERS) {
    if (adapter.ADAPTER_ID === declared.ADAPTER_ID) continue
    if (claimsHost(adapter, baseUrl)) return { adapter, reason: `base url host of ${provider}` }
  }

  if (spec !== undefined && Array.isArray(spec.requests) && spec.requests.length > 0) {
    return { adapter: declared, reason: 'declarative spec' }
  }
  if (options.declared === true && baseUrl !== '') {
    return { adapter: openaiBilling, reason: 'hand-declared route: OpenAI-compatible billing' }
  }
  return { adapter: undefined, reason: 'no quota interface known for this provider' }
}

/**
 * Adapter ids that rely on endpoints a provider never documented publicly.
 *
 * Two very different situations share the label: an endpoint the provider's own
 * CLI uses (Command Code's `/alpha/*` — the provider plugin drives the same
 * routes, so it is enabled by default), and an endpoint reverse-engineered out
 * of a web console (MiniMax's plan remaining, 智谱's account report — those are
 * opt-in, because nothing but a third-party tool vouches for them). Only the
 * second kind is listed here.
 */
export const UNOFFICIAL_ADAPTER_IDS = Object.freeze([])

/** Whether an adapter needs the unofficial opt-in to run. */
export function needsUnofficial(adapter) {
  return adapter !== undefined && UNOFFICIAL_ADAPTER_IDS.includes(adapter.ADAPTER_ID)
}
