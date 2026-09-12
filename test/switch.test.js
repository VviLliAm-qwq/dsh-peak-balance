/**
 * Conversation-switch regressions.
 *
 * A switch publishes no `session/event` (the host replays the target session
 * into its own projector, and DSH only fires the event for appends this process
 * makes), so the line used to attribute every figure to whichever conversation
 * appened last — after switching it showed the PREVIOUS conversation's
 * per-turn cost, and a parked conversation finishing a turn stole it back.
 *
 * Costs below use `deepseek-flash` input-only turns: 1M tokens is ¥1.00
 * off-peak / ¥2.00 peak, 100k is ¥0.10 / ¥0.20. The phase depends on the wall
 * clock the suite runs at, so every assertion accepts either tier.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { FOCUS_POLL_MS } from '../lib/focus.js'
import { apply } from '../lib/plugin.js'
import {
  CLEARED_FOCUS_FIXTURE,
  FIXTURE_SESSION_ID,
  FOCUS_FIXTURE,
  makeCtx,
  makeServices,
  renderLine,
  withEnv,
  withoutSecrets,
} from '../test-support/harness.js'

const MODEL = 'deepseek-flash'

/** A session object as the host hands it over (id + header). */
const session = id => ({ id, header: { id } })

/** Off-peak or peak variant of one expected amount. */
const showsCost = (line, idle, peak) => line.includes(idle) || line.includes(peak)

/** Boot the plugin against the recording seams; `omit` drops whole services. */
function boot(overrides = {}, omit = []) {
  const ctx = makeCtx()
  const services = makeServices(ctx.__record, overrides)
  for (const name of omit) delete services[name]
  ctx.get = name => services[name]
  apply(ctx, undefined)
  assert.ok(ctx.__record.views.length > 0, 'the status view was not registered')
  return ctx
}

/** One complete settled turn for `who`. */
function turn(ctx, who, inputTokens) {
  ctx.__emit('session/event', who, { type: 'request/header', data: { header: { config: { model: MODEL } } } })
  ctx.__emit('session/event', who, {
    type: 'assistant/message',
    time: Date.now(),
    data: { usage: { inputTokens, outputTokens: 0 } },
  })
  ctx.__emit('session/event', who, { type: 'turn/end', time: Date.now(), data: { turn: 1 } })
}

/** Fire the mediated `tui/session-switched` notification the host sends. */
function switchTo(ctx, sessionId) {
  const subscription = ctx.__record.decisions.at(-1)
  assert.ok(subscription, 'no session-switch subscription was registered')
  subscription.listener({ kind: 'resume', sessionId, previousSessionId: 'session-previous', cwd: 'C:/work' })
}

test('the mediated switch notification is registered as a scope-exact subscription', () => {
  withoutSecrets(() => {
    const ctx = boot()
    const subscription = ctx.__record.decisions[0]
    assert.equal(ctx.__record.decisions.length, 1)
    assert.equal(subscription.event, 'tui/session-switched')
    assert.deepEqual(subscription.options, { scope: 'tui/session-switched' })
    assert.equal(typeof subscription.listener, 'function')
    assert.ok(ctx.__record.logs.some(([, message]) => /session-switch subscription registered/.test(message)))

    ctx.__dispose()
    assert.equal(ctx.__record.decisionDisposed, true)
  })
})

test('a switch re-points the line, and a background append cannot steal it back', () => {
  withoutSecrets(() => {
    const ctx = boot()
    const a = session('session-a')
    const b = session('session-b')

    turn(ctx, a, 1_000_000)
    turn(ctx, b, 100_000)
    // No focus yet: the last event wins, which is the old (correct) behaviour.
    assert.ok(showsCost(renderLine(ctx), '¥0.1000', '¥0.2000'))

    switchTo(ctx, 'session-a')
    assert.ok(showsCost(renderLine(ctx), '¥1.00', '¥2.00'), 'the focused conversation owns the line')

    // The conversation we switched away from settles another turn in the
    // background (the host parks it, it is not disposed).
    turn(ctx, b, 100_000)
    assert.ok(
      showsCost(renderLine(ctx), '¥1.00', '¥2.00'),
      'a background append must not take over the focused conversation',
    )

    ctx.__dispose()
  })
})

test('a focused conversation with no turn data in this process shows no figure', () => {
  withoutSecrets(() => {
    const ctx = boot()
    turn(ctx, session('session-a'), 1_000_000)

    // The honest answer for a conversation this process has no data for is
    // "nothing", never the previous conversation's amount.
    switchTo(ctx, 'session-resumed-from-disk')
    assert.match(renderLine(ctx), /本轮 —/)

    ctx.__dispose()
  })
})

test('without the host subscription the focus marker carries the feature', () => {
  withEnv(
    { DEEPSEEK_API_KEY: undefined, DSH_TUI_LANG: 'zh', DSH_PEAK_BALANCE_FOCUS_FILE: FOCUS_FIXTURE },
    () => {
      // A host that exposes no mediated decision surface at all.
      const ctx = boot({}, ['tuiPluginHost'])
      assert.equal(ctx.__record.decisions.length, 0)

      const other = session('session-other')
      const focused = session(FIXTURE_SESSION_ID)
      turn(ctx, other, 1_000_000)
      assert.match(renderLine(ctx), /本轮 —/, 'the marker names a conversation without data yet')

      turn(ctx, focused, 100_000)
      assert.ok(showsCost(renderLine(ctx), '¥0.1000', '¥0.2000'))

      turn(ctx, other, 1_000_000)
      assert.ok(showsCost(renderLine(ctx), '¥0.1000', '¥0.2000'), 'the marker still outranks the last event')

      ctx.__dispose()
    },
  )
})

test('an emptied marker (/new) gives up the line, and the fresh conversation takes it', async () => {
  await withEnv(
    { DEEPSEEK_API_KEY: undefined, DSH_TUI_LANG: 'zh', DSH_PEAK_BALANCE_FOCUS_FILE: FOCUS_FIXTURE },
    async () => {
      const ctx = boot({}, ['tuiPluginHost'])
      const previous = session(FIXTURE_SESSION_ID)
      turn(ctx, previous, 1_000_000)
      assert.ok(showsCost(renderLine(ctx), '¥1.00', '¥2.00'))

      // `/new`: the host empties the marker, and the poll is the only notice.
      process.env.DSH_PEAK_BALANCE_FOCUS_FILE = CLEARED_FOCUS_FIXTURE
      await new Promise(resolve => setTimeout(resolve, FOCUS_POLL_MS + 250))
      assert.match(renderLine(ctx), /本轮 —/, 'the conversation just left must give up the figure')

      // The fresh conversation shows up and owns the line.
      const fresh = session('session-fresh')
      turn(ctx, fresh, 100_000)
      assert.ok(showsCost(renderLine(ctx), '¥0.1000', '¥0.2000'))

      // The parked conversation settling another turn cannot take it back.
      turn(ctx, previous, 1_000_000)
      assert.ok(showsCost(renderLine(ctx), '¥0.1000', '¥0.2000'), 'a parked append must not steal a claimed line')

      ctx.__dispose()
    },
  )
})

test('a resting empty marker cannot mute the conversation that owns the line', async () => {
  await withEnv(
    { DEEPSEEK_API_KEY: undefined, DSH_TUI_LANG: 'zh', DSH_PEAK_BALANCE_FOCUS_FILE: CLEARED_FOCUS_FIXTURE },
    async () => {
      // The host writes `resume.txt` empty BOTH on `/new` and when a session it
      // cannot resume exits, so an empty marker is a normal resting state.
      // Re-applying that reading once per poll muted whichever conversation had
      // claimed the line — and muted it for good, because the cleared-focus
      // guard then skipped that conversation's own events. This test is that
      // field failure.
      const ctx = boot({}, ['tuiPluginHost'])
      const live = session('session-live')
      turn(ctx, live, 100_000)
      assert.ok(showsCost(renderLine(ctx), '¥0.1000', '¥0.2000'))

      await new Promise(resolve => setTimeout(resolve, FOCUS_POLL_MS * 2 + 250))
      assert.ok(
        showsCost(renderLine(ctx), '¥0.1000', '¥0.2000'),
        'an unchanged empty marker is a state, not a fresh /new',
      )

      // The conversation keeps working: its next round still reaches the line.
      turn(ctx, live, 1_000_000)
      assert.ok(showsCost(renderLine(ctx), '¥1.00', '¥2.00'))

      ctx.__dispose()
    },
  )
})

test('a fresh conversation that appends before the poll notices still owns the line', async () => {
  await withEnv(
    { DEEPSEEK_API_KEY: undefined, DSH_TUI_LANG: 'zh', DSH_PEAK_BALANCE_FOCUS_FILE: FOCUS_FIXTURE },
    async () => {
      const ctx = boot({}, ['tuiPluginHost'])
      const previous = session(FIXTURE_SESSION_ID)
      turn(ctx, previous, 1_000_000)

      // `/new`, then the fresh conversation's turn lands before the next poll
      // tick can read the cleared marker.
      process.env.DSH_PEAK_BALANCE_FOCUS_FILE = CLEARED_FOCUS_FIXTURE
      const fresh = session('session-fresh')
      turn(ctx, fresh, 100_000)
      await new Promise(resolve => setTimeout(resolve, FOCUS_POLL_MS + 250))
      assert.ok(
        showsCost(renderLine(ctx), '¥0.1000', '¥0.2000'),
        'a late clear must not blank the conversation that replaced it',
      )

      // The conversation left behind keeps reporting and is ignored.
      turn(ctx, previous, 1_000_000)
      assert.ok(showsCost(renderLine(ctx), '¥0.1000', '¥0.2000'))

      ctx.__dispose()
    },
  )
})

test('a conversation keeps its settled turn when you switch away and back', () => {
  withoutSecrets(() => {
    const ctx = boot()
    const a = session('session-a')
    const b = session('session-b')
    turn(ctx, a, 1_000_000)
    turn(ctx, b, 100_000)

    // Switching away with `/resume` DISPOSES the conversation you left (only a
    // background adoption parks it), so its live tracker goes with it.
    ctx.__emit('session/disposed', a)
    switchTo(ctx, 'session-b')
    assert.ok(showsCost(renderLine(ctx), '¥0.1000', '¥0.2000'))

    // Coming back names the same conversation again, but the host replays its
    // history privately: no session event ever rebuilds the tracker.
    switchTo(ctx, 'session-a')
    assert.ok(
      showsCost(renderLine(ctx), '¥1.00', '¥2.00'),
      "the conversation's own last turn must come back with it",
    )

    // A remembered figure belongs to its conversation only.
    switchTo(ctx, 'session-never-used')
    assert.match(renderLine(ctx), /本轮 —/)

    ctx.__dispose()
  })
})

test('a host that refuses the subscription is contained and the marker still works', () => {
  withEnv(
    { DEEPSEEK_API_KEY: undefined, DSH_TUI_LANG: 'zh', DSH_PEAK_BALANCE_FOCUS_FILE: FOCUS_FIXTURE },
    () => {
      const ctx = boot({
        tuiPluginHost: {
          subscribeDecision() {
            throw new Error('COMPONENT_NOT_ADMITTED')
          },
        },
      })
      assert.ok(
        ctx.__record.logs.some(([level, message]) =>
          level === 'warn' && /session-switch subscribe failed: COMPONENT_NOT_ADMITTED/.test(message)),
      )

      turn(ctx, session(FIXTURE_SESSION_ID), 100_000)
      assert.ok(showsCost(renderLine(ctx), '¥0.1000', '¥0.2000'))

      ctx.__dispose()
    },
  )
})

test('disposing the shown conversation falls back to the most recent, not the stalest', () => {
  withoutSecrets(() => {
    const ctx = boot()
    const a = session('session-a')
    const b = session('session-b')
    const c = session('session-c')

    turn(ctx, a, 1_000_000)
    turn(ctx, b, 100_000)
    turn(ctx, c, 500_000)
    ctx.__emit('session/disposed', c)

    // B was used after A: the line must move to the newest survivor.
    assert.ok(showsCost(renderLine(ctx), '¥0.1000', '¥0.2000'), 'the stalest tracker must not win the fallback')

    ctx.__dispose()
  })
})

test('a reused session id cannot leak one agent\'s turn into another', () => {
  withoutSecrets(() => {
    const ctx = boot()
    // "A → /new → /resume A lands back on the same id with a fresh agent".
    const parked = session('session-dup')
    const fresh = session('session-dup')

    // The parked agent's turn never settled: it was abandoned mid-turn.
    ctx.__emit('session/event', parked, {
      type: 'assistant/message',
      time: Date.now(),
      data: { usage: { inputTokens: 1_000_000, outputTokens: 0 } },
    })
    turn(ctx, fresh, 100_000)
    assert.ok(
      showsCost(renderLine(ctx), '¥0.1000', '¥0.2000'),
      'the abandoned turn must not be priced into the replacement agent',
    )

    // Tearing the parked agent down must not wipe the live one's state.
    ctx.__emit('session/disposed', parked)
    assert.ok(showsCost(renderLine(ctx), '¥0.1000', '¥0.2000'))

    ctx.__dispose()
  })
})
