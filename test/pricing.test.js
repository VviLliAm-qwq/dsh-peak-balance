import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  FLASH_RATES,
  PRO_RATES,
  PRO_ROUTES_TO_FLASH_AT,
  bucketCostCny,
  emptyBuckets,
  estimateCostCny,
  rateCardFor,
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

test('bucket cost prices cache hits separately from misses', () => {
  // 1M input tokens of which 900k hit the cache, plus 100k output.
  const idle = bucketCostCny(BUCKET(1_000_000, 100_000, 900_000), FLASH_RATES.idle)
  // 100k miss * 1 + 900k hit * 0.02 + 100k output * 4, per million.
  assert.equal(idle, (100_000 * 1 + 900_000 * 0.02 + 100_000 * 4) / 1_000_000)
})

test('cache hits can never exceed the input count', () => {
  const withBogusHits = bucketCostCny(BUCKET(1000, 0, 5000), FLASH_RATES.idle)
  const withAllHits = bucketCostCny(BUCKET(1000, 0, 1000), FLASH_RATES.idle)
  assert.equal(withBogusHits, withAllHits)
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

test('a small realistic turn is priced to the cent fraction', () => {
  // 12k miss input + 800 output on flash off-peak.
  const cost = estimateCostCny({ peak: BUCKET(0, 0), idle: BUCKET(12_000, 800) }, 'deepseek-flash')
  assert.equal(cost.total, (12_000 * 1 + 800 * 4) / 1_000_000)
  assert.ok(Math.abs(cost.total - 0.0152) < 1e-12)
})
