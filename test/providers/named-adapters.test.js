import { test } from 'node:test'
import assert from 'node:assert/strict'

import { collect as collectMoonshot, currencyOf, parseMoonshot } from '../../lib/providers/moonshot.js'
import { collect as collectOpenRouter, parseOpenRouter } from '../../lib/providers/openrouter.js'
import { collect as collectSiliconflow, parseSiliconflow } from '../../lib/providers/siliconflow.js'
import { resolveAdapter } from '../../lib/providers/registry.js'
import { meterById } from '../../lib/quota.js'

function fakeFetch(routes) {
  const calls = []
  const impl = async (url, init) => {
    calls.push({ url, init })
    for (const [needle, handler] of Object.entries(routes)) {
      if (url.includes(needle)) {
        const reply = typeof handler === 'function' ? handler() : handler
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

/* --------------------------------------------------------- OpenRouter */

test('openrouter: credits minus usage is the balance, and the key carries the counter', async () => {
  const impl = fakeFetch({
    '/credits': json({ data: { total_credits: 20, total_usage: 7.5 } }),
    '/key': json({ data: { limit: 20, limit_remaining: 12.5, usage: 7.5, usage_daily: 1.25, usage_weekly: 3, usage_monthly: 7.5 } }),
  })
  const snapshot = await collectOpenRouter({
    provider: 'openrouter',
    profile: { baseUrl: 'https://openrouter.ai/api/v1', apiKey: 'sk-or' },
    fetchImpl: impl,
  })
  assert.equal(snapshot.ok, true)
  const balance = meterById(snapshot, 'balance')
  assert.deepEqual([balance.remaining, balance.cap, balance.currency], [12.5, 20, 'USD'])
  assert.deepEqual([meterById(snapshot, 'keyLimit').remaining, meterById(snapshot, 'keyLimit').cap], [12.5, 20])
  assert.equal(meterById(snapshot, 'windowDaily').used, 1.25)
  assert.equal(meterById(snapshot, 'windowWeekly').used, 3)
  assert.equal(meterById(snapshot, 'periodSpend').used, 7.5)
  assert.deepEqual(snapshot.spendCounter, { id: 'key.usage', value: 7.5, unit: { kind: 'money', currency: 'USD' } })
})

test('openrouter: a normal key refused by /credits still reports through /key', async () => {
  const impl = fakeFetch({
    '/credits': json({ error: 'Only management keys can perform this operation' }, 403),
    '/key': json({ data: { usage: 2, usage_daily: 0.5 } }),
  })
  const snapshot = await collectOpenRouter({
    provider: 'openrouter',
    profile: { baseUrl: 'https://openrouter.ai/api/v1', apiKey: 'sk-or' },
    fetchImpl: impl,
  })
  assert.equal(snapshot.ok, true)
  assert.equal(meterById(snapshot, 'balance'), undefined)
  assert.equal(meterById(snapshot, 'windowDaily').used, 0.5)
  assert.match(snapshot.failures[0], /credits: HTTP 403/)
})

test('openrouter: a rejected key is unauthorized, an unreachable host is a network failure', async () => {
  const unauthorized = await collectOpenRouter({
    provider: 'openrouter',
    profile: { baseUrl: 'https://openrouter.ai/api/v1', apiKey: 'sk-or' },
    fetchImpl: fakeFetch({ '/credits': json({}, 401), '/key': json({}, 401) }),
  })
  assert.deepEqual([unauthorized.ok, unauthorized.reason, unauthorized.status], [false, 'unauthorized', 401])

  const offline = await collectOpenRouter({
    provider: 'openrouter',
    profile: { baseUrl: 'https://openrouter.ai/api/v1', apiKey: 'sk-or' },
    fetchImpl: fakeFetch({ '/credits': () => undefined, '/key': () => undefined }),
  })
  assert.equal(offline.reason, 'network')
})

test('openrouter: an unconfigured key never reaches the network', async () => {
  const impl = fakeFetch({})
  const snapshot = await collectOpenRouter({ provider: 'openrouter', profile: {}, fetchImpl: impl })
  assert.equal(snapshot.reason, 'no-key')
  assert.equal(impl.calls.length, 0)
})

/* ------------------------------------------------------------ Moonshot */

test('moonshot: the host decides the currency', () => {
  assert.equal(currencyOf('https://api.moonshot.cn/v1'), 'CNY')
  assert.equal(currencyOf('https://api.moonshot.ai/v1'), 'USD')
})

test('moonshot: zero balances are left off the line', () => {
  const parsed = parseMoonshot({ data: { available_balance: 12.5, voucher_balance: 0, cash_balance: 12.5 } }, 'CNY')
  assert.deepEqual(parsed.meters.map(meter => meter.id), ['balance', 'balance-cash'])
  const bare = parseMoonshot({ data: { available_balance: '3.25' } }, 'USD')
  assert.deepEqual(bare.meters, [{ id: 'balance', kind: 'money', currency: 'USD', remaining: 3.25 }])
})

test('moonshot: a payload without a balance is invalid rather than zero', () => {
  assert.equal(parseMoonshot({ data: {} }, 'CNY'), undefined)
  assert.equal(parseMoonshot({}, 'CNY'), undefined)
})

test('moonshot: the CN route reports a CNY balance from its own endpoint', async () => {
  const impl = fakeFetch({ '/users/me/balance': json({ code: 0, data: { available_balance: 8.5 } }) })
  const snapshot = await collectMoonshot({
    provider: 'moonshotai-cn',
    profile: { baseUrl: 'https://api.moonshot.cn/v1', apiKey: 'sk-moonshot' },
    fetchImpl: impl,
  })
  assert.equal(snapshot.ok, true)
  assert.equal(meterById(snapshot, 'balance').currency, 'CNY')
  assert.equal(impl.calls[0].url, 'https://api.moonshot.cn/v1/users/me/balance')
})

/* -------------------------------------------------------- SiliconFlow */

test('siliconflow: string figures are parsed and no currency is invented', () => {
  const parsed = parseSiliconflow({ data: { balance: '0.88', chargeBalance: '88', totalBalance: '88.88' } })
  const balance = parsed.meters.find(meter => meter.id === 'balance')
  assert.deepEqual([balance.remaining, balance.currency], [0.88, undefined])
  assert.deepEqual(parsed.meters.map(meter => meter.id), ['balance', 'balance-total', 'balance-charged'])
})

test('siliconflow: identical figures collapse into one meter', () => {
  const parsed = parseSiliconflow({ data: { balance: '5', chargeBalance: '5', totalBalance: '5' } })
  assert.deepEqual(parsed.meters, [{ id: 'balance', kind: 'money', remaining: 5 }])
  assert.equal(parseSiliconflow({ data: {} }), undefined)
})

test('siliconflow: a live read reaches /user/info with bearer auth', async () => {
  const impl = fakeFetch({ '/user/info': json({ data: { balance: '1.5' } }) })
  const snapshot = await collectSiliconflow({
    provider: 'siliconflow',
    profile: { baseUrl: 'https://api.siliconflow.com/v1', apiKey: 'sk-sf' },
    fetchImpl: impl,
  })
  assert.equal(snapshot.ok, true)
  assert.equal(impl.calls[0].init.headers.authorization, 'Bearer sk-sf')
})

/* ------------------------------------------------------------ registry */

test('the named adapters claim their provider ids and hosts', () => {
  assert.equal(resolveAdapter({ provider: 'openrouter' }).adapter.ADAPTER_ID, 'openrouter')
  assert.equal(resolveAdapter({ provider: 'moonshotai-cn' }).adapter.ADAPTER_ID, 'moonshot-balance')
  assert.equal(resolveAdapter({ provider: 'siliconflow' }).adapter.ADAPTER_ID, 'siliconflow-balance')
  // A route id unknown to this build is still recognised by its endpoint.
  assert.equal(resolveAdapter({ provider: 'kimi-direct', baseUrl: 'https://api.moonshot.cn/v1' }).adapter.ADAPTER_ID, 'moonshot-balance')
  assert.equal(resolveAdapter({ provider: 'sf-alt', baseUrl: 'https://api.siliconflow.cn/v1' }).adapter.ADAPTER_ID, 'siliconflow-balance')
})
