# Changelog

All notable changes to this project are documented in this file.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and this project adheres to [Semantic Versioning](https://semver.org/).

## [0.1.11] - 2026-09-12

### Fixed

- **Leaving a conversation and coming back lost its figure.** A settled turn is
  a fact about the CONVERSATION, but it lived only inside the tracker of the
  session object that reported it — and switching away through `/resume`
  disposes that session. Coming back reuses the conversation id with a fresh
  agent, and the host replays the conversation privately (no `session/event`),
  so nothing rebuilt the tracker and the line showed `—`. Settled turns are now
  also remembered by conversation id (bounded, newest 24), which is what the
  line falls back to for a known focus with no live tracker. An unknown or
  cleared focus still never resurrects a conversation, so `/new` keeps showing
  `—`.

## [0.1.10] - 2026-09-12

### Fixed

- **`/new` kept the previous conversation's per-turn figure.** The host starts a
  fresh conversation by EMPTYING its focus marker, which 0.1.9 read as "no
  information" and answered with the last-event fallback — i.e. it put back the
  very conversation the user had just left. An emptied marker is now read as the
  statement it is (`{ state: 'cleared' }`, not `{ state: 'absent' }`): the line
  gives up the figure, and the first conversation that is not the one left
  behind claims it, so a parked conversation finishing a background turn cannot
  take the line back. A marker that cannot be read at all still falls back to the
  last session event, which is what a host that never writes one needs.

### Added

- Regression tests covering a `/new` the fallback poll notices both before and
  after the fresh conversation's first turn lands.

## [0.1.9] - 2026-09-12

### Fixed

- **The per-turn cost belonged to the wrong conversation after a switch.** The
  line followed "the session that appended last", but switching conversations
  publishes no `session/event`: the host replays the target session straight
  into its own projector, and DSH only fires that event for appends the current
  process makes ("constructor seeds do not emit"). Switching therefore left the
  *previous* conversation's figure on screen, and a parked conversation
  settling a background turn stole it back. The line now follows the
  conversation the host reports as focused.
- **Disposing the shown conversation fell back to the stalest tracker.** The
  tracker map keeps recency order (newest last) and the fallback read its first
  key — the *least* recently active conversation. It now moves to the newest
  survivor.
- **A reused session id could leak turn state between agents.** Trackers were
  keyed by session id, and dsh-tui reuses ids ("A → /new → /resume A lands back
  on the same id with a fresh agent"): an abandoned mid-turn got priced into the
  replacement agent's first settled turn, and disposing the parked agent deleted
  the live one's data. Trackers are now keyed by the session object.

### Added

- Focus tracking from two independent sources: the host-mediated
  `tui/session-switched` DecisionEvents notification (exact, used when the host
  mounts its plugin-interop row) and the launcher marker the host rewrites on
  every switch, polled once a second as the fallback. A conversation with no
  settled turn in this process now shows `—` instead of another conversation's
  amount.
- The manifest requires `tui.dsh/v1alpha1#DecisionEvents` as an **optional**
  contract with the fallback spelled out, so a host without the capability
  degrades (`compatible_degraded`) instead of refusing admission. Admission was
  verified against the host's own parser/validator/negotiator.
- `DSH_PEAK_BALANCE_FOCUS_FILE` overrides the marker path for tests and
  diagnostics, and the seam probe line now reports `host=<n>`.
- Regression tests for the switch, the marker fallback, a refusing host, the
  disposal fallback order and the reused-id case. `test-support/harness.js`
  carries the shared fake context for the wiring tests.

## [0.1.8] - 2026-09-10

### Fixed

- **The cost formula under-priced cached turns by several times.** It mirrored
  the host's estimator and treated `cacheReadTokens` as a subset of
  `inputTokens` (`(input − cacheRead) × miss + cacheRead × hit`). The provider
  reports the cache-miss input, the cache-hit input and the output as three
  *disjoint* counts — its `totalTokens` is their sum, and dsh-tui derives its
  cache-hit rate from `cacheRead / (input + cacheRead + cacheWrite)` — so
  clamping one against the other silently dropped most of the miss-priced
  prompt. Measured against a real balance drop: a turn that cost ¥0.20 was
  estimated at ¥0.03 before and ¥0.23 after.

### Added

- A regression test pinning the disjoint semantics (a large cache read must not
  be capped by a small miss count).

## [0.1.7] - 2026-09-10

### Changed

- Plain line: a blank row above it (so it never touches the transcript) and two
  cells of indent, one past the prompt cursor's column. The warning frame keeps
  the two-cell indent but no top gap — it already fills the host's three-row
  budget, and a margin would push its bottom border into the clipped area.

## [0.1.6] - 2026-09-10

### Changed

- The contribution is indented by one cell so it lines up with the prompt's own
  content column instead of hugging the terminal edge. The warning frame shifts
  as a whole, keeping both shapes on the same column.

## [0.1.5] - 2026-09-10

### Fixed

- **The entry module must export exactly `name`, `Config` and `apply`.** With
  its helpers (`seamServices`, `settingsSection`, …) also exported from
  `lib/index.js`, the loader wrapped the activation differently and every
  dsh-tui seam registration from that activation was rejected with
  `requires a live Cordis activation context`: the settings namespace still
  registered (that service does not verify the caller), so the plugin looked
  half-alive — no settings card, no status line. `lib/index.js` is now a shell
  that re-exports those three symbols from `lib/plugin.js`, the same shape the
  shipped TUI plugins use.
- A rich status view refused once (the first tick can land while the seam row is
  still activating) is no longer treated as final: the view is retried and only
  a run of refusals degrades it.

### Added

- `test/entry.test.js` pins the export shape and the manifest→shell wiring.
- Regression tests for the seam-resolution order, a refusing shadow
  placeholder, and the retry-then-give-up status behaviour.

## [0.1.4] - 2026-09-10

### Fixed

- **The plugin registered nothing on a real dsh-tui boot.** Services were
  resolved with the non-strict `ctx.get(name, false)`, which — in compositions
  where the dsh-tui seam rows are shadowed — hands back a placeholder whose
  method calls the host rejects with `requires a live Cordis activation
  context`. The settings namespace still registered (the settings service does
  not verify the caller), so the plugin looked half-alive: no settings card, no
  status line. `seamServices()` now asks strictly first — the form the shipped
  TUI plugins use — and keeps the non-strict accessor only as a fallback, so
  both host shapes resolve. Reported by the 0.1.3 lifecycle log.

### Added

- Regression tests for the seam resolution order and for a refusing shadow
  placeholder, so the bug cannot come back silently.

## [0.1.3] - 2026-09-10

### Added

- A bounded lifecycle log at `~/.dsh-tui/dsh-peak-balance.log`: one line when
  the module is imported, one when `apply()` starts (with pid and file path),
  the resolved config, a probe of which host seams are mounted, the outcome of
  every registration, and the teardown. Diagnosing a silently inert plugin
  previously required guessing; the host's own diagnostics never reach a file.
  The log trims itself to its newest half past 128 KiB and stays untouched
  under `node --test`.

## [0.1.2] - 2026-09-10

### Added

- `DSH_PEAK_BALANCE_FORCE_PEAK=1` diagnostic override: renders the peak
  presentation (and the warning frame) outside a real peak window, so the
  effect can be previewed without waiting for the next 09:00 Beijing. The
  countdown keeps describing the real clock, and the switch is off unless the
  variable is set.

## [0.1.1] - 2026-09-10

### Changed

- The warning-color setting is validated at use time instead of by the settings
  schema, so a stale or hand-edited value in the settings document can no longer
  fail the namespace registration (which would have rendered the card as
  unavailable and left it unrepairable from the UI). Unknown colors fall back to
  red.

## [0.1.0] - 2026-09-10

### Added

- Peak/off-peak billing clock above the prompt (Beijing time, Mon-Fri
  09:00-12:00 and 14:00-18:00), with a live countdown to the next switch.
- Live DeepSeek account balance, refreshed after every completed turn and on a
  60 s background interval.
- Per-turn cost estimate for the turn that just finished, priced with the
  official 2026-09-10 rate card (idle and peak buckets are priced separately by
  each request's own timestamp).
- Warning mode: while the current window is peak, the status contribution turns
  into a three-row frame that pulses in one of seven selectable colors.
- A settings card ("Peak & Balance") on the `/settings` screen with four
  switches: balance display, per-turn cost display, warning mode, warning color.
- Graceful degradation: with no `tuiStatus` / `tuiSettingsSections` service (or
  no credentials) the plugin stays inert instead of failing the host.
