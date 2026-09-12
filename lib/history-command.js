/**
 * `/hist` (also `/th` and `/tokenhistory`) plus the `/hist price …` subcommands.
 *
 * Parsing and text building live here — pure and unit tested — while the
 * effects (scan, open the scene, read/write the rate file) arrive as an
 * injected `actions` object from `./plugin.js`. That keeps this module free of
 * host services and leaves one place where a command result string is decided.
 *
 * @module dsh-peak-balance/history-command
 */

import { t } from './i18n.js'

/**
 * Registered command names.
 *
 * `/hist` is the reliable short name. `/th` is kept because it is the name the
 * owner asked for, but a bare `/th` + Enter cannot reach it: dsh-tui's
 * slash-completion overlay executes the HIGHLIGHTED suggestion, the merged list
 * puts built-ins first, and `theme`/`thinking` both match the `th` prefix — so
 * `/th` + Enter switches the theme. `/th` followed by a space closes the
 * overlay and works; `/tokenhistory` and `/hist` never collide with a built-in.
 */
export const HISTORY_COMMANDS = Object.freeze(['th', 'tokenhistory', 'hist'])

/** Manifest id prefix shared by this plugin's command contributions. */
export const CONTRIBUTION_PREFIX = 'com.dsh-tui-ecosystem.dsh-peak-balance'

/** Scene id opened by the commands (must match `tuiScenes` id grammar). */
export const SCENE_ID = 'dsh-peak-balance-token-history'

/**
 * Manifest contribution id of one command name.
 *
 * The mediated `tuiPluginHost.registerCommand` requires this exact id; the
 * direct `ctx.commands.register` fallback ignores it.
 */
export function contributionIdOf(name) {
  return `${CONTRIBUTION_PREFIX}.${name}`
}

/** Subcommand verbs accepted after `price`. */
const REMOVE_VERBS = Object.freeze(['rm', 'remove', 'del', 'delete', 'unset'])
const CLEAR_VERBS = Object.freeze(['clear', 'reset', 'none'])

/** Whether a token is a valid, finite, non-negative price. */
function isPrice(token) {
  if (typeof token !== 'string' || token.trim() === '') return false
  const value = Number(token)
  return Number.isFinite(value) && value >= 0
}

/**
 * Parse one invocation's raw input.
 *
 * @param rawInput - the exact text after the command name (may carry the
 *   separator whitespace, per the command registry's contract).
 * @returns A discriminated instruction; unknown input yields `{ kind: 'error' }`.
 */
export function parseHistoryArgs(rawInput) {
  const text = typeof rawInput === 'string' ? rawInput.trim() : ''
  if (text === '') return { kind: 'open' }
  const parts = text.split(/\s+/)
  if (parts[0] !== 'price') return { kind: 'error', reason: 'unknown-subcommand', token: parts[0] }
  if (parts.length === 1) return { kind: 'price-list' }
  const verb = parts[1].toLowerCase()
  if (CLEAR_VERBS.includes(verb)) return { kind: 'price-clear' }
  if (REMOVE_VERBS.includes(verb)) {
    if (parts.length !== 3) return { kind: 'error', reason: 'bad-args', verb: 'price rm' }
    return { kind: 'price-remove', model: parts[2] }
  }
  if (verb === 'set') {
    if (parts.length !== 3 + 3 && parts.length !== 3 + 6) {
      return { kind: 'error', reason: 'bad-args', verb: 'price set' }
    }
    const model = parts[2]
    const numbers = parts.slice(3)
    if (!numbers.every(isPrice)) return { kind: 'error', reason: 'bad-price' }
    const spec = {
      hit: Number(numbers[0]),
      miss: Number(numbers[1]),
      out: Number(numbers[2]),
    }
    if (numbers.length === 6) {
      spec.peakHit = Number(numbers[3])
      spec.peakMiss = Number(numbers[4])
      spec.peakOut = Number(numbers[5])
    }
    return { kind: 'price-set', model, spec }
  }
  return { kind: 'error', reason: 'unknown-subcommand', token: parts[1] }
}

/** Multi-line usage text (shown for a bare `/th price`-less error and typos). */
export function usageText(lang) {
  return [
    t(lang, 'historyUsageTitle'),
    `  /hist · /tokenhistory          ${t(lang, 'historyUsageOpen')}`,
    `  /th …                          ${t(lang, 'historyUsageThCaveat')}`,
    `  alt+h                          ${t(lang, 'historyUsageShortcut')}`,
    `  /hist price                    ${t(lang, 'historyUsagePriceList')}`,
    `  /hist price set <model> <hit> <miss> <out> [peakHit peakMiss peakOut]`,
    `                                 ${t(lang, 'historyUsagePriceSet')}`,
    `  /hist price rm <model>         ${t(lang, 'historyUsagePriceRm')}`,
    `  /hist price clear              ${t(lang, 'historyUsagePriceClear')}`,
  ].join('\n')
}

/** One number for the rate listing ("0.02"). */
function num(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—'
  return String(Number(value.toFixed(6)))
}

/** Render the custom-rate listing plus the models the card cannot price. */
export function renderPriceList(lang, rates, unknownModels) {
  const lines = [t(lang, 'historyPriceTitle')]
  const entries = Object.entries(rates ?? {})
  if (entries.length === 0) {
    lines.push(`  ${t(lang, 'historyPriceEmpty')}`)
  } else {
    for (const [model, entry] of entries.sort(([a], [b]) => a.localeCompare(b))) {
      const idle = entry?.idle ?? {}
      const peak = entry?.peak ?? {}
      lines.push(
        `  ${model}  ${t(lang, 'historyPriceIdle')} ${num(idle.inputHit)}/${num(idle.inputMiss)}/${num(idle.output)}` +
          `  ${t(lang, 'historyPricePeak')} ${num(peak.inputHit)}/${num(peak.inputMiss)}/${num(peak.output)}`,
      )
    }
  }
  const unknown = Array.isArray(unknownModels) ? unknownModels : []
  if (unknown.length > 0) {
    lines.push(t(lang, 'historyPriceUnknown'))
    for (const item of unknown) {
      lines.push(`  ${item.model}  ${t(lang, 'historyTokens')} ${Math.round(item.tokens)}`)
    }
  }
  lines.push(t(lang, 'historyPriceHint'))
  return lines.join('\n')
}

/**
 * Build the registry definitions for `/hist`, `/th` and `/tokenhistory`.
 *
 * @param options.actions - effect surface supplied by the plugin wiring:
 *   `open()`, `listRates()`, `setRate(model, spec)`, `removeRate(model)`,
 *   `clearRates()`.
 * @param options.getLang - returns `'zh'` / `'en'` at call time.
 * @returns The three `CommandDefinition`s, all sharing one handler.
 */
export function createCommandDefinitions(options) {
  const actions = options?.actions ?? {}
  const getLang = options?.getLang ?? (() => 'zh')

  const handler = async invocation => {
    const lang = getLang()
    const parsed = parseHistoryArgs(invocation?.rawInput)
    try {
      switch (parsed.kind) {
        case 'open':
          return await actions.open()
        case 'price-list': {
          const listing = await actions.listRates?.()
          return { kind: 'success', text: renderPriceList(lang, listing?.rates, listing?.unknown) }
        }
        case 'price-set': {
          const result = await actions.setRate?.(parsed.model, parsed.spec)
          if (result?.ok !== true) {
            return {
              kind: 'error',
              text: `${t(lang, result?.error === 'price' ? 'historyPriceBadPrice' : 'historyPriceBadModel')}\n${usageText(lang)}`,
            }
          }
          return {
            kind: 'success',
            text: t(lang, 'historyPriceSet', {
              model: result.model,
              hit: num(result.entry?.idle?.inputHit),
              miss: num(result.entry?.idle?.inputMiss),
              out: num(result.entry?.idle?.output),
            }),
          }
        }
        case 'price-remove': {
          const result = await actions.removeRate?.(parsed.model)
          return result?.removed === true
            ? { kind: 'success', text: t(lang, 'historyPriceRemoved', { model: result.model }) }
            : { kind: 'success', text: t(lang, 'historyPriceNotSet', { model: result?.model ?? parsed.model }) }
        }
        case 'price-clear': {
          const result = await actions.clearRates?.()
          return { kind: 'success', text: t(lang, 'historyPriceCleared', { count: result?.count ?? 0 }) }
        }
        case 'error':
          // A bad price is worth naming precisely; every other parse failure is
          // answered with the usage text.
          return {
            kind: 'error',
            text: `${t(lang, parsed.reason === 'bad-price' ? 'historyPriceBadPrice' : 'historyBadArgs')}\n${usageText(lang)}`,
          }
        default:
          return { kind: 'error', text: `${t(lang, 'historyBadArgs')}\n${usageText(lang)}` }
      }
    } catch (error) {
      return {
        kind: 'error',
        text: `${t(lang, 'historyCommandFailed')}: ${error instanceof Error ? error.message : String(error)}`,
      }
    }
  }

  return HISTORY_COMMANDS.map(name => ({
    name,
    description: name === 'hist'
      ? 'Token history: daily usage/cost grid, totals and per-model stats'
      : `Token history (same as /hist)${name === 'th' ? ' — type a space after /th so the completion menu does not steal Enter' : ''}`,
    descriptions: {
      zh: name === 'hist'
        ? '历史 token 用量与花费（方格活跃图）'
        : name === 'th'
          ? '历史用量（/th 需在后面加空格，否则补全菜单会切主题）'
          : '历史用量（与 /hist 相同）',
      en: name === 'hist'
        ? 'Token history: daily usage/cost grid'
        : name === 'th'
          ? 'Token history (/th needs a trailing space)'
          : 'Token history (same as /hist)',
    },
    input: { hint: 'price [set|rm|clear] …' },
    handler,
  }))
}
