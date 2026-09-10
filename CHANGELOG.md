# Changelog

All notable changes to this project are documented in this file.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and this project adheres to [Semantic Versioning](https://semver.org/).

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
