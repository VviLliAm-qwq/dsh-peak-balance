import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  CONTRIBUTION_PREFIX,
  HISTORY_COMMANDS,
  SCENE_ID,
  contributionIdOf,
  createCommandDefinitions,
  parseHistoryArgs,
  renderPriceList,
  usageText,
} from '../lib/history-command.js'

test('the command surface is the documented trio', () => {
  assert.deepEqual([...HISTORY_COMMANDS], ['th', 'tokenhistory', 'hist'])
  assert.equal(SCENE_ID, 'dsh-peak-balance-token-history')
  // The scene id must satisfy the host's id grammar.
  assert.match(SCENE_ID, /^[a-z][a-z0-9_-]*$/)
  assert.equal(contributionIdOf('hist'), `${CONTRIBUTION_PREFIX}.hist`)
  assert.equal(contributionIdOf('th'), `${CONTRIBUTION_PREFIX}.th`)
  assert.equal(contributionIdOf('tokenhistory'), 'com.dsh-tui-ecosystem.dsh-peak-balance.tokenhistory')
})

test('no command name is a prefix of a built-in that would steal Enter', () => {
  // The host's completion overlay runs the HIGHLIGHTED suggestion, and the
  // merged list is built-ins first — so a plugin name that is a prefix of a
  // built-in loses the Enter key to it. These are the built-ins that share a
  // prefix with our names (the real LOCAL_COMMANDS list, verbatim enough).
  const builtins = ['help', 'hooks', 'update', 'theme', 'thinking', 'tokens', 'trace', 'tree', 'status']
  for (const name of ['hist', 'tokenhistory']) {
    assert.equal(builtins.some(builtin => builtin.startsWith(name)), false, name)
  }
  assert.equal(builtins.some(builtin => builtin.startsWith('th')), true, 'theme/thinking shadow a bare /th')
  // A user-defined SKILL whose name starts with `hist` would shadow `/hist` the
  // same way; that is out of the plugin's hands and documented in the README.
})

test('a bare invocation opens the scene', () => {
  assert.deepEqual(parseHistoryArgs(''), { kind: 'open' })
  assert.deepEqual(parseHistoryArgs('   '), { kind: 'open' })
  assert.deepEqual(parseHistoryArgs(undefined), { kind: 'open' })
})

test('price subcommands parse into instructions', () => {
  assert.deepEqual(parseHistoryArgs(' price '), { kind: 'price-list' })
  assert.deepEqual(parseHistoryArgs('price set deepseek-v4-pro 0.15 4.5 13.5 '), {
    kind: 'price-set',
    model: 'deepseek-v4-pro',
    spec: { hit: 0.15, miss: 4.5, out: 13.5 },
  })
  // Six numbers carry an explicit peak tier.
  assert.deepEqual(parseHistoryArgs('price set m 1 2 3 4 5 6'), {
    kind: 'price-set',
    model: 'm',
    spec: { hit: 1, miss: 2, out: 3, peakHit: 4, peakMiss: 5, peakOut: 6 },
  })
  assert.deepEqual(parseHistoryArgs('price rm m'), { kind: 'price-remove', model: 'm' })
  for (const verb of ['rm', 'remove', 'del', 'delete', 'unset']) {
    assert.deepEqual(parseHistoryArgs(`price ${verb} model-x`), { kind: 'price-remove', model: 'model-x' })
  }
  for (const verb of ['clear', 'reset', 'none']) {
    assert.deepEqual(parseHistoryArgs(`price ${verb}`), { kind: 'price-clear' })
  }
})

test('bad price input is rejected with a reason', () => {
  assert.deepEqual(parseHistoryArgs('price set m 1 2'), { kind: 'error', reason: 'bad-args', verb: 'price set' })
  assert.deepEqual(parseHistoryArgs('price set m 1 2 3 4'), { kind: 'error', reason: 'bad-args', verb: 'price set' })
  assert.deepEqual(parseHistoryArgs('price set m a 2 3'), { kind: 'error', reason: 'bad-price' })
  assert.deepEqual(parseHistoryArgs('price set m -1 2 3'), { kind: 'error', reason: 'bad-price' })
  assert.deepEqual(parseHistoryArgs('price set m 1 2 3 4 5 x'), { kind: 'error', reason: 'bad-price' })
  assert.deepEqual(parseHistoryArgs('price rm'), { kind: 'error', reason: 'bad-args', verb: 'price rm' })
  assert.deepEqual(parseHistoryArgs('price rm a b'), { kind: 'error', reason: 'bad-args', verb: 'price rm' })
  assert.deepEqual(parseHistoryArgs('bogus'), { kind: 'error', reason: 'unknown-subcommand', token: 'bogus' })
  assert.deepEqual(parseHistoryArgs('price bogus'), { kind: 'error', reason: 'unknown-subcommand', token: 'bogus' })
})

test('the usage text names every supported form', () => {
  const text = usageText('zh')
  assert.match(text, /\/hist · \/tokenhistory/)
  assert.match(text, /\/th …/)
  assert.match(text, /alt\+h/)
  assert.match(text, /price set <model> <hit> <miss> <out>/)
  assert.match(text, /price rm <model>/)
  assert.match(text, /price clear/)
  assert.match(usageText('en'), /Usage:/)
})

test('the price listing shows rates and unrated models', () => {
  const rates = {
    'mystery-model': {
      idle: { inputHit: 0.02, inputMiss: 1, output: 4 },
      peak: { inputHit: 0.04, inputMiss: 2, output: 8 },
      updatedAt: 1,
    },
  }
  const text = renderPriceList('zh', rates, [{ model: 'mystery-2', tokens: 1234 }])
  assert.match(text, /mystery-model/)
  assert.match(text, /空闲 0\.02\/1\/4/)
  assert.match(text, /高峰 0\.04\/2\/8/)
  assert.match(text, /mystery-2/)
  assert.match(text, /1234/)
  const empty = renderPriceList('zh', {}, [])
  assert.match(empty, /暂无自定义费率/)
  assert.doesNotMatch(empty, /费率未知的模型/)
  const english = renderPriceList('en', rates, [])
  assert.match(english, /Custom rates/)
})

/** A stub action surface recording what the handler asked for. */
function makeActions(overrides = {}) {
  const calls = []
  const actions = {
    open: async () => {
      calls.push(['open'])
      return { kind: 'success' }
    },
    listRates: async () => {
      calls.push(['listRates'])
      return { rates: {}, unknown: [] }
    },
    setRate: async (model, spec) => {
      calls.push(['setRate', model, spec])
      return {
        ok: true,
        model,
        entry: { idle: { inputHit: spec.hit, inputMiss: spec.miss, output: spec.out } },
      }
    },
    removeRate: async model => {
      calls.push(['removeRate', model])
      return { model, removed: true }
    },
    clearRates: async () => {
      calls.push(['clearRates'])
      return { count: 2 }
    },
    ...overrides,
  }
  return { actions, calls }
}

test('the handler dispatches every subcommand to the actions', async () => {
  const { actions, calls } = makeActions()
  const definitions = createCommandDefinitions({ actions, getLang: () => 'zh' })
  assert.deepEqual(definitions.map(definition => definition.name), ['th', 'tokenhistory', 'hist'])
  for (const definition of definitions) {
    assert.equal(typeof definition.handler, 'function')
    assert.equal(definition.descriptions.zh.length > 0, true)
    assert.equal(definition.input.hint.length > 0, true)
  }
  // The `/th` description warns about the host overlay; `/hist` is the plain one.
  assert.match(definitions[0].descriptions.zh, /空格/)
  assert.doesNotMatch(definitions[2].descriptions.zh, /空格/)
  const handler = definitions[0].handler

  assert.deepEqual(await handler({ rawInput: '' }), { kind: 'success' })
  const listed = await handler({ rawInput: ' price ' })
  assert.equal(listed.kind, 'success')
  assert.match(listed.text, /自定义费率/)

  const set = await handler({ rawInput: 'price set mystery 0.02 1 4' })
  assert.equal(set.kind, 'success')
  assert.match(set.text, /mystery/)
  assert.match(set.text, /0\.02\/1\/4/)

  const removed = await handler({ rawInput: 'price rm mystery' })
  assert.equal(removed.kind, 'success')
  assert.match(removed.text, /已删除/)

  const cleared = await handler({ rawInput: 'price clear' })
  assert.equal(cleared.kind, 'success')
  assert.match(cleared.text, /2/)

  const bad = await handler({ rawInput: 'nonsense' })
  assert.equal(bad.kind, 'error')
  assert.match(bad.text, /参数不正确/)
  assert.match(bad.text, /用法/)

  assert.deepEqual(calls.map(call => call[0]), ['open', 'listRates', 'setRate', 'removeRate', 'clearRates'])
})

test('failed price writes and missing rates answer without throwing', async () => {
  const { actions } = makeActions({
    setRate: async () => ({ ok: false, error: 'price' }),
  })
  const handler = createCommandDefinitions({ actions, getLang: () => 'en' }).at(0).handler
  const badPrice = await handler({ rawInput: 'price set m 1 2 3' })
  assert.equal(badPrice.kind, 'error')
  assert.match(badPrice.text, /prices must be numbers/)

  const badModel = createCommandDefinitions({
    actions: makeActions({ setRate: async () => ({ ok: false, error: 'model' }) }).actions,
    getLang: () => 'en',
  }).at(0).handler
  assert.match((await badModel({ rawInput: 'price set m 1 2 3' })).text, /model name cannot be empty/)

  const notSet = createCommandDefinitions({
    actions: makeActions({ removeRate: async model => ({ model, removed: false }) }).actions,
    getLang: () => 'zh',
  }).at(0).handler
  const text = await notSet({ rawInput: 'price rm nope' })
  assert.equal(text.kind, 'success')
  assert.match(text.text, /没有自定义费率/)
})

test('a throwing action becomes an error result, never an exception', async () => {
  const { actions } = makeActions({
    open: async () => {
      throw new Error('seam exploded')
    },
  })
  const handler = createCommandDefinitions({ actions, getLang: () => 'zh' }).at(0).handler
  const result = await handler({ rawInput: '' })
  assert.equal(result.kind, 'error')
  assert.match(result.text, /seam exploded/)
})

test('a definition without actions still answers with the usage text', async () => {
  const handler = createCommandDefinitions({}).at(0).handler
  const result = await handler({ rawInput: 'price set m 1 2 3' })
  assert.equal(result.kind, 'error')
  assert.match(result.text, /用法/)
})
