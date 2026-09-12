import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  PEAK_MULTIPLIER,
  RATES_VERSION,
  describeEntry,
  makeEntry,
  normalizeEntry,
  normalizeTier,
  parseRates,
  ratesPath,
  readRates,
  serializeRates,
  withRate,
  withoutAllRates,
  withoutRate,
  writeRates,
} from '../lib/rates.js'

test('the rate file lives in the plugin state directory', () => {
  assert.equal(ratesPath({ DSH_TUI_STATE_DIR: '/tmp/state' }), join('/tmp/state', 'dsh-peak-balance-rates.json'))
  assert.match(ratesPath({}), /dsh-peak-balance-rates\.json$/)
})

test('makeEntry doubles the off-peak price into the peak tier', () => {
  const entry = makeEntry({ hit: 0.02, miss: 1, out: 4 }, 111)
  assert.deepEqual(entry, {
    idle: { inputHit: 0.02, inputMiss: 1, output: 4 },
    peak: { inputHit: 0.04, inputMiss: 2, output: 8 },
    updatedAt: 111,
  })
  assert.equal(PEAK_MULTIPLIER, 2)
  assert.equal(RATES_VERSION, 1)
})

test('makeEntry keeps explicit peak prices', () => {
  const entry = makeEntry({ hit: 1, miss: 2, out: 3, peakHit: 10, peakMiss: 20, peakOut: 30 })
  assert.deepEqual(entry.peak, { inputHit: 10, inputMiss: 20, output: 30 })
  // A partial explicit tier is invalid rather than silently half-derived.
  assert.equal(makeEntry({ hit: 1, miss: 2, out: 3, peakHit: 10 }), undefined)
})

test('makeEntry rejects anything that is not a non-negative finite price', () => {
  for (const spec of [
    undefined,
    {},
    { hit: 1, miss: 2 },
    { hit: -1, miss: 2, out: 3 },
    { hit: '1', miss: 2, out: 3 },
    { hit: Number.NaN, miss: 2, out: 3 },
    { hit: Number.POSITIVE_INFINITY, miss: 2, out: 3 },
  ]) {
    assert.equal(makeEntry(spec), undefined, JSON.stringify(spec))
  }
  // Zero is a legitimate price.
  assert.deepEqual(makeEntry({ hit: 0, miss: 0, out: 0 }).idle, { inputHit: 0, inputMiss: 0, output: 0 })
})

test('normalizeEntry tolerates flat and partially hand-edited entries', () => {
  assert.deepEqual(normalizeTier({ inputHit: 1, inputMiss: 2, output: 3 }), { inputHit: 1, inputMiss: 2, output: 3 })
  assert.equal(normalizeTier(null), undefined)
  assert.equal(normalizeTier({ inputHit: 1 }), undefined)

  const flat = normalizeEntry({ inputHit: 1, inputMiss: 2, output: 3 }, 7)
  assert.deepEqual(flat.idle, { inputHit: 1, inputMiss: 2, output: 3 })
  assert.deepEqual(flat.peak, { inputHit: 2, inputMiss: 4, output: 6 })
  assert.equal(flat.updatedAt, 7)

  const kept = normalizeEntry({ idle: { inputHit: 1, inputMiss: 2, output: 3 }, updatedAt: 42 }, 7)
  assert.equal(kept.updatedAt, 42)
  assert.equal(normalizeEntry({ nope: true }), undefined)
  assert.equal(normalizeEntry(undefined), undefined)
})

test('parseRates drops unusable entries and normalizes model ids', () => {
  const text = JSON.stringify({
    version: RATES_VERSION,
    rates: {
      'deepseek-official/mystery-model': { idle: { inputHit: 1, inputMiss: 2, output: 3 } },
      'MYSTERY-TWO': { inputHit: 4, inputMiss: 5, output: 6 },
      broken: { inputHit: 'x' },
      '': { inputHit: 1, inputMiss: 1, output: 1 },
    },
  })
  const rates = parseRates(text)
  assert.deepEqual(Object.keys(rates).sort(), ['mystery-model', 'mystery-two'])
  assert.deepEqual(rates['mystery-model'].peak, { inputHit: 2, inputMiss: 4, output: 6 })

  for (const bad of ['not json', 'null', '[]', '{}', '{"rates":42}', '']) {
    assert.deepEqual(parseRates(bad), {}, bad)
  }
})

test('serializeRates round-trips through parseRates', () => {
  const rates = {
    'mystery-model': {
      idle: { inputHit: 0.02, inputMiss: 1, output: 4 },
      peak: { inputHit: 0.04, inputMiss: 2, output: 8 },
      updatedAt: 5,
    },
  }
  const text = serializeRates(rates, 99)
  assert.match(text, /\n$/)
  const parsed = JSON.parse(text)
  assert.equal(parsed.version, RATES_VERSION)
  assert.equal(parsed.rates['mystery-model'].updatedAt, 5)
  const back = parseRates(text)
  assert.deepEqual(back['mystery-model'].idle, rates['mystery-model'].idle)
  // A missing timestamp is stamped on the way out.
  const stamped = JSON.parse(serializeRates({ m: { idle: { inputHit: 1, inputMiss: 1, output: 1 } } }, 12))
  assert.equal(stamped.rates.m.updatedAt, 12)
  assert.equal(JSON.parse(serializeRates({ m: null })).rates.m, undefined)
  assert.deepEqual(JSON.parse(serializeRates(undefined)).rates, {})
})

test('withRate and withoutRate are pure and strip provider prefixes', () => {
  const first = withRate({}, 'deepseek-official/mystery', { hit: 1, miss: 2, out: 3 }, 5)
  assert.equal(first.error, undefined)
  assert.equal(first.model, 'mystery')
  assert.deepEqual(Object.keys(first.rates), ['mystery'])
  assert.equal(first.rates.mystery.updatedAt, 5)

  const original = { other: { idle: { inputHit: 1, inputMiss: 1, output: 1 } } }
  const second = withRate(original, 'mystery', { hit: 1, miss: 2, out: 3 })
  assert.equal(Object.keys(original).length, 1)
  assert.deepEqual(Object.keys(second.rates).sort(), ['mystery', 'other'])

  assert.deepEqual(withRate({}, '', { hit: 1, miss: 1, out: 1 }), { error: 'model' })
  assert.deepEqual(withRate({}, 'm', { hit: -1, miss: 1, out: 1 }), { error: 'price' })

  const removed = withoutRate(second.rates, 'MYSTERY')
  assert.equal(removed.removed, true)
  assert.equal(removed.model, 'mystery')
  assert.deepEqual(Object.keys(removed.rates), ['other'])
  assert.deepEqual(withoutRate({}, 'nope'), { rates: {}, model: 'nope', removed: false })
  assert.deepEqual(withoutAllRates(), {})
})

test('readRates and writeRates round-trip on disk and never throw', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-pb-rates-'))
  try {
    const env = { DSH_TUI_STATE_DIR: dir }
    const file = ratesPath(env)
    assert.deepEqual(readRates({ env }), {})

    const rates = withRate({}, 'mystery', { hit: 0.02, miss: 1, out: 4 }, 3).rates
    assert.equal(writeRates(rates, { env }), true)
    assert.deepEqual(readRates({ env }), rates)

    writeFileSync(file, '{ broken')
    assert.deepEqual(readRates({ env }), {})

    // A nested directory that does not exist yet is created on write.
    const nested = join(dir, 'nope', 'deeper')
    assert.equal(writeRates(rates, { env: { DSH_TUI_STATE_DIR: nested } }), true)
    assert.equal(readFileSync(join(nested, 'dsh-peak-balance-rates.json'), 'utf8').length > 0, true)

    assert.equal(writeRates(rates, { path: join(dir, 'dir-as-file', '\u0000x') }), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('describeEntry flattens one entry for display', () => {
  const described = describeEntry(makeEntry({ hit: 1, miss: 2, out: 3 }, 8))
  assert.deepEqual(described, { hit: 1, miss: 2, out: 3, peakHit: 2, peakMiss: 4, peakOut: 6, updatedAt: 8 })
  assert.equal(describeEntry(undefined), undefined)
})
