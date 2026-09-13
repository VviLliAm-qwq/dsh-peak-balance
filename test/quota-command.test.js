import { test } from 'node:test'
import assert from 'node:assert/strict'

import { METER_CHOICES, createQuotaCommand, parseQuotaArgs, renderQuotaReport } from '../lib/quota-command.js'

test('the argument parser accepts the three verbs and rejects everything else', () => {
  assert.deepEqual(parseQuotaArgs(''), { kind: 'status' })
  assert.deepEqual(parseQuotaArgs('  status '), { kind: 'status' })
  assert.deepEqual(parseQuotaArgs('check'), { kind: 'check', provider: '' })
  assert.deepEqual(parseQuotaArgs('check commandcode'), { kind: 'check', provider: 'commandcode' })
  assert.equal(parseQuotaArgs('check a b').kind, 'error')
  assert.deepEqual(parseQuotaArgs('meter window5h'), { kind: 'meter', metric: 'window5h' })
  assert.equal(parseQuotaArgs('meter').reason, 'bad-args')
  assert.equal(parseQuotaArgs('meter calories').reason, 'bad-meter')
  assert.equal(parseQuotaArgs('frobnicate').reason, 'unknown-subcommand')
  assert.deepEqual(METER_CHOICES, [
    'auto',
    'balance',
    'window5h',
    'windowWeekly',
    'windowDaily',
    'windowMonthly',
    'planRemaining',
    'keyLimit',
    'periodSpend',
    'rotate',
  ])
})

const REPORT = {
  provider: 'commandcode',
  source: 'focus',
  adapter: 'commandcode-plan',
  state: 'ok',
  plan: 'GOAT',
  updatedAt: 1_700_000_000_000,
  meters: [{ id: 'window5h', kind: 'credits', used: 1, cap: 14, resetAt: 1_700_000_000_000, exceeded: false }],
  failures: [],
  specPath: '/tmp/providers.json',
  providers: [{ provider: 'commandcode', declared: false, adapter: 'commandcode-plan' }],
}

test('a report names the provider, the adapter, the meter figures and the spec file', () => {
  const text = renderQuotaReport('zh', REPORT)
  assert.match(text, /额度诊断/)
  assert.match(text, /commandcode \(focus\)/)
  assert.match(text, /commandcode-plan/)
  assert.match(text, /GOAT/)
  assert.match(text, /window5h \(credits\) used=1 cap=14/)
  assert.match(text, /\/tmp\/providers\.json/)
  assert.match(text, /commandcode  commandcode-plan/)
})

test('a failure report says so, and an unroutable provider is marked with no adapter', () => {
  const text = renderQuotaReport('en', {
    provider: 'openai',
    source: 'pinned',
    adapter: '',
    state: 'failed',
    reason: 'unsupported',
    detail: 'no quota interface known for this provider',
    providers: [{ provider: 'openai', declared: true, adapter: '' }],
    meters: [],
    failures: ['credits: HTTP 403'],
  })
  assert.match(text, /Quota diagnostics/)
  assert.match(text, /openai \(pinned\)/)
  assert.match(text, /unsupported/)
  assert.match(text, /no quota interface/)
  assert.match(text, /credits: HTTP 403/)
  assert.match(text, /openai \* {2}no adapter/)
})

test('the handler dispatches to the actions and contains their failures', async () => {
  const seen = []
  const command = createQuotaCommand({
    getLang: () => 'zh',
    actions: {
      status: async () => {
        seen.push('status')
        return REPORT
      },
      check: async provider => {
        seen.push(`check:${provider}`)
        return { ...REPORT, provider: provider === '' ? 'commandcode' : provider, source: 'check' }
      },
      setMetric: async metric => {
        seen.push(`meter:${metric}`)
        return { ok: metric !== 'rotate' }
      },
    },
  })
  assert.equal(command.name, 'quota')
  assert.equal(typeof command.descriptions.zh, 'string')

  const status = await command.handler({ rawInput: '' })
  assert.equal(status.kind, 'success')
  assert.match(status.text, /额度诊断/)
  const checked = await command.handler({ rawInput: ' check moonshotai ' })
  assert.equal(checked.kind, 'success')
  assert.match(checked.text, /moonshotai \(check\)/)
  const meter = await command.handler({ rawInput: 'meter windowWeekly' })
  assert.equal(meter.kind, 'success')
  assert.match(meter.text, /windowWeekly/)
  const refused = await command.handler({ rawInput: 'meter rotate' })
  assert.equal(refused.kind, 'error')
  const bad = await command.handler({ rawInput: 'meter nope' })
  assert.equal(bad.kind, 'error')
  assert.match(bad.text, /未知的额度口径/)
  assert.deepEqual(seen, ['status', 'check:moonshotai', 'meter:windowWeekly', 'meter:rotate'])
})

test('a throwing action is reported instead of escaping', async () => {
  const command = createQuotaCommand({
    getLang: () => 'en',
    actions: { status: async () => { throw new Error('probe exploded') } },
  })
  const result = await command.handler({ rawInput: '' })
  assert.equal(result.kind, 'error')
  assert.match(result.text, /probe exploded/)
})
