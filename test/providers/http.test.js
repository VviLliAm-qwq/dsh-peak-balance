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
