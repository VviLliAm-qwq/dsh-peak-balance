/**
 * UI language resolution and strings.
 *
 * Language follows the same chain dsh-TUI uses: `DSH_TUI_LANG` →
 * `~/.dsh-tui/lang.json` → OS locale → `zh`, with the host's live
 * `dsh-tui.lang` setting read first when it is served (that is what a `/lang`
 * switch updates — see `./plugin.js`). The settings-card labels are localized
 * by the host from the `descriptions` maps, so this module only covers the
 * strings the plugin renders itself.
 *
 * @module dsh-peak-balance/i18n
 */

import { readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const STRINGS = Object.freeze({
  zh: Object.freeze({
    peak: '峰时',
    idle: '谷时',
    idleHalf: '谷时·半价',
    peakBadge: '⚡',
    idleBadge: '🌊',
    countdownToIdle: '距谷时 {d}',
    countdownToPeak: '距峰时 {d}',
    weekend: '周末',
    balance: '余额',
    turn: '本轮',
    turnLive: '本轮·计费中',
    session: '会话',
    balanceChecking: '查询中…',
    balanceNoKey: '未配置密钥',
    balanceRejected: '密钥无效',
    balanceUnavailable: '暂不可用',
    unratedModel: '费率未知',
    noTurnYet: '—',
    historyTitle: 'Token 历史',
    historyMetricTokens: '总 token',
    historyMetricCost: '花费',
    historyMetricOutput: '输出 token',
    historyMetricCacheMiss: '未命中输入',
    historyMonthLabel: '{m}月',
    historyScanning: '扫描中',
    historyRefreshing: '刷新中',
    historyScannedAt: '更新于',
    historyError: '扫描失败',
    historyLoading: '正在读取会话日志…',
    historyNoData: '无用量',
    historyLegendLow: '少',
    historyLegendHigh: '多',
    historyLegendMax: '峰值',
    historySubagentShort: '子代理',
    historySubagentOn: '计入',
    historySubagentOff: '不计入',
    historyWindow: '显示 {a}/{b} 周',
    historyExcluded: '已排除 {sessions} 会话 / {events} 次上报',
    historyTokens: 'token',
    historyInput: '未命中输入',
    historyCacheRead: '缓存读',
    historyOutput: '输出',
    historyCost: '花费',
    historyCostIncomplete: '含费率未知模型，金额偏低',
    historyCacheHit: '缓存命中',
    historySubagentShare: '子代理占比',
    historySubagent: '子代理会话',
    historyEvents: '事件',
    historySessions: '会话',
    historyTotalTokens: '总计',
    historyTotalCost: '总花费(估)',
    historyActiveDays: '活跃天数',
    historyBestDay: '峰值日',
    historyColModel: '模型',
    historyColTokens: '总 token',
    historyColCost: '花费(估)',
    historyColCacheHit: '命中率',
    historyColRate: '费率来源',
    historyRateBuiltin: '内置价目',
    historyRateCustom: '自定义',
    historyRateUnknown: '未知',
    historyHint: '←/→ 前后周 · ↑/↓ 前后天 · t 今天 · m 指标 · w 跨度 · s 子代理 · r 刷新 · q/Esc 关闭',
    historyUsageTitle: '用法：',
    historyUsageOpen: '打开历史方格图',
    historyUsageThCaveat: '同样可用；单独回车会被补全菜单抢去切主题，请打「/th 」带个空格',
    historyUsageShortcut: '不用打字的打开方式',
    historyUsagePriceList: '列出自定义费率与费率未知的模型',
    historyUsagePriceSet: '设置费率（元/百万 token；高峰期默认 = 空闲 ×2）',
    historyUsagePriceRm: '删除某模型的自定义费率',
    historyUsagePriceClear: '清空全部自定义费率',
    historyPriceTitle: '自定义费率（空闲命中/未命中/输出 · 高峰命中/未命中/输出，元/百万 token）：',
    historyPriceEmpty: '（暂无自定义费率）',
    historyPriceIdle: '空闲',
    historyPricePeak: '高峰',
    historyPriceUnknown: '费率未知的模型（可为其设置单价）：',
    historyPriceHint: '设置：/th price set <model> <hit> <miss> <out> [peakHit peakMiss peakOut]',
    historyPriceBadPrice: '❌ 价格必须是 ≥ 0 的数字',
    historyPriceBadModel: '❌ 模型名不能为空',
    historyPriceSet: '✅ 已设置 {model}：空闲 {hit}/{miss}/{out} 元/百万 token',
    historyPriceRemoved: '✅ 已删除 {model} 的自定义费率',
    historyPriceNotSet: 'ℹ️ {model} 没有自定义费率',
    historyPriceCleared: '✅ 已清空 {count} 条自定义费率',
    historyBadArgs: '❌ 参数不正确',
    historyCommandFailed: '❌ 命令执行失败',
  }),
  en: Object.freeze({
    peak: 'Peak',
    idle: 'Off-peak',
    idleHalf: 'Off-peak · half',
    peakBadge: '⚡',
    idleBadge: '🌊',
    countdownToIdle: 'off-peak in {d}',
    countdownToPeak: 'peak in {d}',
    weekend: 'weekend',
    balance: 'Balance',
    turn: 'Turn',
    turnLive: 'Turn · live',
    session: 'Session',
    balanceChecking: 'checking…',
    balanceNoKey: 'no API key',
    balanceRejected: 'key rejected',
    balanceUnavailable: 'unavailable',
    unratedModel: 'unrated model',
    noTurnYet: '—',
    historyTitle: 'Token history',
    historyMetricTokens: 'Total tokens',
    historyMetricCost: 'Cost',
    historyMetricOutput: 'Output tokens',
    historyMetricCacheMiss: 'Cache-miss input',
    historyMonthLabel: '{m}',
    historyScanning: 'scanning',
    historyRefreshing: 'refreshing',
    historyScannedAt: 'updated',
    historyError: 'scan failed',
    historyLoading: 'reading session logs…',
    historyNoData: 'no usage',
    historyLegendLow: 'less',
    historyLegendHigh: 'more',
    historyLegendMax: 'peak',
    historySubagentShort: 'subagents',
    historySubagentOn: 'counted',
    historySubagentOff: 'excluded',
    historyWindow: 'showing {a}/{b}w',
    historyExcluded: 'excluded {sessions} sessions / {events} reports',
    historyTokens: 'tokens',
    historyInput: 'input(miss)',
    historyCacheRead: 'cache read',
    historyOutput: 'output',
    historyCost: 'cost',
    historyCostIncomplete: 'includes unrated models; cost is a lower bound',
    historyCacheHit: 'cache hit',
    historySubagentShare: 'subagent share',
    historySubagent: 'Subagent sessions',
    historyEvents: 'events',
    historySessions: 'sessions',
    historyTotalTokens: 'Total',
    historyTotalCost: 'Est. cost',
    historyActiveDays: 'active days',
    historyBestDay: 'busiest',
    historyColModel: 'model',
    historyColTokens: 'tokens',
    historyColCost: 'cost(est)',
    historyColCacheHit: 'hit rate',
    historyColRate: 'rates',
    historyRateBuiltin: 'built-in',
    historyRateCustom: 'custom',
    historyRateUnknown: 'unknown',
    historyHint: '←/→ week · ↑/↓ day · t today · m metric · w span · s subagents · r rescan · q/Esc close',
    historyUsageTitle: 'Usage:',
    historyUsageOpen: 'open the history grid',
    historyUsageThCaveat: 'also works, but a bare Enter is stolen by the completion menu — type "/th " with a space',
    historyUsageShortcut: 'open it without typing',
    historyUsagePriceList: 'list custom rates and models without rates',
    historyUsagePriceSet: 'set rates (CNY per 1M tokens; peak defaults to idle ×2)',
    historyUsagePriceRm: 'drop one model’s custom rates',
    historyUsagePriceClear: 'drop every custom rate',
    historyPriceTitle: 'Custom rates (idle hit/miss/out · peak hit/miss/out, CNY per 1M tokens):',
    historyPriceEmpty: '(no custom rates)',
    historyPriceIdle: 'idle',
    historyPricePeak: 'peak',
    historyPriceUnknown: 'Models without rates (set one for them):',
    historyPriceHint: 'Set: /th price set <model> <hit> <miss> <out> [peakHit peakMiss peakOut]',
    historyPriceBadPrice: '❌ prices must be numbers ≥ 0',
    historyPriceBadModel: '❌ the model name cannot be empty',
    historyPriceSet: '✅ {model} set: idle {hit}/{miss}/{out} per 1M tokens',
    historyPriceRemoved: '✅ dropped custom rates for {model}',
    historyPriceNotSet: 'ℹ️ {model} has no custom rates',
    historyPriceCleared: '✅ dropped {count} custom rate(s)',
    historyBadArgs: '❌ wrong arguments',
    historyCommandFailed: '❌ command failed',
  }),
})

/** Normalize any locale-ish string to a supported language. */
export function normalizeLang(value) {
  if (typeof value !== 'string') return undefined
  const lower = value.trim().toLowerCase()
  if (lower.startsWith('zh')) return 'zh'
  if (lower.startsWith('en')) return 'en'
  return undefined
}

/**
 * The persisted `/lang` file (`~/.dsh-tui/lang.json`).
 *
 * Same path dsh-tui itself uses (`utils/paths.ts` → `~/.dsh-tui`), with a
 * diagnostic/test override so a test never reads the developer's own choice.
 */
export function langPrefFile(env = process.env, options = {}) {
  if (typeof options.langFile === 'string' && options.langFile !== '') return options.langFile
  const override = env?.DSH_PEAK_BALANCE_LANG_FILE
  if (typeof override === 'string' && override !== '') return override
  return join(homedir(), '.dsh-tui', 'lang.json')
}

/**
 * Change stamp of the persisted language file.
 *
 * The plugin polls this once a second so a `/lang` switch shows up even on a
 * host that serves no `dsh-tui` settings namespace; comparing the stamp means
 * an unchanged file costs one `stat` instead of a read + parse.
 *
 * @returns `"<mtimeMs>:<size>"`, or `''` when the file is absent/unreadable.
 */
export function langPrefStamp(options = {}) {
  const statFile = options.statFile ?? statSync
  const file = langPrefFile(options.env, options)
  try {
    const stat = statFile(file)
    return `${stat.mtimeMs}:${stat.size}`
  } catch {
    return ''
  }
}

/**
 * Resolve the UI language.
 *
 * Resolution order mirrors dsh-TUI's own `/lang` mechanism: the environment
 * pin wins, then the persisted choice, then the OS locale. The host's live
 * language is read separately (`settings.get('dsh-tui').lang`, see
 * `./plugin.js`) because it is the only source that reflects a `/lang` switch
 * made after this process started.
 *
 * @param options - `env` (defaults to `process.env`), `readFile` (defaults to
 *   `fs.readFileSync`), `langFile` (defaults to {@link langPrefFile}) and
 *   `locale` (defaults to the process locale) — all injectable for tests.
 * @returns `'zh'` or `'en'`.
 */
export function resolveLang(options = {}) {
  const env = options.env ?? process.env
  const fromEnv = normalizeLang(env?.DSH_TUI_LANG)
  if (fromEnv !== undefined) return fromEnv

  const readFile = options.readFile ?? readFileSync
  const langFile = langPrefFile(env, options)
  try {
    const raw = readFile(langFile, 'utf8')
    const parsed = JSON.parse(raw)
    const fromFile = normalizeLang(parsed?.lang)
    if (fromFile !== undefined) return fromFile
  } catch {
    // Missing/corrupt lang.json is normal (fresh install, hand-edited file).
  }

  let locale
  try {
    locale = options.locale ?? Intl.DateTimeFormat().resolvedOptions().locale
  } catch {
    locale = undefined
  }
  const fromLocale = normalizeLang(locale)
  if (fromLocale !== undefined) return fromLocale
  // dsh-TUI's rule for a locale it does not ship: an ABSENT locale (typical on
  // Windows, where the POSIX variables do not exist and imply nothing) keeps
  // the historical `zh`, while any other stated locale falls back to English —
  // a German user must not be handed a Chinese UI.
  return typeof locale === 'string' && locale.trim() !== '' ? 'en' : 'zh'
}

/**
 * Look up one string.
 *
 * @param lang - `'zh'` or `'en'` (anything else falls back to `en`).
 * @param key - string key.
 * @param params - `{name}` placeholders to substitute.
 */
export function t(lang, key, params) {
  const table = STRINGS[lang] ?? STRINGS.en
  const template = table[key] ?? STRINGS.en[key] ?? key
  if (params === undefined) return template
  return template.replace(/\{(\w+)\}/g, (match, name) =>
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match,
  )
}
