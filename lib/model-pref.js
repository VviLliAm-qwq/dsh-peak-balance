/**
 * The host's persisted model route.
 *
 * A conversation the host restored at boot has no live tracker in this process:
 * the host replays its history privately and publishes no `session/event` (see
 * `./focus.js`), so the provider of the conversation on screen is unknown until
 * its first request. Falling back to the historical `deepseek-official` default
 * then reports a DIFFERENT account's balance — on a machine that runs through a
 * relay or a subscription provider, the first page after a restart shows the
 * official API's number while every later page shows the right one.
 *
 * dsh-tui persists its `/model` picker choice at `~/.dsh-tui/model.json`
 * (`{ provider, model }` — the route it re-applies after a restart), which is
 * the route the next request will use. Reading it is the cheapest honest answer
 * to "no conversation has spoken yet", and it is the same class of host state
 * this plugin already reads for the focus marker and the interface language.
 *
 * @module dsh-peak-balance/model-pref
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Default location of the host's `/model` preference. */
export const MODEL_PREF_FILE = join(homedir(), '.dsh-tui', 'model.json')

/**
 * Path of the host's `/model` preference file.
 *
 * `options.modelFile` and `DSH_PEAK_BALANCE_MODEL_FILE` are the test/diagnostic
 * overrides (mirroring `DSH_PEAK_BALANCE_FOCUS_FILE`), and `DSH_TUI_STATE_DIR`
 * moves the whole TUI state directory the way the host's own paths do.
 *
 * @param env - environment to read; defaults to `process.env`.
 * @param options.modelFile - explicit path, when a caller already has one.
 */
export function modelPrefPath(env = process.env, options = {}) {
  if (typeof options.modelFile === 'string' && options.modelFile !== '') return options.modelFile
  const override = env?.DSH_PEAK_BALANCE_MODEL_FILE
  if (typeof override === 'string' && override !== '') return override
  const dir = typeof env?.DSH_TUI_STATE_DIR === 'string' && env.DSH_TUI_STATE_DIR !== ''
    ? env.DSH_TUI_STATE_DIR
    : join(homedir(), '.dsh-tui')
  return join(dir, 'model.json')
}

/**
 * Pull the provider out of the host's preference document.
 *
 * Only a COMPLETE route names a provider: the host itself discards a file whose
 * `provider` or `model` is missing (dsh-tui's `modelPrefs.parseModelPref`), and
 * honoring half of a half-written document would point the account section at a
 * route the next request will never use.
 *
 * @param text - raw file contents.
 * @returns The provider route id, or `''` when the document is not a route.
 */
export function parseModelProvider(text) {
  try {
    const parsed = JSON.parse(text)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return ''
    const { provider, model } = parsed
    if (typeof provider !== 'string' || provider === '') return ''
    if (typeof model !== 'string' || model === '') return ''
    return provider
  } catch {
    return ''
  }
}

/**
 * Read the preferred provider route.
 *
 * Never throws: a missing, unreadable or hand-edited file is silence, and
 * silence leaves the caller with its own default rather than a guess.
 *
 * @param options - `readFile`, `file` and `env`, all injectable for tests.
 * @returns A provider id, or `''`.
 */
export function readHostModelProvider(options = {}) {
  const readFile = options.readFile ?? readFileSync
  const file = options.file ?? modelPrefPath(options.env)
  try {
    const raw = readFile(file, 'utf8')
    return typeof raw === 'string' ? parseModelProvider(raw) : ''
  } catch {
    // Missing or unreadable: the host never persisted a choice.
    return ''
  }
}
