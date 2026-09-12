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

import { readFileSync, statSync } from 'node:fs'
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
 * @param options - `readFile` (defaults to `fs.readFileSync`), `stat`
 *   (defaults to `fs.statSync`), `file` (defaults to {@link focusFilePath})
 *   and `env`, all injectable for tests.
 * @returns `{ state: 'focused', id, raw, mtimeMs }`, `{ state: 'cleared', raw:
 *   '', mtimeMs }` or `{ state: 'absent' }`; never throws.
 */
export function readFocusMarker(options = {}) {
  const readFile = options.readFile ?? readFileSync
  const stat = options.stat ?? statSync
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
  // The mtime is what tells a REWRITE apart from the same reading being polled
  // again: `/new` can write the same empty string that was already there, and
  // the value alone would look unchanged. Readers that inject `readFile` for a
  // path that does not exist simply get no mtime and fall back to the content.
  let mtimeMs
  try {
    const stats = stat(file)
    if (stats !== null && typeof stats === 'object' && Number.isFinite(stats.mtimeMs)) mtimeMs = stats.mtimeMs
  } catch {
    // No stat available: content-only change detection.
  }
  return id === '' ? { state: 'cleared', raw: '', mtimeMs } : { state: 'focused', id, raw: id, mtimeMs }
}

/**
 * A stable identity for one marker reading.
 *
 * Two readings of a file nobody has written since share a stamp, which is what
 * lets the poll tell "the host says something new" apart from "I looked again".
 *
 * @param marker - a {@link readFocusMarker} result.
 */
export function markerStamp(marker) {
  if (marker?.state === 'absent') return 'absent'
  const mtime = Number.isFinite(marker?.mtimeMs) ? marker.mtimeMs : 'no-mtime'
  return `${mtime}|${marker?.raw ?? ''}`
}

/**
 * Change detector for the fallback poll.
 *
 * Without it the poll re-applies its reading once per second, and a `cleared`
 * reading re-fires forever: the plugin mutes the conversation the marker named,
 * and — because the muted conversation's own events are then skipped — the
 * figure never comes back. That is a real field failure, not a theory: the
 * host writes `resume.txt` empty both on `/new` and when a session it cannot
 * resume exits (`clearResumeTarget`), so an empty marker is a normal resting
 * state and must be applied once, not once per tick.
 *
 * @returns `(marker) => boolean`: `true` only when the reading is new.
 */
export function createMarkerWatcher() {
  let last
  return marker => {
    const stamp = markerStamp(marker)
    if (stamp === last) return false
    last = stamp
    return true
  }
}
