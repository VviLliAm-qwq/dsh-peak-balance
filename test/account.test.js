import { test } from 'node:test'
import assert from 'node:assert/strict'

import { DEFAULT_PROVIDER, collectQuota, createTurnSpend, resolveTarget } from '../lib/account.js'

const json = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body })
const llm = entries => [{ listConfigurableProviders: () => entries }]
const settings = sections => [{ get: ns => sections[ns] }]
const credentials = refs => [{ resolve: async ref => (refs[ref] === undefined ? undefined : { value: refs[ref] }) }]

/* --------------------------------------------------------------- target */

test('the account section can be pinned, turned off, or follow the conversation', () => {
  assert.deepEqual(resolveTarget({ config: { quotaProvider: 'off' } }), { enabled: false, provider: '', source: 'off' })
  assert.deepEqual(resolveTarget({ config: { quotaProvider: 'commandcode' }, provider: 'deepseek-official' }), {
    enabled: true,
    provider: 'commandcode',
    source: 'pinned',
  })
  assert.equal(resolveTarget({ config: { quotaProvider: 'auto' }, provider: 'openrouter' }).provider, 'openrouter')
  // An untouched configuration keeps the original behaviour.
  assert.equal(resolveTarget({ config: {} }).provider, DEFAULT_PROVIDER)
  assert.equal(resolveTarget({ config: { quotaProvider: 'auto' }, provider: '' }).source, 'default')
})

/* -------------------------------------------------------------- collect */

test('a provider with no known quota interface fails as unsupported, with the reason', async () => {
  const snapshot = await collectQuota({
    provider: 'openai',
    config: {},
    spec: { apiBases: {}, providers: {} },
    llmServices: llm([]),
    settingsServices: settings({}),
    credentialsServices: credentials({}),
  })
  assert.deepEqual([snapshot.ok, snapshot.reason], [false, 'unsupported'])
  assert.match(snapshot.detail, /no quota interface/)
})

test('the official route is claimed by id and uses the credential seam', async () => {
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url, init })
    return json({
      is_available: true,
      balance_infos: [{ currency: 'CNY', total_balance: '9.5', granted_balance: '0', topped_up_balance: '9.5' }],
    })
  }
  const snapshot = await collectQuota({
    provider: 'deepseek-official',
    config: { quotaProvider: 'auto' },
    spec: { apiBases: {}, providers: {} },
    llmServices: llm([]),
    settingsServices: settings({}),
    credentialsServices: credentials({ DEEPSEEK_API_KEY: 'sk-seam' }),
    fetchImpl,
  })
  assert.equal(snapshot.ok, true)
  assert.equal(snapshot.provider, 'deepseek-official')
  assert.equal(calls[0].url, 'https://api.deepseek.com/user/balance')
  assert.equal(calls[0].init.headers.authorization, 'Bearer sk-seam')
})

test('Command Code is found through the directory entry, its settings section and the environment key', async () => {
  const urls = []
  const fetchImpl = async url => {
    urls.push(url)
    if (url.endsWith('/alpha/billing/credits')) {
      return json({ credits: { monthlyCredits: 70 }, windowLimits: { fiveHour: { used: 1, cap: 14, resetAt: 999 } } })
    }
    if (url.endsWith('/alpha/billing/subscriptions')) return json({ data: { planId: 'individual-goat' } })
    return json({ totalCredits: 2 })
  }
  const snapshot = await collectQuota({
    provider: 'commandcode',
    config: { quotaProvider: 'auto' },
    spec: { apiBases: {}, providers: {} },
    llmServices: llm([{ provider: 'commandcode', displayName: 'Command Code', settingsNs: 'llm-commandcode', settingsPath: [], declared: false }]),
    settingsServices: settings({ 'llm-commandcode': { apiBase: 'https://api.commandcode.ai' } }),
    credentialsServices: credentials({}),
    env: { COMMANDCODE_API_KEY: 'user_env' },
    fetchImpl,
  })
  assert.equal(snapshot.ok, true)
  assert.equal(urls.length, 3)
  assert.ok(urls.every(url => url.startsWith('https://api.commandcode.ai')))
})

test('a spec stanza reaches the declarative adapter, key and all', async () => {
  const spec = {
    apiBases: { 'my-relay': 'https://relay.example.com' },
    providers: {
      'my-relay': {
        provider: 'my-relay',
        adapter: 'declared',
        authKind: 'bearer',
        apiKeyEnv: 'MY_RELAY_KEY',
        allowUnofficial: false,
        requests: [{
          path: '/api/user/self',
          method: 'GET',
          headers: {},
          meters: [{ id: 'balance', kind: 'money', currency: 'USD', valuePath: 'data.quota', scale: 0.000002 }],
        }],
        spendCounter: undefined,
      },
    },
  }
  const snapshot = await collectQuota({
    provider: 'my-relay',
    config: {},
    spec,
    llmServices: llm([]),
    settingsServices: settings({}),
    credentialsServices: credentials({ MY_RELAY_KEY: 'tok' }),
    fetchImpl: async url => json({ data: { quota: 1000000 } }),
  })
  assert.equal(snapshot.ok, true)
  assert.equal(snapshot.meters[0].remaining, 2)
})

test('a spec-declared provider with no base URL is unsupported rather than guessed', async () => {
  const snapshot = await collectQuota({
    provider: 'ghost',
    config: {},
    spec: { apiBases: {}, providers: { ghost: { provider: 'ghost', adapter: 'declared', requests: [{ path: '/x', method: 'GET', headers: {}, meters: [] }] } } },
    llmServices: llm([]),
    settingsServices: settings({}),
    credentialsServices: credentials({}),
    fetchImpl: async () => json({}),
  })
  assert.deepEqual([snapshot.ok, snapshot.reason], [false, 'unsupported'])
})

test('a throwing adapter is contained', async () => {
  const snapshot = await collectQuota({
    provider: 'deepseek-official',
    config: {},
    spec: { apiBases: {}, providers: {} },
    llmServices: llm([]),
    settingsServices: settings({}),
    credentialsServices: credentials({ DEEPSEEK_API_KEY: 'sk' }),
    fetchImpl: () => {
      throw new Error('boom')
    },
  })
  assert.deepEqual([snapshot.ok, snapshot.reason], [false, 'network'])
})

/* ----------------------------------------------------------- turn spend */

test('turn spend measures the counter difference and retries a lagging zero', () => {
  const spend = createTurnSpend()
  spend.begin({ value: 10, unit: { kind: 'credits' } })
  assert.deepEqual(spend.settle(undefined), { state: 'none' })
  assert.deepEqual(spend.settle({ value: 10, unit: { kind: 'credits' } }), { state: 'pending' })
  const settled = spend.settle({ value: 10.25, unit: { kind: 'credits' } })
  assert.equal(settled.state, 'settled')
  assert.equal(settled.spent, 0.25)
  assert.equal(settled.exact, true)
  assert.deepEqual(spend.last(), settled)
})

test('a forced settlement reports a zero spend as inexact', () => {
  const spend = createTurnSpend()
  spend.begin({ value: 4, unit: { kind: 'money', currency: 'USD' } })
  const settled = spend.settle({ value: 4, unit: { kind: 'money', currency: 'USD' } }, { force: true })
  assert.deepEqual(settled, { state: 'settled', spent: 0, unit: { kind: 'money', currency: 'USD' }, exact: false })
})

test('a counter that resets is not a refund: it re-baselines and says unknown', () => {
  const spend = createTurnSpend()
  spend.begin({ value: 100, unit: { kind: 'money', currency: 'USD' } })
  assert.deepEqual(spend.settle({ value: 2, unit: { kind: 'money', currency: 'USD' } }), { state: 'unknown' })
  // The baseline moved to the new period, so the next turn measures from 2.
  assert.equal(spend.settle({ value: 3, unit: { kind: 'money', currency: 'USD' } }).spent, 1)
})

test('a turn that never started cannot settle', () => {
  const spend = createTurnSpend()
  assert.deepEqual(spend.settle({ value: 5 }), { state: 'none' })
  spend.begin({ value: 5 })
  spend.reset()
  assert.deepEqual(spend.settle({ value: 6 }), { state: 'none' })
  assert.equal(spend.last(), undefined)
})
