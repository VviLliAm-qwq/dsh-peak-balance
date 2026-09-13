import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  bucketKeyOf,
  buildHistoryView,
  foldSessionEvents,
  providerOfHeader,
  splitBucketKey,
} from '../lib/history.js'
import { resolveRateCardForKey, rateSourceForKey } from '../lib/pricing.js'

/** 2026-09-07 12:00 Beijing — a Monday, off-peak. */
const MONDAY_NOON = Date.UTC(2026, 8, 7, 4, 0, 0)

/** One `assistant/message` usage report. */
function usageEvent(seq, time, usage) {
  return { type: 'assistant/message', seq, time, data: { usage } }
}

/** One `request/header` naming a provider and a model. */
function headerEvent(seq, provider, model) {
  return { type: 'request/header', seq, time: MONDAY_NOON, data: { header: { config: { provider, model } } } }
}

/** A session header event. */
const SESSION = { type: 'session', id: 's1', createdAt: MONDAY_NOON, seq: 0 }

test('a bucket key carries the provider, and a bare model id still splits', () => {
  assert.equal(bucketKeyOf('commandcode', 'deepseek/deepseek-v4.1-flash'), 'commandcode/deepseek/deepseek-v4.1-flash')
  assert.equal(bucketKeyOf('', 'deepseek-flash'), 'deepseek-flash')
  assert.equal(bucketKeyOf('commandcode', ''), 'commandcode/(unknown)')
  assert.deepEqual(splitBucketKey('commandcode/deepseek/deepseek-v4.1-flash'), {
    provider: 'commandcode',
    model: 'deepseek/deepseek-v4.1-flash',
  })
  assert.deepEqual(splitBucketKey('deepseek-flash'), { provider: '', model: 'deepseek-flash' })
  assert.deepEqual(splitBucketKey(''), { provider: '', model: '' })

  // A provider-less model id that contains slashes of its own must not be read
  // as `provider/model`: the two-part form would invent `inclusionai` as an
  // account and shorten the model id.
  const free = 'inclusionai/ling-3.0-flash-sante:free'
  assert.equal(bucketKeyOf('', free), `/${free}`)
  assert.deepEqual(splitBucketKey(`/${free}`), { provider: '', model: free })
  assert.deepEqual(splitBucketKey(bucketKeyOf('', free)), { provider: '', model: free })
  // The provider-qualified form is untouched by the marker.
  assert.equal(bucketKeyOf('commandcode', free), `commandcode/${free}`)
  assert.deepEqual(splitBucketKey(bucketKeyOf('commandcode', free)), { provider: 'commandcode', model: free })
})

test('a provider-less model with a slash keeps its own row and invents no provider', () => {
  const record = foldSessionEvents([
    { ...SESSION, id: 'free' },
    { type: 'request/header', seq: 1, time: MONDAY_NOON, data: { header: { config: { model: 'inclusionai/ling-3.0-flash-sante:free' } } } },
    usageEvent(2, MONDAY_NOON, { inputTokens: 100, outputTokens: 10 }),
  ])
  assert.deepEqual(Object.keys(record.models), ['/inclusionai/ling-3.0-flash-sante:free'])
  const view = buildHistoryView([record], { now: MONDAY_NOON })
  assert.equal(view.models.length, 1)
  assert.equal(view.models[0].provider, '')
  assert.equal(view.models[0].providerLabel, '—')
  assert.equal(view.models[0].model, 'inclusionai/ling-3.0-flash-sante:free')
  assert.deepEqual(view.allProviders, [''])
  // No rate card prices this id, so it reports tokens without a CNY figure.
  assert.equal(view.models[0].source, 'unknown')
  assert.equal(view.models[0].cost, 0)
  assert.equal(view.models[0].costIncomplete, true)
})

test('the provider is read off the request header', () => {
  assert.equal(providerOfHeader(headerEvent(1, 'commandcode', 'x')), 'commandcode')
  assert.equal(providerOfHeader({ type: 'request/header', data: { header: { config: {} } } }), '')
  assert.equal(providerOfHeader(undefined), '')
})

test('usage is filed under the provider in force when the request ran', () => {
  const record = foldSessionEvents([
    SESSION,
    headerEvent(1, 'deepseek-official', 'deepseek-flash'),
    usageEvent(2, MONDAY_NOON, { inputTokens: 10, outputTokens: 1 }),
    headerEvent(3, 'commandcode', 'deepseek/deepseek-v4.1-flash'),
    usageEvent(4, MONDAY_NOON, { inputTokens: 20, outputTokens: 2 }),
  ])
  assert.deepEqual(Object.keys(record.models).sort(), [
    'commandcode/deepseek/deepseek-v4.1-flash',
    'deepseek-official/deepseek-flash',
  ])
  assert.equal(record.models['deepseek-official/deepseek-flash'].days['2026-09-07'].idle.input, 10)
  assert.equal(record.models['commandcode/deepseek/deepseek-v4.1-flash'].days['2026-09-07'].idle.input, 20)
})

test('a header without a provider does not erase the one already known', () => {
  const record = foldSessionEvents([
    SESSION,
    headerEvent(1, 'commandcode', 'deepseek/deepseek-v4.1-flash'),
    { type: 'request/header', seq: 2, time: MONDAY_NOON, data: { header: { config: { model: 'deepseek/deepseek-v4.1-flash' } } } },
    usageEvent(3, MONDAY_NOON, { inputTokens: 5, outputTokens: 1 }),
  ])
  assert.deepEqual(Object.keys(record.models), ['commandcode/deepseek/deepseek-v4.1-flash'])
})

test('pre-0.4.0 records (no provider in the key) still aggregate as one row', () => {
  const legacy = [{ id: 'old', models: { 'deepseek-flash': { days: { '2026-09-07': { peak: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, events: 0 }, idle: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0, events: 1 } } } } } }]
  const view = buildHistoryView(legacy, { now: MONDAY_NOON })
  assert.equal(view.models.length, 1)
  assert.equal(view.models[0].provider, '')
  assert.equal(view.models[0].providerLabel, '—')
  assert.deepEqual(view.allProviders, [''])
})

test('the board separates per-provider subtotals and sums them in one unit', () => {
  const records = [
    {
      id: 'a',
      models: {
        'deepseek-official/deepseek-flash': { days: { '2026-09-07': { peak: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, events: 0 }, idle: { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0, events: 1 } } } },
        'commandcode/deepseek/deepseek-v4.1-flash': { days: { '2026-09-07': { peak: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, events: 0 }, idle: { input: 500_000, output: 0, cacheRead: 0, cacheWrite: 0, events: 1 } } } },
      },
    },
  ]
  const view = buildHistoryView(records, { now: MONDAY_NOON, metric: 'cost' })
  assert.deepEqual(view.allProviders, ['commandcode', 'deepseek-official'])
  assert.equal(view.providers.length, 2)
  const byId = Object.fromEntries(view.providers.map(row => [row.id, row]))
  // 1M off-peak miss tokens on the official card = ¥1.
  assert.equal(byId['deepseek-official'].cost, 1)
  // The subscription route's model is unpriced here (the CNY card does not list
  // `deepseek-v4.1-flash`): the row exists, with tokens, and says so rather than
  // costing zero.
  assert.equal(byId.commandcode.cost, 0)
  assert.equal(byId.commandcode.costIncomplete, true)
  // Every figure is a CNY estimate from the same card, so the two rows are
  // summable and the cost metric stays selected even across two accounts.
  assert.equal(view.metric, 'cost')
  assert.equal(view.totals.cost, 1)
  assert.equal(byId.commandcode.unit, undefined)
})

test('the cost metric is one unit everywhere, with no fallback machinery left', () => {
  const records = [{ id: 'a', models: { 'deepseek-official/deepseek-flash': { days: { '2026-09-07': { peak: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, events: 0 }, idle: { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0, events: 1 } } } } } }]
  const view = buildHistoryView(records, { now: MONDAY_NOON, metric: 'cost' })
  assert.equal(view.metric, 'cost')
  assert.equal(view.totals.cost, 1)
  assert.equal(view.mixedUnits, undefined)
  assert.equal(view.costUnit, undefined)
  assert.equal(view.metricFallback, undefined)
  assert.equal(view.requestedMetric, undefined)
  for (const row of [...view.models, ...view.providers]) assert.equal(row.unit, undefined)
})

test('the provider filter narrows the board without hiding the alternatives', () => {
  const records = [{
    id: 'a',
    models: {
      'deepseek-official/deepseek-flash': { days: { '2026-09-07': { peak: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, events: 0 }, idle: { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0, events: 1 } } } },
      'commandcode/deepseek/deepseek-v4.1-flash': { days: { '2026-09-07': { peak: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, events: 0 }, idle: { input: 100, output: 0, cacheRead: 0, cacheWrite: 0, events: 1 } } } },
    },
  }]
  const view = buildHistoryView(records, { now: MONDAY_NOON, metric: 'cost', providerFilter: 'deepseek-official' })
  assert.equal(view.providerFilter, 'deepseek-official')
  assert.equal(view.models.length, 1)
  assert.equal(view.providers.length, 1)
  assert.deepEqual(view.allProviders, ['commandcode', 'deepseek-official'])
  assert.equal(view.metric, 'cost')
  assert.equal(view.totals.cost, 1)
})

test('a provider-qualified custom rate wins over the bare model id', () => {
  const custom = {
    'deepseek-flash': { idle: { inputHit: 1, inputMiss: 1, output: 1 }, peak: { inputHit: 1, inputMiss: 1, output: 1 } },
    'commandcode:deepseek-v4.1-flash': { idle: { inputHit: 2, inputMiss: 2, output: 2 }, peak: { inputHit: 2, inputMiss: 2, output: 2 } },
  }
  assert.equal(resolveRateCardForKey('commandcode/deepseek/deepseek-v4.1-flash', MONDAY_NOON, custom, 'commandcode', 'deepseek/deepseek-v4.1-flash').idle.inputMiss, 2)
  assert.equal(resolveRateCardForKey('deepseek-official/deepseek-flash', MONDAY_NOON, custom, 'deepseek-official', 'deepseek-flash').idle.inputMiss, 1)
  assert.equal(rateSourceForKey('commandcode/deepseek/deepseek-v4.1-flash', custom, MONDAY_NOON, 'commandcode', 'deepseek/deepseek-v4.1-flash'), 'custom')
  // Without a provider-qualified entry the bare id still applies.
  assert.equal(rateSourceForKey('commandcode/deepseek/deepseek-v4.1-flash', { 'deepseek-v4.1-flash': custom['deepseek-flash'] }, MONDAY_NOON, 'commandcode', 'deepseek/deepseek-v4.1-flash'), 'custom')
})

test('the history cache version was bumped for the bucket-key encoding', async () => {
  const { CACHE_VERSION } = await import('../lib/history-scan.js')
  const { BARE_KEY_PREFIX } = await import('../lib/history.js')
  // v2 documents store a provider-less slashed model as `a/b`, which the v3
  // split would read as provider `a`; the version bump is what retires them.
  assert.equal(CACHE_VERSION, 3)
  assert.equal(BARE_KEY_PREFIX, '/')
})
