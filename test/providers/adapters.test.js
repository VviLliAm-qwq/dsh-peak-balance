import { test } from 'node:test'
import assert from 'node:assert/strict'

import { collect as collectCommandCode, parseCommandCode, planInfo } from '../../lib/providers/commandcode.js'
import { collect as collectDeclared } from '../../lib/providers/declared.js'
import { collect as collectDeepSeek } from '../../lib/providers/deepseek.js'
import { billingUrls, collect as collectBilling, parseBilling } from '../../lib/providers/openai-billing.js'
import { meterById } from '../../lib/quota.js'

/** A fetch stand-in keyed by URL suffix. */
function fakeFetch(routes) {
  const calls = []
  const impl = async (url, init) => {
    calls.push({ url, init })
    for (const [needle, handler] of Object.entries(routes)) {
      if (url.includes(needle)) {
        const reply = typeof handler === 'function' ? handler(url, init) : handler
        if (reply === undefined) throw new Error('network down')
        return reply
      }
    }
    return { ok: false, status: 404, json: async () => ({}) }
  }
  impl.calls = calls
  return impl
}

const json = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body })

/* ---------------------------------------------------------------- DeepSeek */

const DEEPSEEK_PAYLOAD = {
  is_available: true,
  balance_infos: [
    { currency: 'CNY', total_balance: '12.34', granted_balance: '0.00', topped_up_balance: '12.34' },
    { currency: 'USD', total_balance: '1.70', granted_balance: '0.00', topped_up_balance: '1.70' },
  ],
}

test('deepseek: a balance entry per currency, without one overwriting the other', async () => {
  const impl = fakeFetch({ '/user/balance': json(DEEPSEEK_PAYLOAD) })
  const snapshot = await collectDeepSeek({ provider: 'deepseek-official', profile: { apiKey: 'sk-x' }, fetchImpl: impl })
  assert.equal(snapshot.ok, true)
  assert.equal(snapshot.adapter, 'deepseek-balance')
  assert.equal(meterById(snapshot, 'balance').currency, 'CNY')
  assert.equal(meterById(snapshot, 'balance').remaining, 12.34)
  assert.equal(meterById(snapshot, 'balance-USD').remaining, 1.7)
  assert.equal(impl.calls[0].url, 'https://api.deepseek.com/user/balance')
  assert.equal(impl.calls[0].init.headers.authorization, 'Bearer sk-x')
})

test('deepseek: a missing key never reaches the network', async () => {
  const impl = fakeFetch({})
  const snapshot = await collectDeepSeek({ provider: 'deepseek-official', profile: {}, fetchImpl: impl })
  assert.deepEqual([snapshot.ok, snapshot.reason], [false, 'no-key'])
  assert.equal(impl.calls.length, 0)
})

test('deepseek: 401 is reported as a rejected key, and a transport failure as a network one', async () => {
  const unauthorized = fakeFetch({ '/user/balance': json({}, 401) })
  const first = await collectDeepSeek({ provider: 'deepseek-official', profile: { apiKey: 'sk-x' }, fetchImpl: unauthorized })
  assert.equal(first.reason, 'unauthorized')

  const offline = fakeFetch({ '/user/balance': () => undefined })
  const second = await collectDeepSeek({ provider: 'deepseek-official', profile: { apiKey: 'sk-x' }, fetchImpl: offline })
  assert.equal(second.reason, 'network')
})

/* ------------------------------------------------------------ Command Code */

// Captured from a real GOAT account (2026-09-13); values trimmed for the test.
const CC_CREDITS = {
  credits: { monthlyCredits: 69.946144443, purchasedCredits: 0, freeCredits: 0 },
  windowLimits: {
    limited: true,
    fiveHour: { used: 0.053855557, cap: 14, exceeded: false, resetAt: 1789295843839 },
    weekly: { used: 0.053855557, cap: 35, exceeded: false, resetAt: 1789882643839 },
  },
}
const CC_SUBSCRIPTION = {
  success: true,
  data: { planId: 'individual-goat', status: 'active', currentPeriodEnd: '2026-10-13T05:29:57.000Z' },
}
const CC_USAGE = { totalCount: 7, totalCredits: 0.006283914, totalTokens: 64192, periodBasis: 'billing-period' }

const ccRoutes = {
  '/alpha/billing/credits': json(CC_CREDITS),
  '/alpha/billing/subscriptions': json(CC_SUBSCRIPTION),
  '/alpha/usage/summary': json(CC_USAGE),
}

test('commandcode: the plan, both rolling windows and the monthly pool become meters', async () => {
  const impl = fakeFetch(ccRoutes)
  const snapshot = await collectCommandCode({ provider: 'commandcode', profile: { apiKey: 'user_x' }, fetchImpl: impl })
  assert.equal(snapshot.ok, true)
  const fiveHour = meterById(snapshot, 'window5h')
  assert.deepEqual([fiveHour.used, fiveHour.cap, fiveHour.kind], [0.053855557, 14, 'credits'])
  assert.equal(fiveHour.resetAt, 1789295843839)
  const weekly = meterById(snapshot, 'windowWeekly')
  assert.equal(weekly.cap, 35)
  const plan = meterById(snapshot, 'planRemaining')
  assert.equal(plan.remaining, 69.946144443)
  assert.equal(plan.cap, 70) // GOAT's monthly grant, from the plan table
  assert.equal(plan.resetAt, Date.parse('2026-10-13T05:29:57.000Z'))
  assert.equal(meterById(snapshot, 'periodSpend').used, 0.006283914)
  // The spend counter is what makes a per-turn figure measurable instead of estimated.
  assert.deepEqual(snapshot.spendCounter, { id: 'usage.totalCredits', value: 0.006283914, unit: { kind: 'credits' } })
})

test('commandcode: the account endpoints get the CLI headers', async () => {
  const impl = fakeFetch(ccRoutes)
  await collectCommandCode({ provider: 'commandcode', profile: { apiKey: 'user_x' }, fetchImpl: impl })
  for (const call of impl.calls) {
    assert.equal(call.init.headers.authorization, 'Bearer user_x')
    assert.equal(call.init.headers['x-command-code-version'], '1.53.1')
    assert.equal(call.init.headers['x-cli-environment'], 'production')
  }
})

test('commandcode: one failing endpoint still reports the other two', async () => {
  const impl = fakeFetch({ ...ccRoutes, '/alpha/usage/summary': json({}, 500) })
  const snapshot = await collectCommandCode({ provider: 'commandcode', profile: { apiKey: 'user_x' }, fetchImpl: impl })
  assert.equal(snapshot.ok, true)
  assert.equal(snapshot.spendCounter, undefined)
  assert.equal(meterById(snapshot, 'window5h').cap, 14)
  assert.match(snapshot.failures[0], /usage: HTTP 500/)
})

test('commandcode: only a total failure fails, and a rejected key wins the reason', async () => {
  const impl = fakeFetch({
    '/alpha/billing/credits': json({}, 401),
    '/alpha/billing/subscriptions': json({}, 401),
    '/alpha/usage/summary': json({}, 401),
  })
  const snapshot = await collectCommandCode({ provider: 'commandcode', profile: { apiKey: 'user_x' }, fetchImpl: impl })
  assert.deepEqual([snapshot.ok, snapshot.reason, snapshot.status], [false, 'unauthorized', 401])
})

test('commandcode: an unknown plan id renders itself and leaves the monthly cap absent', () => {
  const parsed = parseCommandCode({ credits: { credits: { monthlyCredits: 5, planId: 'individual-mystery' } } })
  assert.equal(parsed.planName, 'individual-mystery')
  assert.equal(meterById({ meters: parsed.meters }, 'planRemaining').cap, undefined)
})

test('commandcode: plan ids resolve by longest prefix', () => {
  assert.equal(planInfo('individual-goat').name, 'GOAT')
  assert.equal(planInfo('individual-pro-v1').monthlyCredits, 80)
  assert.equal(planInfo('individual-pro').monthlyCredits, 30)
})

/* ------------------------------------------------------- OpenAI billing */

test('billing: soft limit is the remaining USD, usage is cents', () => {
  const parsed = parseBilling({
    subscription: { soft_limit_usd: 12.5, hard_limit_usd: 20 },
    usage: { total_usage: 750 },
  })
  const balance = parsed.meters.find(meter => meter.id === 'balance')
  assert.deepEqual([balance.remaining, balance.cap, balance.currency], [12.5, 20, 'USD'])
  assert.equal(parsed.meters.find(meter => meter.id === 'periodSpend').used, 7.5)
  assert.deepEqual(parsed.spendCounter, { id: 'billing.total_usage', value: 7.5, unit: { kind: 'money', currency: 'USD' } })
})

test('billing: the unlimited sentinel is not rendered as a balance', () => {
  const parsed = parseBilling({ subscription: { soft_limit_usd: 100000000, hard_limit_usd: 100000000 } })
  assert.equal(parsed.meters.length, 0)
})

test('billing: both spellings of the API root resolve to the same pair', () => {
  assert.equal(billingUrls('https://relay.example.com').subscription, 'https://relay.example.com/v1/dashboard/billing/subscription')
  assert.equal(billingUrls('https://relay.example.com/v1').subscription, 'https://relay.example.com/v1/dashboard/billing/subscription')
  assert.equal(billingUrls('https://relay.example.com/v1/').usage, 'https://relay.example.com/v1/dashboard/billing/usage')
})

test('billing: a gateway that does not implement the pair reads as unsupported', async () => {
  const impl = fakeFetch({})
  const snapshot = await collectBilling({ provider: 'my-gw', profile: { baseUrl: 'https://relay.example.com', apiKey: 'sk-x' }, fetchImpl: impl })
  assert.deepEqual([snapshot.ok, snapshot.reason], [false, 'unsupported'])
})

test('billing: a live pair produces a balance for a relay', async () => {
  const impl = fakeFetch({
    '/subscription': json({ soft_limit_usd: 3.25, hard_limit_usd: 10 }),
    '/usage': json({ total_usage: 675 }),
  })
  const snapshot = await collectBilling({ provider: 'my-gw', profile: { baseUrl: 'https://relay.example.com/v1', apiKey: 'sk-x' }, fetchImpl: impl })
  assert.equal(snapshot.ok, true)
  assert.equal(meterById(snapshot, 'balance').remaining, 3.25)
  assert.equal(snapshot.spendCounter.value, 6.75)
})

/* ----------------------------------------------------------- declared */

const SPEC = {
  provider: 'my-relay',
  adapter: 'declared',
  authKind: 'bearer',
  allowUnofficial: false,
  requests: [
    {
      path: '/api/user/self',
      method: 'GET',
      headers: { 'new-api-user': '1' },
      meters: [
        { id: 'balance', kind: 'money', currency: 'USD', valuePath: 'data.quota', scale: 0.000002 },
        { id: 'periodSpend', kind: 'money', currency: 'USD', usedPath: 'data.used_quota', scale: 0.000002 },
      ],
    },
  ],
  spendCounter: 'data.used_quota',
}

test('declared: dot paths, scale and the counter unit inherited from the meter', async () => {
  const impl = fakeFetch({ '/api/user/self': json({ data: { quota: 2500000, used_quota: 500000 } }) })
  const snapshot = await collectDeclared({
    provider: 'my-relay',
    profile: { baseUrl: 'https://relay.example.com', apiKey: 'tok' },
    spec: SPEC,
    fetchImpl: impl,
  })
  assert.equal(snapshot.ok, true)
  assert.equal(meterById(snapshot, 'balance').remaining, 5) // 2,500,000 quota / 500,000 per USD
  assert.equal(meterById(snapshot, 'periodSpend').used, 1)
  // The counter shares the used_quota path, so it inherits money/USD.
  assert.equal(snapshot.spendCounter.value, 500000)
  assert.deepEqual(snapshot.spendCounter.unit, { kind: 'money', currency: 'USD' })
  assert.equal(impl.calls[0].init.headers['new-api-user'], '1')
})

test('declared: an unreadable path contributes no meter rather than a zero', async () => {
  const impl = fakeFetch({ '/api/user/self': json({ data: {} }) })
  const snapshot = await collectDeclared({
    provider: 'my-relay',
    profile: { baseUrl: 'https://relay.example.com', apiKey: 'tok' },
    spec: SPEC,
    fetchImpl: impl,
  })
  assert.deepEqual([snapshot.ok, snapshot.reason], [false, 'invalid'])
})

test('declared: a relative reset time is converted against the injected clock', async () => {
  const spec = {
    ...SPEC,
    requests: [{
      path: '/plan',
      method: 'GET',
      headers: {},
      meters: [{
        id: 'window5h',
        kind: 'count',
        usedPath: 'used',
        capPath: 'cap',
        resetPath: 'remains',
        resetUnit: 'remainingMs',
      }],
    }],
    spendCounter: undefined,
  }
  const impl = fakeFetch({ '/plan': json({ used: 3, cap: 10, remains: 60000 }) })
  const snapshot = await collectDeclared({
    provider: 'mini',
    profile: { baseUrl: 'https://mini.example.com', apiKey: 'k' },
    spec,
    fetchImpl: impl,
    now: 1_000_000,
  })
  assert.equal(meterById(snapshot, 'window5h').resetAt, 1_060_000)
})
