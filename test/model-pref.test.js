/**
 * The host `/model` preference reader.
 *
 * Pinned because it is the account section's fallback route: the bug it was
 * added for is a restored conversation reporting the OFFICIAL balance on a
 * machine whose current route is a subscription provider. Two things must hold:
 * only a complete persisted route counts (the host discards a half-written
 * file), and anything missing or unreadable is silence rather than a guess.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { MODEL_PREF_FILE, modelPrefPath, parseModelProvider, readHostModelProvider } from '../lib/model-pref.js'
import { MODEL_PREF_FIXTURE } from '../test-support/harness.js'

test('the preference is the host file, relocatable with the TUI state directory', () => {
  assert.equal(MODEL_PREF_FILE, join(homedir(), '.dsh-tui', 'model.json'))
  assert.equal(modelPrefPath({}), MODEL_PREF_FILE)
  assert.equal(modelPrefPath({ DSH_TUI_STATE_DIR: '/tmp/state' }), join('/tmp/state', 'model.json'))
  assert.equal(modelPrefPath({ DSH_PEAK_BALANCE_MODEL_FILE: 'C:/tmp/model.json' }), 'C:/tmp/model.json')
  // An explicit path (a test that already built one) wins over both.
  assert.equal(
    modelPrefPath({ DSH_PEAK_BALANCE_MODEL_FILE: 'C:/tmp/model.json' }, { modelFile: 'C:/tmp/other.json' }),
    'C:/tmp/other.json',
  )
  // An empty override is not a path, and an empty state dir is not a directory.
  assert.equal(modelPrefPath({ DSH_PEAK_BALANCE_MODEL_FILE: '', DSH_TUI_STATE_DIR: '' }), MODEL_PREF_FILE)
})

test('only a complete persisted route names a provider', () => {
  const route = '{"provider":"commandcode","model":"deepseek/deepseek-v4.1-flash"}'
  assert.equal(parseModelProvider(route), 'commandcode')
  // The host's own parser discards a route missing either half (issue #67 in
  // dsh-tui: never merge halves), so a half-written file must not count here.
  assert.equal(parseModelProvider('{"provider":"commandcode"}'), '')
  assert.equal(parseModelProvider('{"model":"deepseek-flash"}'), '')
  assert.equal(parseModelProvider('{"provider":"commandcode","model":""}'), '')
  assert.equal(parseModelProvider('{"provider":"","model":"deepseek-flash"}'), '')
  assert.equal(parseModelProvider('{"provider":null,"model":"x"}'), '')
  assert.equal(parseModelProvider('[{"provider":"x","model":"y"}]'), '')
  assert.equal(parseModelProvider('not json at all'), '')
  assert.equal(parseModelProvider(''), '')
})

test('a missing or unreadable file is silence, not a fallback route', () => {
  const enoent = () => {
    throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
  }
  assert.equal(readHostModelProvider({ readFile: enoent, file: 'nope.json' }), '')
  assert.equal(readHostModelProvider({ readFile: () => undefined, file: 'nope.json' }), '')
  assert.equal(
    readHostModelProvider({ readFile: () => '{ "provider": "moonshot", "model": "kimi-k2" }', file: 'model.json' }),
    'moonshot',
  )
})

test('the fixture names the subscription route the wiring tests rely on', () => {
  assert.equal(readHostModelProvider({ file: MODEL_PREF_FIXTURE }), 'commandcode')
})
