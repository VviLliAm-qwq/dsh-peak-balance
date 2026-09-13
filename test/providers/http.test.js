import { test } from 'node:test'
import assert from 'node:assert/strict'

import { fetchJson } from '../../lib/providers/http.js'

/** A synthetic response with a trackable body. */
function response(options = {}) {
  const cancelled = { count: 0 }
  return {
    cancelled,
    response: {
      ok: options.ok ?? true,
      status: options.status ?? 200,
      body: { cancel: async () => { cancelled.count += 1 } },
      json: options.json ?? (async () => ({})),
    },
  }
}

test('a failure body is cancelled so its socket is not left to the collector', async () => {
  const { response: reply, cancelled } = response({ ok: false, status: 500 })
  const result = await fetchJson('https://relay.example.com/v1/dashboard/billing/usage', {
    fetchImpl: async () => reply,
  })
  assert.deepEqual(result, { ok: false, reason: 'http', status: 500 })
  assert.equal(cancelled.count, 1)
})

test('a body that dies mid-read while the request was aborted is a network failure', async () => {
  // The timeout aborts the same controller that owns the body stream, so a
  // rejection during `json()` after the abort is the transport failing — not
  // the endpoint answering with nonsense.
  //
  // `fetchJson` deliberately `unref()`s its timeout, so nothing in this test
  // holds the event loop open. On Node 22 the runner then declares the loop
  // resolved and cancels the test before the 5 ms abort can fire ("Promise
  // resolution is still pending but the event loop has already resolved"); the
  // Node 24 runner is forgiving, which is why this only ever failed on the
  // lowest supported line. Holding the loop with a ref'd interval keeps the
  // assertion about the classification instead of the runner's bookkeeping.
  const keepAlive = setInterval(() => {}, 1000)
  try {
    const result = await fetchJson('https://relay.example.com/v1/dashboard/billing/usage', {
      timeoutMs: 5,
      fetchImpl: async (url, init) => ({
        ok: true,
        status: 200,
        json: () => new Promise((resolve, reject) => {
          init.signal.addEventListener('abort', () => reject(new Error('aborted')))
        }),
      }),
    })
    assert.deepEqual(result, { ok: false, reason: 'network', status: 200 })
  } finally {
    clearInterval(keepAlive)
  }
})

test('an intact body that is not JSON stays a payload failure', async () => {
  const { response: reply } = response({
    json: async () => {
      throw new SyntaxError('Unexpected token < in JSON')
    },
  })
  const result = await fetchJson('https://relay.example.com/v1/dashboard/billing/usage', {
    fetchImpl: async () => reply,
  })
  assert.deepEqual(result, { ok: false, reason: 'invalid', status: 200 })
})

test('a body that cannot be cancelled does not fail the request', async () => {
  const result = await fetchJson('https://relay.example.com/v1/dashboard/billing/usage', {
    fetchImpl: async () => ({ ok: false, status: 404, json: async () => ({}) }),
  })
  assert.deepEqual(result, { ok: false, reason: 'http', status: 404 })
})
