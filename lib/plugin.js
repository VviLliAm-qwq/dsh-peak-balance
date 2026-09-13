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
 * The per-turn cost follows the conversation the host reports as FOCUSED, not
 * the one that last appended an event: switching conversations publishes no
 * session event, so the last-event heuristic attributed every figure to the
 * previous conversation (see `./focus.js`).
 *
 * @module dsh-peak-balance
 */

import { appendFileSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import z from '@deepseek-ai/schemastery'
import { collectQuota, createTurnSpend, resolveTarget } from './account.js'
import { cnyBalance } from './balance.js'
import { WARN_COLOR_ORDER, buildDisplay, warnColorOptions } from './display.js'
import { FOCUS_POLL_MS, createMarkerWatcher, readFocusMarker } from './focus.js'
import {
  COLOR_SCALE_ORDER,
  LAYOUT_ORDER,
  METRIC_ORDER,
  SPAN_WEEKS_ORDER,
  WEEK_START_ORDER,
  buildHistoryView,
} from './history.js'
import { SCENE_ID, contributionIdOf, createCommandDefinitions } from './history-command.js'
import { historyCachePath, readCache, recordsFromCache, scanSessions } from './history-scan.js'
import { createHistoryScene } from './history-view.js'
import { langPrefStamp, normalizeLang, resolveLang, t } from './i18n.js'
import { readRates, withRate, withoutRate, writeRates } from './rates.js'
import { billingOf, meterById, percentUsed, pickMeter } from './quota.js'
import { createQuotaCommand } from './quota-command.js'
import { catalogEntry, catalogIds } from './providers/catalog.js'
import { resolveAdapter } from './providers/registry.js'
import { readSpecs, specPath } from './providers/spec.js'
import { createStore } from './store.js'
import { createTracker } from './tracker.js'
import { VIEW_KEY, VIEW_MAX_ROWS, createStatusView, shade } from './view.js'

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
  // Token-history options. The select-shaped ones follow the same free-string
  // discipline as `warnColor` and are sanitized against their own order lists.
  historyMetric: z.string().default('tokens'),
  historySpanWeeks: z.string().default('26'),
  historyIncludeSubagents: z.boolean().default(true),
  historyWeekStart: z.string().default('mon'),
  historyColorScale: z.string().default('github'),
  historyLayout: z.string().default('card'),
  historyHoverTokens: z.boolean().default(true),
  historyHoverCost: z.boolean().default(true),
  historyHoverCacheHit: z.boolean().default(true),
  historyHoverModels: z.boolean().default(true),
  // Generic provider quota (0.4.0). The account side of the line is no longer
  // DeepSeek-specific: these four knobs choose the provider, which meter of it
  // to show, how a turn's spend is measured, and whether endpoints that no
  // provider documents publicly may be used.
  quotaProvider: z.string().default('auto'),
  quotaMetric: z.string().default('auto'),
  turnSpendMode: z.string().default('auto'),
  allowUnofficialQuota: z.boolean().default(false),
  quotaProvidersFile: z.string().default(''),
  // How the account readout is shaped: a subscription reads as percentages of
  // its caps, a pay-as-you-go account as amounts.
  billingMode: z.string().default('auto'),
  planPercentBase: z.string().default('meter'),
})

/** Boot defaults mirroring the schema (used when the config is absent/garbled). */
const DEFAULTS = Object.freeze({
  showBalance: true,
  showTurnCost: true,
  warnOnPeak: false,
  warnColor: 'red',
  historyMetric: 'tokens',
  historySpanWeeks: '26',
  historyIncludeSubagents: true,
  historyWeekStart: 'mon',
  historyColorScale: 'github',
  historyLayout: 'card',
  historyHoverTokens: true,
  historyHoverCost: true,
  historyHoverCacheHit: true,
  historyHoverModels: true,
  quotaProvider: 'auto',
  quotaMetric: 'auto',
  turnSpendMode: 'auto',
  allowUnofficialQuota: false,
  quotaProvidersFile: '',
  billingMode: 'auto',
  planPercentBase: 'meter',
})

/** Meter ids `quotaMetric` accepts (see `./quota.js` for the vocabulary). */
export const QUOTA_METRIC_ORDER = Object.freeze([
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

/** How a turn's spend is resolved: the provider's counter, an estimate, or either. */
export const TURN_SPEND_MODE_ORDER = Object.freeze(['auto', 'measured', 'estimate'])

/** How the account readout is shaped (see `./quota.js` `billingOf`). */
export const BILLING_MODE_ORDER = Object.freeze(['auto', 'money', 'plan'])

/** What a plan-mode percentage divides by. */
export const PLAN_PERCENT_BASE_ORDER = Object.freeze(['meter', 'monthly'])

const RETRY_MS = 400
const RETRY_LIMIT = 75
const BALANCE_REFRESH_MS = 60_000
const PHASE_TICK_MS = 20_000
const MIN_BALANCE_GAP_MS = 3_000
/** How long to wait before re-reading a provider spend counter that has not moved. */
const SPEND_RETRY_MS = 3_000
/** Consecutive retries before the spend figure is forced (flagged inexact). */
const SPEND_RETRY_LIMIT = 5
/** Rotation period of the `rotate` quota metric. */
const QUOTA_ROTATE_MS = 8_000
const MAX_TRACKERS = 16
/** Pending `turn:step` request instants remembered per session (see `steps`). */
const MAX_STEPS = 64
/** Refresh cadence of the `/th` scene while it is on screen. */
const HISTORY_REFRESH_MS = 60_000
/** How often the persisted language preference is checked (see applyLanguage). */
const LANG_POLL_MS = 1_000
/** Settled turns remembered per conversation id (see `rememberSettled`). */
const MAX_SETTLED = 24
/** Consecutive rich-view refusals before the line is considered unrenderable. */
const STATUS_REFUSAL_LIMIT = 5
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
  for (const key of [
    'showBalance',
    'showTurnCost',
    'warnOnPeak',
    'historyIncludeSubagents',
    'historyHoverTokens',
    'historyHoverCost',
    'historyHoverCacheHit',
    'historyHoverModels',
    'allowUnofficialQuota',
  ]) {
    if (typeof config[key] === 'boolean') out[key] = config[key]
  }
  if (WARN_COLOR_ORDER.includes(config.warnColor)) out.warnColor = config.warnColor
  for (const [key, allowed] of Object.entries({
    historyMetric: METRIC_ORDER,
    historySpanWeeks: SPAN_WEEKS_ORDER,
    historyWeekStart: WEEK_START_ORDER,
    historyColorScale: COLOR_SCALE_ORDER,
    historyLayout: LAYOUT_ORDER,
    quotaMetric: QUOTA_METRIC_ORDER,
    turnSpendMode: TURN_SPEND_MODE_ORDER,
    billingMode: BILLING_MODE_ORDER,
    planPercentBase: PLAN_PERCENT_BASE_ORDER,
  })) {
    if (allowed.includes(config[key])) out[key] = config[key]
  }
  // Free strings, clamped: a provider id is a route key, and the file path is a
  // local path. Neither is validated beyond shape, because both are meant to
  // name things this build has never heard of.
  if (typeof config.quotaProvider === 'string') out.quotaProvider = config.quotaProvider.trim().slice(0, 64)
  if (typeof config.quotaProvidersFile === 'string') out.quotaProvidersFile = config.quotaProvidersFile.trim().slice(0, 512)
  return out
}

/** Session id as text (`''` when the host exposes none).
 *
 * Used for focus matching only: trackers are keyed by the session OBJECT,
 * because ids are reusable ("A → /new → /resume A lands back on the same id
 * with a fresh agent", dsh-tui `input-delivery`), and an id-keyed map would let
 * the old session's disposal delete the new one's state.
 */
function sessionIdOf(session) {
  try {
    const id = session?.id ?? session?.header?.id ?? session?.sessionId
    if (typeof id === 'string') return id
    if (typeof id === 'number' && Number.isFinite(id)) return String(id)
    return ''
  } catch {
    return ''
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
 * Conversation that spawned one subagent session, when the host names it.
 *
 * Real session headers carry `parentSession` (verified against stored subagent
 * logs, v0 and v3 alike). Without it the child's spend stays unattributed —
 * exactly the old behaviour — rather than being guessed onto some other line.
 */
function parentIdOf(session) {
  try {
    const header = session?.header ?? session?.meta
    const id = header?.parentSession ?? header?.parentSessionId ?? session?.parentSession
    return typeof id === 'string' && id !== '' ? id : undefined
  } catch {
    return undefined
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

/**
 * Balance result -> the display model's small state object.
 *
 * The currency rides along (`cnyBalance` falls back to the first reported
 * entry when no CNY one exists, so the amount is not necessarily yuan) — the
 * view formats the figure with the currency it is actually in.
 */
export function balanceStateOf(result) {
  if (result?.ok === true) {
    const entry = cnyBalance(result)
    return entry === undefined
      ? { state: 'error' }
      : { state: 'ok', amount: entry.total, currency: entry.currency }
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
    groups: [
      {
        id: 'history',
        title: 'Token history',
        descriptions: { zh: '历史用量（/th）', en: 'Token history (/th)' },
      },
      {
        id: 'quota',
        title: 'Provider quota',
        descriptions: { zh: '第三方 provider 额度', en: 'Provider quota' },
      },
    ],
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
      {
        path: ['historyMetric'],
        label: 'Grid metric',
        descriptions: { zh: '方格图口径', en: 'Grid metric' },
        hint: 'What the grid shades: total tokens, estimated cost, output tokens, or cache-miss input.',
        hintDescriptions: {
          zh: '方格深浅表示什么：总 token / 估算花费 / 输出 token / 缓存未命中输入。',
          en: 'What the grid shades: total tokens, estimated cost, output tokens, or cache-miss input.',
        },
        kind: 'select',
        group: 'history',
        options: [
          { value: 'tokens', label: 'Total tokens', descriptions: { zh: '总 token', en: 'Total tokens' } },
          { value: 'cost', label: 'Cost (CNY)', descriptions: { zh: '花费（元）', en: 'Cost (CNY)' } },
          { value: 'output', label: 'Output tokens', descriptions: { zh: '输出 token', en: 'Output tokens' } },
          { value: 'cacheMiss', label: 'Cache-miss input', descriptions: { zh: '未命中输入', en: 'Cache-miss input' } },
        ],
      },
      {
        path: ['historySpanWeeks'],
        label: 'Time span',
        descriptions: { zh: '时间跨度', en: 'Time span' },
        hint: 'How many week columns the grid draws.',
        hintDescriptions: {
          zh: '方格图显示多少周。',
          en: 'How many week columns the grid draws.',
        },
        kind: 'select',
        group: 'history',
        options: [
          { value: '13', label: '13 weeks', descriptions: { zh: '13 周', en: '13 weeks' } },
          { value: '26', label: '26 weeks', descriptions: { zh: '26 周', en: '26 weeks' } },
          { value: '53', label: '53 weeks', descriptions: { zh: '53 周', en: '53 weeks' } },
        ],
      },
      {
        path: ['historyIncludeSubagents'],
        label: 'Count subagents',
        descriptions: { zh: '计入子代理', en: 'Count subagents' },
        hint: 'Subagent sessions spend real tokens; turning this off reports only your own conversations.',
        hintDescriptions: {
          zh: '子代理会话也真实消耗 token；关闭后只统计主人亲自跑的对话。',
          en: 'Subagent sessions spend real tokens; turning this off reports only your own conversations.',
        },
        kind: 'boolean',
        group: 'history',
      },
      {
        path: ['historyWeekStart'],
        label: 'Week starts on',
        descriptions: { zh: '每周起始日', en: 'Week starts on' },
        hint: 'Which weekday the grid’s first row is.',
        hintDescriptions: {
          zh: '方格图第一行是星期几。',
          en: 'Which weekday the grid’s first row is.',
        },
        kind: 'select',
        group: 'history',
        options: [
          { value: 'mon', label: 'Monday', descriptions: { zh: '周一', en: 'Monday' } },
          { value: 'sun', label: 'Sunday', descriptions: { zh: '周日', en: 'Sunday' } },
        ],
      },
      {
        path: ['historyColorScale'],
        label: 'Grid palette',
        descriptions: { zh: '方格色阶', en: 'Grid palette' },
        hint: 'Colors of the intensity levels; “theme” follows the active TUI accent.',
        hintDescriptions: {
          zh: '深浅色阶的配色；“跟随主题”使用当前 TUI 主题的强调色。',
          en: 'Colors of the intensity levels; “theme” follows the active TUI accent.',
        },
        kind: 'select',
        group: 'history',
        options: [
          { value: 'github', label: 'GitHub green', descriptions: { zh: 'GitHub 绿', en: 'GitHub green' } },
          { value: 'blue', label: 'Blue', descriptions: { zh: '蓝色系', en: 'Blue' } },
          { value: 'theme', label: 'Theme accent', descriptions: { zh: '跟随主题', en: 'Theme accent' } },
        ],
      },
      {
        path: ['historyLayout'],
        label: 'Scene layout',
        descriptions: { zh: '场景版式', en: 'Scene layout' },
        hint: '“Card” frames the scene in a rounded box with section separators; “plain” drops the chrome and spends the room on content. Card falls back to plain by itself on a small terminal.',
        hintDescriptions: {
          zh: '「卡片」用圆角边框 + 分区辅助线包住场景；「极简」去掉外框，把空间留给内容。终端太小时卡片会自动退化为极简。',
          en: '“Card” frames the scene in a rounded box with section separators; “plain” drops the chrome and spends the room on content. Card falls back to plain by itself on a small terminal.',
        },
        kind: 'select',
        group: 'history',
        options: [
          { value: 'card', label: 'Card', descriptions: { zh: '卡片（边框 + 辅助线）', en: 'Card' } },
          { value: 'plain', label: 'Plain', descriptions: { zh: '极简（无边框）', en: 'Plain' } },
        ],
      },
      {
        path: ['historyHoverTokens'],
        label: 'Hover: tokens',
        descriptions: { zh: '悬停：token 分项', en: 'Hover: tokens' },
        hint: 'Show the input / cache-read / output split in the day card.',
        hintDescriptions: {
          zh: '在当日明细里显示 未命中输入 / 缓存读 / 输出 分项。',
          en: 'Show the input / cache-read / output split in the day card.',
        },
        kind: 'boolean',
        group: 'history',
      },
      {
        path: ['historyHoverCost'],
        label: 'Hover: cost',
        descriptions: { zh: '悬停：花费', en: 'Hover: cost' },
        hint: 'Show the estimated cost of the hovered day.',
        hintDescriptions: {
          zh: '显示当天的估算花费。',
          en: 'Show the estimated cost of the hovered day.',
        },
        kind: 'boolean',
        group: 'history',
      },
      {
        path: ['historyHoverCacheHit'],
        label: 'Hover: cache hit rate',
        descriptions: { zh: '悬停：缓存命中率', en: 'Hover: cache hit rate' },
        hint: 'Show the hovered day’s cache-hit rate.',
        hintDescriptions: {
          zh: '显示当天缓存命中率。',
          en: 'Show the hovered day’s cache-hit rate.',
        },
        kind: 'boolean',
        group: 'history',
      },
      {
        path: ['historyHoverModels'],
        label: 'Hover: models',
        descriptions: { zh: '悬停：模型明细', en: 'Hover: models' },
        hint: 'Show which models the hovered day used.',
        hintDescriptions: {
          zh: '显示当天用了哪些模型。',
          en: 'Show which models the hovered day used.',
        },
        kind: 'boolean',
        group: 'history',
      },
      {
        path: ['quotaProvider'],
        label: 'Quota provider',
        descriptions: { zh: '额度来源', en: 'Quota provider' },
        hint: '“auto” follows the provider the focused conversation runs through; a provider id pins that one; “off” hides the account section.',
        hintDescriptions: {
          zh: '「auto」跟随当前对话实际使用的 provider；填 provider id 可固定其中一个；「off」隐藏账户那一段。',
          en: '“auto” follows the provider the focused conversation runs through; a provider id pins that one; “off” hides the account section.',
        },
        kind: 'text',
        group: 'quota',
      },
      {
        path: ['quotaMetric'],
        label: 'Quota metric',
        descriptions: { zh: '额度口径', en: 'Quota metric' },
        hint: 'Which meter of the provider to show; “rotate” cycles through every meter it reports.',
        hintDescriptions: {
          zh: '显示 provider 的哪一个额度口径；「轮换」会在它上报的所有口径间循环。',
          en: 'Which meter of the provider to show; “rotate” cycles through every meter it reports.',
        },
        kind: 'select',
        group: 'quota',
        options: [
          { value: 'auto', label: 'Auto', descriptions: { zh: '自动（最紧的窗口）', en: 'Auto (tightest window)' } },
          { value: 'balance', label: 'Balance', descriptions: { zh: '余额', en: 'Balance' } },
          { value: 'window5h', label: '5-hour window', descriptions: { zh: '5 小时窗口', en: '5-hour window' } },
          { value: 'windowWeekly', label: 'Weekly window', descriptions: { zh: '周窗口', en: 'Weekly window' } },
          { value: 'windowDaily', label: 'Daily window', descriptions: { zh: '日窗口', en: 'Daily window' } },
          { value: 'windowMonthly', label: 'Monthly window', descriptions: { zh: '月窗口', en: 'Monthly window' } },
          { value: 'planRemaining', label: 'Plan remaining', descriptions: { zh: '套餐余量', en: 'Plan remaining' } },
          { value: 'keyLimit', label: 'Key limit', descriptions: { zh: 'key 限额', en: 'Key limit' } },
          { value: 'periodSpend', label: 'Period spend', descriptions: { zh: '本期已用', en: 'Period spend' } },
          { value: 'rotate', label: 'Rotate', descriptions: { zh: '轮换', en: 'Rotate' } },
        ],
      },
      {
        path: ['turnSpendMode'],
        label: 'Turn spend',
        descriptions: { zh: '每轮花费口径', en: 'Turn spend' },
        hint: '“measured” reads the provider’s own spend counter after each turn; “estimate” prices the reported tokens with a rate card.',
        hintDescriptions: {
          zh: '「实测」在每轮结束后读取 provider 自己的消费计数器；「估算」用价目表按上报 token 换算。',
          en: '“measured” reads the provider’s own spend counter after each turn; “estimate” prices the reported tokens with a rate card.',
        },
        kind: 'select',
        group: 'quota',
        options: [
          { value: 'auto', label: 'Auto', descriptions: { zh: '自动（有计数器就实测）', en: 'Auto (measured when available)' } },
          { value: 'measured', label: 'Measured', descriptions: { zh: '实测扣减', en: 'Measured' } },
          { value: 'estimate', label: 'Estimate', descriptions: { zh: '价目估算', en: 'Estimate' } },
        ],
      },
      {
        path: ['allowUnofficialQuota'],
        label: 'Unofficial endpoints',
        descriptions: { zh: '允许非公开端点', en: 'Unofficial endpoints' },
        hint: 'Allow quota reads that no provider documents publicly (reverse-engineered console endpoints). Off by default.',
        hintDescriptions: {
          zh: '允许访问厂商未公开文档的额度端点（多为逆向控制台接口）。默认关闭。',
          en: 'Allow quota reads that no provider documents publicly (reverse-engineered console endpoints). Off by default.',
        },
        kind: 'boolean',
        group: 'quota',
      },
      {
        path: ['quotaProvidersFile'],
        label: 'Provider spec file',
        descriptions: { zh: 'provider 声明文件', en: 'Provider spec file' },
        hint: 'JSON file describing providers this build ships no adapter for; empty uses ~/.dsh-tui/dsh-peak-balance-providers.json.',
        hintDescriptions: {
          zh: '描述本包未内置适配器的 provider 的 JSON 文件；留空则用 ~/.dsh-tui/dsh-peak-balance-providers.json。',
          en: 'JSON file describing providers this build ships no adapter for; empty uses ~/.dsh-tui/dsh-peak-balance-providers.json.',
        },
        kind: 'text',
        group: 'quota',
      },
      {
        path: ['billingMode'],
        label: 'Billing mode',
        descriptions: { zh: '计费方式', en: 'Billing mode' },
        hint: 'How the account readout is shaped: a subscription shows percentages of its caps, a pay-as-you-go account shows amounts.',
        hintDescriptions: {
          zh: '账户读数的形态：订阅套餐显示占额度的百分比，按量计费显示金额。',
          en: 'How the account readout is shaped: a subscription shows percentages of its caps, a pay-as-you-go account shows amounts.',
        },
        kind: 'select',
        group: 'quota',
        options: [
          { value: 'auto', label: 'Auto', descriptions: { zh: '自动（按 provider 声明）', en: 'Auto (from the provider)' } },
          { value: 'money', label: 'Amounts', descriptions: { zh: '金额/余额', en: 'Amounts' } },
          { value: 'plan', label: 'Percentages', descriptions: { zh: '百分比', en: 'Percentages' } },
        ],
      },
      {
        path: ['planPercentBase'],
        label: 'Percentage base',
        descriptions: { zh: '百分比基数', en: 'Percentage base' },
        hint: 'What a plan percentage divides by: the window the line shows, or the whole monthly pool.',
        hintDescriptions: {
          zh: '套餐百分比的分母：状态行显示的那个窗口，还是整个月度额度。',
          en: 'What a plan percentage divides by: the window the line shows, or the whole monthly pool.',
        },
        kind: 'select',
        group: 'quota',
        options: [
          { value: 'meter', label: 'Shown window', descriptions: { zh: '当前显示的口径', en: 'Shown window' } },
          { value: 'monthly', label: 'Monthly pool', descriptions: { zh: '月度套餐总量', en: 'Monthly pool' } },
        ],
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
    /**
     * One tracker per session OBJECT (`session -> { id, tracker }`): two
     * sessions that share a reused id therefore never share turn state, and the
     * id rides along for focus matching only.
     */
    const trackers = new Map()
    /**
     * Settled turns by conversation id.
     *
     * Deliberately survives the disposal of the session that reported them: a
     * settled turn is a fact about the CONVERSATION, and switching away and
     * back disposes the session (the host replays the conversation privately on
     * the way back, publishing no event that could rebuild it). Without this the
     * figure would vanish every time the user left a conversation and returned.
     */
    const settledById = new Map()
    const forcePeak = forcePeakFromEnv()
    /** Session object whose events the line followed most recently. */
    let activeSession
    /** Focused session id reported by the host; `undefined` = unknown. */
    let focusId
    /**
     * The host cleared its focus marker (`/new`) and no new conversation has
     * shown up yet.
     *
     * A cleared marker is information, not absence: the conversation it named
     * is gone. {@link clearedFocusId} is the conversation left behind, which
     * must not keep the line while a fresh one is expected.
     */
    let focusCleared = false
    /** Session id the clear left behind (`undefined` when nothing was focused). */
    let clearedFocusId
    /** Focus provenance: a mediated switch event outranks the marker poll. */
    let focusSource = 'none'

    /**
     * The language the host is actually showing.
     *
     * dsh-TUI's `/lang` writes `~/.dsh-tui/lang.json`, flips its in-memory
     * language, and mirrors the choice into the `dsh-tui` settings namespace.
     * The namespace is the only source that reflects a switch made after this
     * process started, so it is read first — through the public
     * `settings.get(ns)` seam, never by importing host internals. The
     * environment pin stays ahead of it (dsh-TUI itself pins it that way), and
     * the persisted file / OS locale remain the fallback for hosts that serve
     * no `dsh-tui` namespace.
     */
    const readHostLang = () => {
      const fromEnv = normalizeLang(process.env?.DSH_TUI_LANG)
      if (fromEnv !== undefined) return fromEnv
      for (const settings of seamServices(ctx, 'settings')) {
        try {
          const fromHost = normalizeLang(settings?.get?.('dsh-tui')?.lang)
          if (fromHost !== undefined) return fromHost
        } catch {
          // No `dsh-tui` namespace on this host: fall through to the file.
        }
      }
      return resolveLang()
    }

    /**
     * The language the plugin renders with (see {@link readHostLang}).
     */
    let lang = 'zh'
    try {
      lang = readHostLang()
    } catch (error) {
      log.warn(`language resolution failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    /**
     * The account-side state the line renders.
     *
     * Since 0.4.0 this is provider-neutral: `quota` is a small display model
     * (`{ state: 'meter', meter, planName }`, or a failure state) derived from a
     * snapshot, so the line says the same kind of thing whether the provider is
     * DeepSeek's own balance, a Command Code plan or a relay's credit pool.
     */
    let quota = { state: 'loading' }
    /** The raw snapshot behind `quota` (the spend counter lives here). */
    let quotaSnapshot
    let quotaRequestedAt = 0
    let quotaInFlight = false
    /** Rotation cursor for the `rotate` metric (advanced by the phase timer). */
    let quotaTick = 0
    /** Per-turn spend measurement (see `./account.js`). */
    const turnSpend = createTurnSpend()
    /** Settled measured spend by conversation id. */
    const spendById = new Map()
    /** Retry bookkeeping for a counter that has not caught up yet. */
    let spendRetryTimer
    let spendRetries = 0
    let disposed = false
    /** Distinct warnings already logged (the retry loop repeats every 400 ms). */
    const seenWarnings = new Set()
    log.info(`config resolved: ${JSON.stringify(resolved)} lang=${lang} forcePeak=${forcePeak}`)

    // ---- Token history (/th) -------------------------------------------------
    /** Observable snapshot the scene renders; the scene never reads files. */
    const historyStore = createStore({
      status: 'idle',
      view: undefined,
      progress: undefined,
      refreshing: false,
      scannedAt: undefined,
      stats: undefined,
      error: undefined,
    })
    /** Custom model rates (user set through `/th price`); win over the card. */
    let rates = {}
    try {
      rates = readRates()
    } catch (error) {
      log.warn(`rate file unreadable: ${messageOf(error)}`)
    }
    /** Scene-local option overrides (`m`/`w`/`s`), cleared on any settings change. */
    const historyOverrides = {}
    /** Reduced session records from the last scan. */
    let historyRecords = []
    let historyScan
    let historyScanAbort
    let sceneDisposer
    let shortcutDisposer
    let historyRefreshTimer
    let settingsScope
    const commandDisposers = []
    const commandTreeDisposers = []
    /** Disposers of the `/quota` command (kept apart from the history family). */
    const quotaCommandDisposers = []

    /** Config the history view renders with (settings + scene-local overrides). */
    const historyConfig = () => ({ ...resolved, ...historyOverrides })

    /**
     * Persist one settings patch.
     *
     * The scene's `m`/`w`/`s` keys are real setting changes, not a private view
     * mode: the owner asked for the subagent switch (and its siblings) to
     * survive a restart, and the settings card is the single source of truth.
     * The optimistic override below flips the UI immediately; `scope.watch`
     * clears it once the write lands. A host without the settings service (or a
     * refused write) keeps the override for this session only.
     */
    const writeSettings = async patch => {
      if (settingsScope === undefined) return false
      try {
        await settingsScope.update(patch)
        return true
      } catch (error) {
        log.warn(`settings write failed: ${messageOf(error)}`)
        return false
      }
    }

    const mergeHistory = patch => {
      try {
        historyStore.set({ ...historyStore.get(), ...patch })
      } catch {
        // The store is a plain object holder; a failed merge is not fatal.
      }
    }

    /** Rebuild the derived view model from the records in hand. */
    const publishHistory = () => {
      try {
        const config = historyConfig()
        const view = buildHistoryView(historyRecords, {
          now: Date.now(),
          spanWeeks: Number(config.historySpanWeeks),
          weekStart: config.historyWeekStart,
          metric: config.historyMetric,
          includeSubagents: config.historyIncludeSubagents,
          customRates: rates,
          providerFilter: config.providerFilter ?? 'all',
        })
        mergeHistory({ view })
      } catch (error) {
        log.warn(`history view failed: ${messageOf(error)}`)
      }
    }

    /**
     * Paint the grid from the on-disk cache before the first scan finishes.
     *
     * The incremental cache already holds one reduced record per session log, and
     * reading it costs ~1 ms where the incremental scan needs tens of them and a
     * cold rebuild takes seconds. Publishing it at activation means `/hist` opens
     * on a finished grid instead of a loading state; the scan that follows only
     * refreshes what changed, and the scene keeps the old numbers on screen until
     * it lands. A missing or unusable cache preloads nothing and costs nothing.
     */
    let historyPreloaded = false
    const preloadHistory = () => {
      if (historyPreloaded || disposed) return
      historyPreloaded = true
      try {
        const cache = readCache({ cachePath: historyCachePath() })
        const records = recordsFromCache(cache)
        if (records.length === 0) return
        historyRecords = records
        mergeHistory({
          status: 'ready',
          scannedAt: cache.builtAt > 0 ? cache.builtAt : undefined,
          progress: undefined,
        })
        publishHistory()
        log.info(`history preloaded records=${records.length} builtAt=${cache.builtAt}`)
      } catch (error) {
        log.warn(`history preload failed: ${messageOf(error)}`)
      }
    }

    /**
     * Scan the session logs, reusing the incremental cache.
     *
     * One scan at a time: a second request while one is running returns the
     * same promise instead of piling up I/O. The full rebuild takes a few
     * seconds on a large corpus, which is why the scene shows progress.
     *
     * A scan never takes the grid away from the screen: with records already in
     * hand (preloaded, or from an earlier scan) the scene stays on `ready` and
     * only marks itself as refreshing, so nothing flickers back to a spinner.
     */
    const scanHistory = () => {
      if (disposed) return Promise.resolve(undefined)
      if (historyScan !== undefined) return historyScan
      const haveRecords = historyRecords.length > 0
      mergeHistory(haveRecords ? { refreshing: true, error: undefined } : { status: 'loading', refreshing: true, error: undefined })
      const controller = new AbortController()
      historyScanAbort = controller
      let progressDone = -1
      historyScan = (async () => {
        try {
          const result = await scanSessions({
            cachePath: historyCachePath(),
            signal: controller.signal,
            onProgress: progress => {
              // The scan already coalesces its ticks; this drops the repeats, so
              // one progress figure costs at most one re-render.
              if (progress.done === progressDone) return
              progressDone = progress.done
              mergeHistory({ progress })
            },
          })
          if (disposed) return undefined
          historyRecords = result.records
          mergeHistory({
            status: 'ready',
            progress: undefined,
            refreshing: false,
            error: undefined,
            scannedAt: Date.now(),
            stats: result.stats,
          })
          publishHistory()
          log.info(
            `history scan files=${result.stats.files} scanned=${result.stats.scanned} reused=${result.stats.reused} ` +
              `events=${result.stats.events} skipped=${result.stats.skippedEvents} ms=${result.stats.durationMs}`,
          )
          return result
        } catch (error) {
          if (!disposed) {
            mergeHistory({
              status: haveRecords ? 'ready' : 'error',
              error: messageOf(error),
              progress: undefined,
              refreshing: false,
            })
          }
          log.warn(`history scan failed: ${messageOf(error)}`)
          return undefined
        } finally {
          historyScan = undefined
          historyScanAbort = undefined
        }
      })()
      return historyScan
    }

    /**
     * Change one select-shaped history option.
     *
     * Optimistic local override first (the chip flips on the next frame), then
     * the settings write. `scope.watch` clears the override and republishes, so
     * the visible state converges on what is actually stored.
     */
    const cycleHistoryOption = (key, order) => {
      const current = historyConfig()[key]
      const index = order.indexOf(current)
      const next = order[(index + 1) % order.length]
      historyOverrides[key] = next
      publishHistory()
      void writeSettings({ [key]: next })
    }

    /** Stop the scene's periodic refresh. */
    const stopHistoryRefresh = () => {
      if (historyRefreshTimer === undefined) return
      clearInterval(historyRefreshTimer)
      historyRefreshTimer = undefined
    }

    /**
     * Refresh while the scene is on screen.
     *
     * Deliberately not hooked to `turn/end`: the grid only needs to be fresh
     * while somebody is looking at it, and an idle TUI should not keep reading
     * the session directory.
     */
    const startHistoryRefresh = scenes => {
      if (historyRefreshTimer !== undefined) return
      historyRefreshTimer = setInterval(() => {
        try {
          if (disposed || scenes?.active?.id !== SCENE_ID) {
            stopHistoryRefresh()
            return
          }
          void scanHistory()
        } catch {
          stopHistoryRefresh()
        }
      }, HISTORY_REFRESH_MS)
      if (typeof historyRefreshTimer.unref === 'function') historyRefreshTimer.unref()
    }

    /** The scene's keyboard effects. */
    const sceneActions = {
      rescan: () => {
        void scanHistory()
      },
      cycleMetric: () => cycleHistoryOption('historyMetric', METRIC_ORDER),
      cycleSpan: () => cycleHistoryOption('historySpanWeeks', SPAN_WEEKS_ORDER),
      toggleSubagents: () => {
        const next = historyConfig().historyIncludeSubagents !== true
        historyOverrides.historyIncludeSubagents = next
        publishHistory()
        void writeSettings({ historyIncludeSubagents: next })
      },
      /**
       * Cycle the provider filter: everything, then each account in turn.
       *
       * Scene-local on purpose — which account you are looking at right now is a
       * question about this visit to the grid, not a preference worth persisting
       * (and the list itself comes from whatever the logs actually contain).
       */
      cycleProvider: () => {
        const present = historyStore.get()?.view?.allProviders ?? []
        const options = ['all', ...present]
        const current = historyConfig().providerFilter ?? 'all'
        const next = options[(Math.max(0, options.indexOf(current)) + 1) % options.length]
        historyOverrides.providerFilter = next
        publishHistory()
      },
    }

    /**
     * Bind `alt+h` to the history scene.
     *
     * A shortcut exists because of a host behaviour the plugin cannot change:
     * dsh-tui's slash-completion overlay owns Enter while it is open, and its
     * list puts built-ins first — so `/th` alone highlights `/theme`. The
     * combo must carry ctrl/alt and must not be reserved; `alt+h` is free
     * (the built-ins use `alt+v`/`alt+up`). Refusals are the host's business:
     * it answers with a no-op disposer and a warning.
     */
    const registerHistoryShortcut = () => {
      if (shortcutDisposer !== undefined) return true
      for (const shortcuts of seamServices(ctx, 'tuiShortcuts')) {
        try {
          const disposer = shortcuts.register('alt+h', {
            description: 'Open the token-history scene (/hist)',
            handler: () => {
              void openHistory()
            },
          })
          if (typeof disposer === 'function') {
            shortcutDisposer = disposer
            log.info('shortcut registered alt+h')
            return true
          }
        } catch (error) {
          warnOnce(log, seenWarnings, `shortcut registration failed: ${messageOf(error)}`)
        }
      }
      return false
    }

    /** Register the full-screen scene once, on whichever seam answers. */
    const registerHistoryScene = () => {
      if (sceneDisposer !== undefined) return true
      for (const scenes of seamServices(ctx, 'tuiScenes')) {
        try {
          const disposer = scenes.register({
            id: SCENE_ID,
            title: 'Token history',
            component: createHistoryScene({
              store: historyStore,
              getConfig: historyConfig,
              getLang: () => lang,
              actions: sceneActions,
              shade,
            }),
          })
          if (typeof disposer === 'function') {
            sceneDisposer = disposer
            log.info('history scene registered')
            return true
          }
        } catch (error) {
          warnOnce(log, seenWarnings, `history scene failed: ${messageOf(error)}`)
        }
      }
      return false
    }

    /** `/th` — open the grid, scanning first when nothing is loaded yet. */
    const openHistory = async () => {
      if (!registerHistoryScene()) {
        return { kind: 'error', text: t(lang, 'historyError') }
      }
      publishHistory()
      void scanHistory()
      let opened = false
      for (const scenes of seamServices(ctx, 'tuiScenes')) {
        try {
          if (scenes.open?.(SCENE_ID) === true) {
            opened = true
            startHistoryRefresh(scenes)
            break
          }
        } catch (error) {
          warnOnce(log, seenWarnings, `history scene open failed: ${messageOf(error)}`)
        }
      }
      return opened ? { kind: 'success' } : { kind: 'error', text: t(lang, 'historyError') }
    }

    /** `/th price …` effects; text is rendered by `./history-command.js`. */
    const commandActions = {
      open: openHistory,
      listRates: () => {
        if (historyRecords.length === 0) void scanHistory()
        const view = historyStore.get()?.view
        const unknown = (view?.models ?? [])
          .filter(entry => entry.source === 'unknown')
          .map(entry => ({ model: entry.model, tokens: entry.tokens }))
        return { rates, unknown }
      },
      setRate: (model, spec) => {
        const result = withRate(rates, model, spec)
        if (result.error !== undefined) return { ok: false, error: result.error }
        rates = result.rates
        if (!writeRates(rates)) log.warn('rate file could not be written; custom rates stay in memory')
        publishHistory()
        return { ok: true, model: result.model, entry: rates[result.model] }
      },
      removeRate: model => {
        const result = withoutRate(rates, model)
        rates = result.rates
        if (!writeRates(rates)) log.warn('rate file could not be written; custom rates stay in memory')
        publishHistory()
        return { model: result.model, removed: result.removed }
      },
      clearRates: () => {
        const count = Object.keys(rates).length
        rates = {}
        if (!writeRates(rates)) log.warn('rate file could not be written; custom rates stay in memory')
        publishHistory()
        return { count }
      },
    }

    /**
     * Register `/th` + `/tokenhistory` once.
     *
     * The mediated surface (`ctx.tuiPluginHost.registerCommand`, C-041) is
     * tried first because it stamps a verified component identity; this plugin
     * is loaded as a plain profile row and has no such identity, so the direct
     * `ctx.commands.register` path (C-070, the documented boundary) is the one
     * that actually answers. Both failures are contained and logged.
     */
    /**
     * Every provider route this process could ask about.
     *
     * Three sources, merged: the routes the LLM seam currently serves (with its
     * own `declared` flag, which is how a hand-written gateway is told apart
     * from a catalog provider), the generated catalog for routes configured in a
     * composition patch, and whatever the spec file names. `/quota` prints the
     * result, which is the fastest way to see why a provider shows nothing.
     */
    const routableProviders = spec => {
      const rows = []
      const seen = new Set()
      const add = (provider, baseUrl, declared) => {
        if (typeof provider !== 'string' || provider === '' || seen.has(provider)) return
        seen.add(provider)
        const { adapter } = resolveAdapter({ provider, baseUrl, spec: spec?.providers?.[provider], declared })
        rows.push({ provider, declared, adapter: adapter?.ADAPTER_ID ?? '' })
      }
      for (const llm of seamServices(ctx, 'llm')) {
        try {
          for (const entry of llm?.listConfigurableProviders?.() ?? []) {
            add(entry?.provider, undefined, entry?.declared === true)
          }
        } catch {
          // A refusing seam contributes nothing; the catalog still does.
        }
      }
      for (const id of catalogIds()) add(id, catalogEntry(id)?.baseUrl, false)
      for (const [id, stanza] of Object.entries(spec?.providers ?? {})) {
        add(id, stanza.baseUrl ?? spec?.apiBases?.[id], false)
      }
      return rows.sort((a, b) => a.provider.localeCompare(b.provider))
    }

    /** One diagnostic report from a snapshot (see `./quota-command.js`). */
    const quotaReportOf = (snapshot, target, spec) => ({
      provider: target.provider,
      source: target.source,
      adapter: snapshot?.adapter,
      state: snapshot === undefined ? 'loading' : snapshot.ok === true ? 'ok' : 'failed',
      reason: snapshot?.ok === true ? undefined : snapshot?.reason,
      detail: snapshot?.detail,
      plan: snapshot?.plan,
      meters: snapshot?.meters,
      failures: snapshot?.failures,
      updatedAt: snapshot?.at,
      specPath: resolved.quotaProvidersFile !== '' ? resolved.quotaProvidersFile : specPath(),
      providers: routableProviders(spec),
    })

    /** The `/quota` effects. */
    const quotaCommandActions = {
      status: async () => {
        const target = resolveTarget({ provider: observedProvider(), config: resolved })
        return quotaReportOf(target.enabled === true ? quotaSnapshot : undefined, target, loadSpecs())
      },
      check: async provider => {
        const requested = typeof provider === 'string' && provider !== '' ? provider : observedProvider()
        const target = requested === ''
          ? resolveTarget({ provider: '', config: resolved })
          : { enabled: true, provider: requested, source: 'check' }
        if (target.enabled !== true) return undefined
        const spec = loadSpecs()
        const snapshot = await collectQuota({
          provider: target.provider,
          config: resolved,
          spec,
          llmServices: seamServices(ctx, 'llm'),
          settingsServices: seamServices(ctx, 'settings'),
          credentialsServices: seamServices(ctx, 'credentials'),
          log,
        })
        return quotaReportOf(snapshot, target, spec)
      },
      setMetric: async metric => {
        if (!QUOTA_METRIC_ORDER.includes(metric)) return { ok: false }
        resolved.quotaMetric = metric
        quotaTick = 0
        publish()
        void writeSettings({ quotaMetric: metric })
        return { ok: true }
      },
    }

    /**
     * Register `/quota` through the same mediated-then-direct path the history
     * commands use (a plugin loaded from a profile row has no verified component
     * identity, so the mediated call is expected to be refused).
     */
    const registerQuotaCommand = () => {
      if (quotaCommandDisposers.length > 0) return true
      let commands
      try {
        commands = ctx.get('commands', false)
      } catch {
        commands = undefined
      }
      if (commands === undefined || typeof commands.register !== 'function') return false
      const definition = createQuotaCommand({ actions: quotaCommandActions, getLang: () => lang })
      let dispose
      let via = 'commands'
      for (const host of seamServices(ctx, 'tuiPluginHost')) {
        try {
          dispose = host.registerCommand(ctx, contributionIdOf(definition.name), definition)
          if (typeof dispose === 'function') via = 'tuiPluginHost'
          break
        } catch (error) {
          log.debug(`mediated command ${definition.name} refused: ${messageOf(error)}`)
        }
      }
      if (typeof dispose !== 'function') {
        try {
          dispose = commands.register(definition)
        } catch (error) {
          warnOnce(log, seenWarnings, `command ${definition.name} failed: ${messageOf(error)}`)
          return false
        }
      }
      if (typeof dispose === 'function') {
        quotaCommandDisposers.push(dispose)
        log.info(`command registered name=${definition.name} via=${via}`)
        return true
      }
      return false
    }

    /**
     * Register the `/hist` family.
     */
    const registerHistoryCommands = () => {
      if (commandDisposers.length > 0) return true
      let commands
      try {
        commands = ctx.get('commands', false)
      } catch {
        commands = undefined
      }
      if (commands === undefined || typeof commands.register !== 'function') return false
      const definitions = createCommandDefinitions({ actions: commandActions, getLang: () => lang })
      for (const definition of definitions) {
        let dispose
        let via = 'commands'
        for (const host of seamServices(ctx, 'tuiPluginHost')) {
          try {
            dispose = host.registerCommand(ctx, contributionIdOf(definition.name), definition)
            if (typeof dispose === 'function') via = 'tuiPluginHost'
            break
          } catch (error) {
            log.debug(`mediated command ${definition.name} refused: ${messageOf(error)}`)
          }
        }
        if (typeof dispose !== 'function') {
          try {
            dispose = commands.register(definition)
          } catch (error) {
            warnOnce(log, seenWarnings, `command ${definition.name} failed: ${messageOf(error)}`)
            continue
          }
        }
        if (typeof dispose === 'function') {
          commandDisposers.push(dispose)
          log.info(`command registered name=${definition.name} via=${via}`)
        }
      }
      return commandDisposers.length > 0
    }

    /**
     * Localized `/`-menu descriptions for the two command roots.
     *
     * The command registry's own descriptor carries no translations, so the
     * completion tree is where Chinese descriptions come from.
     */
    const registerCommandTrees = () => {
      if (commandTreeDisposers.length > 0) return true
      for (const trees of seamServices(ctx, 'tuiCommandTrees')) {
        for (const definition of createCommandDefinitions({ actions: commandActions, getLang: () => lang })) {
          try {
            const dispose = trees.register({
              root: definition.name,
              descriptions: definition.descriptions,
              children: () => [],
            })
            if (typeof dispose === 'function') commandTreeDisposers.push(dispose)
          } catch (error) {
            warnOnce(log, seenWarnings, `command tree ${definition.name} failed: ${messageOf(error)}`)
          }
        }
        if (commandTreeDisposers.length > 0) break
      }
      if (commandTreeDisposers.length > 0) {
        log.info(`command tree registered roots=${commandTreeDisposers.length}`)
      }
      return commandTreeDisposers.length > 0
    }

    /** Whether a tracker entry belongs to the conversation the host focused. */
    const isFocusedEntry = entry => entry !== undefined && focusId !== undefined && entry.id === focusId

    /** Remember one conversation's settled turn (bounded, recency-ordered). */
    const rememberSettled = (id, settled) => {
      if (id === '') return
      settledById.delete(id)
      settledById.set(id, settled)
      while (settledById.size > MAX_SETTLED) {
        const oldest = settledById.keys().next().value
        if (oldest === undefined) break
        settledById.delete(oldest)
      }
    }

    /**
     * Forget a conversation's remembered figure.
     *
     * A round that reported no tokens settles nothing, so the previous figure
     * must go with it: leaving it behind put an older round's cost on the line
     * as if the round that just ended had produced it.
     */
    const forgetSettled = id => {
      if (id === '') return
      settledById.delete(id)
    }

    /**
     * The tracked entry of one session object, created on first use.
     *
     * @param session - the session object the host handed us on an event.
     * @returns `{ id, tracker, steps, turnOpen }`; recency is refreshed so
     *   eviction drops the least recently active session, never the focused
     *   one. `steps` maps `turn:step` to the instant that request STARTED (the
     *   tier a request is billed in is the one it ran in, and the assistant
     *   message lands after the answer); `turnOpen` marks a round as accepting
     *   subagent spend.
     */
    const trackerEntry = session => {
      const existing = trackers.get(session)
      if (existing !== undefined) {
        trackers.delete(session)
        trackers.set(session, existing)
        return existing
      }
      const entry = { id: sessionIdOf(session), tracker: createTracker(), steps: new Map(), turnOpen: false }
      trackers.set(session, entry)
      while (trackers.size > MAX_TRACKERS) {
        const victim = [...trackers.keys()].find(candidate =>
          candidate !== session && candidate !== activeSession && !isFocusedEntry(trackers.get(candidate)))
        if (victim === undefined) break
        trackers.delete(victim)
      }
      return entry
    }

    /** The tracked entry of the focused conversation, when one exists. */
    const focusedEntry = () => {
      if (focusId === undefined) return undefined
      let found
      for (const entry of trackers.values()) {
        if (entry.id === focusId) found = entry
      }
      return found
    }

    /** The tracked entry of one conversation id (newest wins on a reused id). */
    const entryById = id => {
      if (id === undefined || id === '') return undefined
      let found
      for (const entry of trackers.values()) {
        if (entry.id === id) found = entry
      }
      return found
    }

    /**
     * The tracker the status line renders.
     *
     * A known focus wins outright — including when that conversation has no
     * tracker yet, where "no turn data here" is the honest answer and the
     * previous conversation's figure is not. Without a focus signal the line
     * keeps the last-event behaviour — except for the conversation a cleared
     * marker left behind (`/new`), which never keeps the figure.
     */
    const activeEntry = () => {
      if (focusId !== undefined) return focusedEntry()
      if (activeSession === undefined) return undefined
      const entry = trackers.get(activeSession)
      if (focusCleared && entry !== undefined && entry.id === clearedFocusId) return undefined
      return entry
    }

    const activeTracker = () => activeEntry()?.tracker

    /**
     * The cap a plan-mode percentage divides by.
     *
     * `planPercentBase` decides: the window the line is showing (the tightest
     * limit, and the one whose reset the user is watching), or the whole monthly
     * pool. Either falls back to the other, so a provider that reports only one
     * of them still gets a meaningful denominator.
     */
    const planCapOf = () => {
      if (quota?.mode !== 'plan') return undefined
      const shown = quota?.meter
      const monthly = meterById(quotaSnapshot, 'planRemaining')
      const chosen = resolved.planPercentBase === 'monthly' ? (monthly ?? shown) : (shown ?? monthly)
      return typeof chosen?.cap === 'number' && chosen.cap > 0 ? chosen.cap : undefined
    }

    const publish = () => {
      if (disposed) return
      try {
        const entry = activeEntry()
        const tracker = entry?.tracker
        // A conversation whose session was disposed and resumed has no live
        // tracker yet — the host replays its history privately, publishing no
        // event — so its own last settled turn is served from the id-keyed
        // record. The remembered figure is only consulted for a KNOWN focus:
        // an unknown or cleared one must never resurrect a conversation.
        const remembered = focusId === undefined ? undefined : settledById.get(focusId)
        const base = tracker?.lastTurn() ?? remembered
        // A measured spend is an account fact, remembered next to the settled
        // turn (see `settleTurnSpend`); it decorates whatever the tracker (or the
        // remembered record) says the last turn was.
        const measured = entry?.spend ?? (focusId === undefined ? undefined : spendById.get(focusId))
        // On a subscription the measured spend also reads as a share of the cap.
        const percent = measured === undefined ? undefined : percentUsed(measured.spend?.value, planCapOf())
        // A running turn is priced live on every repaint, so the line says what
        // this round has cost SO FAR instead of showing the previous round's
        // settled figure under a "this turn" label.
        const live = tracker === undefined
          ? undefined
          : {
              tokens: tracker.turnTokens(),
              cost: tracker.turnCost(Date.now(), rates),
              // A provider with a spend counter has no live figure: the number
              // only exists once the provider's accounting catches up.
              measured: resolved.turnSpendMode !== 'estimate' && quotaSnapshot?.spendCounter !== undefined,
            }
        store.set(buildDisplay({
          atMs: Date.now(),
          lang,
          config: resolved,
          quota,
          lastTurn: base !== undefined && measured !== undefined
            ? { ...base, ...measured, ...(percent === undefined ? {} : { spendPercent: percent }) }
            : base,
          live,
          forcePeak,
        }))
      } catch (error) {
        log.warn(`publish failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }

    /**
     * Adopt one language and repaint everything the plugin draws.
     *
     * Both surfaces must be refreshed: the status line is built from `lang` on
     * every `publish()`, and the open history scene re-renders because
     * `publishHistory()` swaps the store snapshot it subscribes to. The
     * settings card needs nothing — the host localizes its `descriptions`
     * maps itself.
     *
     * @param next - `'zh'` / `'en'`, or `undefined` for "no new information".
     * @param source - provenance for the log line.
     * @returns whether the language actually changed.
     */
    const applyLanguage = (next, source) => {
      if (disposed || next === undefined || next === lang) return false
      const previous = lang
      lang = next
      log.info(`language switched ${previous} -> ${next} (${source})`)
      publish()
      publishHistory()
      return true
    }

    /**
     * Adopt a session as the focused conversation.
     *
     * @param id - focused session id (non-empty).
     * @param source - provenance for the debug log.
     */
    const applyFocus = (id, source) => {
      if (id === focusId && !focusCleared) return
      focusId = id
      focusCleared = false
      clearedFocusId = undefined
      log.debug(`focus via ${source}: ${id}`)
      publish()
    }

    /**
     * Forget the focused conversation because the host cleared its marker.
     *
     * The host clears the marker exactly when a fresh conversation starts
     * (`/new`), so the figure on screen belongs to the conversation just left:
     * it is hidden until the new one shows up (see {@link claimClearedFocus}).
     */
    const clearFocus = source => {
      if (focusCleared) return
      focusCleared = true
      clearedFocusId = focusId
      focusId = undefined
      log.debug(`focus cleared via ${source}: the left-behind conversation gives up the line`)
      publish()
    }

    /**
     * Apply one marker reading.
     *
     * @param marker - a {@link readFocusMarker} result. An `absent` marker is
     *   ignored: a host that never writes one keeps the last-event fallback
     *   instead of losing the figure entirely.
     * @param source - provenance for the debug log.
     */
    const applyFocusMarker = (marker, source) => {
      if (marker?.state === 'focused') applyFocus(marker.id, source)
      else if (marker?.state === 'cleared') clearFocus(source)
    }

    /**
     * Poll the marker and apply it ONLY when the file actually changed.
     *
     * A reading is a state, not an event. Re-applying it every second made an
     * empty marker (the host's normal resting state: `clearResumeTarget` writes
     * `''` on `/new` and when a session it cannot resume exits) mute whichever
     * conversation had claimed the line — permanently, because that
     * conversation's own events are then skipped by the cleared-focus guard.
     */
    const focusMarkerChanged = createMarkerWatcher()
    const pollFocusMarker = source => {
      const marker = readFocusMarker()
      if (!focusMarkerChanged(marker)) return
      applyFocusMarker(marker, source)
    }

    /**
     * `tui/session-switched` handler (host-mediated DecisionEvents point).
     *
     * This is the exact signal: it fires for every switch (`/resume`, agent
     * view, background adoption, `/new`) and names the session that is now
     * focused, which the session-event firehose never does. Marks the focus as
     * event-sourced so the marker poll stops second-guessing it.
     */
    const onSessionSwitched = payload => {
      try {
        if (disposed) return
        focusSource = 'event'
        const id = payload?.sessionId
        applyFocus(typeof id === 'string' && id !== '' ? id : undefined, 'switch event')
      } catch (error) {
        log.warn(`session switch handler failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }

    /** Path of the declarative provider spec file (settings override wins). */
    const specsPath = () => (resolved.quotaProvidersFile !== '' ? resolved.quotaProvidersFile : specPath())

    /**
     * Read the spec file.
     *
     * Re-read on every refresh instead of cached: it is small, it is the user's
     * live extension point, and a hand edit must take effect without a restart.
     */
    const loadSpecs = () => {
      try {
        return readSpecs({ path: specsPath(), env: process.env })
      } catch (error) {
        log.warn(`provider spec unreadable: ${messageOf(error)}`)
        return { version: 1, apiBases: {}, providers: {}, allowUnofficial: false }
      }
    }

    /** Provider of the conversation on screen, or `''` when the host said nothing. */
    const observedProvider = () => {
      const provider = activeTracker()?.provider
      return typeof provider === 'string' ? provider : ''
    }

    /**
     * Map a snapshot onto the display model.
     *
     * `pinned` separates "the user asked about this provider" from "the
     * conversation happened to run through it": a provider with no quota
     * interface stays quiet unless it was named, while a rejected key or a
     * transport failure is worth showing either way.
     */
    const quotaDisplayOf = (snapshot, pinned) => {
      if (snapshot === undefined) return { state: 'loading' }
      if (snapshot.ok !== true) {
        switch (snapshot.reason) {
          case 'no-key': return { state: 'no-key' }
          case 'unauthorized': return { state: 'unauthorized' }
          case 'unsupported': return pinned ? { state: 'unsupported', pinned: true } : undefined
          default: return { state: 'error' }
        }
      }
      const { meter } = pickMeter(snapshot, resolved.quotaMetric, quotaTick)
      if (meter === undefined) return pinned ? { state: 'unsupported', pinned: true } : undefined
      return {
        state: 'meter',
        // The kind of readout follows the provider's billing method, not the
        // meter that happened to be picked.
        mode: billingOf(snapshot, resolved.billingMode),
        meter,
        planName: snapshot.plan,
        provider: snapshot.provider,
        rotating: snapshot.meters.length > 1 && resolved.quotaMetric === 'rotate',
      }
    }

    /**
     * Refresh the account side.
     *
     * Every provider interaction goes through `collectQuota` (see `./account.js`):
     * the seams are soft-probed on each pass, the spec file is re-read, and any
     * failure becomes a rendered state instead of an exception.
     */
    const refreshQuota = async (options = {}) => {
      if (disposed || resolved.showBalance !== true || quotaInFlight) return
      const now = Date.now()
      if (options.force !== true && now - quotaRequestedAt < MIN_BALANCE_GAP_MS) return
      quotaRequestedAt = now
      quotaInFlight = true
      try {
        const target = resolveTarget({ provider: observedProvider(), config: resolved })
        if (target.enabled !== true) {
          quotaSnapshot = undefined
          quota = undefined
        } else {
          const snapshot = await collectQuota({
            provider: target.provider,
            config: resolved,
            spec: loadSpecs(),
            llmServices: seamServices(ctx, 'llm'),
            settingsServices: seamServices(ctx, 'settings'),
            credentialsServices: seamServices(ctx, 'credentials'),
            log,
          })
          if (disposed) return
          quotaSnapshot = snapshot
          quota = quotaDisplayOf(snapshot, target.source === 'pinned')
          log.debug(
            `quota ${snapshot.ok === true ? `${snapshot.meters.length} meter(s)` : snapshot.reason}` +
            ` provider=${target.provider} source=${target.source}`,
          )
        }
      } catch (error) {
        if (!disposed) quota = { state: 'error' }
        log.warn(`quota refresh failed: ${messageOf(error)}`)
      } finally {
        quotaInFlight = false
      }
      publish()
    }

    /**
     * Capture the provider's spend counter as a turn begins.
     */
    const beginTurnSpend = () => {
      spendRetries = 0
      if (spendRetryTimer !== undefined) {
        clearTimeout(spendRetryTimer)
        spendRetryTimer = undefined
      }
      if (resolved.turnSpendMode === 'estimate') {
        turnSpend.reset()
        return
      }
      turnSpend.begin(quotaSnapshot?.spendCounter)
    }

    /** The conversation a settled figure belongs to. */
    const spendOwnerId = () => activeEntry()?.id ?? ''

    /**
     * Settle the measured spend of the turn that just ended.
     *
     * The figure lands in `spendById` rather than in the tracker: the tracker
     * owns tokens and the estimated cost, while a measured spend is an account
     * fact that must survive a conversation switch (see `settledById`).
     */
    const settleTurnSpend = (options = {}) => {
      if (resolved.turnSpendMode === 'estimate') return
      const owner = activeEntry()
      const result = turnSpend.settle(quotaSnapshot?.spendCounter, { force: options.force === true })
      if (result.state === 'settled') {
        const spend = { spend: { value: result.spent, unit: result.unit }, spendExact: result.exact }
        // Two homes, on purpose: the entry serves the live line (it is what
        // `activeEntry` resolves, with every focus rule already applied), and the
        // id-keyed map serves a conversation the host disposed and resumed.
        if (owner !== undefined) owner.spend = spend
        if (owner?.id !== undefined && owner.id !== '') spendById.set(owner.id, spend)
        publish()
        return
      }
      if (result.state === 'pending') scheduleSpendRetry()
    }

    /**
     * Retry a settlement whose counter has not moved yet.
     *
     * A provider accounts for a request a few seconds after answering it, so a
     * zero difference right after `turn/end` usually means "not yet", not
     * "free". Once the retry budget is spent the figure is forced (and flagged
     * inexact) so the line settles on something instead of spinning forever.
     */
    const scheduleSpendRetry = () => {
      if (disposed || spendRetryTimer !== undefined) return
      if (spendRetries >= SPEND_RETRY_LIMIT) {
        spendRetries = 0
        void refreshQuota({ force: true }).then(() => settleTurnSpend({ force: true }))
        return
      }
      spendRetries += 1
      spendRetryTimer = setTimeout(() => {
        spendRetryTimer = undefined
        void refreshQuota({ force: true }).then(() => settleTurnSpend())
      }, SPEND_RETRY_MS)
      if (typeof spendRetryTimer.unref === 'function') spendRetryTimer.unref()
    }

    /**
     * A conversation other than the one just left claims a cleared focus.
     *
     * After `/new` the line is deliberately blank, and any conversation that is
     * not the one the host left behind is the candidate the user is looking at:
     * claiming it makes the choice sticky, so a parked conversation finishing a
     * background turn cannot take the line over again.
     */
    const claimClearedFocus = entry => {
      if (!focusCleared) return
      if (entry.id === clearedFocusId) return
      focusCleared = false
      clearedFocusId = undefined
      if (entry.id === '') return
      focusId = entry.id
      log.debug(`focus claimed by the new conversation: ${focusId}`)
    }

    /** `turn:step` identity of one session event (`''` when the host omits them). */
    const stepKeyOf = event => {
      const turn = event?.data?.turn
      const step = event?.data?.step
      return turn === undefined || step === undefined ? '' : `${turn}:${step}`
    }

    const onSessionEvent = (session, event) => {
      try {
        if (disposed) return
        const type = event?.type

        // A subagent round is spent on the user's behalf, so its tokens belong
        // to the conversation that spawned it. The child gets no tracker; its
        // reports are folded into the parent's running turn — but only while
        // that turn is still open, so a background child finishing later can
        // never settle its spend into a round that already closed.
        if (isSubagentSession(session)) {
          if (type === 'assistant/message') {
            const parent = entryById(parentIdOf(session))
            if (parent !== undefined && parent.turnOpen) {
              parent.tracker.onUsage(event?.data?.usage, event?.time ?? Date.now())
              publish()
            }
          }
          return
        }

        let entry
        /** Whether this event named a different provider than the tracker held. */
        let providerChanged = false
        if (type === 'request/header') {
          entry = trackerEntry(session)
          entry.turnOpen = true
          entry.tracker.setModel(event?.data?.header?.config?.model)
          // The provider route decides which account the line reports on, so a
          // change of route (a `/model` switch to another provider) re-targets
          // the quota section — but the refresh itself waits until this event has
          // claimed the line, because the target comes from the ACTIVE tracker.
          const provider = event?.data?.header?.config?.provider
          providerChanged = typeof provider === 'string' && provider !== '' && provider !== entry.tracker.provider
          entry.tracker.setProvider(provider)
        } else if (type === 'step/start') {
          // The tier a request is billed in is the one it RAN in: remember the
          // request's own instant and file the later usage report under it.
          entry = trackerEntry(session)
          entry.turnOpen = true
          const key = stepKeyOf(event)
          if (key !== '') {
            entry.steps.set(key, event?.time ?? Date.now())
            while (entry.steps.size > MAX_STEPS) {
              const oldest = entry.steps.keys().next().value
              if (oldest === undefined) break
              entry.steps.delete(oldest)
            }
          }
          return
        } else if (type === 'assistant/message') {
          entry = trackerEntry(session)
          entry.turnOpen = true
          const key = stepKeyOf(event)
          const startedAt = key === '' ? undefined : entry.steps.get(key)
          if (key !== '') entry.steps.delete(key)
          if (entry.tracker.onUsage(event?.data?.usage, startedAt ?? event?.time ?? Date.now()) === undefined) return
        } else if (type === 'turn/start') {
          entry = trackerEntry(session)
          // A new round begins: whatever the previous one left behind (it never
          // emitted `turn/end`) must not be settled into this one.
          entry.tracker.beginTurn()
          entry.steps.clear()
          entry.turnOpen = true
          beginTurnSpend()
        } else if (type === 'turn/end') {
          entry = trackerEntry(session)
          entry.turnOpen = false
          entry.steps.clear()
          const settled = entry.tracker.endTurn(event?.time ?? Date.now(), rates)
          if (settled !== undefined) rememberSettled(entry.id, settled)
          else forgetSettled(entry.id)
        } else {
          return
        }
        // The conversation the host just left behind keeps reporting (a parked
        // turn), but it must not become the line's subject while a fresh
        // conversation is expected.
        if (!(focusCleared && entry.id === clearedFocusId)) {
          activeSession = session
          claimClearedFocus(entry)
          publish()
        }
        if (type === 'request/header' && providerChanged) void refreshQuota({ force: true })
        if (type === 'turn/end') {
          // Read the account again first: a provider with a spend counter needs
          // a fresh reading to measure the turn that just closed.
          void refreshQuota({ force: true }).then(() => settleTurnSpend())
        }
      } catch (error) {
        log.warn(`session event failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }

    /**
     * Forget one disposed session.
     *
     * Deletion is by OBJECT identity, so disposing a parked session can never
     * wipe the state of a live one that happens to carry the same id. When the
     * disposed session was the one on screen, the line moves to the most
     * recently active survivor (the map keeps recency order with the newest
     * last) — the stalest entry would be a different conversation's figure.
     */
    const onSessionDisposed = session => {
      try {
        const entry = trackers.get(session)
        if (entry === undefined) return
        trackers.delete(session)
        const wasActive = activeSession === session
        if (wasActive) activeSession = [...trackers.keys()].pop()
        if (wasActive || isFocusedEntry(entry)) publish()
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
      let quotaTimer
      let rotateTimer
      let focusTimer
      let langTimer
      let focusDisposer
      let probeLogged = false
      let statusRefusals = 0

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
              `status=${seamServices(ctx, 'tuiStatus', onProbeError).length} ` +
              `scenes=${seamServices(ctx, 'tuiScenes', onProbeError).length} ` +
              `commands=${seamServices(ctx, 'commands', onProbeError).length} ` +
              `trees=${seamServices(ctx, 'tuiCommandTrees', onProbeError).length} ` +
              `shortcuts=${seamServices(ctx, 'tuiShortcuts', onProbeError).length} ` +
              `host=${seamServices(ctx, 'tuiPluginHost', onProbeError).length}`
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
              settingsScope = scope
              watchDisposer = scope.watch(next => {
                Object.assign(resolved, sanitizeConfig(next))
                // A settings change is authoritative: drop the scene-local
                // overrides so what the card says is what the grid shows.
                for (const key of Object.keys(historyOverrides)) delete historyOverrides[key]
                publish()
                publishHistory()
                void refreshQuota({ force: true })
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
                  // The first tick can land while the seam row is still
                  // activating, and the host answers a refusal then. Only a
                  // run of refusals means the view will never be admitted.
                  statusRefusals += 1
                  if (statusRefusals >= STATUS_REFUSAL_LIMIT) {
                    warnOnce(
                      log,
                      seenWarnings,
                      `status view was refused ${statusRefusals} times; the line will not render`,
                    )
                    statusDisposer = () => {}
                  }
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

          // `/th`: the full-screen history scene, its two commands and their
          // localized completion descriptions. All three are optional seams
          // that keep retrying with the rest of the probe, and none of them can
          // take the plugin down when a host does not offer it.
          //
          // The cache is read *before* the scene is registered, so the very
          // first `/hist` of a session already has a grid to draw (see
          // `preloadHistory`).
          preloadHistory()
          registerHistoryScene()
          registerHistoryCommands()
          registerQuotaCommand()
          registerCommandTrees()
          registerHistoryShortcut()

          // The exact focus signal, when this activation was admitted with the
          // optional DecisionEvents contract. A host without it (or without the
          // capability) refuses here and the marker poll below carries the
          // feature; a granted-but-later-revoked subscription releases through
          // this disposer, so the retry loop can re-register.
          if (focusDisposer === undefined && focusSource !== 'event') {
            for (const host of seamServices(ctx, 'tuiPluginHost')) {
              try {
                const subscribe = host?.subscribeDecision
                if (typeof subscribe !== 'function') continue
                const disposer = subscribe.call(
                  host,
                  ctx,
                  'tui/session-switched',
                  onSessionSwitched,
                  { scope: 'tui/session-switched' },
                )
                if (typeof disposer === 'function') {
                  focusDisposer = disposer
                  log.info('session-switch subscription registered')
                  break
                }
              } catch (error) {
                warnOnce(log, seenWarnings, `session-switch subscribe failed: ${messageOf(error)}`)
              }
            }
          }

          if (statusDisposer !== undefined && phaseTimer === undefined) {
            publish()
            phaseTimer = setInterval(() => {
              try {
                // The countdown always comes from the real clock; the language
                // is refreshed here too as a slow safety net.
                applyLanguage(readHostLang(), 'phase tick')
                publish()
              } catch (error) {
                log.warn(`phase tick failed: ${error instanceof Error ? error.message : String(error)}`)
              }
            }, PHASE_TICK_MS)
            quotaTimer = setInterval(() => {
              void refreshQuota()
            }, BALANCE_REFRESH_MS)
            // The `rotate` metric cycles the meters on its own cadence, faster
            // than the refresh and free: it only re-renders what is already in
            // hand, it never asks the provider for anything.
            rotateTimer = setInterval(() => {
              if (resolved.showBalance !== true || resolved.quotaMetric !== 'rotate') return
              quotaTick += 1
              publish()
            }, QUOTA_ROTATE_MS)
            // Fallback focus source: the launcher marker the host rewrites on
            // every switch and clears on `/new`. Skipped once a real switch
            // event has arrived, so a second TUI window sharing this profile
            // cannot steer this line. Only CHANGES in the reading are applied
            // (see `pollFocusMarker`): an unchanged empty marker is a resting
            // state, not a fresh "/new".
            if (focusTimer === undefined) {
              pollFocusMarker('marker')
              focusTimer = setInterval(() => {
                try {
                  if (focusSource === 'event') return
                  pollFocusMarker('marker')
                } catch (error) {
                  log.warn(`focus poll failed: ${error instanceof Error ? error.message : String(error)}`)
                }
              }, FOCUS_POLL_MS)
            }
            if (typeof phaseTimer.unref === 'function') phaseTimer.unref()
            if (typeof quotaTimer.unref === 'function') quotaTimer.unref()
            if (typeof rotateTimer.unref === 'function') rotateTimer.unref()
            if (typeof focusTimer.unref === 'function') focusTimer.unref()
            void refreshQuota({ force: true })
          }

          // The `/th` surfaces count as part of "the host accepted this plugin":
          // the scene renders the feature, so a host that never offers
          // `tuiScenes` keeps the retry loop alive to its limit instead of
          // silently pretending startup finished.
          const done =
            scope !== undefined &&
            sectionDisposer !== undefined &&
            statusDisposer !== undefined &&
            sceneDisposer !== undefined &&
            commandDisposers.length > 0
          if (done || ++attempts >= RETRY_LIMIT) {
            if (retryTimer !== undefined) {
              clearInterval(retryTimer)
              retryTimer = undefined
            }
            if (!done) {
              log.warn(
                `host seams incomplete after ${(RETRY_LIMIT * RETRY_MS) / 1000}s ` +
                  `(settings=${scope !== undefined}, section=${sectionDisposer !== undefined}, ` +
                  `status=${statusDisposer !== undefined}, scene=${sceneDisposer !== undefined}, ` +
                  `commands=${commandDisposers.length})`,
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

      // `/lang` support, in two layers.
      //
      // 1. The exact signal: dsh-tui mirrors its choice into the `dsh-tui`
      //    settings namespace, and the settings service emits
      //    `settings/updated(ns, next, prev, source)` on every commit — so a
      //    switch repaints the status line and any open scene immediately.
      // 2. A 1 s poll of the persisted file for hosts that serve no `dsh-tui`
      //    namespace: it re-resolves only when the file's mtime/size moved, so
      //    a steady state costs one `stat` per second.
      const onSettingsUpdated = (ns, next) => {
        try {
          if (ns !== 'dsh-tui') return
          applyLanguage(normalizeLang(next?.lang), 'settings/updated')
        } catch (error) {
          log.warn(`language event failed: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
      try {
        ctx.on('settings/updated', onSettingsUpdated)
      } catch (error) {
        log.warn(`settings subscription failed: ${error instanceof Error ? error.message : String(error)}`)
      }
      let langStamp = langPrefStamp()
      langTimer = setInterval(() => {
        try {
          if (disposed) return
          const stamp = langPrefStamp()
          if (stamp === langStamp) return
          langStamp = stamp
          applyLanguage(readHostLang(), 'lang.json')
        } catch (error) {
          log.warn(`language poll failed: ${error instanceof Error ? error.message : String(error)}`)
        }
      }, LANG_POLL_MS)
      if (typeof langTimer.unref === 'function') langTimer.unref()

      yield () => {
        disposed = true
        for (const timer of [retryTimer, phaseTimer, quotaTimer, rotateTimer, focusTimer, langTimer, spendRetryTimer]) {
          if (timer !== undefined) clearInterval(timer)
        }
        stopHistoryRefresh()
        retryTimer = undefined
        phaseTimer = undefined
        quotaTimer = undefined
        rotateTimer = undefined
        focusTimer = undefined
        langTimer = undefined
        spendRetryTimer = undefined
        try {
          historyScanAbort?.abort()
        } catch {
          // Best-effort teardown.
        }
        historyScanAbort = undefined
        for (const dispose of [...commandDisposers, ...commandTreeDisposers, ...quotaCommandDisposers]) {
          try {
            dispose()
          } catch {
            // Best-effort teardown.
          }
        }
        commandDisposers.length = 0
        commandTreeDisposers.length = 0
        quotaCommandDisposers.length = 0
        try {
          shortcutDisposer?.()
        } catch {
          // Best-effort teardown.
        }
        shortcutDisposer = undefined
        settingsScope = undefined
        try {
          sceneDisposer?.()
        } catch {
          // Best-effort teardown.
        }
        sceneDisposer = undefined
        try {
          focusDisposer?.()
        } catch {
          // Best-effort teardown.
        }
        focusDisposer = undefined
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
        settledById.clear()
        log.info('disposed')
      }
    }, 'dsh-peak-balance lifecycle')
  } catch (error) {
    // A plugin must never fail the host's startup: log and stay inert.
    log.warn(`apply failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}
