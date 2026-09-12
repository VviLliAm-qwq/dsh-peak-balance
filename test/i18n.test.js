import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { langPrefFile, langPrefStamp, normalizeLang, resolveLang, t } from '../lib/i18n.js'

test('normalizeLang maps locale-ish strings onto the shipped languages', () => {
  for (const value of ['zh', 'zh-CN', 'ZH', ' zh-TW ']) assert.equal(normalizeLang(value), 'zh')
  for (const value of ['en', 'en-US', 'EN', ' en-GB ']) assert.equal(normalizeLang(value), 'en')
  for (const value of ['fr', 'ja', '', '  ', undefined, null, 42, {}]) {
    assert.equal(normalizeLang(value), undefined, String(value))
  }
})

test('the language file is the one dsh-TUI persists', () => {
  assert.match(langPrefFile({}), /[\\/]\.dsh-tui[\\/]lang\.json$/)
  // Diagnostic/test override, mirroring the focus-marker override.
  assert.equal(langPrefFile({ DSH_PEAK_BALANCE_LANG_FILE: '/tmp/x.json' }), '/tmp/x.json')
  assert.equal(langPrefFile({ DSH_PEAK_BALANCE_LANG_FILE: '' }), langPrefFile({}))
  assert.equal(langPrefFile({}, { langFile: '/tmp/y.json' }), '/tmp/y.json')
})

test('resolveLang follows the env pin, then the file, then the locale', () => {
  // The environment pin wins over everything.
  assert.equal(
    resolveLang({ env: { DSH_TUI_LANG: 'en' }, readFile: () => '{"lang":"zh"}', locale: 'zh-CN' }),
    'en',
  )
  // Then the persisted choice.
  assert.equal(resolveLang({ env: {}, readFile: () => '{"lang":"en"}', locale: 'zh-CN' }), 'en')
  // A corrupt or foreign file falls through to the locale.
  assert.equal(resolveLang({ env: {}, readFile: () => 'not json', locale: 'en-US' }), 'en')
  assert.equal(resolveLang({ env: {}, readFile: () => '{"lang":"fr"}', locale: 'fr-FR' }), 'en')
  assert.equal(
    resolveLang({ env: {}, readFile: () => { throw new Error('ENOENT') }, locale: 'zh-CN' }),
    'zh',
  )
  // With no `locale` argument the plugin asks the host, and the host's answer is
  // machine-dependent — a Chinese desktop and an English CI runner disagree —
  // so the probe is pinned here. Asserting on the runner's own locale is what
  // made this test pass locally and fail on every CI job.
  const missing = () => { throw new Error('ENOENT') }
  assert.equal(resolveLang({ env: {}, readFile: missing, detectLocale: () => 'en-US' }), 'en')
  assert.equal(resolveLang({ env: {}, readFile: missing, detectLocale: () => 'zh-CN' }), 'zh')
  // No signal at all keeps the historical default.
  assert.equal(resolveLang({ env: {}, readFile: missing, detectLocale: () => undefined }), 'zh')
  // A host probe that throws (no Intl data, sandboxed runtime) is the same as
  // "no signal", never an error.
  assert.equal(resolveLang({ env: {}, readFile: missing, detectLocale: () => { throw new Error('no Intl') } }), 'zh')
  assert.equal(resolveLang({ env: { DSH_TUI_LANG: 'nonsense' }, readFile: () => { throw new Error('x') }, locale: 'de' }), 'en')
})

test('langPrefStamp reports a change and tolerates a missing file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-pb-lang-'))
  try {
    const file = join(dir, 'lang.json')
    const options = { env: { DSH_PEAK_BALANCE_LANG_FILE: file } }
    assert.equal(langPrefStamp(options), '')
    writeFileSync(file, '{"lang":"zh"}')
    const first = langPrefStamp(options)
    assert.match(first, /^[\d.]+:\d+$/)
    assert.equal(langPrefStamp(options), first)
    writeFileSync(file, '{"lang":"english-ish"}')
    assert.notEqual(langPrefStamp(options), first)
    // A throwing stat (permissions, race) is not an error.
    assert.equal(langPrefStamp({ env: {}, statFile: () => { throw new Error('EACCES') } }), '')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('every locale-sensitive string exists in both languages', () => {
  const keys = [
    'peak', 'idle', 'balance', 'turn', 'historyTitle', 'historyScanning', 'historyNoData',
    'historySubagentOn', 'historySubagentOff', 'historyWindow', 'historyExcluded', 'historyHint',
    'historyPriceTitle', 'historyBadArgs', 'historyUsageThCaveat', 'historyUsageShortcut',
  ]
  for (const key of keys) {
    for (const lang of ['zh', 'en']) {
      const text = t(lang, key)
      assert.notEqual(text, key, `${lang}.${key} is missing`)
      assert.equal(text.trim().length > 0, true)
    }
  }
  // Unknown keys render themselves (visible typos) and unknown languages fall
  // back to English.
  assert.equal(t('zh', 'nope'), 'nope')
  assert.equal(t('fr', 'peak'), t('en', 'peak'))
  assert.equal(t('zh', 'historyScanning', undefined), '扫描中')
})
