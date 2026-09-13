import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  discoverProvider,
  drill,
  findConfigurableProvider,
  readProviderSection,
  resolveCredential,
} from '../../lib/providers/discovery.js'

const llm = entries => [{ listConfigurableProviders: () => entries }]
const settings = sections => [{ get: ns => sections[ns] }]

test('a directory entry carries the settings pointer and the declared flag', () => {
  const entry = findConfigurableProvider(llm([
    { provider: 'commandcode', displayName: 'Command Code', settingsNs: 'llm-commandcode', settingsPath: [], declared: false },
  ]), 'commandcode')
  assert.deepEqual(entry, {
    provider: 'commandcode',
    displayName: 'Command Code',
    settingsNs: 'llm-commandcode',
    settingsPath: [],
    declared: false,
  })
})

test('a throwing or absent seam is treated as "no directory entry"', () => {
  const hostile = [{ listConfigurableProviders: () => { throw new Error('refused') } }]
  assert.equal(findConfigurableProvider(hostile, 'commandcode'), undefined)
  assert.equal(findConfigurableProvider([{}], 'commandcode'), undefined)
  assert.equal(findConfigurableProvider(undefined, 'commandcode'), undefined)
})

test('the settings section is read through the entry path', () => {
  const profile = readProviderSection(
    settings({ 'llm-pi-ai': { providers: { openrouter: { baseURL: 'https://openrouter.ai/api/v1', apiKeyEnv: 'OPENROUTER_API_KEY' } } } }),
    { settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'openrouter'] },
  )
  assert.equal(profile.baseURL, 'https://openrouter.ai/api/v1')
  assert.equal(readProviderSection([{ get: () => undefined }], { settingsNs: 'llm-x' }), undefined)
})

test('drill walks a nested path and stops safely on a miss', () => {
  assert.equal(drill({ a: { b: { c: 1 } } }, ['a', 'b', 'c']), 1)
  assert.equal(drill({ a: 1 }, ['a', 'b']), undefined)
  assert.deepEqual(drill({ a: 1 }, []), { a: 1 })
})

test('base url precedence: spec override, then provider stanza, then the route section, then the catalog', () => {
  const withSpec = discoverProvider({
    provider: 'commandcode',
    llmServices: llm([]),
    settingsServices: settings({}),
    spec: { apiBases: { commandcode: 'https://spec.example.com' }, providers: {} },
  })
  assert.equal(withSpec.baseUrl, 'https://spec.example.com')
  assert.ok(withSpec.sources.includes('spec.apiBases'))

  const withSection = discoverProvider({
    provider: 'openrouter',
    llmServices: llm([{ provider: 'openrouter', displayName: 'OpenRouter', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'openrouter'] }]),
    settingsServices: settings({ 'llm-pi-ai': { providers: { openrouter: { baseURL: 'https://openrouter.ai/api/v1', apiKeyEnv: 'OPENROUTER_API_KEY' } } } }),
    spec: { apiBases: {}, providers: {} },
  })
  assert.equal(withSection.baseUrl, 'https://openrouter.ai/api/v1')
  assert.equal(withSection.apiKeyRef, 'OPENROUTER_API_KEY')
  assert.equal(withSection.displayName, 'OpenRouter')
  assert.ok(withSection.sources.includes('settings section'))
})

test('a provider nothing is known about still resolves, with empty fields', () => {
  const profile = discoverProvider({ provider: 'mystery', llmServices: llm([]), settingsServices: settings({}), spec: { apiBases: {}, providers: {} } })
  assert.deepEqual([profile.baseUrl, profile.apiKeyRef, profile.declared], [undefined, undefined, false])
  assert.equal(profile.displayName, 'mystery')
})

test('a credential is resolved through the seam first and the environment second', async () => {
  const seam = [{ resolve: async ref => (ref === 'X_KEY' ? { value: 'from-seam' } : undefined) }]
  assert.equal(await resolveCredential(seam, 'X_KEY', { X_KEY: 'from-env' }), 'from-seam')
  assert.equal(await resolveCredential(seam, 'Y_KEY', { Y_KEY: 'from-env' }), 'from-env')
  assert.equal(await resolveCredential([{ resolve: async () => { throw new Error('refused') } }], 'Z_KEY', { Z_KEY: 'env' }), 'env')
  assert.equal(await resolveCredential(seam, '', { X_KEY: 'env' }), '')
  assert.equal(await resolveCredential(seam, 'MISSING', {}), '')
})
