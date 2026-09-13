/**
 * Command Code subscription-plan adapter.
 *
 * Command Code bills a subscription in *credits* and paces it with two rolling
 * windows. The endpoints below are the ones the provider's own CLI (and the
 * `@mars-sea/dsh-commandcode-provider` plugin) use; they are **not** in the
 * public documentation, which is why every field is read defensively and a
 * missing one degrades rather than failing the whole read.
 *
 * | endpoint | what it answers |
 * | --- | --- |
 * | `GET /alpha/billing/credits` | remaining monthly credits + 5-hour/weekly windows |
 * | `GET /alpha/billing/subscriptions` | the plan id (`individual-goat`) and period |
 * | `GET /alpha/usage/summary` | period totals, including the spend counter |
 *
 * @module dsh-peak-balance/providers/commandcode
 */

import { failSnapshot, okSnapshot } from '../quota.js'
import { bearer, failureReasonOf, fetchJson, trimBase } from './http.js'

/** Adapter id (diagnostics and `/quota`). */
export const ADAPTER_ID = 'commandcode-plan'

/** A subscription: capped rolling windows over a monthly credit pool. */
export const BILLING = 'plan'

/** Provider routes this adapter claims. */
export const PROVIDER_IDS = Object.freeze(['commandcode'])

/** Base-URL hosts this adapter claims when the route id is unknown. */
export const HOSTS = Object.freeze(['api.commandcode.ai'])

/** Base URL used when neither the route profile nor a spec supplies one. */
export const DEFAULT_BASE_URL = 'https://api.commandcode.ai'

/**
 * Credential reference used when the route's own configuration does not name one.
 *
 * The provider plugin declares `apiKeyEnv: COMMANDCODE_API_KEY` in its bundle
 * patch — composition configuration the settings seam cannot see — so the
 * reference is carried here as the fallback.
 */
export const API_KEY_ENV = 'COMMANDCODE_API_KEY'

/**
 * CLI version the account endpoints expect in `x-command-code-version`.
 *
 * The header is informational for the endpoints this adapter reads; the value
 * mirrors the provider plugin's snapshot and a spec may override it.
 */
export const CLI_VERSION = '1.53.1'

/**
 * Subscription `planId` prefix → display name and monthly credit grant.
 *
 * Mirrors the plan map the provider plugin carries (itself synced from the
 * official CLI bundle). Only used to turn `individual-goat` into "GOAT" and to
 * give the monthly meter a cap; an unknown plan simply renders its raw id.
 */
const KNOWN_PLANS = Object.freeze({
  'individual-go': { name: 'Go', monthlyCredits: 10 },
  'individual-goat': { name: 'GOAT', monthlyCredits: 70 },
  'individual-pro': { name: 'Pro', monthlyCredits: 30 },
  'individual-pro-v1': { name: 'Pro', monthlyCredits: 80 },
  'individual-provider': { name: 'Provider', monthlyCredits: 15 },
  'individual-max': { name: 'Max', monthlyCredits: 150 },
  'individual-ultra': { name: 'Ultra', monthlyCredits: 300 },
  'teams-pro': { name: 'Teams Pro', monthlyCredits: 40 },
})

/** Longest-prefix-first plan ids, matching the official CLI's match order. */
const PLAN_PREFIXES = Object.keys(KNOWN_PLANS).sort((a, b) => b.length - a.length)

/**
 * Resolve a subscription plan id.
 *
 * @param planId - e.g. `individual-goat-v1`.
 * @returns `{ name, monthlyCredits }`; `{ name: planId }` for an unknown plan.
 */
export function planInfo(planId) {
  if (typeof planId !== 'string' || planId === '') return undefined
  for (const prefix of PLAN_PREFIXES) {
    if (planId.startsWith(prefix)) return { id: planId, ...KNOWN_PLANS[prefix] }
  }
  return { id: planId, name: planId }
}

/** A finite number out of an untrusted payload value, or `undefined`. */
function num(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value.trim())
    return Number.isFinite(parsed) ? parsed : undefined
  }
  return undefined
}

/** Read one window block (`{ used, cap, resetAt, exceeded }`). */
export function windowMeter(id, block) {
  if (block === null || typeof block !== 'object') return undefined
  const used = num(block.used)
  const cap = num(block.cap)
  if (used === undefined && cap === undefined) return undefined
  return {
    id,
    kind: 'credits',
    used,
    cap,
    resetAt: num(block.resetAt),
    exceeded: block.exceeded === true,
  }
}

/**
 * Parse the three payloads into meters.
 *
 * Exported for tests: the parsing rules (which field is a cap, which is a
 * remaining amount, what counts as exceeded) are the part worth pinning.
 *
 * @param input.credits - `/alpha/billing/credits` payload.
 * @param input.subscription - `/alpha/billing/subscriptions` payload.
 * @param input.usage - `/alpha/usage/summary` payload.
 * @returns `{ meters, spendCounter, planId, planName }`.
 */
export function parseCommandCode(input = {}) {
  const credits = input.credits !== null && typeof input.credits === 'object' ? input.credits : undefined
  const creditsData = credits?.credits !== null && typeof credits?.credits === 'object' ? credits.credits : undefined
  const windowLimits = credits?.windowLimits !== null && typeof credits?.windowLimits === 'object' ? credits.windowLimits : undefined

  const subscriptionData = input.subscription?.data !== null && typeof input.subscription?.data === 'object'
    ? input.subscription.data
    : undefined
  const planId = typeof subscriptionData?.planId === 'string' && subscriptionData.planId !== ''
    ? subscriptionData.planId
    : typeof creditsData?.planId === 'string' && creditsData.planId !== ''
      ? creditsData.planId
      : undefined
  const plan = planInfo(planId)

  const meters = []
  const fiveHour = windowMeter('window5h', windowLimits?.fiveHour)
  if (fiveHour !== undefined) meters.push(fiveHour)
  const weekly = windowMeter('windowWeekly', windowLimits?.weekly)
  if (weekly !== undefined) meters.push(weekly)

  const monthly = num(creditsData?.monthlyCredits)
  if (monthly !== undefined) {
    meters.push({
      id: 'planRemaining',
      kind: 'credits',
      remaining: monthly,
      cap: plan?.monthlyCredits,
      resetAt: typeof subscriptionData?.currentPeriodEnd === 'string'
        ? Date.parse(subscriptionData.currentPeriodEnd)
        : undefined,
    })
  }

  const usage = input.usage !== null && typeof input.usage === 'object' ? input.usage : undefined
  const totalCredits = num(usage?.totalCredits)
  if (totalCredits !== undefined) {
    meters.push({ id: 'periodSpend', kind: 'credits', used: totalCredits })
  }

  return {
    meters,
    spendCounter: totalCredits === undefined
      ? undefined
      : { id: 'usage.totalCredits', value: totalCredits, unit: { kind: 'credits' } },
    planId,
    planName: plan?.name,
  }
}

/**
 * Collect the plan state.
 *
 * The three endpoints answer independently: a single failing one is recorded in
 * `failures` while the rest still report. Only a total failure becomes a failed
 * snapshot, and then the *first* reason wins — a rejected key reads as
 * `unauthorized` rather than as a generic outage.
 */
export async function collect(options = {}) {
  const provider = typeof options.provider === 'string' ? options.provider : ''
  const provenance = { provider, adapter: ADAPTER_ID, at: options.now }
  const apiKey = options.profile?.apiKey
  if (typeof apiKey !== 'string' || apiKey === '') return failSnapshot('no-key', provenance)
  const base = trimBase(options.profile?.baseUrl ?? DEFAULT_BASE_URL)
  const headers = {
    ...bearer(apiKey),
    'x-command-code-version': typeof options.cliVersion === 'string' ? options.cliVersion : CLI_VERSION,
    'x-cli-environment': 'production',
  }
  const request = path => fetchJson(`${base}${path}`, {
    headers,
    fetchImpl: options.fetchImpl,
    timeoutMs: options.timeoutMs,
  })

  const [creditsResult, subscriptionResult, usageResult] = await Promise.all([
    request('/alpha/billing/credits'),
    request('/alpha/billing/subscriptions'),
    request('/alpha/usage/summary'),
  ])

  const failures = []
  const record = (path, result) => {
    if (result.ok === true) return
    const reason = failureReasonOf(result)
    failures.push(`${path}: ${result.status === undefined ? reason : `HTTP ${result.status}`}`)
  }
  record('credits', creditsResult)
  record('subscriptions', subscriptionResult)
  record('usage', usageResult)

  if (creditsResult.ok !== true && subscriptionResult.ok !== true && usageResult.ok !== true) {
    const first = [creditsResult, subscriptionResult, usageResult].find(result => result.ok !== true)
    return failSnapshot(failureReasonOf(first), { ...provenance, status: first?.status, detail: failures.join('; ') })
  }

  const parsed = parseCommandCode({
    credits: creditsResult.ok === true ? creditsResult.json : undefined,
    subscription: subscriptionResult.ok === true ? subscriptionResult.json : undefined,
    usage: usageResult.ok === true ? usageResult.json : undefined,
  })
  if (parsed.meters.length === 0 && parsed.spendCounter === undefined) {
    return failSnapshot('invalid', { ...provenance, detail: failures.join('; ') })
  }
  return okSnapshot({
    ...provenance,
    meters: parsed.meters,
    spendCounter: parsed.spendCounter,
    plan: parsed.planName,
    billing: BILLING,
    failures,
  })
}
