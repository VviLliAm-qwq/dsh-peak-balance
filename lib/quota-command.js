/**
 * The `/quota` command: what the account section is reading, and why.
 *
 * Provider quota is the one part of this plugin that depends on endpoints it
 * does not own, so "nothing is showing" has to be answerable without a
 * debugger. The command reports the resolved target, the adapter that claimed
 * it, the last outcome and every provider the host can route — which is also how
 * a spec file gets verified after being written.
 *
 * @module dsh-peak-balance/quota-command
 */

import { t } from './i18n.js'

/** Command name (the manifest contribution id is derived from it). */
export const QUOTA_COMMAND = 'quota'

/** Meter ids the `meter` subcommand accepts (see `./quota.js`). */
export const METER_CHOICES = Object.freeze([
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

/**
 * Parse one invocation.
 *
 * @param rawInput - text after the command name.
 * @returns `{ kind: 'status' }` / `{ kind: 'check', provider }` /
 *   `{ kind: 'meter', metric }` / `{ kind: 'error', reason }`.
 */
export function parseQuotaArgs(rawInput) {
  const text = typeof rawInput === 'string' ? rawInput.trim() : ''
  if (text === '') return { kind: 'status' }
  const parts = text.split(/\s+/)
  const verb = parts[0].toLowerCase()
  if (verb === 'status') return { kind: 'status' }
  if (verb === 'check') {
    if (parts.length > 2) return { kind: 'error', reason: 'bad-args' }
    return { kind: 'check', provider: parts[1] ?? '' }
  }
  if (verb === 'meter') {
    if (parts.length !== 2) return { kind: 'error', reason: 'bad-args' }
    const metric = parts[1]
    if (!METER_CHOICES.includes(metric)) return { kind: 'error', reason: 'bad-meter', metric }
    return { kind: 'meter', metric }
  }
  return { kind: 'error', reason: 'unknown-subcommand', token: parts[0] }
}

/** One meter as a single readable line. */
function meterLine(meter) {
  const parts = []
  if (typeof meter.used === 'number') parts.push(`used=${meter.used}`)
  if (typeof meter.cap === 'number') parts.push(`cap=${meter.cap}`)
  if (typeof meter.remaining === 'number') parts.push(`left=${meter.remaining}`)
  if (typeof meter.resetAt === 'number') parts.push(`reset=${new Date(meter.resetAt).toISOString()}`)
  if (meter.exceeded === true) parts.push('EXCEEDED')
  return `  ${meter.id}${meter.currency === undefined ? '' : ` ${meter.currency}`} (${meter.kind}) ${parts.join(' ') || 'no figures'}`
}

/** The usage block shown for a bad invocation. */
function usageText(lang) {
  return [
    t(lang, 'quotaUsageTitle'),
    `  /quota                         ${t(lang, 'quotaUsageStatus')}`,
    `  /quota check [provider]        ${t(lang, 'quotaUsageCheck')}`,
    `  /quota meter <metric>          ${t(lang, 'quotaUsageMeter')}`,
  ].join('\n')
}

/**
 * Render one report (the shape `actions.status()` / `actions.check()` return).
 *
 * @param lang - `'zh'` / `'en'`.
 * @param report - `{ provider, source, adapter, state, reason, detail, plan,
 *   meters, specPath, updatedAt, providers }`.
 */
export function renderQuotaReport(lang, report) {
  const lines = [t(lang, 'quotaStatusTitle')]
  const provider = report?.provider === '' || report?.provider === undefined ? '—' : report.provider
  lines.push(`  ${t(lang, 'quotaStatusProvider')} ${provider}${report?.source === undefined ? '' : ` (${report.source})`}`)
  lines.push(`  ${t(lang, 'quotaStatusAdapter')} ${report?.adapter === undefined || report.adapter === '' ? '—' : report.adapter}`)
  lines.push(`  ${t(lang, 'quotaStatusState')} ${report?.state ?? '—'}${report?.reason === undefined ? '' : ` (${report.reason})`}`)
  if (typeof report?.detail === 'string' && report.detail !== '') {
    lines.push(`  ${t(lang, 'quotaStatusDetail')} ${report.detail}`)
  }
  if (typeof report?.plan === 'string' && report.plan !== '') lines.push(`  plan ${report.plan}`)
  if (typeof report?.updatedAt === 'number') lines.push(`  at ${new Date(report.updatedAt).toISOString()}`)

  const meters = Array.isArray(report?.meters) ? report.meters : []
  if (meters.length > 0) {
    lines.push(t(lang, 'quotaStatusMeters'))
    for (const meter of meters) lines.push(meterLine(meter))
  }
  const failures = Array.isArray(report?.failures) ? report.failures : []
  if (failures.length > 0) {
    lines.push(t(lang, 'quotaStatusFailures'))
    for (const failure of failures) lines.push(`  ${failure}`)
  }
  const providers = Array.isArray(report?.providers) ? report.providers : []
  if (providers.length > 0) {
    lines.push(t(lang, 'quotaStatusProviders'))
    for (const entry of providers) {
      const adapter = entry.adapter === undefined || entry.adapter === '' ? t(lang, 'quotaStatusNoAdapter') : entry.adapter
      lines.push(`  ${entry.provider}${entry.declared === true ? ' *' : ''}  ${adapter}`)
    }
  }
  if (typeof report?.specPath === 'string' && report.specPath !== '') {
    lines.push(`  ${t(lang, 'quotaStatusSpec')} ${report.specPath}`)
  }
  return lines.join('\n')
}

/**
 * Build the registry definition for `/quota`.
 *
 * @param options.actions - `status()`, `check(provider)`, `setMetric(metric)`.
 * @param options.getLang - returns `'zh'` / `'en'` at call time.
 */
export function createQuotaCommand(options) {
  const actions = options?.actions ?? {}
  const getLang = options?.getLang ?? (() => 'zh')

  const definition = {
    name: QUOTA_COMMAND,
    description: 'Provider quota diagnostics: adapter, endpoint and last outcome',
    descriptions: {
      zh: '第三方 provider 额度诊断（适配器、端点与最近一次结果）',
      en: 'Provider quota diagnostics: adapter, endpoint and last outcome',
    },
    handler: async invocation => {
      const lang = getLang()
      const parsed = parseQuotaArgs(invocation?.rawInput)
      try {
        switch (parsed.kind) {
          case 'status':
            return { kind: 'success', text: renderQuotaReport(lang, await actions.status?.()) }
          case 'check': {
            const report = await actions.check?.(parsed.provider)
            if (report === undefined) return { kind: 'error', text: `${t(lang, 'quotaBadArgs')}\n${usageText(lang)}` }
            return { kind: 'success', text: renderQuotaReport(lang, report) }
          }
          case 'meter': {
            const result = await actions.setMetric?.(parsed.metric)
            if (result?.ok !== true) return { kind: 'error', text: `${t(lang, 'quotaBadArgs')}\n${usageText(lang)}` }
            return { kind: 'success', text: t(lang, 'quotaMetricSet', { metric: parsed.metric }) }
          }
          case 'error':
            return {
              kind: 'error',
              text: `${t(lang, parsed.reason === 'bad-meter' ? 'quotaBadMeter' : 'quotaBadArgs')}\n${usageText(lang)}`,
            }
          default:
            return { kind: 'error', text: `${t(lang, 'quotaBadArgs')}\n${usageText(lang)}` }
        }
      } catch (error) {
        return { kind: 'error', text: `${error instanceof Error ? error.message : String(error)}` }
      }
    },
  }
  return definition
}
