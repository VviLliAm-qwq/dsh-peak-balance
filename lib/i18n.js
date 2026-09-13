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
    quota: '额度',
    quotaUnsupported: '无接口',
    quotaPinned: '额度（已指定）',
    planLabel: '套餐 {name}',
    quotaReset: '距重置 {d}',
    quotaExceeded: '已打满',
    quotaRemainingPct: '剩 {p}',
    quotaSpent: '已用',
    quotaLeft: '余',
    meterWindow5h: '5h',
    meterWindowWeekly: '周',
    meterWindowDaily: '日',
    meterWindowMonthly: '月',
    meterPlanRemaining: '套餐余量',
    meterKeyLimit: 'key 限额',
    meterPeriodSpend: '本期',
    meterBalance: '余额',
    creditsUnit: 'credits',
    turnSpendApprox: '≈',
    quotaUsageTitle: '用法：',
    quotaUsageStatus: '当前额度来源与最近一次结果',
    quotaUsageCheck: '现场探测一个 provider（留空用当前目标）',
    quotaUsageMeter: '切换状态行口径（auto/balance/window5h/…）',
    quotaStatusTitle: '额度诊断',
    quotaStatusProvider: 'provider ',
    quotaStatusAdapter: '适配器   ',
    quotaStatusState: '状态     ',
    quotaStatusDetail: '说明     ',
    quotaStatusMeters: '口径：',
    quotaStatusFailures: '部分端点失败：',
    quotaStatusProviders: '可路由的 provider（* = 组合里声明的网关）：',
    quotaStatusNoAdapter: '无适配器',
    quotaStatusSpec: '声明文件 ',
    quotaBadArgs: '参数不对。',
    quotaBadMeter: '未知的额度口径。',
    quotaMetricSet: '额度口径已切换为 {metric}',
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
    historyProviderShort: '来源',
    historyProviderAll: '全部',
    historyCostMixed: '多个计价单位，已按 token 显示',
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
    historyHint: '←/→ 前后周 · ↑/↓ 前后天 · t 今天 · m 指标 · w 跨度 · s 子代理 · p 来源 · r 刷新 · q/Esc 关闭',
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
    quota: 'Quota',
    quotaUnsupported: 'no API',
    quotaPinned: 'Quota (pinned)',
    planLabel: 'plan {name}',
    quotaReset: 'resets in {d}',
    quotaExceeded: 'at cap',
    quotaRemainingPct: '{p} left',
    quotaSpent: 'used',
    quotaLeft: 'left',
    meterWindow5h: '5h',
    meterWindowWeekly: 'wk',
    meterWindowDaily: 'day',
    meterWindowMonthly: 'mo',
    meterPlanRemaining: 'plan left',
    meterKeyLimit: 'key cap',
    meterPeriodSpend: 'period',
    meterBalance: 'balance',
    creditsUnit: 'credits',
    turnSpendApprox: '≈',
    unratedModel: 'unrated model',
    noTurnYet: '—',
    quotaUsageTitle: 'Usage:',
    quotaUsageStatus: 'current quota source and its last outcome',
    quotaUsageCheck: 'probe one provider now (empty = the current target)',
    quotaUsageMeter: 'switch the status-line meter (auto/balance/window5h/…)',
    quotaStatusTitle: 'Quota diagnostics',
    quotaStatusProvider: 'provider ',
    quotaStatusAdapter: 'adapter  ',
    quotaStatusState: 'state    ',
    quotaStatusDetail: 'detail   ',
    quotaStatusMeters: 'meters:',
    quotaStatusFailures: 'failed endpoints:',
    quotaStatusProviders: 'routable providers (* = gateway declared in the composition):',
    quotaStatusNoAdapter: 'no adapter',
    quotaStatusSpec: 'spec file ',
    quotaBadArgs: 'Bad arguments.',
    quotaBadMeter: 'Unknown quota meter.',
    quotaMetricSet: 'Quota meter switched to {metric}',
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
    historyProviderShort: 'source',
    historyProviderAll: 'all',
    historyCostMixed: 'multiple units; showing tokens',
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
    historyHint: '←/→ week · ↑/↓ day · t today · m metric · w span · s subagents · p source · r rescan · q/Esc close',
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
 * The host locale, as the platform reports it.
 *
 * `Intl` is the only signal dsh-TUI itself reads: the POSIX variables are absent
 * on Windows, where their absence implies nothing. Exposed as a seam rather than
 * called inline because the answer is machine-dependent — a Chinese desktop and
 * an English CI runner disagree — so a test that asserts on "the locale" has to
 * pin this instead of inheriting whoever runs it.
 *
 * @returns The locale tag (`'zh-CN'`, `'en-US'`, …).
 */
function detectLocale() {
  return Intl.DateTimeFormat().resolvedOptions().locale
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
 *   `fs.readFileSync`), `langFile` (defaults to {@link langPrefFile}),
 *   `locale` (defaults to {@link detectLocale}) and `detectLocale` (the host
 *   probe itself) — all injectable for tests.
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
    const detect = options.detectLocale ?? detectLocale
    locale = options.locale ?? detect()
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
