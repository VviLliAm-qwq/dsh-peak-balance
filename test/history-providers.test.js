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

test('the board separates per-provider subtotals and never adds two units', () => {
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
  assert.deepEqual(byId['deepseek-official'].unit, { kind: 'money', currency: 'CNY' })
  // The subscription's models are unpriced here (no card, no custom rates): the
  // row exists, with tokens, and says so rather than costing zero.
  assert.equal(byId.commandcode.cost, 0)
  assert.equal(byId.commandcode.costIncomplete, true)
  assert.deepEqual(byId.commandcode.unit, { kind: 'credits' })
  // Two units in play: the cost metric falls back to tokens, and says so.
  assert.equal(view.metric, 'tokens')
  assert.equal(view.requestedMetric, 'cost')
  assert.equal(view.metricFallback, true)
  assert.equal(view.mixedUnits, true)
  assert.equal(view.costUnit, undefined)
})

test('a single unit keeps the cost metric and reports it', () => {
  const records = [{ id: 'a', models: { 'deepseek-official/deepseek-flash': { days: { '2026-09-07': { peak: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, events: 0 }, idle: { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0, events: 1 } } } } } }]
  const view = buildHistoryView(records, { now: MONDAY_NOON, metric: 'cost' })
  assert.equal(view.metric, 'cost')
  assert.equal(view.metricFallback, false)
  assert.equal(view.mixedUnits, false)
  assert.equal(view.costUnit, 'money:CNY')
  assert.equal(view.totals.cost, 1)
})

test('the provider filter narrows the board without hiding the alternatives', () => {
  const records = [{
    id: 'a',
    models: {
      'deepseek-official/deepseek-flash': { days: { '2026-09-07': { peak: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, events: 0 }, idle: { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0, events: 1 } } } },
      'commandcode/deepseek/deepseek-v4.1-flash': { days: { '2026-09-07': { peak: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, events: 0 }, idle: { input: 100, output: 0, cacheRead: 0, cacheWrite: 0, events: 1 } } } },
    },
  }]
  const view = buildHistoryView(records, { now: MONDAY_NOON, providerFilter: 'deepseek-official' })
  assert.equal(view.providerFilter, 'deepseek-official')
  assert.equal(view.models.length, 1)
  assert.equal(view.providers.length, 1)
  assert.deepEqual(view.allProviders, ['commandcode', 'deepseek-official'])
  // One unit on screen after filtering, so cost is usable again.
  assert.equal(view.mixedUnits, false)
  assert.equal(view.costUnit, 'money:CNY')
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

test('the history cache version was bumped for the provider keys', async () => {
  const { CACHE_VERSION } = await import('../lib/history-scan.js')
  assert.equal(CACHE_VERSION, 2)
})
