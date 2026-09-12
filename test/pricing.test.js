import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  FLASH_RATES,
  PRO_RATES,
  PRO_ROUTES_TO_FLASH_AT,
  baseModelId,
  bucketCostCny,
  emptyBuckets,
  estimateCostCny,
  rateCardFor,
  rateSourceOf,
  resolveRateCard,
  totalTokens,
} from '../lib/pricing.js'

const BUCKET = (input, output, cacheRead = 0) => ({ input, output, cacheRead, cacheWrite: 0 })

test('flash rates match the official 2026-09-10 card', () => {
  assert.deepEqual(
    { ...FLASH_RATES.idle },
    { inputHit: 0.02, inputMiss: 1, output: 4 },
  )
  assert.deepEqual(
    { ...FLASH_RATES.peak },
    { inputHit: 0.04, inputMiss: 2, output: 8 },
  )
})

test('pro rates match the official card', () => {
  assert.deepEqual({ ...PRO_RATES.idle }, { inputHit: 0.15, inputMiss: 4.5, output: 13.5 })
  assert.deepEqual({ ...PRO_RATES.peak }, { inputHit: 0.3, inputMiss: 9, output: 27 })
})

test('rateCardFor resolves live, legacy and provider-prefixed ids', () => {
  assert.equal(rateCardFor('deepseek-flash'), FLASH_RATES)
  assert.equal(rateCardFor('deepseek-official/deepseek-flash'), FLASH_RATES)
  assert.equal(rateCardFor('deepseek-v4-flash'), FLASH_RATES)
  assert.equal(rateCardFor('deepseek-v4-flash-vision-exp'), FLASH_RATES)
  assert.equal(rateCardFor('deepseek-v4-pro'), PRO_RATES)
})

test('unknown models stay unrated instead of guessing', () => {
  assert.equal(rateCardFor('gpt-5.5'), undefined)
  assert.equal(rateCardFor(''), undefined)
  assert.equal(rateCardFor(undefined), undefined)
  assert.equal(estimateCostCny({ peak: BUCKET(1000, 100), idle: BUCKET(0, 0) }, 'mystery-model'), undefined)
})

test('v4-pro is billed at flash rates once the route is retired', () => {
  const before = PRO_ROUTES_TO_FLASH_AT - 1
  const after = PRO_ROUTES_TO_FLASH_AT
  assert.equal(rateCardFor('deepseek-v4-pro', before), PRO_RATES)
  assert.equal(rateCardFor('deepseek-v4-pro', after), FLASH_RATES)
})

test('bucket cost prices misses, hits and output as disjoint counts', () => {
  // 100k cache-miss input + 900k cache-hit input + 100k output.
  const idle = bucketCostCny(BUCKET(100_000, 100_000, 900_000), FLASH_RATES.idle)
  assert.equal(idle, (100_000 * 1 + 900_000 * 0.02 + 100_000 * 4) / 1_000_000)
})

test('cache hits are counted in full, not clamped to the miss count', () => {
  // The provider reports the two input figures separately (its `totalTokens`
  // is input + cacheRead + output), so a large cache read must not be capped
  // by a small miss count — clamping here was a real ~2.5x under-price.
  const withLargeHit = bucketCostCny(BUCKET(1000, 0, 9000), FLASH_RATES.idle)
  assert.equal(withLargeHit, (1000 * 1 + 9000 * 0.02) / 1_000_000)
  assert.ok(withLargeHit > bucketCostCny(BUCKET(1000, 0, 0), FLASH_RATES.idle))
})

test('estimateCostCny prices each bucket with its own tier', () => {
  const buckets = { peak: BUCKET(1_000_000, 0), idle: BUCKET(1_000_000, 0) }
  const cost = estimateCostCny(buckets, 'deepseek-flash')
  // 1M miss tokens: 2 元 peak + 1 元 idle.
  assert.equal(cost.peak, 2)
  assert.equal(cost.idle, 1)
  assert.equal(cost.total, 3)
  assert.equal(cost.tokens, 2_000_000)
})

test('empty accounting yields no cost figure', () => {
  assert.equal(estimateCostCny(emptyBuckets(), 'deepseek-flash'), undefined)
  assert.equal(totalTokens(emptyBuckets()), 0)
  assert.equal(totalTokens(undefined), 0)
})

test('totalTokens counts every reported count, cache reads included', () => {
  // The provider's own `totalTokens` is input + cacheRead (+ cacheWrite) +
  // output. Counting only input + output under-reported a warm turn by orders
  // of magnitude (a sampled turn: 61k instead of 31.3M) and let the
  // `tokens <= 0` guard read a cache-only report as "nothing spent".
  const buckets = {
    peak: { input: 1_000, output: 2_000, cacheRead: 30_000_000, cacheWrite: 5 },
    idle: { input: 4, output: 0, cacheRead: 0, cacheWrite: 0 },
  }
  assert.equal(totalTokens(buckets), 30_003_009)
})

test('a cache-only report still has a price', () => {
  const onlyCacheRead = { peak: BUCKET(0, 0), idle: BUCKET(0, 0, 1_000_000) }
  const cost = estimateCostCny(onlyCacheRead, 'deepseek-flash')
  assert.equal(cost.tokens, 1_000_000)
  assert.equal(cost.total, 0.02) // 1M cache hits at the off-peak hit rate
})

test('a small realistic turn is priced to the cent fraction', () => {
  // 12k miss input + 800 output on flash off-peak.
  const cost = estimateCostCny({ peak: BUCKET(0, 0), idle: BUCKET(12_000, 800) }, 'deepseek-flash')
  assert.equal(cost.total, (12_000 * 1 + 800 * 4) / 1_000_000)
  assert.ok(Math.abs(cost.total - 0.0152) < 1e-12)
})

test('baseModelId strips only the provider prefix', () => {
  assert.equal(baseModelId('deepseek-official/deepseek-flash'), 'deepseek-flash')
  assert.equal(baseModelId(' DeepSeek-Flash '), 'deepseek-flash')
  assert.equal(baseModelId('deepseek-flash'), 'deepseek-flash')
  assert.equal(baseModelId(''), '')
  assert.equal(baseModelId(undefined), '')
})

test('custom rates win over the built-in card', () => {
  const custom = {
    'deepseek-flash': {
      idle: { inputHit: 1, inputMiss: 1, output: 1 },
      peak: { inputHit: 2, inputMiss: 2, output: 2 },
    },
  }
  assert.equal(resolveRateCard('deepseek-flash'), FLASH_RATES)
  assert.equal(resolveRateCard('deepseek-flash', Date.now(), custom).idle.inputMiss, 1)
  assert.equal(resolveRateCard('deepseek-official/deepseek-flash', Date.now(), custom).peak.inputMiss, 2)
  // A flat entry (hand-written) is usable in both windows.
  const flat = resolveRateCard('mystery', Date.now(), { mystery: { inputHit: 1, inputMiss: 2, output: 3 } })
  assert.deepEqual(flat.idle, { inputHit: 1, inputMiss: 2, output: 3 })
  assert.equal(flat.peak, flat.idle)
  // Nonsense custom entries fall through to the card instead of pricing wrongly.
  assert.equal(resolveRateCard('deepseek-flash', Date.now(), { 'deepseek-flash': 'nope' }), FLASH_RATES)
  assert.equal(resolveRateCard('deepseek-flash', Date.now(), { 'deepseek-flash': null }), FLASH_RATES)
  assert.equal(resolveRateCard('mystery', Date.now(), null), undefined)
})

test('rateSourceOf names the provenance of the rates', () => {
  const custom = { mystery: { idle: { inputHit: 1, inputMiss: 1, output: 1 }, peak: { inputHit: 2, inputMiss: 2, output: 2 } } }
  assert.equal(rateSourceOf('deepseek-flash'), 'builtin')
  assert.equal(rateSourceOf('deepseek-v4-pro'), 'builtin')
  assert.equal(rateSourceOf('mystery'), 'unknown')
  assert.equal(rateSourceOf('mystery', custom), 'custom')
  assert.equal(rateSourceOf('', custom), 'unknown')
  assert.equal(rateSourceOf(undefined, custom), 'unknown')
})

test('estimateCostCny accepts custom rates end to end', () => {
  const buckets = { peak: BUCKET(1_000_000, 0), idle: BUCKET(1_000_000, 0) }
  const custom = {
    'deepseek-flash': {
      idle: { inputHit: 1, inputMiss: 1, output: 1 },
      peak: { inputHit: 10, inputMiss: 10, output: 10 },
    },
  }
  const cost = estimateCostCny(buckets, 'deepseek-flash', Date.now(), custom)
  assert.equal(cost.peak, 10)
  assert.equal(cost.idle, 1)
  assert.equal(cost.total, 11)
  // An unrated model stays unrated even with unrelated custom rates present.
  assert.equal(estimateCostCny(buckets, 'mystery', Date.now(), custom), undefined)
  assert.equal(estimateCostCny(buckets, 'mystery', Date.now(), { mystery: { idle: {}, peak: {} } }), undefined)
})
