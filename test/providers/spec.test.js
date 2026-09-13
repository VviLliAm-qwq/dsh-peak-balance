import { test } from 'node:test'
import assert from 'node:assert/strict'

import { numberAt, parseSpecs, readPath, resetInstant, specPath } from '../../lib/providers/spec.js'

const DOC = {
  version: 1,
  allowUnofficial: true,
  apiBases: { 'my-relay': 'https://relay.example.com', broken: 42 },
  providers: {
    'my-relay': {
      auth: { kind: 'bearer', apiKeyEnv: 'MY_RELAY_KEY' },
      requests: [
        {
          path: '/api/user/self',
          headers: { 'new-api-user': '1', ignored: 7 },
          meters: [
            { id: 'balance', kind: 'money', currency: 'usd', value: 'data.quota', scale: 0.000002 },
            { id: 'periodSpend', kind: 'money', used: 'data.used_quota', cap: 'data.total' },
            { id: 'broken' },
          ],
        },
      ],
      spendCounter: 'data.used_quota',
      spendUnit: { kind: 'money', currency: 'usd' },
    },
    'no-requests': { requests: [] },
  },
}

test('a spec document is normalized, and unusable entries are dropped', () => {
  const spec = parseSpecs(JSON.stringify(DOC))
  assert.equal(spec.allowUnofficial, true)
  assert.deepEqual(spec.apiBases, { 'my-relay': 'https://relay.example.com' })
  assert.deepEqual(Object.keys(spec.providers), ['my-relay'])
  const provider = spec.providers['my-relay']
  assert.equal(provider.apiKeyEnv, 'MY_RELAY_KEY')
  assert.equal(provider.spendCounter, 'data.used_quota')
  assert.deepEqual(provider.spendUnit, { kind: 'money', currency: 'USD' })
  assert.equal(provider.requests[0].method, 'GET')
  assert.deepEqual(provider.requests[0].headers, { 'new-api-user': '1' })
  // The meter that names no readable path is dropped; the other two survive.
  assert.deepEqual(provider.requests[0].meters.map(meter => meter.id), ['balance', 'periodSpend'])
  assert.equal(provider.requests[0].meters[0].currency, 'USD')
  assert.equal(provider.requests[0].meters[0].scale, 0.000002)
})

test('a broken or hostile document reads as an empty spec', () => {
  for (const text of ['', 'not json', '[]', '"nope"', 'null']) {
    const spec = parseSpecs(text)
    assert.deepEqual(spec.providers, {})
    assert.deepEqual(spec.apiBases, {})
    assert.equal(spec.allowUnofficial, false)
  }
})

test('dot paths read nested objects and array indices, and a miss is undefined', () => {
  const payload = { data: { results: [{ amount: '123.45' }], quota: 5 } }
  assert.equal(readPath(payload, 'data.quota'), 5)
  assert.equal(readPath(payload, 'data.results.0.amount'), '123.45')
  assert.equal(readPath(payload, 'data.results.9.amount'), undefined)
  assert.equal(readPath(payload, 'data.missing.deep'), undefined)
  assert.equal(readPath(payload, undefined), undefined)
  assert.equal(readPath(undefined, 'a'), undefined)
})

test('numeric strings are accepted, junk is not', () => {
  assert.equal(numberAt('12.5'), 12.5)
  assert.equal(numberAt(12.5), 12.5)
  assert.equal(numberAt(''), undefined)
  assert.equal(numberAt('abc'), undefined)
  assert.equal(numberAt(Number.NaN), undefined)
  assert.equal(numberAt(null), undefined)
})

test('every reset unit resolves to an epoch instant', () => {
  assert.equal(resetInstant(1_700_000_000_000, 'ms'), 1_700_000_000_000)
  assert.equal(resetInstant(1_700_000_000, 's'), 1_700_000_000_000)
  assert.equal(resetInstant('2026-10-13T05:29:57.000Z', 'iso'), Date.parse('2026-10-13T05:29:57.000Z'))
  assert.equal(resetInstant(60_000, 'remainingMs', 1_000_000), 1_060_000)
  assert.equal(resetInstant(60, 'remainingS', 1_000_000), 1_060_000)
  assert.equal(resetInstant('nope', 'iso'), undefined)
  assert.equal(resetInstant(undefined, 'ms'), undefined)
})

test('the spec path honors the state-directory override', () => {
  assert.match(specPath({ DSH_TUI_STATE_DIR: '/tmp/state' }).replace(/\\/g, '/'), /^\/tmp\/state\/dsh-peak-balance-providers\.json$/)
  assert.match(specPath({}).replace(/\\/g, '/'), /\.dsh-tui\/dsh-peak-balance-providers\.json$/)
})
