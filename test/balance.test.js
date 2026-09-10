import { test } from 'node:test'
import assert from 'node:assert/strict'

import { BALANCE_ENDPOINT, cnyBalance, fetchBalance, parseBalancePayload } from '../lib/balance.js'

const OK_PAYLOAD = {
  is_available: true,
  balance_infos: [
    { currency: 'CNY', total_balance: '12.34', granted_balance: '0.00', topped_up_balance: '12.34' },
    { currency: 'USD', total_balance: '1.70', granted_balance: '0.00', topped_up_balance: '1.70' },
  ],
}

/** Minimal fetch stand-in. */
function fakeFetch(handler) {
  const calls = []
  const impl = async (url, init) => {
    calls.push({ url, init })
    return handler(url, init)
  }
  impl.calls = calls
  return impl
}

const jsonResponse = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
})

test('a missing key short-circuits without any request', async () => {
  const impl = fakeFetch(() => jsonResponse(OK_PAYLOAD))
  const result = await fetchBalance('', { fetchImpl: impl })
  assert.deepEqual(result, { ok: false, reason: 'no-key' })
  assert.equal(impl.calls.length, 0)
})

test('a successful lookup is parsed and the key rides the auth header', async () => {
  const impl = fakeFetch(() => jsonResponse(OK_PAYLOAD))
  const result = await fetchBalance('sk-test', { fetchImpl: impl })
  assert.equal(result.ok, true)
  assert.equal(result.isAvailable, true)
  assert.equal(result.balances.length, 2)
  assert.equal(impl.calls[0].url, BALANCE_ENDPOINT)
  assert.equal(impl.calls[0].init.headers.authorization, 'Bearer sk-test')
  assert.equal(cnyBalance(result).total, 12.34)
})

test('a custom base URL keeps the documented route', async () => {
  const impl = fakeFetch(() => jsonResponse(OK_PAYLOAD))
  await fetchBalance('sk-test', { fetchImpl: impl, baseUrl: 'https://example.test/' })
  assert.equal(impl.calls[0].url, 'https://example.test/user/balance')
})

test('http failures map to reasons instead of throwing', async () => {
  for (const status of [401, 403]) {
    const result = await fetchBalance('sk-test', { fetchImpl: fakeFetch(() => jsonResponse({}, status)) })
    assert.deepEqual(result, { ok: false, reason: 'unauthorized', status })
  }
  const serverError = await fetchBalance('sk-test', { fetchImpl: fakeFetch(() => jsonResponse({}, 500)) })
  assert.deepEqual(serverError, { ok: false, reason: 'http', status: 500 })
})

test('a transport failure is a value, never a rejection', async () => {
  const result = await fetchBalance('sk-test', {
    fetchImpl: async () => {
      throw new Error('socket hang up')
    },
  })
  assert.deepEqual(result, { ok: false, reason: 'network' })
})

test('a malformed payload is rejected rather than half-read', () => {
  assert.equal(parseBalancePayload({}), undefined)
  assert.equal(parseBalancePayload({ balance_infos: 'nope' }), undefined)
  assert.equal(parseBalancePayload({ balance_infos: [{ currency: 'CNY' }] }), undefined)
  assert.equal(parseBalancePayload(null), undefined)
  assert.deepEqual(parseBalancePayload({ balance_infos: [] }), { ok: true, isAvailable: false, balances: [] })
})

test('numeric strings and numbers are both accepted', () => {
  const parsed = parseBalancePayload({
    is_available: true,
    balance_infos: [{ currency: 'CNY', total_balance: 3.5, granted_balance: '1', topped_up_balance: 2.5 }],
  })
  assert.equal(parsed.balances[0].total, 3.5)
  assert.equal(cnyBalance(parsed).granted, 1)
})

test('cnyBalance falls back to the first entry when no CNY row exists', () => {
  const parsed = parseBalancePayload({
    is_available: true,
    balance_infos: [{ currency: 'USD', total_balance: '1', granted_balance: '0', topped_up_balance: '1' }],
  })
  assert.equal(cnyBalance(parsed).currency, 'USD')
  assert.equal(cnyBalance({ ok: false, reason: 'network' }), undefined)
})
