/**
 * Which conversation the TUI is showing.
 *
 * A conversation switch is invisible on the `session/event` firehose: the host
 * replays the target session straight into its own projector, and DSH only
 * publishes `session/event` for events THIS process appends ("constructor
 * seeds do not emit" — `dsh-session`, session constructor). Inferring the
 * focused conversation from "the last event I saw" therefore renders the
 * *previous* conversation's per-turn cost after every switch.
 *
 * Two independent signals close that gap:
 *
 * 1. `tui/session-switched` — the host's own non-veto DecisionEvents
 *    notification ("per-session plugin state rebinds here"), carrying
 *    `{ kind, sessionId, previousSessionId, cwd }`. It is the exact signal, but
 *    a plugin can only receive it after being admitted with the DecisionEvents
 *    contract, so it is optional for this plugin.
 * 2. `~/.dsh-tui/resume.txt` — the launcher marker the host rewrites on every
 *    switch (adoption, `/resume`, boot) and clears on `/new`. Polled as the
 *    fallback whenever the mediated subscription is unavailable.
 *
 * Either way a *session id* is all this module produces. Deciding whether that
 * id currently owns turn data belongs to the wiring, so a stale marker can
 * never invent a conversation.
 *
 * @module dsh-peak-balance/focus
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * Fallback poll interval in milliseconds.
 *
 * The marker is a tiny file and the poll only runs while the mediated
 * subscription has not delivered a switch, so a second of latency on the
 * fallback path is cheaper than another seam.
 */
export const FOCUS_POLL_MS = 1_000

/** Default marker path; the host owns the file, this plugin only reads it. */
export const FOCUS_FILE = join(homedir(), '.dsh-tui', 'resume.txt')

/**
 * Marker path, honoring the `DSH_PEAK_BALANCE_FOCUS_FILE` override.
 *
 * The override exists for tests and diagnostics, mirroring
 * `DSH_PEAK_BALANCE_FORCE_PEAK`: a test run must not read (or be steered by)
 * the developer's real marker.
 *
 * @param env - environment to read; defaults to `process.env`.
 */
export function focusFilePath(env = process.env) {
  const override = env?.DSH_PEAK_BALANCE_FOCUS_FILE
  return typeof override === 'string' && override !== '' ? override : FOCUS_FILE
}

/**
 * Read the host's focus marker.
 *
 * Three outcomes, and the difference between the last two matters: a marker
 * the host EMPTIED is a statement ("a fresh conversation started, the one you
 * had is gone"), while a marker that cannot be read at all is merely silence
 * (a host that never writes one) — and only silence may fall back to the last
 * session event.
 *
 * @param options - `readFile` (defaults to `fs.readFileSync`), `file`
 *   (defaults to {@link focusFilePath}) and `env`, all injectable for tests.
 * @returns `{ state: 'focused', id }`, `{ state: 'cleared' }` or
 *   `{ state: 'absent' }`; never throws.
 */
export function readFocusMarker(options = {}) {
  const readFile = options.readFile ?? readFileSync
  const file = options.file ?? focusFilePath(options.env)
  let raw
  try {
    raw = readFile(file, 'utf8')
  } catch {
    // Missing or unreadable: the host never wrote one.
    return { state: 'absent' }
  }
  if (typeof raw !== 'string') return { state: 'absent' }
  const id = raw.trim()
  return id === '' ? { state: 'cleared' } : { state: 'focused', id }
}
