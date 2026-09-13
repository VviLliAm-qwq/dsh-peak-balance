import { test } from 'node:test'
import assert from 'node:assert/strict'

import { needsUnofficial, resolveAdapter } from '../../lib/providers/registry.js'

const SPEC = {
  provider: 'my-relay',
  adapter: 'declared',
  requests: [{ path: '/quota', method: 'GET', headers: {}, meters: [{ id: 'balance', kind: 'money', valuePath: 'total' }] }],
}

test('a built-in adapter claims its own provider id', () => {
  assert.equal(resolveAdapter({ provider: 'deepseek-official' }).adapter.ADAPTER_ID, 'deepseek-balance')
  assert.equal(resolveAdapter({ provider: 'commandcode' }).adapter.ADAPTER_ID, 'commandcode-plan')
})

test('an unknown id is claimed by base-URL host', () => {
  const { adapter, reason } = resolveAdapter({ provider: 'cc-alt', baseUrl: 'https://api.commandcode.ai/v1' })
  assert.equal(adapter.ADAPTER_ID, 'commandcode-plan')
  assert.match(reason, /host/)
})

test('the host claim parses the hostname, so a lookalike is not claimed', () => {
  // A substring test would hand the Moonshot adapter a key meant for a
  // lookalike host; the route then goes unclaimed rather than misrouted.
  for (const baseUrl of [
    'https://api.moonshot.cn.evil.tld/v1',
    'https://evil.tld/api.moonshot.cn',
    'https://api.moonshot.ai.evil.tld/v1',
  ]) {
    assert.equal(resolveAdapter({ provider: 'not-a-real-route', baseUrl }).adapter, undefined)
  }
  // A real subdomain and a path under the claimed host still count.
  assert.equal(resolveAdapter({ provider: 'cc-alt', baseUrl: 'https://relay.api.commandcode.ai/v1' }).adapter.ADAPTER_ID, 'commandcode-plan')
  assert.equal(resolveAdapter({ provider: 'ds-alt', baseUrl: 'https://api.deepseek.com/proxy/v1' }).adapter.ADAPTER_ID, 'deepseek-balance')
})

test('a Moonshot alias route needs a base URL instead of guessing the CN host', () => {
  // `kimi` / `moonshot` are not catalog route ids: without a configured host
  // there is no way to know whether the account bills in CNY or USD, so the
  // honest answer is "no interface known" rather than a silent CN read.
  assert.equal(resolveAdapter({ provider: 'kimi' }).adapter, undefined)
  assert.equal(resolveAdapter({ provider: 'moonshot' }).adapter, undefined)
  assert.equal(resolveAdapter({ provider: 'kimi', baseUrl: 'https://api.moonshot.ai/v1' }).adapter.ADAPTER_ID, 'moonshot-balance')
})

test('a spec stanza selects the declarative adapter', () => {
  const { adapter, reason } = resolveAdapter({ provider: 'my-relay', spec: SPEC })
  assert.equal(adapter.ADAPTER_ID, 'declared')
  assert.equal(reason, 'declarative spec')
})

test('a spec may force another built-in adapter', () => {
  const forced = { ...SPEC, adapter: 'openai-billing' }
  assert.equal(resolveAdapter({ provider: 'my-relay', spec: forced }).adapter.ADAPTER_ID, 'openai-billing')
})

test('a hand-declared gateway falls back to the OpenAI-compatible billing pair', () => {
  const { adapter, reason } = resolveAdapter({
    provider: 'my-gw',
    baseUrl: 'https://gw.example.com/v1',
    declared: true,
  })
  assert.equal(adapter.ADAPTER_ID, 'openai-billing')
  assert.match(reason, /hand-declared/)
})

test('a first-party catalog route is never probed with a relay-only endpoint', () => {
  const { adapter, reason } = resolveAdapter({ provider: 'openai', baseUrl: 'https://api.openai.com/v1' })
  assert.equal(adapter, undefined)
  assert.match(reason, /no quota interface/)
})

test('an explicit spec stanza outranks the relay guess', () => {
  const { adapter } = resolveAdapter({ provider: 'my-gw', baseUrl: 'https://gw.example.com', declared: true, spec: SPEC })
  assert.equal(adapter.ADAPTER_ID, 'declared')
})

test('Command Code is enabled by default (the provider CLI drives the same endpoints)', () => {
  assert.equal(needsUnofficial(resolveAdapter({ provider: 'commandcode' }).adapter), false)
  assert.equal(needsUnofficial(undefined), false)
})
