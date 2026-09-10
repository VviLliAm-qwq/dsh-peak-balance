/**
 * dsh-peak-balance — DeepSeek peak/off-peak clock, live balance and per-turn
 * cost for dsh-tui, rendered above the prompt.
 *
 * The plugin is deliberately defensive: every host service it touches is
 * optional (see {@link seamServices}), every registration is retried until the
 * service appears, every failure is logged and swallowed, and every timer is
 * cleared from this activation's effect disposer. A host without the TUI
 * seams, without credentials, or without a network stays fully functional —
 * this plugin never takes the session down.
 *
 * @module dsh-peak-balance
 */

import { appendFileSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import z from '@deepseek-ai/schemastery'
import { BALANCE_TIMEOUT_MS, cnyBalance, fetchBalance } from './balance.js'
import { WARN_COLOR_ORDER, buildDisplay, warnColorOptions } from './display.js'
import { resolveLang } from './i18n.js'
import { createStore } from './store.js'
import { createTracker } from './tracker.js'
import { VIEW_KEY, VIEW_MAX_ROWS, createStatusView } from './view.js'

export const name = 'dsh-peak-balance'

/** Settings namespace; also the settings-card namespace. */
export const SETTINGS_NS = 'dsh-peak-balance'

/** Every key has a default: a missing composition entry changes nothing. */
export const Config = z.object({
  showBalance: z.boolean().default(true),
  showTurnCost: z.boolean().default(true),
  warnOnPeak: z.boolean().default(false),
  // Deliberately a free string: the settings service fails a namespace
  // registration whose stored section does not fit its schema, and an
  // unregistered namespace renders as an unavailable card the user cannot
  // repair from the UI. A hand-edited or stale color is therefore accepted
  // here and sanitized at use time (sanitizeConfig / warnColorHex).
  warnColor: z.string().default('red'),
})

/** Boot defaults mirroring the schema (used when the config is absent/garbled). */
const DEFAULTS = Object.freeze({
  showBalance: true,
  showTurnCost: true,
  warnOnPeak: false,
  warnColor: 'red',
})

const RETRY_MS = 400
const RETRY_LIMIT = 75
const BALANCE_REFRESH_MS = 60_000
const PHASE_TICK_MS = 20_000
const MIN_BALANCE_GAP_MS = 3_000
const MAX_TRACKERS = 16
const DIAG_LOG = join(homedir(), '.dsh-tui', 'dsh-peak-balance.log')
/** Above this size the log is trimmed to its newest half. */
const MAX_LOG_BYTES = 128 * 1024

/**
 * Diagnostic override: `DSH_PEAK_BALANCE_FORCE_PEAK=1` renders the peak
 * presentation — and therefore the warning frame — outside a real peak window,
 * so the effect can be previewed without waiting for 09:00 Beijing.
 */
export function forcePeakFromEnv(env = process.env) {
  const raw = env?.DSH_PEAK_BALANCE_FORCE_PEAK
  return typeof raw === 'string' && /^(1|true|yes|on)$/i.test(raw.trim())
}

/**
 * Import-time breadcrumb: one line per module load, so a support session can
 * tell "the host never loaded this file" apart from "the entry never applied".
 * Bounded exactly like every other log line, and silent under `node --test`.
 */
try {
  if (typeof process.env?.NODE_TEST_CONTEXT !== 'string') {
    appendLogLine(
      DIAG_LOG,
      `${new Date().toISOString()} info module imported pid=${process.pid} node=${process.version}\n`,
    )
  }
} catch {
  // Diagnostics must never be the reason a module fails to load.
}

/** Error -> one-line message, tolerating exotic throw values. */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

/** Warn once per distinct message: a 400 ms retry loop must not flood the log. */
function warnOnce(log, seen, message) {
  if (seen.has(message)) return
  seen.add(message)
  log.warn(message)
}

/** Coerce an untrusted config object into known keys with valid types. */
export function sanitizeConfig(config) {
  const out = { ...DEFAULTS }
  if (config === null || typeof config !== 'object') return out
  for (const key of ['showBalance', 'showTurnCost', 'warnOnPeak']) {
    if (typeof config[key] === 'boolean') out[key] = config[key]
  }
  if (WARN_COLOR_ORDER.includes(config.warnColor)) out.warnColor = config.warnColor
  return out
}

/** Session id used to key trackers (shape differs across hosts/replays). */
function sessionKey(session) {
  try {
    const id = session?.id ?? session?.header?.id ?? session?.sessionId
    return typeof id === 'string' && id !== '' ? id : 'default'
  } catch {
    return 'default'
  }
}

/** Whether a session is a subagent child (its spend is not the user's turn). */
function isSubagentSession(session) {
  try {
    const header = session?.header ?? session?.meta
    return header?.origin === 'subagent' || (header?.delegationDepth ?? 0) > 0
  } catch {
    return false
  }
}

/**
 * Resolve one optional host service, most-trusted form first.
 *
 * `ctx.get(name)` (strict) hides a provider whose fiber has not reached ACTIVE
 * yet and — in compositions that shadow the dsh-tui seam rows — skips the
 * shadow placeholder. `ctx.get(name, false)` returns that placeholder, whose
 * method calls the host then refuses with "requires a live Cordis activation
 * context". Asking strictly first therefore matches what the shipped TUI
 * plugins (chime, format-setting) do, and the non-strict form stays as a
 * fallback for compositions where only it answers.
 *
 * @param ctx - any context with a Cordis `get`.
 * @param name - service name.
 * @param onError - optional sink for accessor failures (a throwing `get` is a
 *   host defect worth logging once, not a silent absence).
 * @returns Candidate service instances, possibly empty; never throws.
 */
export function seamServices(ctx, name, onError) {
  const out = []
  try {
    const strict = ctx.get(name)
    if (strict !== undefined && strict !== null) out.push(strict)
  } catch (error) {
    onError?.(name, error)
  }
  try {
    const soft = ctx.get(name, false)
    if (soft !== undefined && soft !== null && !out.includes(soft)) out.push(soft)
  } catch (error) {
    onError?.(name, error)
  }
  return out
}

/** Balance result -> the display model's small state object. */
export function balanceStateOf(result) {
  if (result?.ok === true) {
    const cny = cnyBalance(result)
    return cny === undefined ? { state: 'error' } : { state: 'ok', amount: cny.total }
  }
  switch (result?.reason) {
    case 'no-key':
      return { state: 'no-key' }
    case 'unauthorized':
      return { state: 'unauthorized' }
    default:
      return { state: 'error' }
  }
}

/** The settings card rendered at the top level of the /settings screen. */
export function settingsSection() {
  return {
    ns: SETTINGS_NS,
    title: 'Peak & Balance',
    descriptions: { zh: '峰谷与余额', en: 'Peak & Balance' },
    fields: [
      {
        path: ['showBalance'],
        label: 'Show balance',
        descriptions: { zh: '显示余额', en: 'Show balance' },
        hint: 'Account balance above the prompt; refreshed after every turn and once a minute.',
        hintDescriptions: {
          zh: '在对话栏上方显示账户余额；每轮对话结束与每分钟各刷新一次。',
          en: 'Account balance above the prompt; refreshed after every turn and once a minute.',
        },
        kind: 'boolean',
      },
      {
        path: ['showTurnCost'],
        label: 'Show per-turn cost',
        descriptions: { zh: '显示每轮花费', en: 'Show per-turn cost' },
        hint: 'Estimated cost of the turn that just finished.',
        hintDescriptions: {
          zh: '显示刚刚结束的那一轮对话的估算花费。',
          en: 'Estimated cost of the turn that just finished.',
        },
        kind: 'boolean',
      },
      {
        path: ['warnOnPeak'],
        label: 'Peak-hour warning',
        descriptions: { zh: '峰时警告模式', en: 'Peak-hour warning' },
        hint: 'While the peak window is active the status line becomes a frame pulsing in the chosen color.',
        hintDescriptions: {
          zh: '处于高峰时段时，状态行变成一个按所选颜色闪烁的边框。',
          en: 'While the peak window is active the status line becomes a frame pulsing in the chosen color.',
        },
        kind: 'boolean',
      },
      {
        path: ['warnColor'],
        label: 'Warning color',
        descriptions: { zh: '警告色系', en: 'Warning color' },
        hint: 'Frame color used by the peak-hour warning (←/→ to step through the seven colors).',
        hintDescriptions: {
          zh: '峰时警告边框的颜色（←/→ 可切换七种色系）。',
          en: 'Frame color used by the peak-hour warning (←/→ to step through the seven colors).',
        },
        kind: 'select',
        options: warnColorOptions(),
      },
    ],
  }
}

/** Quiet logger: host logger always, plus an opt-in file when DSH_TUI_DEBUG is set. */
function createLogger(ctx) {
  const env = typeof process.env?.DSH_TUI_DEBUG === 'string' ? process.env.DSH_TUI_DEBUG : ''
  const verbose = env !== '' && env !== '0' && env !== 'false'
  // Lifecycle lines always land in the plugin's own log: when a seam silently
  // refuses (or the entry never applies), the host's own diagnostics are not
  // reachable from the TUI, and `~/.dsh-tui/<plugin>.log` is the convention
  // the other TUI plugins in this ecosystem already follow. Under `node --test`
  // the file stays untouched so test runs never pollute a user's log.
  const fileEnabled = typeof process.env?.NODE_TEST_CONTEXT !== 'string'
  const write = (level, message) => {
    try {
      ctx.logger?.[level]?.(`dsh-peak-balance: ${message}`)
    } catch {
      // Observability only; never let logging break the plugin.
    }
    if (!fileEnabled) return
    try {
      appendLogLine(DIAG_LOG, `${new Date().toISOString()} ${level} ${message}\n`)
    } catch {
      // Unwritable log path is not an error worth surfacing.
    }
  }
  return {
    info: message => write('info', message),
    warn: message => write('warn', message),
    debug: message => {
      if (verbose) write('debug', message)
    },
  }
}

/**
 * Append one diagnostic line, keeping the file bounded: past `MAX_LOG_BYTES`
 * the older half is dropped, so a long-lived session cannot grow the log
 * without bound.
 */
function appendLogLine(path, line) {
  try {
    if (statSync(path).size > MAX_LOG_BYTES) {
      const keep = readFileSync(path, 'utf8').slice(-Math.floor(MAX_LOG_BYTES / 2))
      writeFileSync(path, keep)
    }
  } catch {
    // Missing or unreadable file: the append below recreates it.
  }
  appendFileSync(path, line)
}

/**
 * Wire the plugin.
 *
 * @param ctx - Cordis context of this activation.
 * @param config - composition-entry config; every key falls back to a default.
 */
export function apply(ctx, config) {
  let log
  try {
    log = createLogger(ctx)
  } catch {
    log = { info: () => {}, warn: () => {}, debug: () => {} }
  }

  // First line of the plugin's own log: proves the entry applied, in which
  // process, and from which file on disk.
  try {
    log.info(`apply started pid=${process.pid} node=${process.version} file=${fileURLToPath(import.meta.url)}`)
  } catch {
    // Logging must never be the reason a plugin fails to load.
  }

  try {
    const resolved = sanitizeConfig(config)
    const store = createStore(undefined)
    /** One tracker per session; the most recent event wins the display. */
    const trackers = new Map()
    const forcePeak = forcePeakFromEnv()
    let activeKey
    let lang = 'zh'
    try {
      lang = resolveLang()
    } catch (error) {
      log.warn(`language resolution failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    let balance = { state: 'loading' }
    let balanceRequestedAt = 0
    let balanceInFlight = false
    let disposed = false
    /** Distinct warnings already logged (the retry loop repeats every 400 ms). */
    const seenWarnings = new Set()
    log.info(`config resolved: ${JSON.stringify(resolved)} lang=${lang} forcePeak=${forcePeak}`)

    const trackerEntry = session => {
      const key = sessionKey(session)
      let tracker = trackers.get(key)
      if (tracker === undefined) {
        tracker = createTracker()
        trackers.set(key, tracker)
        while (trackers.size > MAX_TRACKERS) {
          const oldest = trackers.keys().next().value
          if (oldest === undefined || oldest === key) break
          trackers.delete(oldest)
        }
      } else {
        // Refresh recency so eviction drops the least recently active session.
        trackers.delete(key)
        trackers.set(key, tracker)
      }
      return { key, tracker }
    }

    const activeTracker = () => (activeKey === undefined ? undefined : trackers.get(activeKey))

    const publish = () => {
      if (disposed) return
      try {
        const tracker = activeTracker()
        store.set(buildDisplay({
          atMs: Date.now(),
          lang,
          config: resolved,
          balance,
          lastTurn: tracker?.lastTurn(),
          liveTokens: tracker?.turnTokens(),
          forcePeak,
        }))
      } catch (error) {
        log.warn(`publish failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }

    const resolveApiKey = async () => {
      try {
        for (const credentials of seamServices(ctx, 'credentials')) {
          const resolvedCredential = await credentials?.resolve?.('DEEPSEEK_API_KEY')
          if (typeof resolvedCredential?.value === 'string' && resolvedCredential.value !== '') {
            return resolvedCredential.value
          }
        }
      } catch {
        // Credentials seam missing or refusing: fall back to the environment.
      }
      const fromEnv = process.env?.DEEPSEEK_API_KEY
      return typeof fromEnv === 'string' ? fromEnv : ''
    }

    const refreshBalance = async (options = {}) => {
      if (disposed || resolved.showBalance !== true || balanceInFlight) return
      const now = Date.now()
      if (options.force !== true && now - balanceRequestedAt < MIN_BALANCE_GAP_MS) return
      balanceRequestedAt = now
      balanceInFlight = true
      try {
        const apiKey = await resolveApiKey()
        const result = await fetchBalance(apiKey, { timeoutMs: BALANCE_TIMEOUT_MS })
        if (disposed) return
        balance = balanceStateOf(result)
        log.debug(`balance ${balance.state}${balance.amount === undefined ? '' : ` ${balance.amount}`}`)
      } catch (error) {
        if (!disposed) balance = { state: 'error' }
        log.warn(`balance refresh failed: ${error instanceof Error ? error.message : String(error)}`)
      } finally {
        balanceInFlight = false
      }
      publish()
    }

    const onSessionEvent = (session, event) => {
      try {
        if (disposed || isSubagentSession(session)) return
        const type = event?.type
        if (type === 'request/header') {
          const entry = trackerEntry(session)
          entry.tracker.setModel(event?.data?.header?.config?.model)
          activeKey = entry.key
          publish()
          return
        }
        if (type === 'assistant/message') {
          const entry = trackerEntry(session)
          if (entry.tracker.onUsage(event?.data?.usage, event?.time ?? Date.now()) !== undefined) {
            activeKey = entry.key
            publish()
          }
          return
        }
        if (type === 'turn/end') {
          const entry = trackerEntry(session)
          entry.tracker.endTurn(event?.time ?? Date.now())
          activeKey = entry.key
          publish()
          void refreshBalance()
        }
      } catch (error) {
        log.warn(`session event failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }

    const onSessionDisposed = session => {
      try {
        const key = sessionKey(session)
        trackers.delete(key)
        if (activeKey === key) {
          activeKey = trackers.size === 0 ? undefined : trackers.keys().next().value
          publish()
        }
      } catch {
        // Teardown bookkeeping only.
      }
    }

    ctx.effect(function* lifecycle() {
      let scope
      let sectionDisposer
      let statusDisposer
      let watchDisposer
      let attempts = 0
      let retryTimer
      let phaseTimer
      let balanceTimer
      let probeLogged = false

      const tryOnce = () => {
        // Every host interaction is optional and every failure is contained:
        // a missing or misbehaving seam must never surface as a startup error.
        try {
          if (!probeLogged) {
            probeLogged = true
            // Candidate counts: 0 = seam absent, 1 = one form answered,
            // 2 = both forms returned distinct instances. A throwing accessor
            // is reported instead of being mistaken for an absent seam.
            const onProbeError = (name, error) => warnOnce(log, seenWarnings, `seam accessor ${name} threw: ${messageOf(error)}`)
            const probe =
              `settings=${seamServices(ctx, 'settings', onProbeError).length} ` +
              `sections=${seamServices(ctx, 'tuiSettingsSections', onProbeError).length} ` +
              `status=${seamServices(ctx, 'tuiStatus', onProbeError).length}`
            log.info(`seam probe: ${probe}`)
          }
          if (scope === undefined) {
            let registered = false
            for (const settings of seamServices(ctx, 'settings')) {
              try {
                scope = settings.register(SETTINGS_NS, Config)
                registered = true
                break
              } catch (error) {
                warnOnce(log, seenWarnings, `settings register failed: ${messageOf(error)}`)
              }
            }
            if (registered) {
              try {
                Object.assign(resolved, sanitizeConfig(scope.get()))
              } catch {
                // An unreadable section keeps the composition-entry values.
              }
              watchDisposer = scope.watch(next => {
                Object.assign(resolved, sanitizeConfig(next))
                publish()
                void refreshBalance({ force: true })
              })
              log.info('settings namespace registered')
            }
          }
          if (sectionDisposer === undefined) {
            for (const sections of seamServices(ctx, 'tuiSettingsSections')) {
              try {
                sectionDisposer = sections.register(settingsSection())
                log.info('settings section registered')
                break
              } catch (error) {
                warnOnce(log, seenWarnings, `settings section failed: ${messageOf(error)}`)
              }
            }
          }
          if (statusDisposer === undefined) {
            for (const status of seamServices(ctx, 'tuiStatus')) {
              try {
                const disposer = status.registerView({
                  key: VIEW_KEY,
                  maxRows: VIEW_MAX_ROWS,
                  component: createStatusView(store),
                })
                if (disposer === undefined) {
                  warnOnce(log, seenWarnings, 'status view was refused by the host; the line will not render')
                  statusDisposer = () => {}
                } else {
                  statusDisposer = disposer
                  log.info('status view registered')
                }
                break
              } catch (error) {
                warnOnce(log, seenWarnings, `status view failed: ${messageOf(error)}`)
              }
            }
          }

          if (statusDisposer !== undefined && phaseTimer === undefined) {
            publish()
            phaseTimer = setInterval(() => {
              try {
                lang = resolveLang()
                publish()
              } catch (error) {
                log.warn(`phase tick failed: ${error instanceof Error ? error.message : String(error)}`)
              }
            }, PHASE_TICK_MS)
            balanceTimer = setInterval(() => {
              void refreshBalance()
            }, BALANCE_REFRESH_MS)
            if (typeof phaseTimer.unref === 'function') phaseTimer.unref()
            if (typeof balanceTimer.unref === 'function') balanceTimer.unref()
            void refreshBalance({ force: true })
          }

          const done = scope !== undefined && sectionDisposer !== undefined && statusDisposer !== undefined
          if (done || ++attempts >= RETRY_LIMIT) {
            if (retryTimer !== undefined) {
              clearInterval(retryTimer)
              retryTimer = undefined
            }
            if (!done) {
              log.warn(
                `host seams incomplete after ${(RETRY_LIMIT * RETRY_MS) / 1000}s ` +
                  `(settings=${scope !== undefined}, section=${sectionDisposer !== undefined}, status=${statusDisposer !== undefined})`,
              )
            }
          }
        } catch (error) {
          log.warn(`service probe failed: ${error instanceof Error ? error.message : String(error)}`)
        }
      }

      retryTimer = setInterval(tryOnce, RETRY_MS)
      if (typeof retryTimer.unref === 'function') retryTimer.unref()
      tryOnce()

      try {
        ctx.on('session/event', onSessionEvent)
        ctx.on('session/disposed', onSessionDisposed)
      } catch (error) {
        log.warn(`event subscription failed: ${error instanceof Error ? error.message : String(error)}`)
      }

      yield () => {
        disposed = true
        for (const timer of [retryTimer, phaseTimer, balanceTimer]) {
          if (timer !== undefined) clearInterval(timer)
        }
        retryTimer = undefined
        phaseTimer = undefined
        balanceTimer = undefined
        try {
          statusDisposer?.()
        } catch {
          // Best-effort teardown.
        }
        try {
          sectionDisposer?.()
        } catch {
          // Best-effort teardown.
        }
        try {
          watchDisposer?.()
        } catch {
          // Best-effort teardown.
        }
        trackers.clear()
        log.info('disposed')
      }
    }, 'dsh-peak-balance lifecycle')
  } catch (error) {
    // A plugin must never fail the host's startup: log and stay inert.
    log.warn(`apply failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}
