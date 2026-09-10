/**
 * UI language resolution and strings.
 *
 * Language follows the same chain the TUI itself uses: `DSH_TUI_LANG` →
 * `~/.dsh-tui/lang.json` → OS locale → `zh`. The settings-card labels are
 * localized by the host from the `descriptions` maps, so this module only
 * covers the status line.
 *
 * @module dsh-peak-balance/i18n
 */

import { readFileSync } from 'node:fs'
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
    session: '会话',
    balanceChecking: '查询中…',
    balanceNoKey: '未配置密钥',
    balanceRejected: '密钥无效',
    balanceUnavailable: '暂不可用',
    unratedModel: '费率未知',
    noTurnYet: '—',
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
    session: 'Session',
    balanceChecking: 'checking…',
    balanceNoKey: 'no API key',
    balanceRejected: 'key rejected',
    balanceUnavailable: 'unavailable',
    unratedModel: 'unrated model',
    noTurnYet: '—',
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
 * Resolve the UI language.
 *
 * @param options - `env` (defaults to `process.env`), `readFile` (defaults to
 *   `fs.readFileSync`), `langFile` (defaults to `~/.dsh-tui/lang.json`) and
 *   `locale` (defaults to the process locale) — all injectable for tests.
 * @returns `'zh'` or `'en'`.
 */
export function resolveLang(options = {}) {
  const env = options.env ?? process.env
  const fromEnv = normalizeLang(env?.DSH_TUI_LANG)
  if (fromEnv !== undefined) return fromEnv

  const readFile = options.readFile ?? readFileSync
  const langFile = options.langFile ?? join(homedir(), '.dsh-tui', 'lang.json')
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
  return normalizeLang(locale) ?? 'zh'
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
