import { test } from 'node:test'
import assert from 'node:assert/strict'

import { apply } from '../lib/plugin.js'
import { ABSENT_DSH_HOME, ABSENT_FOCUS_FILE, ABSENT_LANG_FILE, ABSENT_STATE_DIR, makeCtx, makeServices, renderLine, withEnv } from '../test-support/harness.js'

/** A session object the plugin can key a tracker by. */
const FAKE_SESSION = { id: 'session-1', header: { id: 'session-1' } }

/** Everything that must stay pinned so a test never reaches outside the process. */
const PINS = {
  DEEPSEEK_API_KEY: undefined,
  COMMANDCODE_API_KEY: undefined,
  DSH_TUI_LANG: 'zh',
  DSH_PEAK_BALANCE_FOCUS_FILE: ABSENT_FOCUS_FILE,
  DSH_PEAK_BALANCE_LANG_FILE: ABSENT_LANG_FILE,
  DSH_TUI_STATE_DIR: ABSENT_STATE_DIR,
  DSH_HOME: ABSENT_DSH_HOME,
}

const json = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body })
const settle = (ms = 40) => new Promise(resolve => setTimeout(resolve, ms))

/** Swap the process-wide fetch for the duration of `body`. */
async function withFetch(impl, body) {
  const saved = globalThis.fetch
  globalThis.fetch = impl
  try {
    return await body()
  } finally {
    globalThis.fetch = saved
  }
}

/** A context wired like a real host: seams present, credentials resolving `refs`. */
function hostContext(options = {}) {
  const ctx = makeCtx()
  const services = makeServices(ctx.__record)
  // `makeServices` mirrors the TUI seams; the harness the plugin also probes are
  // attached here (the credentials seam is what turns a key into a request).
  services.credentials = {
    resolve: async ref => (options.keys?.[ref] === undefined ? undefined : { value: options.keys[ref] }),
  }
  ctx.get = name => services[name]
  if (options.settings !== undefined) ctx.__record.settingsValues = { 'dsh-peak-balance': options.settings }
  return ctx
}

test('the account section reports the official balance in its own currency', async () => {
  await withEnv({ ...PINS }, async () => {
    await withFetch(async url => {
      assert.match(url, /\/user\/balance$/)
      return json({
        is_available: true,
        balance_infos: [{ currency: 'CNY', total_balance: '12.34', granted_balance: '0', topped_up_balance: '12.34' }],
      })
    }, async () => {
      const ctx = hostContext({ keys: { DEEPSEEK_API_KEY: 'sk-test' } })
      apply(ctx, undefined)
      await settle()
      assert.match(renderLine(ctx), /余额 ¥12\.34/)
      ctx.__dispose()
    })
  })
})

test('a provider switch re-targets the section: the Command Code plan appears', async () => {
  await withEnv({ ...PINS, COMMANDCODE_API_KEY: 'user_test' }, async () => {
    await withFetch(async url => {
      if (url.endsWith('/alpha/billing/credits')) {
        return json({
          credits: { monthlyCredits: 69.9 },
          windowLimits: { fiveHour: { used: 1, cap: 14, resetAt: Date.now() + 3_600_000 } },
        })
      }
      if (url.endsWith('/alpha/billing/subscriptions')) return json({ data: { planId: 'individual-goat' } })
      return json({ totalCredits: 2 })
    }, async () => {
      const ctx = hostContext({})
      apply(ctx, undefined)
      await settle()
      // No key for the default provider: the line says so rather than guessing.
      assert.match(renderLine(ctx), /额度 未配置密钥/)

      ctx.__emit('session/event', FAKE_SESSION, {
        type: 'request/header',
        data: { header: { config: { provider: 'commandcode', model: 'deepseek/deepseek-v4.1-flash' } } },
      })
      await settle(80)
      const line = renderLine(ctx)
      assert.match(line, /套餐 GOAT/)
      assert.ok(line.includes('5h 剩 92.9%(1.00/14.00)'))
      assert.match(line, /距重置/)
      ctx.__dispose()
    })
  })
})

test('a pinned provider with no quota interface says so, while an auto one stays quiet', async () => {
  await withEnv({ ...PINS }, async () => {
    // Pinned: the user asked about this provider, so "no API" is the answer.
    const pinned = hostContext({ settings: { quotaProvider: 'openai' } })
    apply(pinned, undefined)
    await settle(60)
    assert.match(renderLine(pinned), /额度（已指定） 无接口/)
    pinned.__dispose()

    // Auto: the conversation happens to run through it — nothing to add to the
    // line, and nothing invented either.
    const auto = hostContext({})
    apply(auto, undefined)
    await settle()
    auto.__emit('session/event', FAKE_SESSION, {
      type: 'request/header',
      data: { header: { config: { provider: 'openai', model: 'gpt-5.6' } } },
    })
    await settle(60)
    assert.doesNotMatch(renderLine(auto), /额度/)
    auto.__dispose()
  })
})

test('the account section follows “off” without a single request', async () => {
  await withEnv({ ...PINS, DEEPSEEK_API_KEY: 'sk-test' }, async () => {
    let calls = 0
    await withFetch(async () => {
      calls += 1
      return json({ is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '1', granted_balance: '0', topped_up_balance: '1' }] })
    }, async () => {
      const ctx = hostContext({ settings: { quotaProvider: 'off' } })
      apply(ctx, undefined)
      await settle(60)
      assert.equal(calls, 0)
      assert.doesNotMatch(renderLine(ctx), /额度/)
      ctx.__dispose()
    })
  })
})

test('a turn’s spend is measured from the provider counter, not estimated', async () => {
  await withEnv({ ...PINS, COMMANDCODE_API_KEY: 'user_test' }, async () => {
    let totalCredits = 10
    await withFetch(async url => {
      if (url.endsWith('/alpha/billing/credits')) {
        return json({
          credits: { monthlyCredits: 66 },
          windowLimits: { fiveHour: { used: 4, cap: 14, resetAt: Date.now() + 3_600_000 } },
        })
      }
      if (url.endsWith('/alpha/billing/subscriptions')) return json({ data: { planId: 'individual-goat' } })
      return json({ totalCredits })
    }, async () => {
      const ctx = hostContext({})
      apply(ctx, undefined)
      await settle()
      // Route the conversation through Command Code and let the counter settle
      // as the turn's baseline.
      ctx.__emit('session/event', FAKE_SESSION, {
        type: 'request/header',
        data: { header: { config: { provider: 'commandcode', model: 'deepseek/deepseek-v4.1-flash' } } },
      })
      await settle(80)

      ctx.__emit('session/event', FAKE_SESSION, { type: 'turn/start', data: { turn: 1 } })
      ctx.__emit('session/event', FAKE_SESSION, {
        type: 'assistant/message',
        time: Date.now(),
        data: { turn: 1, step: 1, usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0 } },
      })
      // The provider books the request a moment later.
      totalCredits = 10.25
      ctx.__emit('session/event', FAKE_SESSION, { type: 'turn/end', data: { turn: 1 } })
      await settle(120)

      const line = renderLine(ctx)
      assert.ok(line.includes('本轮 1.79%(0.2500)'))
      ctx.__dispose()
    })
  })
})
