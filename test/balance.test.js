import { test } from 'node:test'
import assert from 'node:assert/strict'

import { parseBalancePayload } from '../lib/balance.js'

test('a malformed payload is rejected rather than half-read', () => {
  assert.equal(parseBalancePayload({}), undefined)
  assert.equal(parseBalancePayload({ balance_infos: 'nope' }), undefined)
  assert.equal(parseBalancePayload({ balance_infos: [{ currency: 'CNY' }] }), undefined)
  assert.equal(parseBalancePayload(null), undefined)
  assert.deepEqual(parseBalancePayload({ balance_infos: [] }), { ok: true, isAvailable: false, balances: [] })
})

test('numeric strings and numbers are both accepted, and every row is kept', () => {
  const parsed = parseBalancePayload({
    is_available: true,
    balance_infos: [
      { currency: 'CNY', total_balance: 3.5, granted_balance: '1', topped_up_balance: 2.5 },
      { currency: 'USD', total_balance: '1', granted_balance: '0', topped_up_balance: '1' },
    ],
  })
  assert.equal(parsed.isAvailable, true)
  assert.deepEqual(parsed.balances, [
    { currency: 'CNY', total: 3.5, granted: 1, toppedUp: 2.5 },
    { currency: 'USD', total: 1, granted: 0, toppedUp: 1 },
  ])
})
